import { randomUUID } from "node:crypto";
import type { ThreadId, TurnId } from "@t3tools/contracts";
import { estimateCustomAgentTokens, redactCustomAgentSecrets } from "./CustomAgentOutputReducer.ts";

export interface CustomAgentArtifact {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly toolCallId?: string | undefined;
  readonly kind: string;
  readonly path?: string | undefined;
  readonly command?: string | undefined;
  readonly content: string;
  readonly summary: string;
  readonly preview: string;
  readonly tokensEstimate: number;
  readonly sensitive: boolean;
  readonly truncated: boolean;
  readonly createdAt: string;
  readonly metadata: Record<string, unknown>;
}

export interface CustomAgentContextStore {
  readonly storeArtifact: (
    input: Omit<CustomAgentArtifact, "id" | "createdAt" | "tokensEstimate">,
  ) => CustomAgentArtifact;
  readonly retrieveArtifact: (
    id: string,
    range?: { readonly start?: number; readonly end?: number },
  ) => CustomAgentArtifact | undefined;
  readonly searchArtifacts: (
    query: string,
    filters?: { readonly threadId?: ThreadId; readonly kind?: string },
  ) => ReadonlyArray<CustomAgentArtifact>;
  readonly summarizeArtifact: (id: string) => string;
  readonly recordDecision: (input: Record<string, unknown>) => void;
  readonly recordConstraint: (input: Record<string, unknown>) => void;
  readonly recordError: (input: Record<string, unknown>) => void;
  readonly recordFileTouch: (input: { readonly threadId: ThreadId; readonly path: string }) => void;
  readonly recordCommand: (input: {
    readonly threadId: ThreadId;
    readonly command: string;
    readonly exitCode: number | null;
  }) => void;
  readonly buildSessionSummary: (threadId: ThreadId) => string;
  readonly buildTurnSummary: (turnId: TurnId) => string;
  readonly buildWorkingContext: (input: {
    readonly threadId: ThreadId;
    readonly currentUserRequest: string;
    readonly maxTokens: number;
  }) => string;
}

export function makeCustomAgentContextStore(): CustomAgentContextStore {
  const artifacts = new Map<string, CustomAgentArtifact>();
  const decisions: Array<Record<string, unknown>> = [];
  const constraints: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  const fileTouches = new Map<string, Set<string>>();
  const commands = new Map<string, Array<{ command: string; exitCode: number | null }>>();

  const storeArtifact: CustomAgentContextStore["storeArtifact"] = (input) => {
    const artifact: CustomAgentArtifact = {
      ...input,
      id: `artifact_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      tokensEstimate: estimateCustomAgentTokens(input.content),
      preview: input.sensitive ? redactCustomAgentSecrets(input.preview) : input.preview,
      summary: input.sensitive ? redactCustomAgentSecrets(input.summary) : input.summary,
    };
    artifacts.set(artifact.id, artifact);
    return artifact;
  };

  return {
    storeArtifact,
    retrieveArtifact: (id, range) => {
      const artifact = artifacts.get(id);
      if (!artifact || !range) return artifact;
      const lines = artifact.content.split(/\r?\n/);
      const start = Math.max(0, (range.start ?? 1) - 1);
      const end = Math.min(lines.length, range.end ?? lines.length);
      return { ...artifact, content: lines.slice(start, end).join("\n") };
    },
    searchArtifacts: (query, filters) => {
      const q = query.toLowerCase();
      return [...artifacts.values()]
        .filter((artifact) => !filters?.threadId || artifact.threadId === filters.threadId)
        .filter((artifact) => !filters?.kind || artifact.kind === filters.kind)
        .filter((artifact) =>
          `${artifact.summary}\n${artifact.preview}\n${artifact.path ?? ""}`
            .toLowerCase()
            .includes(q),
        )
        .slice(0, 20);
    },
    summarizeArtifact: (id) => artifacts.get(id)?.summary ?? `Artifact not found: ${id}`,
    recordDecision: (input) => decisions.push(input),
    recordConstraint: (input) => constraints.push(input),
    recordError: (input) => errors.push(input),
    recordFileTouch: (input) => {
      const key = input.threadId;
      const touched = fileTouches.get(key) ?? new Set<string>();
      touched.add(input.path);
      fileTouches.set(key, touched);
    },
    recordCommand: (input) => {
      const list = commands.get(input.threadId) ?? [];
      list.push({ command: input.command, exitCode: input.exitCode });
      commands.set(input.threadId, list);
    },
    buildSessionSummary: (threadId) => {
      const touched = [...(fileTouches.get(threadId) ?? [])];
      const commandList = commands.get(threadId) ?? [];
      const sessionArtifacts = [...artifacts.values()].filter(
        (artifact) => artifact.threadId === threadId,
      );
      return [
        touched.length ? `Touched files: ${touched.join(", ")}` : undefined,
        commandList.length
          ? `Commands: ${commandList.map((c) => `${c.command} => ${c.exitCode}`).join("; ")}`
          : undefined,
        sessionArtifacts.length
          ? `Artifacts: ${sessionArtifacts
              .slice(-5)
              .map((a) => `${a.id} ${a.summary}`)
              .join("; ")}`
          : undefined,
        decisions.length
          ? `Recent decisions: ${decisions
              .slice(-3)
              .map((entry) => JSON.stringify(entry))
              .join("; ")}`
          : undefined,
        constraints.length
          ? `Constraints: ${constraints
              .slice(-3)
              .map((entry) => JSON.stringify(entry))
              .join("; ")}`
          : undefined,
        errors.length
          ? `Recent errors: ${errors
              .slice(-3)
              .map((entry) => JSON.stringify(entry))
              .join("; ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    },
    buildTurnSummary: (turnId) =>
      [...artifacts.values()]
        .filter((artifact) => artifact.turnId === turnId)
        .map((artifact) => artifact.summary)
        .join("\n"),
    buildWorkingContext: (input) => {
      const parts = [
        `Current request: ${input.currentUserRequest}`,
        input.maxTokens > 0 ? undefined : "Context budget exhausted",
        `Session summary:\n${input.currentUserRequest ? "" : ""}${[...artifacts.values()]
          .filter((artifact) => artifact.threadId === input.threadId)
          .slice(-8)
          .map((artifact) => `- ${artifact.id}: ${artifact.summary}`)
          .join("\n")}`,
      ];
      let context = parts.filter(Boolean).join("\n\n");
      while (estimateCustomAgentTokens(context) > input.maxTokens && context.length > 500)
        context = context.slice(0, Math.floor(context.length * 0.8));
      return context;
    },
  };
}
