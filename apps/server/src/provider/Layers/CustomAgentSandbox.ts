import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CustomAgentSettings } from "@t3tools/contracts";
import { reduceCustomAgentOutput } from "./CustomAgentOutputReducer.ts";
import type { CustomAgentContextStore } from "./CustomAgentContextStore.ts";

const execFileAsync = promisify(execFile);

export type CustomAgentRiskLevel = "low" | "mutation" | "network" | "destructive" | "sensitive";

export interface CustomAgentCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutPreview: string;
  readonly stderrPreview: string;
  readonly stdoutArtifactId?: string | undefined;
  readonly stderrArtifactId?: string | undefined;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly riskLevel: CustomAgentRiskLevel;
  readonly riskReasons: ReadonlyArray<string>;
}

export class CustomAgentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomAgentPolicyError";
  }
}

function splitPathList(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

export function resolveCustomAgentWorkspace(
  settings: CustomAgentSettings,
  fallbackCwd: string,
): string {
  return path.resolve(settings.workspaceRoot || fallbackCwd);
}

export function normalizeCustomAgentPath(
  settings: CustomAgentSettings,
  workspaceRoot: string,
  inputPath: string,
): string {
  const resolved = path.resolve(workspaceRoot, inputPath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    const allowed = splitPathList(settings.allowedPaths);
    const blocked = splitPathList(settings.blockedPaths);
    const normalizedRelative = relative || ".";
    if (
      allowed.length > 0 &&
      !allowed.some(
        (entry) =>
          normalizedRelative === entry ||
          normalizedRelative.startsWith(`${entry.replace(/\/$/, "")}/`),
      )
    ) {
      throw new CustomAgentPolicyError(`Path is not allowed by policy: ${inputPath}`);
    }
    if (
      blocked.some(
        (entry) =>
          normalizedRelative === entry ||
          normalizedRelative.startsWith(`${entry.replace(/\/$/, "")}/`),
      )
    ) {
      throw new CustomAgentPolicyError(`Path is blocked by policy: ${inputPath}`);
    }
    try {
      const realWorkspace = realpathSync(workspaceRoot);
      const existing = lstatSync(resolved).isSymbolicLink() ? realpathSync(resolved) : resolved;
      const realRelative = path.relative(realWorkspace, existing);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative))
        throw new CustomAgentPolicyError(`Symlink escapes workspace: ${inputPath}`);
    } catch (error) {
      if (error instanceof CustomAgentPolicyError) throw error;
    }
    return resolved;
  }
  if (settings.sandboxMode === "danger-full-access") return resolved;
  throw new CustomAgentPolicyError(`Path escapes workspace: ${inputPath}`);
}

export function classifyCustomAgentCommand(
  settings: CustomAgentSettings,
  command: string,
): { riskLevel: CustomAgentRiskLevel; reasons: ReadonlyArray<string>; blocked: boolean } {
  const lower = command.toLowerCase();
  const reasons: string[] = [];
  let riskLevel: CustomAgentRiskLevel = "low";
  const blockedPatterns = [
    /\brm\s+-[^\n]*r[f]?\b/,
    /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push)\b/,
    /\b(chmod|chown)\s+(-r|--recursive)\b/,
    /\b(mkfs|dd\s+if=|shutdown|reboot|sudo|su\b)\b/,
    /\b(npm|pnpm|yarn|bun)\s+publish\b/,
    /\b(cat|grep|rg|find)\b[^\n]*(\.ssh|id_rsa|wallet|cookies|keychain)/,
  ];
  if (blockedPatterns.some((pattern) => pattern.test(lower))) {
    riskLevel = "destructive";
    reasons.push("Command matches destructive or credential-access pattern.");
  }
  if (/\b(curl|wget|ssh|scp|rsync|nc|netcat)\b/.test(lower)) {
    riskLevel = settings.networkPolicy === "deny" ? "destructive" : "network";
    reasons.push("Command may use network access.");
  }
  if (/\b(touch|mv|cp|rm|mkdir|sed\s+-i|perl\s+-pi|git\s+commit)\b/.test(lower)) {
    riskLevel = riskLevel === "low" ? "mutation" : riskLevel;
    reasons.push("Command may mutate files or repository state.");
  }
  if (
    settings.allowedCommands.length > 0 &&
    !settings.allowedCommands.some((allowed) => lower.startsWith(allowed.toLowerCase()))
  ) {
    reasons.push("Command is not in allowlist.");
    return { riskLevel: "destructive", reasons, blocked: true };
  }
  if (settings.blockedCommands.some((blocked) => lower.includes(blocked.toLowerCase()))) {
    reasons.push("Command is blocked by provider settings.");
    return { riskLevel: "destructive", reasons, blocked: true };
  }
  if (settings.networkPolicy === "deny" && reasons.includes("Command may use network access."))
    return { riskLevel, reasons, blocked: true };
  return { riskLevel, reasons, blocked: riskLevel === "destructive" };
}

export function sanitizeCustomAgentEnv(env: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const deny =
    /(api|token|secret|key|password|credential|private|ssh|github|npm|aws|gcp|azure|database|bearer)/i;
  const clean: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG,
  };
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!deny.test(key)) clean[key] = value;
  }
  return clean;
}

export async function makeCustomAgentTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "t3-custom-agent-"));
}

export async function runCustomAgentCommand(input: {
  readonly settings: CustomAgentSettings;
  readonly contextStore: CustomAgentContextStore;
  readonly threadId: string;
  readonly turnId?: string | undefined;
  readonly toolCallId: string;
  readonly workspaceRoot: string;
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly env?: Record<string, string> | undefined;
}): Promise<CustomAgentCommandResult> {
  const risk = classifyCustomAgentCommand(input.settings, input.command);
  if (risk.blocked) throw new CustomAgentPolicyError(`Command blocked: ${risk.reasons.join(" ")}`);
  const cwd = normalizeCustomAgentPath(input.settings, input.workspaceRoot, input.cwd ?? ".");
  const started = Date.now();
  let timedOut = false;
  try {
    const result = await execFileAsync("/bin/sh", ["-lc", input.command], {
      cwd,
      env: sanitizeCustomAgentEnv(input.env),
      timeout: input.timeoutMs ?? input.settings.commandTimeoutMs,
      maxBuffer: input.maxOutputBytes ?? input.settings.maxToolOutputBytes,
      windowsHide: true,
    });
    const stdoutReduced = reduceCustomAgentOutput({
      raw: result.stdout,
      toolName: "run_command.stdout",
      purpose: "command stdout",
      settings: input.settings,
    });
    const stderrReduced = reduceCustomAgentOutput({
      raw: result.stderr,
      toolName: "run_command.stderr",
      purpose: "command stderr",
      settings: input.settings,
    });
    const stdoutArtifact = input.contextStore.storeArtifact({
      threadId: input.threadId as never,
      turnId: input.turnId as never,
      toolCallId: input.toolCallId,
      kind: "command.stdout",
      command: input.command,
      content: result.stdout,
      summary: stdoutReduced.summary,
      preview: stdoutReduced.preview,
      sensitive: false,
      truncated: stdoutReduced.truncated,
      metadata: { cwd },
    });
    const stderrArtifact = input.contextStore.storeArtifact({
      threadId: input.threadId as never,
      turnId: input.turnId as never,
      toolCallId: input.toolCallId,
      kind: "command.stderr",
      command: input.command,
      content: result.stderr,
      summary: stderrReduced.summary,
      preview: stderrReduced.preview,
      sensitive: false,
      truncated: stderrReduced.truncated,
      metadata: { cwd },
    });
    return {
      exitCode: 0,
      signal: null,
      stdoutPreview: stdoutReduced.preview,
      stderrPreview: stderrReduced.preview,
      stdoutArtifactId: stdoutArtifact.id,
      stderrArtifactId: stderrArtifact.id,
      durationMs: Date.now() - started,
      truncated: stdoutReduced.truncated || stderrReduced.truncated,
      timedOut,
      riskLevel: risk.riskLevel,
      riskReasons: risk.reasons,
    };
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: NodeJS.Signals;
      killed?: boolean;
    };
    timedOut = error.killed === true || error.code === "ETIMEDOUT";
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : String(error.message ?? error);
    const stdoutReduced = reduceCustomAgentOutput({
      raw: stdout,
      toolName: "run_command.stdout",
      purpose: "command stdout",
      settings: input.settings,
    });
    const stderrReduced = reduceCustomAgentOutput({
      raw: stderr,
      toolName: "run_command.stderr",
      purpose: "command stderr",
      settings: input.settings,
    });
    const stdoutArtifact = input.contextStore.storeArtifact({
      threadId: input.threadId as never,
      turnId: input.turnId as never,
      toolCallId: input.toolCallId,
      kind: "command.stdout",
      command: input.command,
      content: stdout,
      summary: stdoutReduced.summary,
      preview: stdoutReduced.preview,
      sensitive: false,
      truncated: stdoutReduced.truncated,
      metadata: { cwd },
    });
    const stderrArtifact = input.contextStore.storeArtifact({
      threadId: input.threadId as never,
      turnId: input.turnId as never,
      toolCallId: input.toolCallId,
      kind: "command.stderr",
      command: input.command,
      content: stderr,
      summary: stderrReduced.summary,
      preview: stderrReduced.preview,
      sensitive: false,
      truncated: stderrReduced.truncated,
      metadata: { cwd },
    });
    return {
      exitCode: typeof error.code === "number" ? error.code : null,
      signal: error.signal ?? null,
      stdoutPreview: stdoutReduced.preview,
      stderrPreview: stderrReduced.preview,
      stdoutArtifactId: stdoutArtifact.id,
      stderrArtifactId: stderrArtifact.id,
      durationMs: Date.now() - started,
      truncated: stdoutReduced.truncated || stderrReduced.truncated,
      timedOut,
      riskLevel: risk.riskLevel,
      riskReasons: risk.reasons,
    };
  }
}

export function newCustomAgentId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
