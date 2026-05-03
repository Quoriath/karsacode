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
const MAX_TOOL_STEPS = 24;
const MAX_INVALID_TOOL_CALLS = 3;

function formatCustomAgentRuntimeError(error: unknown): string {
  const message = String((error as Error).message ?? error);
  return message.startsWith("Failed to reach Custom Agent API endpoint:") ||
    message.startsWith("Custom Agent API error") ||
    message.startsWith("Custom Agent API returned invalid JSON")
    ? message
    : `Custom Agent runtime error: ${message}`;
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

async function completeCustomAgentModel(
  backend: CustomAgentLlmBackend,
  input: {
    readonly messages: ReadonlyArray<CustomAgentChatMessage>;
    readonly model: string;
  },
): Promise<string> {
  let streamed = "";
  try {
    for await (const chunk of backend.stream({ ...input, stream: true })) streamed += chunk;
    if (streamed.trim().length > 0) return streamed;
  } catch {
    streamed = "";
  }
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
    try {
      for (let step = 0; step < MAX_TOOL_STEPS; step++) {
        if (state.activeAbort?.signal.aborted) throw new Error("Turn interrupted.");
        const workingContext = contextStore.buildWorkingContext({
          threadId: state.session.threadId,
          currentUserRequest: userInput,
          maxTokens: input.settings.maxContextTokens,
        });
        const llmMessages: CustomAgentChatMessage[] = [
          {
            role: "system",
            content: runtimePrompt,
          },
          ...state.messages.slice(-20),
          { role: "system", content: `Compact working context:\n${workingContext}` },
        ];
        const output = await completeCustomAgentModel(input.backend, {
          messages: llmMessages,
          model: state.session.model ?? input.settings.model,
        });
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
          if (parsed.command.content.length > 0)
            await emit({
              type: "content.delta",
              ...eventBase({
                instanceId: input.instanceId,
                threadId: state.session.threadId,
                turnId,
                itemId: assistantItemId,
              }),
              payload: { streamKind: "assistant_text", delta: parsed.command.content },
            } as ProviderRuntimeEvent);
          state.messages.push({ role: "assistant", content: parsed.command.content });
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
              detail: result.content.slice(0, 1000),
              data: result.data,
            },
          } as ProviderRuntimeEvent);
          state.messages.push({
            role: "user",
            content: `Tool result:\n${JSON.stringify({
              tool: parsed.command.tool,
              ok: result.ok,
              result: result.content,
            })}`,
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
            content: `Tool result:\n${JSON.stringify({
              tool: parsed.command.tool,
              ok: false,
              error: message,
            })}`,
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
