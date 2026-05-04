import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CustomAgentSettings,
  ProviderApprovalDecision,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { reduceCustomAgentOutput } from "./CustomAgentOutputReducer.ts";
import type { CustomAgentContextStore } from "./CustomAgentContextStore.ts";
import {
  makeCustomAgentCheckpointStore,
  type CustomAgentCheckpointStore,
  customAgentHash,
} from "./CustomAgentCheckpoint.ts";
import {
  normalizeCustomAgentPath,
  runCustomAgentCommand,
  classifyCustomAgentCommand,
  newCustomAgentId,
  type CustomAgentRiskLevel,
} from "./CustomAgentSandbox.ts";
import {
  findCustomAgentFiles,
  getCustomAgentProjectContext,
  listCustomAgentFiles,
  searchCustomAgentRepo,
} from "./CustomAgentSearch.ts";
import { semanticSearchCustomAgent } from "./CustomAgentSemanticSearch.ts";
import { makeCustomAgentMcp } from "./CustomAgentMcp.ts";
import { makeCustomAgentSkillRegistry, formatSkillListForPrompt } from "./CustomAgentSkills.ts";

const execFileAsync = promisify(execFile);

export type CustomAgentToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "apply_patch"
  | "run_command"
  | "tool_batch"
  | "search_repo"
  | "find_files"
  | "semantic_search"
  | "list_files"
  | "project_context"
  | "git_status"
  | "git_diff"
  | "working_tree_summary"
  | "create_checkpoint"
  | "rollback_checkpoint"
  | "list_checkpoints"
  | "retrieve_artifact"
  | "summarize_artifact"
  | "mcp_list_servers"
  | "mcp_list_tools"
  | "mcp_call_tool"
  | "skill_list"
  | "skill_execute";

export interface CustomAgentToolResult {
  readonly ok: boolean;
  readonly content: string;
  readonly data?: unknown;
  readonly artifactId?: string | undefined;
  readonly checkpointId?: string | undefined;
  readonly diff?: string | undefined;
}

export interface CustomAgentApprovalRequest {
  readonly requestId: string;
  readonly requestType:
    | "command_execution_approval"
    | "exec_command_approval"
    | "file_read_approval"
    | "file_change_approval"
    | "apply_patch_approval"
    | "dynamic_tool_call";
  readonly toolName: CustomAgentToolName;
  readonly purpose: string;
  readonly riskSummary: string;
  readonly args: Record<string, unknown>;
  readonly affectedFiles: ReadonlyArray<string>;
  readonly policyReason: string;
}

export interface CustomAgentToolCallContext {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly toolCallId: string;
  readonly runtimeMode: "approval-required" | "auto-accept-edits" | "full-access";
  readonly sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  readonly requestApproval: (
    request: CustomAgentApprovalRequest,
  ) => Promise<ProviderApprovalDecision>;
  readonly emitDiff?: ((diff: string) => void) | undefined;
}

export interface CustomAgentToolRegistry {
  readonly names: ReadonlyArray<CustomAgentToolName>;
  readonly checkpointStore: CustomAgentCheckpointStore;
  readonly execute: (
    name: string,
    args: Record<string, unknown>,
    context: CustomAgentToolCallContext,
  ) => Promise<CustomAgentToolResult>;
  readonly requiresApproval: (
    name: CustomAgentToolName,
    args: Record<string, unknown>,
    risk: CustomAgentRiskLevel,
  ) => boolean;
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  if (typeof value === "string") return value;
  if (fallback !== "") return fallback;
  throw new Error(`Missing string argument: ${key}`);
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function rel(workspaceRoot: string, file: string): string {
  return path.relative(workspaceRoot, file) || ".";
}

async function readText(file: string): Promise<string> {
  const buffer = await readFile(file);
  if (buffer.subarray(0, 8000).includes(0)) throw new Error("Binary file refused.");
  return buffer.toString("utf8");
}

async function diffFile(
  workspaceRoot: string,
  relativePath: string,
  before: string,
  after: string,
): Promise<string> {
  const tmp = path.join(workspaceRoot, ".karsacode", "custom-agent", "tmp-diff");
  await mkdir(tmp, { recursive: true });
  const safe = createHash("sha256").update(relativePath).digest("hex");
  const oldFile = path.join(tmp, `${safe}.old`);
  const newFile = path.join(tmp, `${safe}.new`);
  await writeFile(oldFile, before, "utf8");
  await writeFile(newFile, after, "utf8");
  try {
    const result = await execFileAsync("git", ["diff", "--no-index", "--", oldFile, newFile], {
      cwd: workspaceRoot,
      maxBuffer: 1_000_000,
    });
    return result.stdout
      .replaceAll(oldFile, `a/${relativePath}`)
      .replaceAll(newFile, `b/${relativePath}`);
  } catch (error) {
    const e = error as { stdout?: string };
    return (e.stdout ?? "")
      .replaceAll(oldFile, `a/${relativePath}`)
      .replaceAll(newFile, `b/${relativePath}`);
  }
}

function parsePatchFiles(patch: string): ReadonlyArray<string> {
  const files = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^(?:---|\+\+\+)\s+(?:a|b)\/(.+)$/);
    if (match?.[1] && match[1] !== "/dev/null") files.add(match[1]);
  }
  return [...files];
}

function approvalFor(
  settings: CustomAgentSettings,
  context: CustomAgentToolCallContext,
  name: CustomAgentToolName,
  risk: CustomAgentRiskLevel,
): boolean {
  if (settings.approvalPolicy === "always") return true;
  if (settings.approvalPolicy === "never" || context.runtimeMode === "full-access") return false;
  if (
    context.runtimeMode === "approval-required" &&
    (risk === "mutation" || risk === "network" || risk === "destructive" || risk === "sensitive")
  )
    return true;
  if (settings.approvalPolicy === "on-mutation" && (risk === "mutation" || risk === "destructive"))
    return true;
  if (settings.approvalPolicy === "on-risk" && risk !== "low") return true;
  if (context.runtimeMode === "auto-accept-edits" && name === "run_command" && risk !== "low")
    return true;
  return false;
}

async function maybeApprove(input: {
  settings: CustomAgentSettings;
  context: CustomAgentToolCallContext;
  name: CustomAgentToolName;
  risk: CustomAgentRiskLevel;
  requestType: CustomAgentApprovalRequest["requestType"];
  purpose: string;
  args: Record<string, unknown>;
  affectedFiles?: ReadonlyArray<string>;
  detail?: string;
}) {
  if (!approvalFor(input.settings, input.context, input.name, input.risk)) return;
  const decision = await input.context.requestApproval({
    requestId: newCustomAgentId("approval"),
    requestType: input.requestType,
    toolName: input.name,
    purpose: input.purpose,
    riskSummary: input.detail ?? input.risk,
    args: input.args,
    affectedFiles: input.affectedFiles ?? [],
    policyReason: `${input.settings.approvalPolicy}/${input.context.runtimeMode}`,
  });
  if (decision !== "accept" && decision !== "acceptForSession")
    throw new Error(`Approval declined for ${input.name}.`);
}

export function makeCustomAgentToolRegistry(input: {
  readonly settings: CustomAgentSettings;
  readonly workspaceRoot: string;
  readonly contextStore: CustomAgentContextStore;
  readonly checkpointStore?: CustomAgentCheckpointStore;
}): CustomAgentToolRegistry {
  const checkpointStore = input.checkpointStore ?? makeCustomAgentCheckpointStore();
  const mcp = makeCustomAgentMcp(input.settings);
  const skillRegistry = makeCustomAgentSkillRegistry();
  const names: ReadonlyArray<CustomAgentToolName> = [
    "read_file",
    "write_file",
    "edit_file",
    "apply_patch",
    "run_command",
    "tool_batch",
    "search_repo",
    "find_files",
    "semantic_search",
    "list_files",
    "project_context",
    "git_status",
    "git_diff",
    "working_tree_summary",
    "create_checkpoint",
    "rollback_checkpoint",
    "list_checkpoints",
    "retrieve_artifact",
    "summarize_artifact",
    "mcp_list_servers",
    "mcp_list_tools",
    "mcp_call_tool",
    "skill_list",
    "skill_execute",
  ];

  async function execute(
    nameRaw: string,
    args: Record<string, unknown>,
    context: CustomAgentToolCallContext,
  ): Promise<CustomAgentToolResult> {
    if (!names.includes(nameRaw as CustomAgentToolName))
      return { ok: false, content: `Unknown tool: ${nameRaw}` };
    const name = nameRaw as CustomAgentToolName;
    const purpose = stringArg(args, "purpose", "tool call");
    if (name === "read_file") {
      const file = normalizeCustomAgentPath(
        input.settings,
        input.workspaceRoot,
        stringArg(args, "path"),
      );
      const relative = rel(input.workspaceRoot, file);
      const sensitive = /(^|\/)(\.env|\.ssh|id_rsa|secrets?|credentials?)(\/|$)/i.test(relative);
      await maybeApprove({
        settings: input.settings,
        context,
        name,
        risk: sensitive ? "sensitive" : "low",
        requestType: "file_read_approval",
        purpose,
        args,
        affectedFiles: [relative],
      });
      const info = await stat(file);
      const content = await readText(file);
      const start = Math.max(1, numberArg(args, "startLine") ?? 1);
      const end = Math.min(
        content.split(/\r?\n/).length,
        numberArg(args, "endLine") ?? content.split(/\r?\n/).length,
      );
      const maxBytes = numberArg(args, "maxBytes") ?? input.settings.maxFileReadBytes;
      const lines = content
        .split(/\r?\n/)
        .slice(start - 1, end)
        .join("\n");
      const reduced = reduceCustomAgentOutput({
        raw:
          info.size > input.settings.maxFileReadBytes && !args.startLine
            ? content.split(/\r?\n/).slice(0, 200).join("\n")
            : lines,
        toolName: name,
        purpose,
        settings: input.settings,
        maxPreviewBytes: maxBytes,
      });
      const artifact = input.contextStore.storeArtifact({
        threadId: context.threadId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        kind: "file.read",
        path: relative,
        content,
        summary: reduced.summary,
        preview: reduced.preview,
        sensitive,
        truncated: reduced.truncated,
        metadata: { startLine: start, endLine: end },
      });
      return {
        ok: true,
        content: JSON.stringify({
          path: relative,
          lineRange: [start, end],
          preview: reduced.preview,
          truncated: reduced.truncated,
          artifactId: artifact.id,
        }),
        artifactId: artifact.id,
        data: { path: relative, startLine: start, endLine: end },
      };
    }
    if (name === "list_files") {
      const listInput: Parameters<typeof listCustomAgentFiles>[0] = {
        settings: input.settings,
        workspaceRoot: input.workspaceRoot,
      };
      if (typeof args.path === "string") listInput.path = args.path;
      if (typeof args.glob === "string") listInput.glob = args.glob;
      const listMaxResults = numberArg(args, "maxResults");
      if (listMaxResults !== undefined) listInput.maxResults = listMaxResults;
      const includeHidden = boolArg(args, "includeHidden");
      if (includeHidden !== undefined) listInput.includeHidden = includeHidden;
      const listed = await listCustomAgentFiles(listInput);
      const artifact = input.contextStore.storeArtifact({
        threadId: context.threadId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        kind: "file.list",
        content: listed.raw,
        summary: listed.summary,
        preview: listed.files.slice(0, 100).join("\n"),
        sensitive: false,
        truncated: listed.files.length > 100,
        metadata: {},
      });
      return {
        ok: true,
        content: JSON.stringify({
          summary: listed.summary,
          files: listed.files.slice(0, 100),
          artifactId: artifact.id,
        }),
        artifactId: artifact.id,
      };
    }
    if (name === "project_context") {
      const maxFiles = numberArg(args, "maxFiles");
      const result = await getCustomAgentProjectContext({
        settings: input.settings,
        workspaceRoot: input.workspaceRoot,
        ...(maxFiles !== undefined ? { maxFiles } : {}),
      });
      return {
        ok: true,
        content: JSON.stringify(result),
        data: {
          projectName: result.projectName,
          totalFiles: result.totalFiles,
          extensions: result.extensions,
          projectSignals: result.projectSignals,
        },
      };
    }
    if (name === "find_files") {
      const findInput: Parameters<typeof findCustomAgentFiles>[0] = {
        settings: input.settings,
        workspaceRoot: input.workspaceRoot,
      };
      if (typeof args.query === "string") findInput.query = args.query;
      if (typeof args.extension === "string") findInput.extension = args.extension;
      if (typeof args.path === "string") findInput.path = args.path;
      const maxResults = numberArg(args, "maxResults");
      if (maxResults !== undefined) findInput.maxResults = maxResults;
      const result = await findCustomAgentFiles(findInput);
      const artifact = input.contextStore.storeArtifact({
        threadId: context.threadId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        kind: "file.find",
        content: result.files.join("\n"),
        summary: result.summary,
        preview: result.files.slice(0, 80).join("\n"),
        sensitive: false,
        truncated: result.totalMatches > result.files.length,
        metadata: { query: args.query, extension: args.extension },
      });
      return {
        ok: true,
        content: JSON.stringify({ ...result, artifactId: artifact.id }),
        artifactId: artifact.id,
      };
    }
    if (name === "search_repo") {
      const searchInput: Parameters<typeof searchCustomAgentRepo>[0] = {
        settings: input.settings,
        workspaceRoot: input.workspaceRoot,
        query: stringArg(args, "query"),
      };
      if (typeof args.path === "string") searchInput.path = args.path;
      if (typeof args.glob === "string") searchInput.glob = args.glob;
      const regex = boolArg(args, "regex");
      if (regex !== undefined) searchInput.regex = regex;
      const caseSensitive = boolArg(args, "caseSensitive");
      if (caseSensitive !== undefined) searchInput.caseSensitive = caseSensitive;
      const maxResults = numberArg(args, "maxResults");
      if (maxResults !== undefined) searchInput.maxResults = maxResults;
      const contextLines = numberArg(args, "contextLines");
      if (contextLines !== undefined) searchInput.contextLines = contextLines;
      const result = await searchCustomAgentRepo(searchInput);
      const artifact = input.contextStore.storeArtifact({
        threadId: context.threadId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        kind: "search.repo",
        content: result.raw,
        summary: `${result.totalMatches} matches in ${result.topFiles.length} top files`,
        preview: result.snippets.map((s) => `${s.path}:${s.line}: ${s.text}`).join("\n"),
        sensitive: false,
        truncated: result.totalMatches > result.snippets.length,
        metadata: { query: args.query },
      });
      return {
        ok: true,
        content: JSON.stringify({
          totalMatches: result.totalMatches,
          topFiles: result.topFiles,
          snippets: result.snippets,
          suggestedReads: result.suggestedReads,
          artifactId: artifact.id,
        }),
        artifactId: artifact.id,
      };
    }
    if (name === "semantic_search") {
      const semanticInput: Parameters<typeof semanticSearchCustomAgent>[0] = {
        settings: input.settings,
        workspaceRoot: input.workspaceRoot,
        query: stringArg(args, "query"),
      };
      if (typeof args.path === "string") semanticInput.path = args.path;
      if (typeof args.glob === "string") semanticInput.glob = args.glob;
      const maxResults = numberArg(args, "maxResults");
      if (maxResults !== undefined) semanticInput.maxResults = maxResults;
      return { ok: true, content: JSON.stringify(await semanticSearchCustomAgent(semanticInput)) };
    }
    if (name === "write_file" || name === "edit_file") {
      if (context.sandboxMode === "read-only") throw new Error("Sandbox is read-only.");
      const file = normalizeCustomAgentPath(
        input.settings,
        input.workspaceRoot,
        stringArg(args, "path"),
      );
      const relative = rel(input.workspaceRoot, file);
      const before = existsSync(file) ? await readText(file) : "";
      if (typeof args.expectedHash === "string" && customAgentHash(before) !== args.expectedHash)
        throw new Error("expectedHash does not match current file content.");
      let after: string;
      if (name === "write_file") after = stringArg(args, "content");
      else {
        if (!Array.isArray(args.edits)) throw new Error("edits must be an array.");
        after = before;
        for (const edit of args.edits as Array<Record<string, unknown>>) {
          const newText = typeof edit.newText === "string" ? edit.newText : undefined;
          if (newText === undefined) throw new Error("edit.newText is required.");
          if (typeof edit.oldText === "string") {
            const occurrences = after.split(edit.oldText).length - 1;
            if (occurrences !== 1)
              throw new Error(`Ambiguous edit: oldText matched ${occurrences} times.`);
            after = after.replace(edit.oldText, newText);
          } else if (typeof edit.startLine === "number" && typeof edit.endLine === "number") {
            const lines = after.split(/\r?\n/);
            lines.splice(
              Math.max(0, edit.startLine - 1),
              Math.max(0, edit.endLine - edit.startLine + 1),
              ...newText.split(/\r?\n/),
            );
            after = lines.join("\n");
          } else throw new Error("Each edit needs oldText or startLine/endLine.");
        }
      }
      const diff = await diffFile(input.workspaceRoot, relative, before, after);
      const checkpoint = await checkpointStore.createCheckpoint({
        threadId: context.threadId,
        turnId: context.turnId,
        purpose,
        files: [relative],
        workspaceRoot: input.workspaceRoot,
        toolCallId: context.toolCallId,
        unifiedDiff: diff,
      });
      await maybeApprove({
        settings: input.settings,
        context,
        name,
        risk: "mutation",
        requestType: "file_change_approval",
        purpose,
        args: {
          ...args,
          content:
            typeof args.content === "string" ? `<${args.content.length} chars>` : args.content,
        },
        affectedFiles: [relative],
        detail: diff.slice(0, input.settings.maxToolPreviewBytes),
      });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, after, "utf8");
      await checkpointStore.finalizeCheckpoint(checkpoint.id, input.workspaceRoot);
      input.contextStore.recordFileTouch({ threadId: context.threadId, path: relative });
      context.emitDiff?.(diff);
      return {
        ok: true,
        content: JSON.stringify({
          path: relative,
          beforeHash: customAgentHash(before),
          afterHash: customAgentHash(after),
          checkpointId: checkpoint.id,
          diffSummary: diff.slice(0, 2000),
        }),
        checkpointId: checkpoint.id,
        diff,
      };
    }
    if (name === "apply_patch") {
      if (context.sandboxMode === "read-only") throw new Error("Sandbox is read-only.");
      const patch = stringArg(args, "patch");
      const files = parsePatchFiles(patch);
      if (files.length === 0) throw new Error("Patch contains no file paths.");
      for (const file of files) {
        if (path.isAbsolute(file) || file.includes(".."))
          throw new Error(`Unsafe patch path: ${file}`);
        normalizeCustomAgentPath(input.settings, input.workspaceRoot, file);
      }
      const expected = Array.isArray(args.expectedFiles)
        ? args.expectedFiles.filter((x): x is string => typeof x === "string")
        : undefined;
      if (expected && expected.some((file) => !files.includes(file)))
        throw new Error("Patch did not include all expected files.");
      const checkpoint = await checkpointStore.createCheckpoint({
        threadId: context.threadId,
        turnId: context.turnId,
        purpose,
        files,
        workspaceRoot: input.workspaceRoot,
        toolCallId: context.toolCallId,
        unifiedDiff: patch,
      });
      await maybeApprove({
        settings: input.settings,
        context,
        name,
        risk: "mutation",
        requestType: "apply_patch_approval",
        purpose,
        args: { patch: patch.slice(0, input.settings.maxToolPreviewBytes) },
        affectedFiles: files,
        detail: patch.slice(0, input.settings.maxToolPreviewBytes),
      });
      try {
        await execFileAsync("git", ["apply", "--whitespace=nowarn", "-"], {
          cwd: input.workspaceRoot,
          input: patch,
        } as never);
      } catch (error) {
        throw new Error(`Failed to apply patch: ${String((error as Error).message ?? error)}`, {
          cause: error,
        });
      }
      await checkpointStore.finalizeCheckpoint(checkpoint.id, input.workspaceRoot);
      context.emitDiff?.(patch);
      return {
        ok: true,
        content: JSON.stringify({
          files,
          checkpointId: checkpoint.id,
          patchPreview: patch.slice(0, 2000),
        }),
        checkpointId: checkpoint.id,
        diff: patch,
      };
    }
    if (name === "run_command") {
      const command = stringArg(args, "command");
      const risk = classifyCustomAgentCommand(input.settings, command);
      await maybeApprove({
        settings: input.settings,
        context,
        name,
        risk: risk.riskLevel,
        requestType: "exec_command_approval",
        purpose,
        args,
        detail: risk.reasons.join(" ") || command,
      });
      const result = await runCustomAgentCommand({
        settings: input.settings,
        contextStore: input.contextStore,
        threadId: context.threadId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        workspaceRoot: input.workspaceRoot,
        command,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        timeoutMs: numberArg(args, "timeoutMs"),
        maxOutputBytes: numberArg(args, "maxOutputBytes"),
        env:
          typeof args.env === "object" && args.env && !Array.isArray(args.env)
            ? (args.env as Record<string, string>)
            : undefined,
      });
      input.contextStore.recordCommand({
        threadId: context.threadId,
        command,
        exitCode: result.exitCode,
      });
      return { ok: true, content: JSON.stringify(result), data: result };
    }
    if (name === "tool_batch") {
      const calls = Array.isArray(args.calls)
        ? args.calls.filter((call): call is Record<string, unknown> => {
            return typeof call === "object" && call !== null && !Array.isArray(call);
          })
        : [];
      const allowedBatchTools = new Set<CustomAgentToolName>([
        "project_context",
        "find_files",
        "list_files",
        "search_repo",
        "semantic_search",
        "read_file",
        "git_status",
        "git_diff",
        "working_tree_summary",
        "summarize_artifact",
      ]);
      if (calls.length === 0) return { ok: false, content: "tool_batch needs non-empty calls." };
      const results: Array<{ tool: string; ok: boolean; content: string; artifactId?: string }> =
        [];
      for (const [index, call] of calls.slice(0, 6).entries()) {
        const tool = typeof call.tool === "string" ? call.tool : "";
        const callArgs =
          typeof call.args === "object" && call.args !== null && !Array.isArray(call.args)
            ? (call.args as Record<string, unknown>)
            : {};
        if (!allowedBatchTools.has(tool as CustomAgentToolName)) {
          results.push({ tool, ok: false, content: "Tool is not allowed in read-only batch." });
          continue;
        }
        const childResult = await execute(
          tool,
          { ...callArgs, purpose: String(callArgs.purpose ?? `batch step ${index + 1}`) },
          { ...context, toolCallId: `${context.toolCallId}_${index + 1}` },
        );
        results.push({
          tool,
          ok: childResult.ok,
          content: childResult.content.slice(0, input.settings.maxToolPreviewBytes),
          ...(childResult.artifactId ? { artifactId: childResult.artifactId } : {}),
        });
      }
      return {
        ok: results.every((result) => result.ok),
        content: JSON.stringify({ results, truncatedToCalls: Math.min(calls.length, 6) }),
      };
    }
    if (name === "git_status" || name === "git_diff" || name === "working_tree_summary") {
      const command =
        name === "git_status"
          ? "git status --porcelain=v1 -b"
          : name === "git_diff"
            ? "printf '== unstaged diff stat ==\\n'; git diff --stat; printf '\\n== unstaged compact summary ==\\n'; git diff --compact-summary; printf '\\n== staged diff stat ==\\n'; git diff --cached --stat; printf '\\n== staged compact summary ==\\n'; git diff --cached --compact-summary"
            : "printf '== status ==\\n'; git status --short; printf '\\n== unstaged diff stat ==\\n'; git diff --stat; printf '\\n== staged diff stat ==\\n'; git diff --cached --stat";
      const result = await runCustomAgentCommand({
        settings: { ...input.settings, blockedCommands: [] },
        contextStore: input.contextStore,
        threadId: context.threadId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        workspaceRoot: input.workspaceRoot,
        command,
        timeoutMs: 10000,
      });
      return { ok: true, content: JSON.stringify(result), data: result };
    }
    if (name === "create_checkpoint") {
      const files = Array.isArray(args.files)
        ? args.files.filter((x): x is string => typeof x === "string")
        : [];
      const checkpoint = await checkpointStore.createCheckpoint({
        threadId: context.threadId,
        turnId: context.turnId,
        purpose,
        files,
        workspaceRoot: input.workspaceRoot,
        toolCallId: context.toolCallId,
      });
      return { ok: true, content: JSON.stringify(checkpoint), checkpointId: checkpoint.id };
    }
    if (name === "rollback_checkpoint") {
      await maybeApprove({
        settings: input.settings,
        context,
        name,
        risk: "mutation",
        requestType: "file_change_approval",
        purpose,
        args,
        detail: "Rollback overwrites current files.",
      });
      const checkpoint = await checkpointStore.rollbackCheckpoint(
        stringArg(args, "checkpointId"),
        input.workspaceRoot,
      );
      return { ok: true, content: JSON.stringify(checkpoint), checkpointId: checkpoint.id };
    }
    if (name === "list_checkpoints")
      return {
        ok: true,
        content: JSON.stringify(checkpointStore.listCheckpoints(context.threadId)),
      };
    if (name === "retrieve_artifact") {
      const range: { start?: number; end?: number } = {};
      const start = numberArg(args, "start");
      if (start !== undefined) range.start = start;
      const end = numberArg(args, "end");
      if (end !== undefined) range.end = end;
      const artifact = input.contextStore.retrieveArtifact(stringArg(args, "artifactId"), range);
      return artifact
        ? {
            ok: true,
            content: JSON.stringify({
              ...artifact,
              content: artifact.sensitive ? "[sensitive artifact omitted]" : artifact.content,
            }),
          }
        : { ok: false, content: "Artifact not found." };
    }
    if (name === "summarize_artifact")
      return {
        ok: true,
        content: input.contextStore.summarizeArtifact(stringArg(args, "artifactId")),
      };
    if (name === "mcp_list_servers")
      return { ok: true, content: JSON.stringify(await mcp.listServers()) };
    if (name === "mcp_list_tools")
      return {
        ok: true,
        content: JSON.stringify(
          await mcp.listTools(typeof args.server === "string" ? args.server : undefined),
        ),
      };
    if (name === "mcp_call_tool") {
      await maybeApprove({
        settings: input.settings,
        context,
        name,
        risk: mcp.classifyRisk(stringArg(args, "server"), stringArg(args, "tool"), args.args),
        requestType: "dynamic_tool_call",
        purpose,
        args,
      });
      return {
        ok: true,
        content: JSON.stringify(
          await mcp.callTool(stringArg(args, "server"), stringArg(args, "tool"), args.args),
        ),
      };
    }
    if (name === "skill_list") {
      const list = skillRegistry.list();
      return {
        ok: true,
        content: [
          `Available skills (${list.length}):`,
          "",
          formatSkillListForPrompt(list),
          "",
          'To execute a skill, use tool_call with tool="skill_execute" and args={"skillId": "...", "args": {...}, "purpose": "..."}',
        ].join("\n"),
      };
    }
    if (name === "skill_execute") {
      const skillId = stringArg(args, "skillId");
      const skillArgs =
        typeof args.args === "object" && args.args !== null
          ? (args.args as Record<string, unknown>)
          : {};
      const skillCtx = {
        workspaceRoot: input.workspaceRoot,
        settings: input.settings,
        contextStore: input.contextStore,
      };
      const result = await skillRegistry.execute(skillId, skillArgs, skillCtx);
      return {
        ok: result.ok,
        content: result.content,
      };
    }
    return { ok: false, content: `Unhandled tool: ${name}` };
  }

  return {
    names,
    checkpointStore,
    execute,
    requiresApproval: (name, args, risk) =>
      approvalFor(
        input.settings,
        {
          runtimeMode: input.settings.defaultRuntimeMode,
          sandboxMode: input.settings.sandboxMode,
        } as CustomAgentToolCallContext,
        name,
        risk,
      ),
  };
}
