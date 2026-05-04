import { randomUUID } from "node:crypto";
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
  TurnId,
} from "@t3tools/contracts";
import { Effect, Queue } from "effect";
import type { CustomAgentLlmBackend, CustomAgentChatMessage } from "./CustomAgentLlmBackend.ts";
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

function formatCustomAgentRuntimeError(error: unknown): string {
  const message = String((error as Error).message ?? error);
  return message.startsWith("Failed to reach Custom Agent API endpoint:") ||
    message.startsWith("Custom Agent API error") ||
    message.startsWith("Custom Agent API returned invalid JSON")
    ? message
    : `Custom Agent runtime error: ${message}`;
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
  if (typeof parsed.exitCode === "number") parts.push(`exit ${parsed.exitCode}`);
  if (typeof parsed.artifactId === "string") parts.push(`artifact ${parsed.artifactId}`);
  if (parsed.truncated === true) parts.push("truncated");
  return parts.join(" | ").slice(0, 500);
}

function formatToolResultForModel(input: {
  readonly tool: string;
  readonly ok: boolean;
  readonly content: string;
}): string {
  const parsed = parseToolJson(input.content);
  const result =
    parsed && typeof parsed.preview === "string"
      ? { ...parsed, preview: parsed.preview.slice(0, 1200) }
      : (parsed ?? input.content.slice(0, 1600));
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

interface CustomAgentSessionState {
  session: ProviderSession;
  readonly messages: CustomAgentChatMessage[];
  readonly compactedHistorySummaries: string[];
  activeTurnId?: TurnId | undefined;
  activeAbort?: AbortController | undefined;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly pendingUserInputRequests: Map<string, unknown>;
  readonly activeToolCalls: Map<string, unknown>;
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

function contextBudget(settings: CustomAgentSettings): number {
  return Math.max(8000, settings.maxContextTokens || 48000);
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
  },
  onFinalContentDelta?: ((delta: string) => Promise<void>) | undefined,
): Promise<string> {
  let streamed = "";
  let emittedFinalContent = "";
  let pendingDeltaEmission: Promise<void> = Promise.resolve();
  let pendingDeltaEmissionError: unknown;

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
    for await (const chunk of backend.stream({ ...input, stream: true })) {
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
  } catch {
    streamFailed = true;
    streamed = "";
  }
  await drainFinalContentDeltas();
  if (!streamFailed && streamed.trim().length > 0) return streamed;
  return (await backend.complete({ ...input, stream: false })).content;
}

export async function makeCustomAgentRuntime(input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CustomAgentSettings;
  readonly workspaceRoot: string;
  readonly backend: CustomAgentLlmBackend;
  readonly events: Queue.Queue<ProviderRuntimeEvent>;
}): Promise<CustomAgentRuntime> {
  const events = input.events;
  const sessions = new Map<ThreadId, CustomAgentSessionState>();
  const contextStore = makeCustomAgentContextStore();
  const tools = makeCustomAgentToolRegistry({
    settings: input.settings,
    workspaceRoot: input.workspaceRoot,
    contextStore,
  });
  const systemPrompt = await loadCustomAgentSystemPrompt(input.settings, input.workspaceRoot).catch(
    () =>
      loadCustomAgentSystemPrompt({ ...input.settings, systemPromptPath: "" }, input.workspaceRoot),
  );
  const runtimePrompt = buildCustomAgentRuntimePrompt({
    systemPrompt,
    toolNames: tools.names,
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

  function getSession(threadId: ThreadId): CustomAgentSessionState {
    const session = sessions.get(threadId);
    if (!session) throw new Error(`Unknown CustomAgent thread: ${threadId}`);
    return session;
  }

  async function estimateModelInputTokens(
    messages: ReadonlyArray<CustomAgentChatMessage>,
    model: string,
  ): Promise<number> {
    if (!input.backend.countTokens) return estimateMessages(messages);
    return await input.backend.countTokens({ messages, model }).catch(() => estimateMessages(messages));
  }

  async function emitContextUsageSnapshot(inputState: {
    readonly state: CustomAgentSessionState;
    readonly turnId: TurnId;
    readonly usedTokens: number;
  }): Promise<void> {
    const usedTokens = Math.max(1, Math.round(inputState.usedTokens));
    const maxTokens = Math.max(1, Math.round(contextBudget(input.settings)));
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
    const budget = contextBudget(input.settings);
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
      });
      const summary = normalizeCompactionOutput(compactOutput.content);
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
    const assistantItemId = `assistant_${randomUUID()}`;
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
    const toolCallCounts = new Map<string, number>();
    const emitAutomaticTool = async (
      tool: string,
      args: Record<string, unknown>,
      reason: string,
    ): Promise<string | undefined> => {
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
          requestApproval: async () => {
            throw new Error(`Automatic ${tool} requires approval; skipped.`);
          },
        });
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

    try {
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
        repoAutoInspected = true;
        const listedContent = await emitAutomaticTool(
          "tool_batch",
          {
            calls: [
              {
                tool: "find_files",
                args: {
                  query: "README",
                  maxResults: 10,
                  purpose: "Find project overview README candidates",
                },
              },
              {
                tool: "find_files",
                args: {
                  query: "package.json",
                  maxResults: 10,
                  purpose: "Find package manifest candidates",
                },
              },
              {
                tool: "find_files",
                args: {
                  query: "pnpm-workspace.yaml",
                  maxResults: 5,
                  purpose: "Find workspace manifest candidates",
                },
              },
              {
                tool: "find_files",
                args: {
                  query: "turbo.json",
                  maxResults: 5,
                  purpose: "Find build orchestration config candidates",
                },
              },
              {
                tool: "find_files",
                args: {
                  query: "AGENTS.md",
                  maxResults: 5,
                  purpose: "Find local agent instructions",
                },
              },
            ],
            purpose: "Auto-find compact project overview files",
          },
          "Auto-find project overview files",
        );
        const overviewFiles = listedContent
          ? selectProjectOverviewFiles(extractListedFiles(listedContent))
          : [];
        if (input.settings.approvalPolicy !== "always") {
          for (const path of overviewFiles) {
            await emitAutomaticTool(
              "read_file",
              {
                path,
                startLine: 1,
                endLine: path.toLowerCase() === "package.json" ? 120 : 80,
                purpose: "Auto-read project overview evidence",
              },
              `Auto-read ${path}`,
            );
          }
        }
        state.messages.push({
          role: "user",
          content:
            "Automatic repo overview inspection is complete. Answer the user's project overview request directly from these tool results. If evidence is thin, say exactly what was inspected.",
        });
      }
      for (let step = 0; step < MAX_TOOL_STEPS; step++) {
        if (state.activeAbort?.signal.aborted) throw new Error("Turn interrupted.");
        let workingContext = contextStore.buildWorkingContext({
          threadId: state.session.threadId,
          currentUserRequest: userInput,
          maxTokens: input.settings.maxContextTokens,
        });
        const compacted = await maybeCompactContext({
          state,
          turnId,
          currentUserRequest: userInput,
          workingContext,
        });
        if (compacted) {
          workingContext = contextStore.buildWorkingContext({
            threadId: state.session.threadId,
            currentUserRequest: userInput,
            maxTokens: Math.floor(contextBudget(input.settings) * 0.45),
          });
        }
        const llmMessages: CustomAgentChatMessage[] = [
          {
            role: "system",
            content: runtimePrompt,
          },
          ...state.messages.slice(-20),
          { role: "system", content: `Compact working context:\n${workingContext}` },
        ];
        await emitContextUsageSnapshot({
          state,
          turnId,
          usedTokens: await estimateModelInputTokens(
            llmMessages,
            state.session.model ?? input.settings.model,
          ),
        });
        let liveFinalContent = "";
        const output = await completeCustomAgentModel(
          input.backend,
          {
            messages: llmMessages,
            model: state.session.model ?? input.settings.model,
          },
          async (delta) => {
            liveFinalContent += delta;
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
        );
        const parsed = parseCustomAgentModelCommand(output.trim());
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
          if (
            repoAutoInspected &&
            liveFinalContent.length === 0 &&
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
          const remainingContent = parsed.command.content.slice(liveFinalContent.length);
          if (remainingContent.length > 0)
            await emit({
              type: "content.delta",
              ...eventBase({
                instanceId: input.instanceId,
                threadId: state.session.threadId,
                turnId,
                itemId: assistantItemId,
              }),
              payload: { streamKind: "assistant_text", delta: remainingContent },
            } as ProviderRuntimeEvent);
          state.messages.push({ role: "assistant", content: parsed.command.content });
          await emitContextUsageSnapshot({
            state,
            turnId,
            usedTokens: estimateMessages(state.messages),
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
              usage: { estimatedTokens: estimateMessages(state.messages) },
            },
          } as ProviderRuntimeEvent);
          state.session = {
            ...state.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: nowIso(),
          };
          state.activeTurnId = undefined;
          return;
        }
        const toolCallId = `tool_${randomUUID()}`;
        const toolCallSignature = `${parsed.command.tool}:${stableJson(parsed.command.args)}`;
        const repeatCount = toolCallCounts.get(toolCallSignature) ?? 0;
        toolCallCounts.set(toolCallSignature, repeatCount + 1);
        state.activeToolCalls.set(toolCallId, parsed.command);
        const itemType =
          parsed.command.tool === "run_command"
            ? "command_execution"
            : parsed.command.tool.includes("mcp")
              ? "mcp_tool_call"
              : ["write_file", "edit_file", "apply_patch"].includes(parsed.command.tool)
                ? "file_change"
                : "dynamic_tool_call";
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
            title: parsed.command.tool,
            detail: parsed.command.reason,
          },
        } as ProviderRuntimeEvent);
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
              title: parsed.command.tool,
              detail: skipped.content,
            },
          } as ProviderRuntimeEvent);
          state.messages.push(
            {
              role: "user",
              content: formatToolResultForModel({
                tool: parsed.command.tool,
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
          continue;
        }
        try {
          const result = await tools.execute(parsed.command.tool, parsed.command.args, {
            threadId: state.session.threadId,
            turnId,
            toolCallId,
            runtimeMode: input.settings.defaultRuntimeMode,
            sandboxMode: input.settings.sandboxMode,
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
          if (result.artifactId) state.toolArtifacts.push(result.artifactId);
          state.turns
            .find((turn) => turn.id === turnId)
            ?.items.push({ toolCallId, tool: parsed.command.tool, result });
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
              title: parsed.command.tool,
              detail: formatToolActivityDetail(parsed.command.tool, result),
              data: result.data,
            },
          } as ProviderRuntimeEvent);
          state.messages.push({
            role: "user",
            content: formatToolResultForModel({
              tool: parsed.command.tool,
              ok: result.ok,
              content: result.content,
            }),
          });
        } catch (error) {
          const message = formatCustomAgentRuntimeError(error);
          await emit({
            type: "item.completed",
            ...eventBase({
              instanceId: input.instanceId,
              threadId: state.session.threadId,
              turnId,
              itemId: toolCallId,
            }),
            payload: { itemType, status: "failed", title: parsed.command.tool, detail: message },
          } as ProviderRuntimeEvent);
          state.messages.push({
            role: "user",
            content: formatToolResultForModel({
              tool: parsed.command.tool,
              ok: false,
              content: message,
            }),
          });
        } finally {
          state.activeToolCalls.delete(toolCallId);
        }
      }
      throw new Error("Tool step limit exceeded.");
    } catch (error) {
      const message = formatCustomAgentRuntimeError(error);
      await emitRuntimeError(state.session.threadId, turnId, message);
      await emit({
        type: "turn.completed",
        ...eventBase({ instanceId: input.instanceId, threadId: state.session.threadId, turnId }),
        payload: {
          state: state.activeAbort?.signal.aborted ? "interrupted" : "failed",
          errorMessage: message,
        },
      } as ProviderRuntimeEvent);
      state.session = {
        ...state.session,
        status: "error",
        activeTurnId: undefined,
        lastError: message,
        updatedAt: nowIso(),
      };
      state.activeTurnId = undefined;
    }
  }

  return {
    settings: input.settings,
    workspaceRoot: input.workspaceRoot,
    contextStore,
    tools,
    events,
    startSession: async (sessionInput) => {
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: input.instanceId,
        status: "ready",
        runtimeMode: sessionInput.runtimeMode,
        cwd: sessionInput.cwd ?? input.workspaceRoot,
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
      state.turns.push({ id: turnId, items: [] });
      state.session = {
        ...state.session,
        status: "running",
        activeTurnId: turnId,
        model: turnInput.modelSelection?.model ?? state.session.model,
        updatedAt: nowIso(),
      };
      void runTurn(state, turnInput.input ?? "", turnId);
      return { threadId: turnInput.threadId, turnId } satisfies ProviderTurnStartResult;
    },
    interruptTurn: async (threadId, turnId) => {
      const state = getSession(threadId);
      if (!turnId || state.activeTurnId === turnId) state.activeAbort?.abort();
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
      state.activeAbort?.abort();
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
      await Promise.all(
        [...sessions.keys()].map((threadId) => getSession(threadId).activeAbort?.abort()),
      );
      sessions.clear();
    },
  };
}
