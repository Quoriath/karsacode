import type {
  CustomAgentSettings,
  ProviderApprovalDecision,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { Effect, Queue, Stream } from "effect";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { CustomAgentLlmBackend } from "./CustomAgentLlmBackend.ts";
import { makeCustomAgentRuntime } from "./CustomAgentRuntime.ts";

const PROVIDER = ProviderDriverKind.make("customAgent");

type RuntimePromise<T> = Promise<T>;

function adapt<T>(
  operation: string,
  promise: RuntimePromise<T>,
): Effect.Effect<T, ProviderAdapterError> {
  return Effect.tryPromise({
    try: () => promise,
    catch: (cause) => {
      const detail = String((cause as Error).message ?? cause);
      if (detail.includes("Unknown CustomAgent thread")) {
        return new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId: detail.split(": ").at(-1) ?? "unknown",
          cause,
        });
      }
      return new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: operation,
        detail,
        cause,
      });
    },
  });
}

export const makeCustomAgentAdapter = Effect.fn("makeCustomAgentAdapter")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CustomAgentSettings;
  readonly workspaceRoot: string;
  readonly backend: CustomAgentLlmBackend;
}) {
  const events = yield* Queue.unbounded<import("@t3tools/contracts").ProviderRuntimeEvent>();
  const runtime = yield* Effect.tryPromise({
    try: () => makeCustomAgentRuntime({ ...input, events }),
    catch: (cause) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: "<init>",
        detail: String((cause as Error).message ?? cause),
        cause,
      }),
  });
  const streamEvents = Stream.fromQueue(runtime.events);
  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (sessionInput) => adapt("startSession", runtime.startSession(sessionInput)),
    sendTurn: (turnInput) => adapt("sendTurn", runtime.sendTurn(turnInput)),
    interruptTurn: (threadId, turnId) =>
      adapt("interruptTurn", runtime.interruptTurn(threadId, turnId)),
    respondToRequest: (threadId, requestId, decision: ProviderApprovalDecision) =>
      adapt("respondToRequest", runtime.respondToRequest(threadId, requestId, decision)),
    respondToUserInput: (threadId, requestId, answers) =>
      adapt("respondToUserInput", runtime.respondToUserInput(threadId, requestId, answers)),
    stopSession: (threadId) => adapt("stopSession", runtime.stopSession(threadId)),
    listSessions: () => Effect.succeed(runtime.listSessions()),
    hasSession: (threadId) => Effect.succeed(runtime.hasSession(threadId)),
    readThread: (threadId) => adapt("readThread", Promise.resolve(runtime.readThread(threadId))),
    rollbackThread: (threadId, numTurns) =>
      adapt("rollbackThread", Promise.resolve(runtime.rollbackThread(threadId, numTurns))),
    stopAll: () => adapt("stopAll", runtime.stopAll()),
    streamEvents,
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
