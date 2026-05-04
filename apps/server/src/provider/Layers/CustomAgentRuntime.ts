import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  CustomAgentSettings,
  ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  ThreadId,
} from "@t3tools/contracts";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Queue } from "effect";
import type {
  CustomAgentLlmBackend,
  CustomAgentChatMessage,
  CustomAgentModelToolCall,
} from "./CustomAgentLlmBackend.ts";
import { parseCustomAgentModelCommand } from "./CustomAgentLlmBackend.ts";
import { buildCustomAgentRuntimePrompt, loadCustomAgentSystemPrompt } from "./CustomAgentPrompt.ts";
import {
  makeCustomAgentContextStore,
  type CustomAgentContextStore,
} from "./CustomAgentContextStore.ts";
import {
  makeCustomAgentToolRegistry,
  type CustomAgentApprovalRequest,
  type CustomAgentToolRegistry,
  type CustomAgentToolResult,
} from "./CustomAgentTools.ts";

const PROVIDER = ProviderDriverKind.make("customAgent");
const MAX_TOOL_STEPS = 12;
const MAX_INVALID_TOOL_CALLS = 3;
const MAX_REPEAT_TOOL_CALLS = 1;
const CONTEXT_COMPACT_TRIGGER_RATIO = 0.82;
const CONTEXT_COMPACT_FORCE_RATIO = 0.96;
const CONTEXT_COMPACT_RECENT_MESSAGES = 8;
const CONTEXT_COMPACT_MIN_MESSAGES = 12;
const CONTEXT_COMPACT_MAX_SUMMARIES = 5;
const MAX_SUBAGENTS_PER_CALL = 8;
const MAX_ACTIVE_SUBAGENTS_PER_SESSION = 16;
const SUBAGENT_RECENT_MESSAGES = 10;
const SUBAGENT_MAX_OUTPUT_TOKENS = 1600;
const SUBAGENT_WAIT_TIMEOUT_MS = 120_000;
const MAX_TODO_ITEMS = 12;
const MAX_TODO_TEXT_LENGTH = 180;
const TODO_REQUIRED_MIN_CHARS = 90;
const TODO_REQUIRED_KEYWORDS = [
  "analyze",
  "audit",
  "bug",
  "debug",
  "develop",
  "implement",
  "improve",
  "investigate",
  "plan",
  "refactor",
  "review",
  "cek",
  "analisis",
  "audit",
  "bug",
  "debug",
  "fitur",
  "implementasi",
  "kembangkan",
  "lanjutkan",
  "perbaiki",
  "project",
  "proyek",
  "prompt",
  "sistem",
  "tambahkan",
  "tools",
] as const;
const SUBAGENT_NAMES = [
  "Aether",
  "Orion",
  "Atlas",
  "Zephyr",
  "Lykos",
  "Aster",
  "Eryx",
  "Helios",
  "Nikos",
  "Xander",
  "Theron",
  "Damon",
  "Leonidas",
  "Evander",
  "Kairos",
  "Castor",
  "Ares",
  "Cygnus",
  "Leander",
  "Dorian",
  "Kael",
  "Zyren",
  "Veyr",
  "Auron",
  "Nox",
  "Riven",
  "Soren",
  "Draven",
  "Vael",
  "Kyros",
  "Axion",
  "Eryon",
  "Zarek",
  "Lucien",
  "Rhaen",
  "Varyn",
  "Azrael",
  "Kieran",
  "Sylas",
  "Caelum",
  "Nyron",
  "Zevan",
  "Aurel",
  "Orien",
  "Draxen",
  "Valen",
  "Ezren",
  "Kairox",
  "Thorne",
  "Astrael",
] as const;

function formatCustomAgentRuntimeError(error: unknown): string {
  const message = String((error as Error).message ?? error);
  return message.startsWith("Failed to reach Custom Agent API endpoint:") ||
    message.startsWith("Custom Agent API error") ||
    message.startsWith("Custom Agent API returned invalid JSON")
    ? message
    : `Custom Agent runtime error: ${message}`;
}

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new DOMException("Aborted", "AbortError");
}

function isAbortLikeError(error: unknown): boolean {
  const message = String((error as Error).message ?? error);
  const name = String((error as Error).name ?? "");
  return name === "AbortError" || /\b(aborted|interrupted|turn interrupted)\b/i.test(message);
}

function isRetryableRuntimeError(error: unknown): boolean {
  if (isAbortLikeError(error)) return false;
  const message = String((error as Error).message ?? error);
  return (
    /\b(timeout|timed out|econnreset|econnrefused|socket|fetch failed|network|rate limit|429|500|502|503|504)\b/i.test(
      message,
    ) || message.trim().length === 0
  );
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function parseToolJson(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function countArrayField(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function sliceArrayField<T extends Record<string, unknown>>(
  object: T,
  key: string,
  limit: number,
): T {
  const value = object[key];
  return Array.isArray(value) ? { ...object, [key]: value.slice(0, limit) } : object;
}

function compactToolJsonForModel(tool: string, parsed: Record<string, unknown>): unknown {
  if (typeof parsed.preview === "string")
    return { ...parsed, preview: parsed.preview.slice(0, 1200) };

  if (tool === "code_navigation") {
    const outlines = Array.isArray(parsed.outlines)
      ? parsed.outlines.slice(0, 6).map((outline) => {
          if (!outline || typeof outline !== "object") return outline;
          const record = outline as Record<string, unknown>;
          return {
            ...record,
            symbols: Array.isArray(record.symbols) ? record.symbols.slice(0, 14) : record.symbols,
            suggestedReads: Array.isArray(record.suggestedReads)
              ? record.suggestedReads.slice(0, 6)
              : record.suggestedReads,
          };
        })
      : parsed.outlines;
    const lexicalMatches =
      parsed.lexicalMatches && typeof parsed.lexicalMatches === "object"
        ? sliceArrayField(
            sliceArrayField(parsed.lexicalMatches as Record<string, unknown>, "snippets", 8),
            "suggestedReads",
            8,
          )
        : parsed.lexicalMatches;
    return { ...parsed, lexicalMatches, outlines };
  }

  if (tool === "project_map")
    return {
      ...parsed,
      keyFiles: Array.isArray(parsed.keyFiles) ? parsed.keyFiles.slice(0, 24) : parsed.keyFiles,
      folders: Array.isArray(parsed.folders) ? parsed.folders.slice(0, 12) : parsed.folders,
      extensions: Array.isArray(parsed.extensions)
        ? parsed.extensions.slice(0, 12)
        : parsed.extensions,
    };

  if (tool === "list_files") return sliceArrayField(parsed, "files", 80);

  if (tool === "find_files") return sliceArrayField(parsed, "files", 60);

  if (tool === "search_repo")
    return sliceArrayField(sliceArrayField(parsed, "snippets", 12), "suggestedReads", 12);

  if (tool === "web_search")
    return {
      ...parsed,
      results: Array.isArray(parsed.results)
        ? parsed.results.slice(0, 6).map((result) => {
            if (!result || typeof result !== "object") return result;
            const record = result as Record<string, unknown>;
            return {
              ...record,
              text: typeof record.text === "string" ? record.text.slice(0, 800) : record.text,
            };
          })
        : parsed.results,
    };

  if (tool === "web_fetch")
    return {
      ...parsed,
      pages: Array.isArray(parsed.pages)
        ? parsed.pages.slice(0, 3).map((page) => {
            if (!page || typeof page !== "object") return page;
            const record = page as Record<string, unknown>;
            return {
              ...record,
              text: typeof record.text === "string" ? record.text.slice(0, 1200) : record.text,
            };
          })
        : parsed.pages,
      failures: Array.isArray(parsed.failures) ? parsed.failures.slice(0, 5) : parsed.failures,
    };

  return parsed;
}

function formatToolActivityDetail(tool: string, result: { ok: boolean; content: string }): string {
  const parsed = parseToolJson(result.content);
  if (!parsed) return result.content.slice(0, 500);

  const parts = [`${result.ok ? "ok" : "failed"} ${tool}`];
  if (typeof parsed.path === "string") parts.push(parsed.path);
  if (typeof parsed.projectName === "string") parts.push(parsed.projectName);
  if (typeof parsed.totalFiles === "number") parts.push(`${parsed.totalFiles} files`);
  if (Array.isArray(parsed.lineRange) && parsed.lineRange.length === 2) {
    parts.push(`lines ${String(parsed.lineRange[0])}-${String(parsed.lineRange[1])}`);
  }
  const fileCount = countArrayField(parsed.files);
  if (fileCount !== undefined) parts.push(`${fileCount} files`);
  const snippetCount = countArrayField(parsed.snippets);
  if (snippetCount !== undefined) parts.push(`${snippetCount} matches`);
  const resultCount = countArrayField(parsed.results);
  if (resultCount !== undefined) parts.push(`${resultCount} results`);
  const pageCount = countArrayField(parsed.pages);
  if (pageCount !== undefined) parts.push(`${pageCount} pages`);
  const failureCount = countArrayField(parsed.failures);
  if (failureCount !== undefined && failureCount > 0) parts.push(`${failureCount} failures`);
  if (typeof parsed.query === "string") parts.push(parsed.query);
  const keyFileCount = countArrayField(parsed.keyFiles);
  if (keyFileCount !== undefined) parts.push(`${keyFileCount} key files`);
  const outlineCount = countArrayField(parsed.outlines);
  if (outlineCount !== undefined) parts.push(`${outlineCount} candidates`);
  if (parsed.fileMatches && typeof parsed.fileMatches === "object") {
    const totalMatches = (parsed.fileMatches as Record<string, unknown>).totalMatches;
    if (typeof totalMatches === "number") parts.push(`${totalMatches} file matches`);
  }
  if (parsed.lexicalMatches && typeof parsed.lexicalMatches === "object") {
    const totalMatches = (parsed.lexicalMatches as Record<string, unknown>).totalMatches;
    if (typeof totalMatches === "number") parts.push(`${totalMatches} lexical matches`);
  }
  if (typeof parsed.candidates === "number") parts.push(`${parsed.candidates} candidates`);
  if (typeof parsed.lexicalMatches === "number") parts.push(`${parsed.lexicalMatches} lexical`);
  if (typeof parsed.exitCode === "number") parts.push(`exit ${parsed.exitCode}`);
  if (typeof parsed.artifactId === "string") parts.push(`artifact ${parsed.artifactId}`);
  if (parsed.truncated === true) parts.push("truncated");
  return parts.join(" | ").slice(0, 500);
}

function itemTypeForTool(tool: string) {
  return tool === "run_command"
    ? "command_execution"
    : tool === "web_search" || tool === "web_fetch"
      ? "web_search"
      : tool.includes("mcp")
        ? "mcp_tool_call"
        : ["write_file", "edit_file", "delete_file", "apply_patch"].includes(tool)
          ? "file_change"
          : "dynamic_tool_call";
}

const CONCURRENT_SAFE_TOOLS = new Set([
  "read_file",
  "todo_read",
  "code_navigation",
  "project_map",
  "file_outline",
  "search_repo",
  "find_files",
  "semantic_search",
  "web_search",
  "web_fetch",
  "list_files",
  "project_context",
  "git_status",
  "git_diff",
  "working_tree_summary",
  "subagent_status",
  "list_checkpoints",
  "retrieve_artifact",
  "search_artifacts",
  "summarize_artifact",
  "mcp_list_servers",
  "mcp_list_tools",
  "skill_list",
]);

function canRunToolCallsConcurrently(calls: ReadonlyArray<CustomAgentModelToolCall>): boolean {
  return calls.length > 1 && calls.every((call) => CONCURRENT_SAFE_TOOLS.has(call.tool));
}

function formatToolResultForModel(input: {
  readonly tool: string;
  readonly ok: boolean;
  readonly content: string;
}): string {
  const parsed = parseToolJson(input.content);
  const result = parsed
    ? compactToolJsonForModel(input.tool, parsed)
    : input.content.slice(0, 1600);
  return `Tool result. Continue immediately: if this is enough, emit {"type":"final","content":"..."} now.\n${JSON.stringify(
    {
      tool: input.tool,
      ok: input.ok,
      result,
    },
  )}`;
}

function isProjectOverviewRequest(input: string): boolean {
  const normalized = input.toLowerCase();
  return (
    /\b(cek|check|analisis|analyze|baca|read|jelaskan|explain)\b/.test(normalized) &&
    /\b(project|proyek|repo|repository|workspace)\b/.test(normalized) &&
    /\b(apa|about|tentang|struktur|structure|overview)\b/.test(normalized)
  );
}

function isPassiveUnverifiedProjectAnswer(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    /belum.*(baca|membaca|cek|melihat|inspect)/.test(normalized) ||
    /jika.*(mau|ingin).*(cek|lihat|baca)/.test(normalized) ||
    /saya bisa.*(cek|lihat|baca)/.test(normalized) ||
    /i can.*(check|inspect|read)/.test(normalized)
  );
}

function isLikelyRawStructuredFileDump(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  const keys = new Set(Object.keys(record));
  const packageManifestKeys = [
    "name",
    "version",
    "scripts",
    "dependencies",
    "devDependencies",
    "type",
    "main",
  ];
  const packageManifestScore = packageManifestKeys.filter((key) => keys.has(key)).length;
  return packageManifestScore >= 4;
}

function chunkAssistantText(content: string): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const remaining = content.length - cursor;
    const target = remaining > 320 ? 180 : remaining;
    const slice = content.slice(cursor, cursor + target);
    const softBreak = Math.max(
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(". "),
      slice.lastIndexOf(", "),
      slice.lastIndexOf(" "),
    );
    const size = softBreak > 80 && remaining > target ? softBreak + 1 : Math.min(target, remaining);
    chunks.push(content.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
}

function extractListedFiles(content: string): string[] {
  const parsed = parseToolJson(content);
  if (Array.isArray(parsed?.results)) {
    return parsed.results.flatMap((result) => {
      if (
        typeof result === "object" &&
        result !== null &&
        "content" in result &&
        typeof result.content === "string"
      )
        return extractListedFiles(result.content);
      return [];
    });
  }
  return Array.isArray(parsed?.files)
    ? parsed.files.filter((file): file is string => typeof file === "string")
    : [];
}

function selectProjectOverviewFiles(files: ReadonlyArray<string>): string[] {
  const priority = [
    "README.md",
    "readme.md",
    "package.json",
    "pnpm-workspace.yaml",
    "turbo.json",
    "AGENTS.md",
  ];
  const selected = priority.filter((candidate) => files.includes(candidate));
  return selected.slice(0, 4);
}

interface PendingApproval {
  readonly request: CustomAgentApprovalRequest;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
}

type CustomAgentSubagentStatus = "running" | "completed" | "failed" | "cancelled";
type CustomAgentTodoStatus = "pending" | "in_progress" | "completed" | "blocked";

interface CustomAgentTodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: CustomAgentTodoStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CustomAgentSubagentTask {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly wait: boolean;
  readonly turnId: TurnId;
  readonly itemId: string;
  readonly createdAt: string;
  readonly abort: AbortController;
  status: CustomAgentSubagentStatus;
  completedAt?: string | undefined;
  result?: string | undefined;
  error?: string | undefined;
  promise?: Promise<CustomAgentSubagentTask> | undefined;
}

interface CustomAgentSessionState {
  session: ProviderSession;
  readonly messages: CustomAgentChatMessage[];
  readonly compactedHistorySummaries: string[];
  activeTurnId?: TurnId | undefined;
  activeAbort?: AbortController | undefined;
  activeAssistantItemId?: string | undefined;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly pendingUserInputRequests: Map<string, unknown>;
  readonly activeToolCalls: Map<string, unknown>;
  readonly subagents: Map<string, CustomAgentSubagentTask>;
  readonly todos: Map<string, CustomAgentTodoItem>;
  readonly settledTurnIds: Set<TurnId>;
  readonly toolArtifacts: string[];
  readonly contextReferences: string[];
  readonly currentDiffs: string[];
  readonly touchedFiles: Set<string>;
  readonly commandHistory: string[];
  readonly testCheckResults: string[];
  readonly userDecisions: string[];
  readonly taskConstraints: string[];
  tokenUsageEstimate: number;
  lastCompactionMessageCount: number;
  projectContextInjected: boolean;
  subagentNameCursor: number;
  todoTaskId?: RuntimeTaskId | undefined;
  readonly turns: Array<{ id: TurnId; items: unknown[] }>;
}

export interface CustomAgentRuntime {
  readonly settings: CustomAgentSettings;
  readonly workspaceRoot: string;
  readonly contextStore: CustomAgentContextStore;
  readonly tools: CustomAgentToolRegistry;
  readonly events: Queue.Queue<ProviderRuntimeEvent>;
  readonly startSession: (input: ProviderSessionStartInput) => Promise<ProviderSession>;
  readonly sendTurn: (input: ProviderSendTurnInput) => Promise<ProviderTurnStartResult>;
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Promise<void>;
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: string,
    answers: Record<string, unknown>,
  ) => Promise<void>;
  readonly stopSession: (threadId: ThreadId) => Promise<void>;
  readonly listSessions: () => ReadonlyArray<ProviderSession>;
  readonly hasSession: (threadId: ThreadId) => boolean;
  readonly readThread: (threadId: ThreadId) => {
    threadId: ThreadId;
    turns: ReadonlyArray<{ id: TurnId; items: ReadonlyArray<unknown> }>;
  };
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => { threadId: ThreadId; turns: ReadonlyArray<{ id: TurnId; items: ReadonlyArray<unknown> }> };
  readonly stopAll: () => Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function eventBase(input: {
  instanceId: ProviderInstanceId;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
}) {
  return {
    eventId: EventId.make(randomUUID()),
    provider: PROVIDER,
    providerInstanceId: input.instanceId,
    threadId: input.threadId,
    createdAt: nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
  };
}

function estimateMessages(messages: ReadonlyArray<CustomAgentChatMessage>): number {
  return Math.ceil(messages.map((message) => message.content).join("\n").length / 4);
}

function extractPromptTokensFromUsage(
  usage: Record<string, unknown> | undefined,
): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const promptTokens = usage.prompt_tokens;
  return typeof promptTokens === "number" && promptTokens > 0 ? promptTokens : undefined;
}

async function contextBudget(
  settings: CustomAgentSettings,
  backend: CustomAgentLlmBackend,
  model: string,
): Promise<number> {
  // Priority 1: Use maxInputTokens if explicitly set
  if (settings.maxInputTokens && settings.maxInputTokens > 0) {
    return Math.max(8000, settings.maxInputTokens);
  }

  // Priority 2: Check per-model context windows map
  if (settings.modelContextWindows && settings.modelContextWindows[model]) {
    const modelContext = settings.modelContextWindows[model];
    if (modelContext > 0) {
      console.log(`[ContextBudget] Using per-model context for ${model}: ${modelContext}`);
      const reservedBuffer = 2000;
      const maxOutput = settings.maxOutputTokens || 4000;
      const calculatedInput = modelContext - maxOutput - reservedBuffer;
      return Math.max(8000, calculatedInput);
    }
  }

  // Priority 3: Try to get actual context window from API
  let maxContext = settings.maxContextTokens;
  let contextSource = "unknown";
  if (backend.getModelContextWindow) {
    try {
      const apiContextWindow = await backend.getModelContextWindow(model);
      if (apiContextWindow && apiContextWindow > 0) {
        maxContext = apiContextWindow;
        contextSource = "endpoint";
      }
    } catch {
      // Silently fail, will use settings
    }
  }

  // Get source for logging
  if (backend.getContextWindowSource) {
    try {
      contextSource = await backend.getContextWindowSource(model);
    } catch {
      contextSource = "error";
    }
  }

  // Priority 4: Use settings.maxContextTokens if available
  if (!maxContext || maxContext <= 0) {
    // If no context window info available at all, use a safe fallback
    console.warn(
      `[ContextBudget] No context window detected for model ${model} (source: ${contextSource}). Using safe fallback of 250k tokens. Set maxContextTokens manually in settings for accuracy.`,
    );
    maxContext = 250000; // 250k tokens - safe fallback
  }

  // Calculate input budget from context window
  const reservedBuffer = 2000; // Safety buffer for system prompts, tool schemas, etc.
  const maxOutput = settings.maxOutputTokens || 4000;
  const calculatedInput = maxContext - maxOutput - reservedBuffer;

  const finalBudget = Math.max(8000, calculatedInput);

  console.log(
    `[ContextBudget] Model: ${model}, MaxContext: ${maxContext}, Source: ${contextSource}, FinalInputBudget: ${finalBudget}`,
  );

  return finalBudget;
}

function compactPercent(tokens: number, budget: number): number {
  return Math.min(999, Math.round((tokens / budget) * 100));
}

function trimForCompactionSource(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headChars = Math.floor(maxChars * 0.24);
  const tailChars = Math.floor(maxChars * 0.72);
  return `${content.slice(0, headChars)}\n\n[...middle omitted for context compaction...]\n\n${content.slice(
    -tailChars,
  )}`;
}

function asCompactList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, 12);
}

function appendCompactSection(parts: string[], title: string, values: ReadonlyArray<string>): void {
  if (values.length === 0) return;
  parts.push(`${title}:\n${values.map((value) => `- ${value}`).join("\n")}`);
}

function normalizeCompactionOutput(content: string): string {
  const parsed = parseToolJson(content);
  if (!parsed) return content.trim().slice(0, 12000);

  const parts: string[] = [];
  if (typeof parsed.summary === "string" && parsed.summary.trim().length > 0)
    parts.push(`Summary:\n${parsed.summary.trim()}`);
  if (typeof parsed.currentObjective === "string" && parsed.currentObjective.trim().length > 0)
    parts.push(`Current objective:\n${parsed.currentObjective.trim()}`);
  appendCompactSection(parts, "Completed", asCompactList(parsed.completed));
  appendCompactSection(parts, "Pending / unfinished", asCompactList(parsed.pending));
  if (typeof parsed.nextStep === "string" && parsed.nextStep.trim().length > 0)
    parts.push(`Next step:\n${parsed.nextStep.trim()}`);
  appendCompactSection(parts, "Evidence / inspected facts", asCompactList(parsed.evidence));
  appendCompactSection(parts, "Files / paths", asCompactList(parsed.files));
  appendCompactSection(parts, "Tools / commands", asCompactList(parsed.tools));
  appendCompactSection(parts, "Constraints / decisions", asCompactList(parsed.constraints));
  appendCompactSection(parts, "Risks / verification gaps", asCompactList(parsed.risks));
  return (parts.length > 0 ? parts.join("\n\n") : JSON.stringify(parsed)).slice(0, 12000);
}

function buildCompactionSource(input: {
  readonly state: CustomAgentSessionState;
  readonly currentUserRequest: string;
  readonly workingContext: string;
  readonly olderMessages: ReadonlyArray<CustomAgentChatMessage>;
  readonly recentMessages: ReadonlyArray<CustomAgentChatMessage>;
  readonly maxChars: number;
}): string {
  const transcript = input.olderMessages
    .map((message, index) => {
      const content = trimForCompactionSource(message.content, 2600);
      return `<message index="${index}" role="${message.role}">\n${content}\n</message>`;
    })
    .join("\n\n");
  const recent = input.recentMessages
    .map((message, index) => {
      const content = trimForCompactionSource(message.content, 1800);
      return `<recent index="${index}" role="${message.role}">\n${content}\n</recent>`;
    })
    .join("\n\n");
  const source = [
    `Current user request:\n${input.currentUserRequest}`,
    input.state.compactedHistorySummaries.length > 0
      ? `Previous compact summaries:\n${input.state.compactedHistorySummaries.join("\n\n---\n\n")}`
      : "",
    `Older conversation and tool context to compact:\n${transcript}`,
    `Recent messages to preserve verbatim after compaction:\n${recent}`,
    `Current working context:\n${trimForCompactionSource(input.workingContext, 6000)}`,
    input.state.toolArtifacts.length > 0
      ? `Stored artifacts:\n${input.state.toolArtifacts.slice(-20).join("\n")}`
      : "",
    input.state.currentDiffs.length > 0
      ? `Current diffs summary:\n${input.state.currentDiffs
          .slice(-3)
          .map((diff) => trimForCompactionSource(diff, 3000))
          .join("\n\n---\n\n")}`
      : "",
    input.state.commandHistory.length > 0
      ? `Command history:\n${input.state.commandHistory.slice(-20).join("\n")}`
      : "",
    input.state.userDecisions.length > 0
      ? `User decisions:\n${input.state.userDecisions.slice(-20).join("\n")}`
      : "",
    input.state.taskConstraints.length > 0
      ? `Task constraints:\n${input.state.taskConstraints.slice(-20).join("\n")}`
      : "",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n====\n\n");
  return trimForCompactionSource(source, input.maxChars);
}

function buildCompactionPrompt(source: string): ReadonlyArray<CustomAgentChatMessage> {
  return [
    {
      role: "system",
      content:
        "You are KarsaCode's hidden context compactor. Summarize conversation and tool state so the same coding agent can continue without losing task continuity. Preserve verified facts, file paths, commands, tool results, user constraints, unfinished work, and verification gaps. Do not invent evidence. Return exactly one JSON object.",
    },
    {
      role: "user",
      content: `Compact this session context. Output JSON only with this shape:
{
  "summary": "dense but readable session summary",
  "currentObjective": "what the user currently wants",
  "completed": ["completed actions or confirmed facts"],
  "pending": ["unfinished tasks, blockers, next work"],
  "nextStep": "the single best continuation step",
  "evidence": ["important inspected evidence and where it came from"],
  "files": ["relevant files and paths"],
  "tools": ["tools or commands already run, with results when important"],
  "constraints": ["active user/project constraints"],
  "risks": ["unknowns, failures, checks not run, stale assumptions"]
}

Context to compact:
${source}`,
    },
  ];
}

function buildCompactResumeMessage(input: {
  readonly summary: string;
  readonly currentUserRequest: string;
  readonly tokenEstimate: number;
  readonly budget: number;
}): CustomAgentChatMessage {
  return {
    role: "system",
    content: `Context compacted automatically by KarsaCode before the next model call.

Why:
- Estimated context was ${compactPercent(input.tokenEstimate, input.budget)}% of the configured budget (${input.tokenEstimate}/${input.budget} tokens).
- Older chat/tool history was replaced by the compact state below.

How to continue:
- Treat this compact state as authoritative session memory.
- Continue the current task; do not ask the user to restart or re-send context.
- Use recent messages and fresh tool results for exact wording.
- If a fact is not in compact state, recent messages, or tool evidence, say it is unverified.
- Continue from "Pending / unfinished" and "Next step" when present.

Current user request:
${input.currentUserRequest}

Compact state:
${input.summary}`,
  };
}

function truncateIncompleteJsonStringEscape(raw: string): string {
  let trailingBackslashes = 0;
  for (let index = raw.length - 1; index >= 0 && raw[index] === "\\"; index--) {
    trailingBackslashes += 1;
  }
  if (trailingBackslashes % 2 === 1) {
    raw = raw.slice(0, -1);
  }

  const incompleteUnicodeEscape = raw.match(/\\u[0-9a-fA-F]{0,3}$/u);
  return incompleteUnicodeEscape ? raw.slice(0, incompleteUnicodeEscape.index) : raw;
}

function decodeJsonStringPrefix(raw: string): string {
  let candidate = truncateIncompleteJsonStringEscape(raw);
  while (candidate.length > 0) {
    try {
      return JSON.parse(`"${candidate}"`) as string;
    } catch {
      candidate = candidate.slice(0, -1);
    }
  }
  return "";
}

function extractStreamingContentPrefix(raw: string): string | undefined {
  const contentMatch = /"content"\s*:\s*"/u.exec(raw);
  if (!contentMatch) return undefined;

  const start = contentMatch.index + contentMatch[0].length;
  let escaped = false;
  for (let index = start; index < raw.length; index++) {
    const char = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return decodeJsonStringPrefix(raw.slice(start, index));
    }
  }

  return decodeJsonStringPrefix(raw.slice(start));
}

async function completeCustomAgentModel(
  backend: CustomAgentLlmBackend,
  input: {
    readonly messages: ReadonlyArray<CustomAgentChatMessage>;
    readonly model: string;
    readonly maxOutputTokens?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  },
  onFinalContentDelta?: ((delta: string) => Promise<void>) | undefined,
): Promise<{ content: string; usage?: Record<string, unknown> }> {
  let streamed = "";
  let emittedFinalContent = "";
  let pendingDeltaEmission: Promise<void> = Promise.resolve();
  let pendingDeltaEmissionError: unknown;
  let streamUsage: Record<string, unknown> | undefined;

  const enqueueFinalContentDelta = (delta: string): void => {
    if (!onFinalContentDelta || delta.length === 0) return;
    pendingDeltaEmission = pendingDeltaEmission
      .then(() => onFinalContentDelta(delta))
      .catch((error: unknown) => {
        pendingDeltaEmissionError ??= error;
      });
  };

  const drainFinalContentDeltas = async (): Promise<void> => {
    await pendingDeltaEmission;
    if (pendingDeltaEmissionError) throw pendingDeltaEmissionError;
  };

  let streamFailed = false;
  try {
    throwIfSignalAborted(input.signal);
    for await (const chunk of backend.stream({
      ...input,
      stream: true,
      maxOutputTokens: input.maxOutputTokens,
    })) {
      throwIfSignalAborted(input.signal);
      streamed += chunk;
      const finalContentPrefix = extractStreamingContentPrefix(streamed);
      if (
        onFinalContentDelta &&
        finalContentPrefix !== undefined &&
        finalContentPrefix.length > emittedFinalContent.length
      ) {
        const delta = finalContentPrefix.slice(emittedFinalContent.length);
        emittedFinalContent = finalContentPrefix;
        enqueueFinalContentDelta(delta);
      }
    }
    // Get usage from streaming backend if available
    if (backend.getLastUsage) {
      streamUsage = backend.getLastUsage();
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    streamFailed = true;
    streamed = "";
  }
  throwIfSignalAborted(input.signal);
  await drainFinalContentDeltas();
  if (!streamFailed && streamed.trim().length > 0) {
    return {
      content: streamed,
      ...(streamUsage !== undefined ? { usage: streamUsage } : {}),
    };
  }
  const completeResult = await backend.complete({
    ...input,
    stream: false,
    maxOutputTokens: input.maxOutputTokens,
  });
  return {
    content: completeResult.content,
    ...(completeResult.usage !== undefined ? { usage: completeResult.usage } : {}),
  };
}

export async function makeCustomAgentRuntime(input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CustomAgentSettings;
  readonly workspaceRoot: string;
  readonly backend: CustomAgentLlmBackend;
  readonly events: Queue.Queue<ProviderRuntimeEvent>;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}): Promise<CustomAgentRuntime> {
  const events = input.events;
  const sessions = new Map<ThreadId, CustomAgentSessionState>();
  const contextStore = makeCustomAgentContextStore();
  const defaultTools = makeCustomAgentToolRegistry({
    settings: input.settings,
    workspaceRoot: input.workspaceRoot,
    contextStore,
    environment: input.environment,
  });
  const toolRegistries = new Map<string, CustomAgentToolRegistry>([
    [path.resolve(input.workspaceRoot), defaultTools],
  ]);
  const toolsForWorkspace = (workspaceRoot: string): CustomAgentToolRegistry => {
    const resolved = path.resolve(workspaceRoot || input.workspaceRoot);
    const existing = toolRegistries.get(resolved);
    if (existing) return existing;
    const registry = makeCustomAgentToolRegistry({
      settings: input.settings,
      workspaceRoot: resolved,
      contextStore,
      checkpointStore: defaultTools.checkpointStore,
      environment: input.environment,
    });
    toolRegistries.set(resolved, registry);
    return registry;
  };
  const workspaceRootForSession = (state: CustomAgentSessionState): string =>
    path.resolve(state.session.cwd || input.workspaceRoot);
  const systemPrompt = await loadCustomAgentSystemPrompt(input.settings, input.workspaceRoot).catch(
    () =>
      loadCustomAgentSystemPrompt({ ...input.settings, systemPromptPath: "" }, input.workspaceRoot),
  );
  const runtimePrompt = buildCustomAgentRuntimePrompt({
    systemPrompt,
    toolNames: defaultTools.names,
    mcpEnabled: input.settings.mcpEnabled,
    checkpointEnabled: input.settings.checkpointEnabled,
    semanticSearchEnabled: input.settings.semanticSearchEnabled,
  });

  async function emit(event: ProviderRuntimeEvent): Promise<void> {
    await Effect.runPromise(Queue.offer(events, event));
  }

  async function emitRuntimeError(
    threadId: ThreadId,
    turnId: TurnId | undefined,
    message: string,
  ): Promise<void> {
    await emit({
      type: "runtime.error",
      ...eventBase({ instanceId: input.instanceId, threadId, ...(turnId ? { turnId } : {}) }),
      payload: { class: "provider_error", message },
    } as ProviderRuntimeEvent);
  }

  async function completeModelWithRetry(inputState: {
    readonly state: CustomAgentSessionState;
    readonly turnId: TurnId;
    readonly messages: ReadonlyArray<CustomAgentChatMessage>;
    readonly model: string;
    readonly maxOutputTokens?: number | undefined;
    readonly onFinalContentDelta?: ((delta: string) => Promise<void>) | undefined;
  }): Promise<Awaited<ReturnType<typeof completeCustomAgentModel>>> {
    const attempts = 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      assertTurnOpen(inputState.state, inputState.turnId);
      try {
        return await completeCustomAgentModel(
          input.backend,
          {
            messages: inputState.messages,
            model: inputState.model,
            maxOutputTokens: inputState.maxOutputTokens,
            signal: inputState.state.activeAbort?.signal,
          },
          inputState.onFinalContentDelta,
        );
      } catch (error) {
        lastError = error;
        if (
          inputState.state.activeAbort?.signal.aborted ||
          isTurnSettled(inputState.state, inputState.turnId) ||
          attempt >= attempts ||
          !isRetryableRuntimeError(error)
        ) {
          throw error;
        }
        const message = formatCustomAgentRuntimeError(error);
        await emit({
          type: "runtime.warning",
          ...eventBase({
            instanceId: input.instanceId,
            threadId: inputState.state.session.threadId,
            turnId: inputState.turnId,
          }),
          payload: {
            message: `${message}; retrying model response (${attempt}/${attempts - 1})`,
            detail: { attempt, attempts },
          },
        } as ProviderRuntimeEvent);
        await sleep(450 * attempt, inputState.state.activeAbort?.signal);
      }
    }
    throw lastError;
  }

  function getSession(threadId: ThreadId): CustomAgentSessionState {
    const session = sessions.get(threadId);
    if (!session) throw new Error(`Unknown CustomAgent thread: ${threadId}`);
    return session;
  }

  function isTurnSettled(state: CustomAgentSessionState, turnId: TurnId): boolean {
    return state.settledTurnIds.has(turnId);
  }

  function assertTurnOpen(state: CustomAgentSessionState, turnId: TurnId): void {
    if (isTurnSettled(state, turnId) || state.activeAbort?.signal.aborted) {
      throw new Error("Turn interrupted.");
    }
  }

  function isSubagentTool(tool: string): boolean {
    return tool === "subagent_spawn" || tool === "subagent_status" || tool === "subagent_wait";
  }

  function isTodoTool(tool: string): boolean {
    return tool === "todo_write" || tool === "todo_read";
  }

  function todoItemsForUi(state: CustomAgentSessionState): ReadonlyArray<Record<string, string>> {
    return [...state.todos.values()].map((item) => ({
      id: item.id,
      content: item.content,
      status: item.status,
      updatedAt: item.updatedAt,
    }));
  }

  function todoCounts(state: CustomAgentSessionState): Record<CustomAgentTodoStatus, number> {
    const counts: Record<CustomAgentTodoStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      blocked: 0,
    };
    for (const item of state.todos.values()) counts[item.status] += 1;
    return counts;
  }

  function todoSummaryLine(state: CustomAgentSessionState): string {
    const counts = todoCounts(state);
    const total = state.todos.size;
    const active = [...state.todos.values()].find((item) => item.status === "in_progress");
    const suffix = active ? ` - ${active.content}` : "";
    return `Todo ${counts.completed}/${total} done${counts.blocked ? `, ${counts.blocked} blocked` : ""}${suffix}`;
  }

  function openTodoItems(state: CustomAgentSessionState): ReadonlyArray<CustomAgentTodoItem> {
    return [...state.todos.values()].filter((item) => item.status !== "completed");
  }

  function shouldRequireTodoForUserInput(userInput: string): boolean {
    const normalized = userInput.toLowerCase();
    if (normalized.length >= TODO_REQUIRED_MIN_CHARS) return true;
    if (normalized.includes("\n")) return true;
    return TODO_REQUIRED_KEYWORDS.some((keyword) => normalized.includes(keyword));
  }

  function buildTodoRuntimeHint(
    state: CustomAgentSessionState,
    userInput: string,
  ): string | undefined {
    const openItems = openTodoItems(state);
    const requiresTodo = shouldRequireTodoForUserInput(userInput);
    if (!requiresTodo && openItems.length === 0) return undefined;

    const lines = [
      "Todo discipline:",
      "- Use todo_write for any multi-step, code-editing, debugging, audit, project-analysis, or medium+ task.",
      "- Keep exactly one main item in_progress unless independent subagents are running.",
      "- Before a final answer, todo statuses must reflect reality: completed, blocked, or still pending with a reason.",
      "- If a tool result changes the next step, update todo_write before continuing.",
    ];
    if (state.todos.size === 0) {
      lines.push(
        "- This request appears to need visible planning and no todo exists yet; create a compact 2-7 item todo_write before other non-automatic work unless the task is truly one-shot.",
      );
    } else {
      lines.push(`- Current ${todoSummaryLine(state)}.`);
      for (const item of openItems.slice(0, 5)) {
        lines.push(`  - ${item.status}: ${item.content}`);
      }
    }
    return lines.join("\n");
  }

  async function emitTodoList(
    state: CustomAgentSessionState,
    turnId: TurnId,
    reason: string,
  ): Promise<void> {
    if (!state.todoTaskId) state.todoTaskId = RuntimeTaskId.make(`todo_${randomUUID()}`);
    await emit({
      type: "task.progress",
      ...eventBase({
        instanceId: input.instanceId,
        threadId: state.session.threadId,
        turnId,
      }),
      payload: {
        taskId: state.todoTaskId,
        description: todoSummaryLine(state),
        summary: "Todo plan",
        metadata: {
          kind: "todo_list",
          reason,
          counts: todoCounts(state),
          items: todoItemsForUi(state),
        },
      },
    } as ProviderRuntimeEvent);
  }

  function normalizeTodoStatus(value: unknown): CustomAgentTodoStatus {
    return value === "in_progress" ||
      value === "completed" ||
      value === "blocked" ||
      value === "pending"
      ? value
      : "pending";
  }

  function normalizeTodoId(value: unknown, content: string): string {
    if (typeof value === "string" && value.trim().length > 0) {
      return value
        .trim()
        .slice(0, 80)
        .replace(/[^\w.-]+/g, "_");
    }
    return `todo_${content
      .toLowerCase()
      .replace(/[^\w]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48)}_${randomUUID().slice(0, 8)}`;
  }

  function normalizeTodoItems(
    state: CustomAgentSessionState,
    itemsRaw: unknown,
  ): ReadonlyArray<CustomAgentTodoItem> {
    if (!Array.isArray(itemsRaw)) throw new Error("todo_write requires an items array.");
    const now = nowIso();
    return itemsRaw.slice(0, MAX_TODO_ITEMS).flatMap((itemRaw) => {
      if (!itemRaw || typeof itemRaw !== "object") return [];
      const item = itemRaw as Record<string, unknown>;
      const content =
        typeof item.content === "string"
          ? item.content.trim()
          : typeof item.task === "string"
            ? item.task.trim()
            : "";
      if (!content) return [];
      const id = normalizeTodoId(item.id, content);
      const previous = state.todos.get(id);
      return [
        {
          id,
          content: content.slice(0, MAX_TODO_TEXT_LENGTH),
          status: normalizeTodoStatus(item.status),
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        },
      ];
    });
  }

  async function executeTodoRuntimeTool(inputTool: {
    readonly state: CustomAgentSessionState;
    readonly turnId: TurnId;
    readonly tool: string;
    readonly args: Record<string, unknown>;
  }): Promise<CustomAgentToolResult> {
    if (inputTool.tool === "todo_read") {
      return {
        ok: true,
        content: JSON.stringify({
          summary: todoSummaryLine(inputTool.state),
          items: todoItemsForUi(inputTool.state),
        }),
      };
    }

    if (inputTool.tool !== "todo_write") {
      return { ok: false, content: `Unknown todo tool: ${inputTool.tool}` };
    }

    const items = normalizeTodoItems(inputTool.state, inputTool.args.items);
    if (items.length === 0) {
      return { ok: false, content: "todo_write requires 1-12 non-empty items." };
    }
    inputTool.state.todos.clear();
    for (const item of items) inputTool.state.todos.set(item.id, item);
    await emitTodoList(
      inputTool.state,
      inputTool.turnId,
      typeof inputTool.args.reason === "string" ? inputTool.args.reason.slice(0, 160) : "updated",
    );
    return {
      ok: true,
      content: JSON.stringify({
        summary: todoSummaryLine(inputTool.state),
        items: todoItemsForUi(inputTool.state),
      }),
    };
  }

  function compactSubagentText(content: string): string {
    const normalized = content.replace(/\s+\n/g, "\n").trim();
    return normalized.length > 6000 ? `${normalized.slice(0, 6000)}\n...[truncated]` : normalized;
  }

  function subagentStatus(task: CustomAgentSubagentTask): Record<string, unknown> {
    return {
      id: task.id,
      name: task.name,
      task: task.task.slice(0, 220),
      wait: task.wait,
      status: task.status,
      createdAt: task.createdAt,
      ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      ...(task.result ? { result: task.result.slice(0, 1800) } : {}),
      ...(task.error ? { error: task.error } : {}),
    };
  }

  function chooseSubagentName(
    state: CustomAgentSessionState,
    requestedName: string | undefined,
  ): string {
    const activeNames = new Set(
      [...state.subagents.values()]
        .filter((task) => task.status === "running")
        .map((task) => task.name),
    );
    if (
      requestedName &&
      SUBAGENT_NAMES.includes(requestedName as (typeof SUBAGENT_NAMES)[number]) &&
      !activeNames.has(requestedName)
    )
      return requestedName;
    for (let index = 0; index < SUBAGENT_NAMES.length; index++) {
      const name = SUBAGENT_NAMES[state.subagentNameCursor % SUBAGENT_NAMES.length] ?? "Aether";
      state.subagentNameCursor += 1;
      if (!activeNames.has(name)) return name;
    }
    const fallback = SUBAGENT_NAMES[state.subagentNameCursor % SUBAGENT_NAMES.length] ?? "Aether";
    state.subagentNameCursor += 1;
    return `${fallback}-${state.subagentNameCursor}`;
  }

  function parseSubagentSpecs(args: Record<string, unknown>): ReadonlyArray<{
    readonly task: string;
    readonly wait: boolean;
    readonly name?: string | undefined;
  }> {
    const rawAgents = Array.isArray(args.agents) ? args.agents : undefined;
    const records = rawAgents ?? (typeof args.task === "string" ? [{ task: args.task }] : []);
    const specs: Array<{ task: string; wait: boolean; name?: string | undefined }> = [];
    const seen = new Set<string>();
    for (const raw of records.slice(0, MAX_SUBAGENTS_PER_CALL)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const task = typeof record.task === "string" ? record.task.trim() : "";
      if (!task) continue;
      const key = task.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      const wait = typeof record.wait === "boolean" ? record.wait : true;
      const name = typeof record.name === "string" ? record.name.trim() : undefined;
      specs.push({ task, wait, ...(name ? { name } : {}) });
    }
    return specs;
  }

  function buildSubagentMessages(inputState: {
    readonly state: CustomAgentSessionState;
    readonly subagent: CustomAgentSubagentTask;
    readonly userInput: string;
    readonly workingContext: string;
  }): CustomAgentChatMessage[] {
    const recent = inputState.state.messages
      .slice(-SUBAGENT_RECENT_MESSAGES)
      .map((message) => `${message.role}: ${message.content.slice(0, 1200)}`)
      .join("\n\n");
    return [
      {
        role: "system",
        content: [
          `You are ${inputState.subagent.name}, a focused subagent inside KarsaCode.`,
          "Work independently on only the assigned task.",
          "Do not modify files. Do not ask for tools. Do not claim evidence you do not have.",
          'Return exactly one JSON object: {"type":"final","content":"concise result with evidence, uncertainty, and useful next action"}.',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Workspace: ${workspaceRootForSession(inputState.state)}`,
          `Main user request:\n${inputState.userInput.slice(0, 3000)}`,
          `Assigned subagent task:\n${inputState.subagent.task}`,
          inputState.workingContext
            ? `Working context:\n${inputState.workingContext.slice(0, 9000)}`
            : "",
          recent ? `Recent thread context:\n${recent}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];
  }

  function extractSubagentFinalContent(raw: string): string {
    const parsed = parseCustomAgentModelCommand(raw);
    if (parsed.ok && parsed.command.type === "final") return parsed.command.content;
    return raw;
  }

  async function runSubagentTask(inputState: {
    readonly state: CustomAgentSessionState;
    readonly subagent: CustomAgentSubagentTask;
    readonly userInput: string;
    readonly workingContext: string;
  }): Promise<CustomAgentSubagentTask> {
    const { state, subagent } = inputState;
    try {
      const output = await completeCustomAgentModel(input.backend, {
        messages: buildSubagentMessages(inputState),
        model: state.session.model ?? input.settings.model,
        maxOutputTokens: Math.min(
          input.settings.maxOutputTokens ?? SUBAGENT_MAX_OUTPUT_TOKENS,
          SUBAGENT_MAX_OUTPUT_TOKENS,
        ),
        signal: subagent.abort.signal,
      });
      const result = compactSubagentText(extractSubagentFinalContent(output.content));
      subagent.status = "completed";
      subagent.result = result;
      subagent.completedAt = nowIso();
      state.messages.push({
        role: "user",
        content: `Subagent ${subagent.name} completed.\nTask: ${subagent.task}\nResult:\n${result}`,
      });
      await emit({
        type: "item.completed",
        ...eventBase({
          instanceId: input.instanceId,
          threadId: state.session.threadId,
          turnId: subagent.turnId,
          itemId: subagent.itemId,
        }),
        payload: {
          itemType: "dynamic_tool_call",
          status: "completed",
          title: `Subagent ${subagent.name}`,
          detail: subagent.wait ? "Completed waited subagent" : "Completed background subagent",
          data: subagentStatus(subagent),
        },
      } as ProviderRuntimeEvent);
    } catch (error) {
      const aborted = subagent.abort.signal.aborted;
      subagent.status = aborted ? "cancelled" : "failed";
      subagent.error = aborted ? "Subagent cancelled." : formatCustomAgentRuntimeError(error);
      subagent.completedAt = nowIso();
      state.messages.push({
        role: "user",
        content: `Subagent ${subagent.name} ${subagent.status}.\nTask: ${subagent.task}\nError: ${subagent.error}`,
      });
      await emit({
        type: "item.completed",
        ...eventBase({
          instanceId: input.instanceId,
          threadId: state.session.threadId,
          turnId: subagent.turnId,
          itemId: subagent.itemId,
        }),
        payload: {
          itemType: "dynamic_tool_call",
          status: "failed",
          title: `Subagent ${subagent.name}`,
          detail: subagent.error,
          data: subagentStatus(subagent),
        },
      } as ProviderRuntimeEvent);
    }
    return subagent;
  }

  async function spawnSubagent(inputState: {
    readonly state: CustomAgentSessionState;
    readonly turnId: TurnId;
    readonly task: string;
    readonly wait: boolean;
    readonly userInput: string;
    readonly workingContext: string;
    readonly requestedName?: string | undefined;
  }): Promise<CustomAgentSubagentTask> {
    const id = `subagent_${randomUUID()}`;
    const itemId = `item_${id}`;
    const name = chooseSubagentName(inputState.state, inputState.requestedName);
    const subagent: CustomAgentSubagentTask = {
      id,
      name,
      task: inputState.task,
      wait: inputState.wait,
      turnId: inputState.turnId,
      itemId,
      createdAt: nowIso(),
      abort: new AbortController(),
      status: "running",
    };
    inputState.state.subagents.set(id, subagent);
    await emit({
      type: "item.started",
      ...eventBase({
        instanceId: input.instanceId,
        threadId: inputState.state.session.threadId,
        turnId: inputState.turnId,
        itemId,
      }),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: `Subagent ${name}`,
        detail: `${inputState.wait ? "wait" : "background"}: ${inputState.task.slice(0, 180)}`,
        data: { id, name, wait: inputState.wait, task: inputState.task },
      },
    } as ProviderRuntimeEvent);
    subagent.promise = runSubagentTask({
      state: inputState.state,
      subagent,
      userInput: inputState.userInput,
      workingContext: inputState.workingContext,
    });
    void subagent.promise;
    return subagent;
  }

  async function waitForSubagents(
    tasks: ReadonlyArray<CustomAgentSubagentTask>,
    timeoutMs: number,
  ): Promise<"completed" | "timeout"> {
    const running = tasks.filter((task) => task.status === "running" && task.promise);
    if (running.length === 0) return "completed";
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(
        () => resolve("timeout"),
        Math.max(1000, Math.min(timeoutMs, SUBAGENT_WAIT_TIMEOUT_MS)),
      ),
    );
    const all = Promise.all(running.map((task) => task.promise)).then(() => "completed" as const);
    return await Promise.race([all, timeout]);
  }

  async function executeSubagentRuntimeTool(inputState: {
    readonly state: CustomAgentSessionState;
    readonly turnId: TurnId;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly userInput: string;
  }): Promise<CustomAgentToolResult> {
    const { state, turnId, tool, args, userInput } = inputState;
    if (tool === "subagent_status") {
      const ids = Array.isArray(args.ids)
        ? args.ids.filter((id): id is string => typeof id === "string")
        : [];
      const tasks = [...state.subagents.values()].filter((task) =>
        ids.length > 0 ? ids.includes(task.id) : task.status === "running",
      );
      return {
        ok: true,
        content: JSON.stringify({ subagents: tasks.map(subagentStatus) }),
        data: { subagents: tasks.map(subagentStatus) },
      };
    }

    if (tool === "subagent_wait") {
      const ids = Array.isArray(args.ids)
        ? args.ids.filter((id): id is string => typeof id === "string")
        : [];
      const all = args.all === true;
      const timeoutMs =
        typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
          ? args.timeoutMs
          : SUBAGENT_WAIT_TIMEOUT_MS;
      const tasks = [...state.subagents.values()].filter((task) =>
        all || ids.length === 0 ? task.status === "running" : ids.includes(task.id),
      );
      const waitStatus = await waitForSubagents(tasks, timeoutMs);
      return {
        ok: true,
        content: JSON.stringify({ waitStatus, subagents: tasks.map(subagentStatus) }),
        data: { waitStatus, subagents: tasks.map(subagentStatus) },
      };
    }

    if (tool !== "subagent_spawn") {
      return { ok: false, content: `Unknown subagent tool: ${tool}` };
    }

    const runningCount = [...state.subagents.values()].filter(
      (task) => task.status === "running",
    ).length;
    const availableSlots = Math.max(0, MAX_ACTIVE_SUBAGENTS_PER_SESSION - runningCount);
    const specs = parseSubagentSpecs(args).slice(0, availableSlots);
    const skipped = parseSubagentSpecs(args).length - specs.length;
    const workingContext = contextStore.buildWorkingContext({
      threadId: state.session.threadId,
      currentUserRequest: state.messages.at(-1)?.content ?? "",
      maxTokens: 3500,
    });
    const spawned = await Promise.all(
      specs.map((spec) =>
        spawnSubagent({
          state,
          turnId,
          task: spec.task,
          wait: spec.wait,
          requestedName: spec.name,
          userInput,
          workingContext,
        }),
      ),
    );
    const waited = spawned.filter((task) => task.wait);
    const waitStatus = await waitForSubagents(waited, SUBAGENT_WAIT_TIMEOUT_MS);
    return {
      ok: true,
      content: JSON.stringify({
        waitStatus,
        spawned: spawned.map(subagentStatus),
        waitedResults: waited.map(subagentStatus),
        background: spawned.filter((task) => !task.wait).map(subagentStatus),
        skippedDueToLimit: skipped,
        note: "Background subagents keep running and their completion is injected into the main thread context automatically.",
      }),
      data: {
        waitStatus,
        spawned: spawned.map(subagentStatus),
        waitedResults: waited.map(subagentStatus),
        background: spawned.filter((task) => !task.wait).map(subagentStatus),
        skippedDueToLimit: skipped,
      },
    };
  }

  function clearActiveTurn(state: CustomAgentSessionState, turnId: TurnId): void {
    if (state.activeTurnId !== turnId) return;
    state.activeTurnId = undefined;
    state.activeAbort = undefined;
    state.activeAssistantItemId = undefined;
    state.activeToolCalls.clear();
  }

  async function settleTurnInterrupted(
    state: CustomAgentSessionState,
    turnId: TurnId,
    reason: string,
  ): Promise<void> {
    if (isTurnSettled(state, turnId)) return;
    state.settledTurnIds.add(turnId);
    state.activeAbort?.abort();
    for (const subagent of state.subagents.values()) {
      if (subagent.turnId === turnId && subagent.wait && subagent.status === "running") {
        subagent.abort.abort();
      }
    }
    for (const pending of state.pendingApprovals.values()) pending.resolve("cancel");
    state.pendingApprovals.clear();
    state.pendingUserInputRequests.clear();

    if (state.activeAssistantItemId) {
      await emit({
        type: "item.completed",
        ...eventBase({
          instanceId: input.instanceId,
          threadId: state.session.threadId,
          turnId,
          itemId: state.activeAssistantItemId,
        }),
        payload: { itemType: "assistant_message", status: "failed", detail: reason },
      } as ProviderRuntimeEvent);
    }
    for (const [toolCallId, toolCall] of state.activeToolCalls.entries()) {
      const tool =
        toolCall && typeof toolCall === "object" && "tool" in toolCall
          ? String((toolCall as { tool?: unknown }).tool ?? "tool")
          : "tool";
      await emit({
        type: "item.completed",
        ...eventBase({
          instanceId: input.instanceId,
          threadId: state.session.threadId,
          turnId,
          itemId: toolCallId,
        }),
        payload: {
          itemType: itemTypeForTool(tool),
          status: "failed",
          title: tool,
          detail: reason,
        },
      } as ProviderRuntimeEvent);
    }
    await emit({
      type: "turn.completed",
      ...eventBase({ instanceId: input.instanceId, threadId: state.session.threadId, turnId }),
      payload: { state: "interrupted", stopReason: reason },
    } as ProviderRuntimeEvent);
    state.session = {
      ...state.session,
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
      updatedAt: nowIso(),
    };
    clearActiveTurn(state, turnId);
    await emit({
      type: "session.state.changed",
      ...eventBase({ instanceId: input.instanceId, threadId: state.session.threadId }),
      payload: { state: "ready", reason },
    } as ProviderRuntimeEvent);
  }

  async function settleTurnFailed(
    state: CustomAgentSessionState,
    turnId: TurnId,
    message: string,
  ): Promise<void> {
    if (isTurnSettled(state, turnId)) return;
    state.settledTurnIds.add(turnId);
    await emitRuntimeError(state.session.threadId, turnId, message);
    await emit({
      type: "turn.completed",
      ...eventBase({ instanceId: input.instanceId, threadId: state.session.threadId, turnId }),
      payload: { state: "failed", errorMessage: message },
    } as ProviderRuntimeEvent);
    state.session = {
      ...state.session,
      status: "ready",
      activeTurnId: undefined,
      lastError: message,
      updatedAt: nowIso(),
    };
    clearActiveTurn(state, turnId);
    await emit({
      type: "session.state.changed",
      ...eventBase({ instanceId: input.instanceId, threadId: state.session.threadId }),
      payload: { state: "ready", reason: "turn_failed" },
    } as ProviderRuntimeEvent);
  }

  async function estimateModelInputTokens(
    messages: ReadonlyArray<CustomAgentChatMessage>,
    model: string,
  ): Promise<number> {
    if (!input.backend.countTokens) return estimateMessages(messages);
    return await input.backend
      .countTokens({ messages, model })
      .catch(() => estimateMessages(messages));
  }

  async function emitContextUsageSnapshot(inputState: {
    readonly state: CustomAgentSessionState;
    readonly turnId: TurnId;
    readonly usedTokens: number;
    readonly model: string;
  }): Promise<void> {
    const usedTokens = Math.max(1, Math.round(inputState.usedTokens));
    const model = inputState.model;
    const maxTokens = Math.max(
      1,
      Math.round(await contextBudget(input.settings, input.backend, model)),
    );

    // Get context window source for debugging
    let contextSource = "unknown";
    if (input.backend.getContextWindowSource) {
      try {
        contextSource = await input.backend.getContextWindowSource(model);
      } catch {
        contextSource = "error";
      }
    }

    console.log(
      `[ContextWindow] Model: ${model}, Used: ${usedTokens}, Max: ${maxTokens}, Source: ${contextSource}`,
    );

    inputState.state.tokenUsageEstimate = usedTokens;
    await emit({
      type: "thread.token-usage.updated",
      ...eventBase({
        instanceId: input.instanceId,
        threadId: inputState.state.session.threadId,
        turnId: inputState.turnId,
      }),
      payload: {
        usage: {
          usedTokens,
          maxTokens,
          compactsAutomatically: input.settings.contextCompressionEnabled,
          contextSource,
        },
      },
    } as ProviderRuntimeEvent);
  }

  async function maybeCompactContext(inputState: {
    readonly state: CustomAgentSessionState;
    readonly turnId: TurnId;
    readonly currentUserRequest: string;
    readonly workingContext: string;
  }): Promise<boolean> {
    const { state, turnId, currentUserRequest, workingContext } = inputState;
    if (!input.settings.contextCompressionEnabled) return false;
    if (state.messages.length < CONTEXT_COMPACT_MIN_MESSAGES) return false;

    const model = state.session.model ?? input.settings.model;
    const budget = await contextBudget(input.settings, input.backend, model);
    const tokenEstimate = await estimateModelInputTokens(
      [
        { role: "system", content: runtimePrompt },
        ...state.messages,
        { role: "system", content: `Compact working context:\n${workingContext}` },
      ],
      model,
    );
    state.tokenUsageEstimate = tokenEstimate;

    const ratio = tokenEstimate / budget;
    const forceCompact = ratio >= CONTEXT_COMPACT_FORCE_RATIO;
    if (ratio < CONTEXT_COMPACT_TRIGGER_RATIO) return false;
    if (
      !forceCompact &&
      state.messages.length <= state.lastCompactionMessageCount + CONTEXT_COMPACT_MIN_MESSAGES
    )
      return false;

    const recentCount = Math.min(CONTEXT_COMPACT_RECENT_MESSAGES, state.messages.length);
    const olderMessages = state.messages.slice(0, -recentCount);
    const recentMessages = state.messages.slice(-recentCount);
    if (olderMessages.length < 2) return false;

    const compactionItemId = `compaction_${randomUUID()}`;
    await emit({
      type: "item.started",
      ...eventBase({
        instanceId: input.instanceId,
        threadId: state.session.threadId,
        turnId,
        itemId: compactionItemId,
      }),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "context_compaction",
        detail: `Context ${compactPercent(tokenEstimate, budget)}% of budget; compacting older history`,
      },
    } as ProviderRuntimeEvent);

    try {
      const source = buildCompactionSource({
        state,
        currentUserRequest,
        workingContext,
        olderMessages,
        recentMessages,
        maxChars: Math.max(16000, budget * 3),
      });
      const compactOutput = await input.backend.complete({
        messages: buildCompactionPrompt(source),
        model,
        temperature: 0,
        stream: false,
        maxOutputTokens: input.settings.maxOutputTokens,
      });
      const summary = normalizeCompactionOutput(compactOutput.content);
      const compactPromptTokens = extractPromptTokensFromUsage(compactOutput.usage);
      if (compactPromptTokens) {
        console.log(`[Compaction] Actual prompt tokens from API: ${compactPromptTokens}`);
      }
      const resumeMessage = buildCompactResumeMessage({
        summary,
        currentUserRequest,
        tokenEstimate,
        budget,
      });

      state.compactedHistorySummaries.push(summary);
      if (state.compactedHistorySummaries.length > CONTEXT_COMPACT_MAX_SUMMARIES) {
        state.compactedHistorySummaries.splice(
          0,
          state.compactedHistorySummaries.length - CONTEXT_COMPACT_MAX_SUMMARIES,
        );
      }
      state.messages.splice(0, state.messages.length, resumeMessage, ...recentMessages);
      state.lastCompactionMessageCount = state.messages.length;
      state.tokenUsageEstimate = estimateMessages([
        { role: "system", content: runtimePrompt },
        ...state.messages,
      ]);

      await emit({
        type: "item.completed",
        ...eventBase({
          instanceId: input.instanceId,
          threadId: state.session.threadId,
          turnId,
          itemId: compactionItemId,
        }),
        payload: {
          itemType: "dynamic_tool_call",
          status: "completed",
          title: "context_compaction",
          detail: `Compacted older context; preserved ${recentMessages.length} recent messages`,
        },
      } as ProviderRuntimeEvent);
      return true;
    } catch (error) {
      const message = formatCustomAgentRuntimeError(error);
      await emit({
        type: "item.completed",
        ...eventBase({
          instanceId: input.instanceId,
          threadId: state.session.threadId,
          turnId,
          itemId: compactionItemId,
        }),
        payload: {
          itemType: "dynamic_tool_call",
          status: "failed",
          title: "context_compaction",
          detail: message,
        },
      } as ProviderRuntimeEvent);
      return false;
    }
  }

  async function runTurn(
    state: CustomAgentSessionState,
    userInput: string,
    turnId: TurnId,
  ): Promise<void> {
    const tools = toolsForWorkspace(workspaceRootForSession(state));
    const assistantItemId = `assistant_${randomUUID()}`;
    state.activeAssistantItemId = assistantItemId;
    state.messages.push({ role: "user", content: userInput });
    state.tokenUsageEstimate = estimateMessages(state.messages);
    await emit({
      type: "turn.started",
      ...eventBase({ instanceId: input.instanceId, threadId: state.session.threadId, turnId }),
      payload: { model: state.session.model ?? input.settings.model },
    } as ProviderRuntimeEvent);
    await emit({
      type: "item.started",
      ...eventBase({
        instanceId: input.instanceId,
        threadId: state.session.threadId,
        turnId,
        itemId: assistantItemId,
      }),
      payload: { itemType: "assistant_message", status: "inProgress" },
    } as ProviderRuntimeEvent);
    let invalidCalls = 0;
    let repoAutoInspected = false;
    let todoFinalGuardUsed = false;
    const toolCallCounts = new Map<string, number>();
    const emitAutomaticTool = async (
      tool: string,
      args: Record<string, unknown>,
      reason: string,
    ): Promise<string | undefined> => {
      assertTurnOpen(state, turnId);
      const toolCallId = `tool_${randomUUID()}`;
      await emit({
        type: "item.started",
        ...eventBase({
          instanceId: input.instanceId,
          threadId: state.session.threadId,
          turnId,
          itemId: toolCallId,
        }),
        payload: {
          itemType: "dynamic_tool_call",
          status: "inProgress",
          title: tool,
          detail: reason,
        },
      } as ProviderRuntimeEvent);
      try {
        const result = await tools.execute(tool, args, {
          threadId: state.session.threadId,
          turnId,
          toolCallId,
          runtimeMode: input.settings.defaultRuntimeMode,
          sandboxMode: input.settings.sandboxMode,
          signal: state.activeAbort?.signal,
          requestApproval: async () => {
            throw new Error(`Automatic ${tool} requires approval; skipped.`);
          },
        });
        assertTurnOpen(state, turnId);
        if (result.artifactId) state.toolArtifacts.push(result.artifactId);
        await emit({
          type: "item.completed",
          ...eventBase({
            instanceId: input.instanceId,
            threadId: state.session.threadId,
            turnId,
            itemId: toolCallId,
          }),
          payload: {
            itemType: "dynamic_tool_call",
            status: result.ok ? "completed" : "failed",
            title: tool,
            detail: formatToolActivityDetail(tool, result),
            data: result.data,
          },
        } as ProviderRuntimeEvent);
        state.messages.push({
          role: "user",
          content: formatToolResultForModel({ tool, ok: result.ok, content: result.content }),
        });
        return result.content;
      } catch (error) {
        if (state.activeAbort?.signal.aborted || isTurnSettled(state, turnId)) throw error;
        const message = formatCustomAgentRuntimeError(error);
        await emit({
          type: "item.completed",
          ...eventBase({
            instanceId: input.instanceId,
            threadId: state.session.threadId,
            turnId,
            itemId: toolCallId,
          }),
          payload: {
            itemType: "dynamic_tool_call",
            status: "failed",
            title: tool,
            detail: message,
          },
        } as ProviderRuntimeEvent);
        state.messages.push({
          role: "user",
          content: formatToolResultForModel({ tool, ok: false, content: message }),
        });
        return undefined;
      }
    };

    type StartedModelToolCall = {
      readonly command: CustomAgentModelToolCall;
      readonly toolCallId: string;
      readonly itemType: ReturnType<typeof itemTypeForTool>;
      readonly repeatCount: number;
    };

    const startModelToolCall = async (
      command: CustomAgentModelToolCall,
      index?: number,
    ): Promise<StartedModelToolCall> => {
      assertTurnOpen(state, turnId);
      const toolCallId = `tool_${randomUUID()}`;
      const toolCallSignature = `${command.tool}:${stableJson(command.args)}`;
      const repeatCount = toolCallCounts.get(toolCallSignature) ?? 0;
      toolCallCounts.set(toolCallSignature, repeatCount + 1);
      state.activeToolCalls.set(toolCallId, command);
      const itemType = itemTypeForTool(command.tool);
      await emit({
        type: "item.started",
        ...eventBase({
          instanceId: input.instanceId,
          threadId: state.session.threadId,
          turnId,
          itemId: toolCallId,
        }),
        payload: {
          itemType,
          status: "inProgress",
          title: command.tool,
          detail:
            index === undefined
              ? command.reason
              : command.reason
                ? `parallel ${index + 1}: ${command.reason}`
                : `parallel ${index + 1}`,
          data: { args: command.args },
        },
      } as ProviderRuntimeEvent);
      return { command, toolCallId, itemType, repeatCount };
    };

    const finishStartedModelToolCall = async (started: StartedModelToolCall): Promise<void> => {
      const { command, toolCallId, itemType, repeatCount } = started;
      if (repeatCount >= MAX_REPEAT_TOOL_CALLS) {
        const skipped = {
          ok: false,
          content:
            "Repeated identical tool call skipped. Use the previous tool result from context and answer final now, or call a different narrower tool only if required.",
        };
        await emit({
          type: "item.completed",
          ...eventBase({
            instanceId: input.instanceId,
            threadId: state.session.threadId,
            turnId,
            itemId: toolCallId,
          }),
          payload: {
            itemType,
            status: "failed",
            title: command.tool,
            detail: skipped.content,
            data: { args: command.args },
          },
        } as ProviderRuntimeEvent);
        state.messages.push(
          {
            role: "user",
            content: formatToolResultForModel({
              tool: command.tool,
              ok: false,
              content: skipped.content,
            }),
          },
          {
            role: "user",
            content:
              "Do not call the same tool with the same args again. Use existing evidence and answer final now unless a different tool is strictly necessary.",
          },
        );
        state.activeToolCalls.delete(toolCallId);
        return;
      }
      try {
        const result = isSubagentTool(command.tool)
          ? await executeSubagentRuntimeTool({
              state,
              turnId,
              tool: command.tool,
              args: command.args,
              userInput,
            })
          : isTodoTool(command.tool)
            ? await executeTodoRuntimeTool({
                state,
                turnId,
                tool: command.tool,
                args: command.args,
              })
            : await tools.execute(command.tool, command.args, {
                threadId: state.session.threadId,
                turnId,
                toolCallId,
                runtimeMode: input.settings.defaultRuntimeMode,
                sandboxMode: input.settings.sandboxMode,
                signal: state.activeAbort?.signal,
                requestApproval: async (request) => {
                  await emit({
                    type: "request.opened",
                    ...eventBase({
                      instanceId: input.instanceId,
                      threadId: state.session.threadId,
                      turnId,
                      requestId: request.requestId,
                    }),
                    payload: {
                      requestType: request.requestType,
                      detail: request.riskSummary,
                      args: request,
                    },
                  } as ProviderRuntimeEvent);
                  state.session = { ...state.session, status: "running", updatedAt: nowIso() };
                  return await new Promise<ProviderApprovalDecision>((resolve) => {
                    state.pendingApprovals.set(request.requestId, { request, resolve });
                  }).then(async (decision) => {
                    contextStore.recordDecision({
                      requestId: request.requestId,
                      decision,
                      tool: request.toolName,
                    });
                    await emit({
                      type: "request.resolved",
                      ...eventBase({
                        instanceId: input.instanceId,
                        threadId: state.session.threadId,
                        turnId,
                        requestId: request.requestId,
                      }),
                      payload: { requestType: request.requestType, decision },
                    } as ProviderRuntimeEvent);
                    return decision;
                  });
                },
                emitDiff: (diff) => {
                  state.currentDiffs.push(diff);
                  void emit({
                    type: "turn.diff.updated",
                    ...eventBase({
                      instanceId: input.instanceId,
                      threadId: state.session.threadId,
                      turnId,
                    }),
                    payload: { unifiedDiff: diff },
                  } as ProviderRuntimeEvent);
                },
              });
        assertTurnOpen(state, turnId);
        if (result.artifactId) state.toolArtifacts.push(result.artifactId);
        state.turns
          .find((turn) => turn.id === turnId)
          ?.items.push({
            toolCallId,
            tool: command.tool,
            result,
          });
        await emit({
          type: "item.completed",
          ...eventBase({
            instanceId: input.instanceId,
            threadId: state.session.threadId,
            turnId,
            itemId: toolCallId,
          }),
          payload: {
            itemType,
            status: result.ok ? "completed" : "failed",
            title: command.tool,
            detail: formatToolActivityDetail(command.tool, result),
            data: result.data ?? { args: command.args },
          },
        } as ProviderRuntimeEvent);
        state.messages.push({
          role: "user",
          content: formatToolResultForModel({
            tool: command.tool,
            ok: result.ok,
            content: result.content,
          }),
        });
      } catch (error) {
        if (state.activeAbort?.signal.aborted || isTurnSettled(state, turnId)) throw error;
        const message = formatCustomAgentRuntimeError(error);
        await emit({
          type: "item.completed",
          ...eventBase({
            instanceId: input.instanceId,
            threadId: state.session.threadId,
            turnId,
            itemId: toolCallId,
          }),
          payload: {
            itemType,
            status: "failed",
            title: command.tool,
            detail: message,
            data: { args: command.args },
          },
        } as ProviderRuntimeEvent);
        state.messages.push({
          role: "user",
          content: formatToolResultForModel({
            tool: command.tool,
            ok: false,
            content: message,
          }),
        });
      } finally {
        state.activeToolCalls.delete(toolCallId);
      }
    };

    const executeModelToolCall = async (
      command: CustomAgentModelToolCall,
      index?: number,
    ): Promise<void> => {
      const started = await startModelToolCall(command, index);
      await finishStartedModelToolCall(started);
    };

    try {
      assertTurnOpen(state, turnId);
      if (!state.projectContextInjected) {
        state.projectContextInjected = true;
        await emitAutomaticTool(
          "project_context",
          { purpose: "Auto-load compact workspace and system context for this session" },
          "Auto-load project context",
        );
        state.messages.push({
          role: "user",
          content:
            "Compact project context was auto-loaded. Use it to understand the active workspace, OS, file counts, extensions, and likely stack. It is only a summary; inspect exact files before making precise claims.",
        });
      }
      if (isProjectOverviewRequest(userInput)) {
        assertTurnOpen(state, turnId);
        repoAutoInspected = true;
        const listedContents = await Promise.all([
          emitAutomaticTool(
            "find_files",
            {
              query: "README",
              maxResults: 10,
              purpose: "Find project overview README candidates",
            },
            "Auto-find README files",
          ),
          emitAutomaticTool(
            "find_files",
            {
              query: "package.json",
              maxResults: 10,
              purpose: "Find package manifest candidates",
            },
            "Auto-find package manifests",
          ),
          emitAutomaticTool(
            "find_files",
            {
              query: "pnpm-workspace.yaml",
              maxResults: 5,
              purpose: "Find workspace manifest candidates",
            },
            "Auto-find workspace manifests",
          ),
          emitAutomaticTool(
            "find_files",
            {
              query: "turbo.json",
              maxResults: 5,
              purpose: "Find build orchestration config candidates",
            },
            "Auto-find build orchestration config",
          ),
          emitAutomaticTool(
            "find_files",
            {
              query: "AGENTS.md",
              maxResults: 5,
              purpose: "Find local agent instructions",
            },
            "Auto-find local agent instructions",
          ),
        ]);
        const overviewFiles = selectProjectOverviewFiles(
          listedContents.flatMap((content) => (content ? extractListedFiles(content) : [])),
        );
        if (input.settings.approvalPolicy !== "always" && overviewFiles.length > 0) {
          await Promise.all(
            overviewFiles.map((path) =>
              emitAutomaticTool(
                "read_file",
                {
                  path,
                  startLine: 1,
                  endLine: path.toLowerCase() === "package.json" ? 120 : 80,
                  purpose: "Auto-read project overview evidence",
                },
                `Auto-read ${path}`,
              ),
            ),
          );
        }
        state.messages.push({
          role: "user",
          content:
            "Automatic repo overview inspection is complete. Answer the user's project overview request directly from these tool results. If evidence is thin, say exactly what was inspected.",
        });
      }
      for (let step = 0; step < MAX_TOOL_STEPS; step++) {
        assertTurnOpen(state, turnId);
        const model = state.session.model ?? input.settings.model;
        const budget = await contextBudget(input.settings, input.backend, model);
        let workingContext = contextStore.buildWorkingContext({
          threadId: state.session.threadId,
          currentUserRequest: userInput,
          maxTokens: budget,
        });
        const compacted = await maybeCompactContext({
          state,
          turnId,
          currentUserRequest: userInput,
          workingContext,
        });
        assertTurnOpen(state, turnId);
        if (compacted) {
          workingContext = contextStore.buildWorkingContext({
            threadId: state.session.threadId,
            currentUserRequest: userInput,
            maxTokens: Math.floor(budget * 0.45),
          });
        }
        const todoRuntimeHint = buildTodoRuntimeHint(state, userInput);
        const llmMessages: CustomAgentChatMessage[] = [
          {
            role: "system",
            content: runtimePrompt,
          },
          ...state.messages.slice(-20),
          { role: "system", content: `Compact working context:\n${workingContext}` },
          ...(todoRuntimeHint
            ? [
                {
                  role: "system" as const,
                  content: todoRuntimeHint,
                },
              ]
            : []),
        ];
        await emitContextUsageSnapshot({
          state,
          turnId,
          usedTokens: await estimateModelInputTokens(
            llmMessages,
            state.session.model ?? input.settings.model,
          ),
          model: state.session.model ?? input.settings.model,
        });
        let output: Awaited<ReturnType<typeof completeCustomAgentModel>>;
        let streamedFinalContent = "";
        try {
          output = await completeModelWithRetry({
            state,
            turnId,
            messages: llmMessages,
            model: state.session.model ?? input.settings.model,
            maxOutputTokens: input.settings.maxOutputTokens,
            onFinalContentDelta: async (delta) => {
              assertTurnOpen(state, turnId);
              streamedFinalContent += delta;
              await emit({
                type: "content.delta",
                ...eventBase({
                  instanceId: input.instanceId,
                  threadId: state.session.threadId,
                  turnId,
                  itemId: assistantItemId,
                }),
                payload: { streamKind: "assistant_text", delta },
              } as ProviderRuntimeEvent);
            },
          });
          assertTurnOpen(state, turnId);
        } catch (error) {
          throw error;
        }
        assertTurnOpen(state, turnId);
        const parsed = parseCustomAgentModelCommand(output.content.trim());
        if (!parsed.ok) {
          invalidCalls += 1;
          state.messages.push({
            role: "user",
            content: `Previous assistant output was invalid JSON for the Custom Agent protocol: ${parsed.error}`,
          });
          if (invalidCalls >= MAX_INVALID_TOOL_CALLS) throw new Error(parsed.error);
          continue;
        }
        if (parsed.command.type === "final") {
          const openTodos = openTodoItems(state);
          if (
            shouldRequireTodoForUserInput(userInput) &&
            openTodos.length > 0 &&
            !todoFinalGuardUsed &&
            invalidCalls < MAX_INVALID_TOOL_CALLS
          ) {
            todoFinalGuardUsed = true;
            invalidCalls += 1;
            state.messages.push({
              role: "user",
              content: [
                "Before final, reconcile the visible todo checklist with the work actually completed.",
                `Open todo items: ${openTodos.map((item) => `${item.status}:${item.content}`).join(" | ")}`,
                "If work is done, call todo_write marking completed items. If not done, mark blocked/pending truthfully, then answer final.",
              ].join("\n"),
            });
            continue;
          }
          if (
            repoAutoInspected &&
            isPassiveUnverifiedProjectAnswer(parsed.command.content) &&
            invalidCalls < MAX_INVALID_TOOL_CALLS
          ) {
            invalidCalls += 1;
            state.messages.push({
              role: "user",
              content:
                "Your previous final answer was invalid for this request. You already received repository tool results. Answer directly from those results now; do not say you need permission or have not inspected the repo.",
            });
            continue;
          }
          if (
            isProjectOverviewRequest(userInput) &&
            isLikelyRawStructuredFileDump(parsed.command.content) &&
            invalidCalls < MAX_INVALID_TOOL_CALLS
          ) {
            invalidCalls += 1;
            state.messages.push({
              role: "user",
              content:
                "Your previous final answer pasted raw file or tool output. Summarize the inspected project evidence instead. Do not paste raw package.json or raw file contents unless the user explicitly asks for raw content.",
            });
            continue;
          }
          const remainingContent = parsed.command.content.startsWith(streamedFinalContent)
            ? parsed.command.content.slice(streamedFinalContent.length)
            : parsed.command.content;
          for (const delta of chunkAssistantText(remainingContent)) {
            assertTurnOpen(state, turnId);
            await emit({
              type: "content.delta",
              ...eventBase({
                instanceId: input.instanceId,
                threadId: state.session.threadId,
                turnId,
                itemId: assistantItemId,
              }),
              payload: { streamKind: "assistant_text", delta },
            } as ProviderRuntimeEvent);
          }
          assertTurnOpen(state, turnId);
          state.messages.push({ role: "assistant", content: parsed.command.content });
          const actualPromptTokens = extractPromptTokensFromUsage(output.usage);
          const usedTokens = actualPromptTokens ?? estimateMessages(state.messages);
          await emitContextUsageSnapshot({
            state,
            turnId,
            usedTokens,
            model: state.session.model ?? input.settings.model,
          });
          await emit({
            type: "item.completed",
            ...eventBase({
              instanceId: input.instanceId,
              threadId: state.session.threadId,
              turnId,
              itemId: assistantItemId,
            }),
            payload: { itemType: "assistant_message", status: "completed" },
          } as ProviderRuntimeEvent);
          await emit({
            type: "turn.completed",
            ...eventBase({
              instanceId: input.instanceId,
              threadId: state.session.threadId,
              turnId,
            }),
            payload: {
              state: "completed",
              stopReason: "final",
              usage: {
                estimatedTokens: actualPromptTokens ?? estimateMessages(state.messages),
                ...(output.usage && { apiUsage: output.usage }),
              },
            },
          } as ProviderRuntimeEvent);
          state.settledTurnIds.add(turnId);
          state.session = {
            ...state.session,
            status: "ready",
            activeTurnId: undefined,
            lastError: undefined,
            updatedAt: nowIso(),
          };
          clearActiveTurn(state, turnId);
          await emit({
            type: "session.state.changed",
            ...eventBase({ instanceId: input.instanceId, threadId: state.session.threadId }),
            payload: { state: "ready", reason: "turn_completed" },
          } as ProviderRuntimeEvent);
          return;
        }
        const toolCalls: ReadonlyArray<CustomAgentModelToolCall> =
          parsed.command.type === "tool_calls"
            ? parsed.command.calls
            : [
                {
                  tool: parsed.command.tool,
                  args: parsed.command.args,
                  reason: parsed.command.reason,
                },
              ];
        if (canRunToolCallsConcurrently(toolCalls)) {
          const startedToolCalls: StartedModelToolCall[] = [];
          for (const [index, command] of toolCalls.entries()) {
            startedToolCalls.push(await startModelToolCall(command, index));
          }
          const settledToolCalls = await Promise.allSettled(
            startedToolCalls.map((started) => finishStartedModelToolCall(started)),
          );
          const fatalToolError = settledToolCalls.find(
            (result) => result.status === "rejected" && isAbortLikeError(result.reason),
          );
          if (fatalToolError?.status === "rejected") throw fatalToolError.reason;
          const unexpectedToolErrors = settledToolCalls.filter(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          for (const failed of unexpectedToolErrors) {
            const message = formatCustomAgentRuntimeError(failed.reason);
            state.messages.push({
              role: "user",
              content: formatToolResultForModel({
                tool: "parallel_tool_call",
                ok: false,
                content: message,
              }),
            });
          }
        } else {
          for (const [index, command] of toolCalls.entries()) {
            await executeModelToolCall(command, toolCalls.length > 1 ? index : undefined);
          }
        }
      }
      throw new Error("Tool step limit exceeded.");
    } catch (error) {
      if (isTurnSettled(state, turnId)) return;
      const message = formatCustomAgentRuntimeError(error);
      if (state.activeAbort?.signal.aborted || message.includes("Turn interrupted.")) {
        await settleTurnInterrupted(state, turnId, "Interrupted");
        return;
      }
      await settleTurnFailed(state, turnId, message);
    }
  }

  return {
    settings: input.settings,
    workspaceRoot: input.workspaceRoot,
    contextStore,
    tools: defaultTools,
    events,
    startSession: async (sessionInput) => {
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: input.instanceId,
        status: "ready",
        runtimeMode: sessionInput.runtimeMode,
        cwd: path.resolve(sessionInput.cwd ?? input.workspaceRoot),
        model: sessionInput.modelSelection?.model ?? input.settings.model,
        threadId: sessionInput.threadId,
        resumeCursor: sessionInput.resumeCursor,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      const state: CustomAgentSessionState = {
        session,
        messages: [],
        compactedHistorySummaries: [],
        pendingApprovals: new Map(),
        pendingUserInputRequests: new Map(),
        activeToolCalls: new Map(),
        subagents: new Map(),
        todos: new Map(),
        settledTurnIds: new Set(),
        toolArtifacts: [],
        contextReferences: [],
        currentDiffs: [],
        touchedFiles: new Set(),
        commandHistory: [],
        testCheckResults: [],
        userDecisions: [],
        taskConstraints: [],
        tokenUsageEstimate: 0,
        lastCompactionMessageCount: 0,
        projectContextInjected: false,
        subagentNameCursor: 0,
        turns: [],
      };
      sessions.set(session.threadId, state);
      await emit({
        type: "session.started",
        ...eventBase({ instanceId: input.instanceId, threadId: session.threadId }),
        payload: { message: "CustomAgent session started" },
      } as ProviderRuntimeEvent);
      await emit({
        type: "session.state.changed",
        ...eventBase({ instanceId: input.instanceId, threadId: session.threadId }),
        payload: { state: "ready" },
      } as ProviderRuntimeEvent);
      await emit({
        type: "thread.started",
        ...eventBase({ instanceId: input.instanceId, threadId: session.threadId }),
        payload: { providerThreadId: session.threadId },
      } as ProviderRuntimeEvent);
      return session;
    },
    sendTurn: async (turnInput) => {
      const state = getSession(turnInput.threadId);
      if (state.activeTurnId) throw new Error("A turn is already active for this thread.");
      const turnId = TurnId.make(`turn_${randomUUID()}`);
      state.activeTurnId = turnId;
      state.activeAbort = new AbortController();
      state.activeAssistantItemId = undefined;
      state.settledTurnIds.delete(turnId);
      state.turns.push({ id: turnId, items: [] });
      state.session = {
        ...state.session,
        status: "running",
        activeTurnId: turnId,
        model: turnInput.modelSelection?.model ?? state.session.model,
        updatedAt: nowIso(),
      };
      void runTurn(state, turnInput.input ?? "", turnId).catch((error: unknown) =>
        settleTurnFailed(state, turnId, formatCustomAgentRuntimeError(error)),
      );
      return { threadId: turnInput.threadId, turnId } satisfies ProviderTurnStartResult;
    },
    interruptTurn: async (threadId, turnId) => {
      const state = getSession(threadId);
      const activeTurnId = state.activeTurnId;
      if (!activeTurnId) return;
      if (!turnId || activeTurnId === turnId) {
        await settleTurnInterrupted(state, activeTurnId, "Interrupted by user");
      }
    },
    respondToRequest: async (threadId, requestId, decision) => {
      const state = getSession(threadId);
      const pending = state.pendingApprovals.get(requestId);
      if (!pending) throw new Error(`Unknown approval request: ${requestId}`);
      state.pendingApprovals.delete(requestId);
      pending.resolve(decision);
    },
    respondToUserInput: async (threadId, requestId, answers) => {
      const state = getSession(threadId);
      state.pendingUserInputRequests.delete(requestId);
      contextStore.recordDecision({ requestId, answers });
    },
    stopSession: async (threadId) => {
      const state = getSession(threadId);
      for (const subagent of state.subagents.values()) {
        if (subagent.status === "running") subagent.abort.abort();
      }
      if (state.activeTurnId) {
        await settleTurnInterrupted(state, state.activeTurnId, "Session stopped");
      }
      state.session = { ...state.session, status: "closed", updatedAt: nowIso() };
      sessions.delete(threadId);
      await emit({
        type: "session.exited",
        ...eventBase({ instanceId: input.instanceId, threadId }),
        payload: { exitKind: "graceful", recoverable: false },
      } as ProviderRuntimeEvent);
    },
    listSessions: () => [...sessions.values()].map((state) => state.session),
    hasSession: (threadId) => sessions.has(threadId),
    readThread: (threadId) => ({ threadId, turns: getSession(threadId).turns }),
    rollbackThread: (threadId, numTurns) => {
      const state = getSession(threadId);
      state.turns.splice(Math.max(0, state.turns.length - numTurns), numTurns);
      return { threadId, turns: state.turns };
    },
    stopAll: async () => {
      for (const state of sessions.values()) {
        for (const subagent of state.subagents.values()) {
          if (subagent.status === "running") subagent.abort.abort();
        }
      }
      await Promise.all(
        [...sessions.values()].map((state) =>
          state.activeTurnId
            ? settleTurnInterrupted(state, state.activeTurnId, "All sessions stopped")
            : Promise.resolve(),
        ),
      );
      sessions.clear();
    },
  };
}
