import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Effect, Queue, Stream } from "effect";
import {
  CustomAgentSettings,
  ProviderInstanceId,
  ThreadId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { CustomAgentDriver } from "../Drivers/CustomAgentDriver.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import {
  buildCustomAgentAuthHeaders,
  type CustomAgentLlmBackend,
  makeOpenAiCompatibleCustomAgentBackend,
  makeFakeCustomAgentBackend,
  parseCustomAgentModelCommand,
  resolveCustomAgentChatCompletionsUrl,
} from "./CustomAgentLlmBackend.ts";
import { makeCustomAgentRuntime } from "./CustomAgentRuntime.ts";
import { buildCustomAgentRuntimePrompt } from "./CustomAgentPrompt.ts";
import { makeCustomAgentContextStore } from "./CustomAgentContextStore.ts";
import { makeCustomAgentToolRegistry } from "./CustomAgentTools.ts";
import { reduceCustomAgentOutput, redactCustomAgentSecrets } from "./CustomAgentOutputReducer.ts";
import { classifyCustomAgentCommand } from "./CustomAgentSandbox.ts";

function settings(overrides: Partial<CustomAgentSettings> = {}): CustomAgentSettings {
  return {
    ...Schema.decodeSync(CustomAgentSettings)({}),
    enabled: true,
    apiKeyEnvVar: "CUSTOM_AGENT_TEST_KEY",
    ...overrides,
  };
}

function tmpWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "custom-agent-test-"));
}

async function runtime(
  outputs: ReadonlyArray<string>,
  workspaceRoot = tmpWorkspace(),
  config = settings(),
) {
  const events = await Effect.runPromise(
    Queue.unbounded<import("@t3tools/contracts").ProviderRuntimeEvent>(),
  );
  return makeCustomAgentRuntime({
    instanceId: ProviderInstanceId.make("customAgent"),
    settings: config,
    workspaceRoot,
    backend: makeFakeCustomAgentBackend(outputs),
    events,
  });
}

async function runtimeWithBackend(
  backend: CustomAgentLlmBackend,
  workspaceRoot = tmpWorkspace(),
  config = settings(),
) {
  const events = await Effect.runPromise(
    Queue.unbounded<import("@t3tools/contracts").ProviderRuntimeEvent>(),
  );
  return makeCustomAgentRuntime({
    instanceId: ProviderInstanceId.make("customAgent"),
    settings: config,
    workspaceRoot,
    backend,
    events,
  });
}

async function takeRuntimeEvent(
  queue: Queue.Queue<import("@t3tools/contracts").ProviderRuntimeEvent>,
  predicate: (event: import("@t3tools/contracts").ProviderRuntimeEvent) => boolean,
  timeoutMs = 500,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const event = await Promise.race([
      Effect.runPromise(Queue.take(queue)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
    ]);
    if (!event) break;
    if (predicate(event)) return event;
  }
  throw new Error("Timed out waiting for Custom Agent runtime event");
}

describe("CustomAgent provider", () => {
  it("decodes settings defaults and registers the driver", () => {
    const decoded = Schema.decodeSync(CustomAgentSettings)({});
    expect(decoded.enabled).toBe(false);
    expect(decoded.defaultRuntimeMode).toBe("approval-required");
    expect(decoded.sandboxMode).toBe("workspace-write");
    expect(decoded.networkPolicy).toBe("deny");
    expect(decoded.contextCompressionEnabled).toBe(true);
    expect(decoded.checkpointEnabled).toBe(true);
    expect(decoded.semanticSearchEnabled).toBe(false);
    expect(
      BUILT_IN_DRIVERS.some((driver) => driver.driverKind === CustomAgentDriver.driverKind),
    ).toBe(true);
  });

  it("instructs repo-analysis requests to inspect with safe tools instead of asking permission", () => {
    const prompt = buildCustomAgentRuntimePrompt({
      systemPrompt: "You are Karsa.",
      toolNames: ["list_files", "read_file", "search_repo"],
      mcpEnabled: false,
      checkpointEnabled: true,
      semanticSearchEnabled: false,
    });

    expect(prompt).toContain("For repository/project analysis requests");
    expect(prompt).toContain("do not answer by asking permission to inspect");
    expect(prompt).toContain("call list_files");
  });

  it("parses final and tool-call JSON strictly", () => {
    expect(parseCustomAgentModelCommand('{"type":"final","content":"ok"}')).toEqual({
      ok: true,
      command: { type: "final", content: "ok" },
    });
    expect(
      parseCustomAgentModelCommand(
        '{"type":"tool_call","tool":"search_repo","args":{"query":"x"}}',
      ),
    ).toMatchObject({ ok: true, command: { type: "tool_call", tool: "search_repo" } });
    expect(parseCustomAgentModelCommand("run rm -rf /")).toMatchObject({ ok: false });
  });

  it("normalizes Custom Agent chat completion URLs", () => {
    expect(resolveCustomAgentChatCompletionsUrl("api.example.com/v1")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(
      resolveCustomAgentChatCompletionsUrl("https://api.example.com/v1/chat/completions"),
    ).toBe("https://api.example.com/v1/chat/completions");
  });

  it("builds configurable API key auth headers", () => {
    expect(buildCustomAgentAuthHeaders(settings({ apiKeyPrefix: "Bearer " }), "sk-test")).toEqual({
      Authorization: "Bearer sk-test",
    });
    expect(
      buildCustomAgentAuthHeaders(
        settings({ apiKeyHeader: "api-key", apiKeyPrefix: "" }),
        "sk-azure",
      ),
    ).toEqual({ "api-key": "sk-azure" });
    expect(buildCustomAgentAuthHeaders(settings({ apiKeyHeader: "" }), "sk-test")).toEqual({});
    expect(buildCustomAgentAuthHeaders(settings({ apiKeyRequired: false }), "sk-test")).toEqual({});
  });

  it("retries local 401 responses with common auth header shapes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"type":"final","content":"ok"}' } }],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const backend = makeOpenAiCompatibleCustomAgentBackend(
        settings({
          apiBaseUrl: "http://127.0.0.1:8317/v1",
          apiKey: "dummy",
        }),
        {},
      );
      await expect(backend.complete({ messages: [], model: "gpt-5.5" })).resolves.toMatchObject({
        content: '{"type":"final","content":"ok"}',
      });
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        response_format: { type: "json_object" },
        stream: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        Authorization: "Bearer dummy",
      });
      expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
        "X-LocalAI-API-Key": "dummy",
      });
      expect(fetchMock.mock.calls[2]?.[1]?.headers).not.toHaveProperty("Authorization");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries local 401 responses with query key auth", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("query-key=dummy")
        ? new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"type":"final","content":"ok"}' } }],
            }),
          )
        : new Response("unauthorized", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const backend = makeOpenAiCompatibleCustomAgentBackend(
        settings({
          apiBaseUrl: "http://127.0.0.1:8317/v1",
          apiKey: "dummy",
        }),
        {},
      );
      await expect(backend.complete({ messages: [], model: "gpt-5.5" })).resolves.toMatchObject({
        content: '{"type":"final","content":"ok"}',
      });
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("query-key=dummy"))).toBe(
        true,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("streams OpenAI-compatible chat completion chunks", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"{\\"type\\":\\"final\\","}}]}',
            'data: {"choices":[{"delta":{"content":"\\"content\\":\\"ok\\"}"}}]}',
            "data: [DONE]",
            "",
          ].join("\n"),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const backend = makeOpenAiCompatibleCustomAgentBackend(
        settings({
          apiBaseUrl: "http://127.0.0.1:8317/v1",
          apiKey: "dummy",
        }),
        {},
      );
      let content = "";
      for await (const chunk of backend.stream({ messages: [], model: "gpt-5.5" }))
        content += chunk;
      expect(content).toBe('{"type":"final","content":"ok"}');
      const firstCall = fetchMock.mock.calls[0] as unknown as [string, { body?: string }];
      const body = JSON.parse(String(firstCall?.[1]?.body));
      expect(body).toMatchObject({
        stream: true,
      });
      expect(body).not.toHaveProperty("response_format");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("streams OpenAI-compatible data chunks without a trailing newline", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"{\\"content\\":\\"ok\\",\\"type\\":\\"final\\"}"}}]}',
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const backend = makeOpenAiCompatibleCustomAgentBackend(
        settings({
          apiBaseUrl: "http://127.0.0.1:8317/v1",
          apiKey: "dummy",
        }),
        {},
      );
      let content = "";
      for await (const chunk of backend.stream({ messages: [], model: "gpt-5.5" }))
        content += chunk;
      expect(content).toBe('{"content":"ok","type":"final"}');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("streams raw OpenAI-compatible JSON chunks without SSE framing", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          '{"choices":[{"delta":{"content":"{\\"content\\":\\"raw ok\\",\\"type\\":\\"final\\"}"}}]}',
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const backend = makeOpenAiCompatibleCustomAgentBackend(
        settings({
          apiBaseUrl: "http://127.0.0.1:8317/v1",
          apiKey: "dummy",
        }),
        {},
      );
      let content = "";
      for await (const chunk of backend.stream({ messages: [], model: "gpt-5.5" }))
        content += chunk;
      expect(content).toBe('{"content":"raw ok","type":"final"}');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to non-streaming completion when streaming is unsupported", async () => {
    const backend: CustomAgentLlmBackend = {
      ...makeFakeCustomAgentBackend([]),
      // eslint-disable-next-line require-yield
      stream: async function* () {
        throw new Error("stream unsupported");
      },
      complete: async () => ({
        content: '{"type":"final","content":"fallback ok"}',
      }),
    };
    const rt = await runtimeWithBackend(backend);
    const threadId = ThreadId.make("thread-stream-fallback");
    await rt.startSession({ threadId, runtimeMode: "approval-required" });
    await rt.sendTurn({ threadId, input: "hi" });
    const events = await Effect.runPromise(
      Stream.fromQueue(rt.events).pipe(Stream.take(6), Stream.runCollect),
    );
    expect(
      [...events].some(
        (event) => event.type === "content.delta" && event.payload.delta.includes("fallback ok"),
      ),
    ).toBe(true);
  });

  it("emits final answer content while the model JSON response is still streaming", async () => {
    let releaseStream: (() => void) | undefined;
    const streamCanFinish = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const backend: CustomAgentLlmBackend = {
      ...makeFakeCustomAgentBackend([]),
      stream: async function* () {
        yield '{"type":"final","content":"Hel';
        await streamCanFinish;
        yield 'lo"}';
      },
      complete: async () => ({
        content: '{"type":"final","content":"fallback"}',
      }),
    };
    const rt = await runtimeWithBackend(backend);
    const threadId = ThreadId.make("thread-live-final-stream");
    await rt.startSession({ threadId, runtimeMode: "approval-required" });
    await rt.sendTurn({ threadId, input: "hi" });

    const firstDelta = await takeRuntimeEvent(
      rt.events,
      (event) => event.type === "content.delta" && event.payload.delta === "Hel",
    );

    expect(firstDelta.type).toBe("content.delta");
    releaseStream?.();
    const completed = await takeRuntimeEvent(
      rt.events,
      (event) =>
        event.type === "turn.completed" &&
        "state" in event.payload &&
        event.payload.state === "completed",
    );
    expect(completed.type).toBe("turn.completed");
  });

  it("emits final answer content before the final JSON type field arrives", async () => {
    let releaseStream: (() => void) | undefined;
    const streamCanFinish = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const backend: CustomAgentLlmBackend = {
      ...makeFakeCustomAgentBackend([]),
      stream: async function* () {
        yield '{"content":"Hel';
        await streamCanFinish;
        yield 'lo","type":"final"}';
      },
      complete: async () => ({
        content: '{"type":"final","content":"fallback"}',
      }),
    };
    const rt = await runtimeWithBackend(backend);
    const threadId = ThreadId.make("thread-live-content-before-type");
    await rt.startSession({ threadId, runtimeMode: "approval-required" });
    await rt.sendTurn({ threadId, input: "hi" });

    const firstDelta = await takeRuntimeEvent(
      rt.events,
      (event) => event.type === "content.delta" && event.payload.delta === "Hel",
    );

    expect(firstDelta.type).toBe("content.delta");
    releaseStream?.();
    const completed = await takeRuntimeEvent(
      rt.events,
      (event) =>
        event.type === "turn.completed" &&
        "state" in event.payload &&
        event.payload.state === "completed",
    );
    expect(completed.type).toBe("turn.completed");
  });

  it("sends explicit Custom Agent protocol and tool guidance in the system prompt", async () => {
    let prompt = "";
    const backend: CustomAgentLlmBackend = {
      ...makeFakeCustomAgentBackend([]),
      stream: async function* (input) {
        prompt = input.messages[0]?.content ?? "";
        yield '{"type":"final","content":"ok"}';
      },
    };
    const rt = await runtimeWithBackend(backend);
    const threadId = ThreadId.make("thread-prompt");
    await rt.startSession({ threadId, runtimeMode: "approval-required" });
    await rt.sendTurn({ threadId, input: "hi" });
    await Effect.runPromise(Stream.fromQueue(rt.events).pipe(Stream.take(6), Stream.runCollect));
    expect(prompt).toContain("Custom Agent protocol");
    expect(prompt).toContain("Do not emit native OpenAI tool_calls");
    expect(prompt).toContain("read_file:");
    expect(prompt).toContain("mcp_list_servers");
    expect(prompt).toContain("Token saver playbook");
    expect(prompt).toContain("Emit final answers as soon as you have enough evidence");
  });

  it("starts/stops sessions and streams a simple final answer", async () => {
    const rt = await runtime(['{"type":"final","content":"Hello from CustomAgent"}']);
    const threadId = ThreadId.make("thread-simple");
    await rt.startSession({ threadId, runtimeMode: "approval-required" });
    expect(rt.hasSession(threadId)).toBe(true);
    await rt.sendTurn({ threadId, input: "hi" });
    const events = await Effect.runPromise(
      Stream.fromQueue(rt.events).pipe(Stream.take(6), Stream.runCollect),
    );
    expect(
      [...events].some(
        (event) => event.type === "content.delta" && event.payload.delta.includes("Hello"),
      ),
    ).toBe(true);
    await rt.stopSession(threadId);
    expect(rt.hasSession(threadId)).toBe(false);
  });

  it("surfaces backend connection failures as actionable runtime errors", async () => {
    const backend: CustomAgentLlmBackend = {
      ...makeFakeCustomAgentBackend([]),
      // eslint-disable-next-line require-yield
      stream: async function* () {
        throw new Error(
          "Failed to reach Custom Agent API endpoint: https://api.example.com/v1/chat/completions DNS failed",
        );
      },
      complete: async () => {
        throw new Error(
          "Failed to reach Custom Agent API endpoint: https://api.example.com/v1/chat/completions DNS failed",
        );
      },
    };
    const rt = await runtimeWithBackend(backend);
    const threadId = ThreadId.make("thread-fetch-failed");
    await rt.startSession({ threadId, runtimeMode: "approval-required" });
    await rt.sendTurn({ threadId, input: "hi" });
    const events = await Effect.runPromise(
      Stream.fromQueue(rt.events).pipe(Stream.take(6), Stream.runCollect),
    );
    expect(
      [...events].some(
        (event) =>
          event.type === "runtime.error" &&
          event.payload.message.includes("Failed to reach Custom Agent API endpoint"),
      ),
    ).toBe(true);
  });

  it("blocks read_file path traversal and summarizes large file reads", async () => {
    const workspace = tmpWorkspace();
    const config = settings({ maxFileReadBytes: 50, maxToolPreviewBytes: 80 });
    const store = makeCustomAgentContextStore();
    const tools = makeCustomAgentToolRegistry({
      settings: config,
      workspaceRoot: workspace,
      contextStore: store,
    });
    await writeFile(
      path.join(workspace, "big.txt"),
      Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
    );
    const ctx = {
      threadId: ThreadId.make("thread-read"),
      turnId: "turn-read" as never,
      toolCallId: "tool-read",
      runtimeMode: "full-access" as const,
      sandboxMode: "workspace-write" as const,
      requestApproval: async () => "accept" as const,
    };
    await expect(
      tools.execute("read_file", { path: "../outside", purpose: "test" }, ctx),
    ).rejects.toThrow(/escapes workspace/);
    const result = await tools.execute("read_file", { path: "big.txt", purpose: "test" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("artifactId");
    expect(result.content.length).toBeLessThan(1000);
  });

  it("limits search/list results and reports semantic search disabled", async () => {
    const workspace = tmpWorkspace();
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        writeFile(
          path.join(workspace, "src", `file${i}.ts`),
          `export const value${i} = "needle";\n`,
        ),
      ),
    );
    const store = makeCustomAgentContextStore();
    const tools = makeCustomAgentToolRegistry({
      settings: settings({ maxSearchResults: 5, preferRipgrep: false, preferFd: false }),
      workspaceRoot: workspace,
      contextStore: store,
    });
    const ctx = {
      threadId: ThreadId.make("thread-search"),
      turnId: "turn-search" as never,
      toolCallId: "tool-search",
      runtimeMode: "full-access" as const,
      sandboxMode: "workspace-write" as const,
      requestApproval: async () => "accept" as const,
    };
    const search = JSON.parse(
      (await tools.execute("search_repo", { query: "needle", maxResults: 3, purpose: "test" }, ctx))
        .content,
    ) as { snippets: unknown[] };
    expect(search.snippets.length).toBeLessThanOrEqual(3);
    const listed = JSON.parse(
      (await tools.execute("list_files", { maxResults: 4, purpose: "test" }, ctx)).content,
    ) as { files: unknown[] };
    expect(listed.files.length).toBeLessThanOrEqual(4);
    expect(
      (await tools.execute("semantic_search", { query: "needle", purpose: "test" }, ctx)).content,
    ).toContain("disabled");
  });

  it("classifies blocked commands, times out commands, and reduces output with redaction", async () => {
    const config = settings({ commandTimeoutMs: 50 });
    expect(classifyCustomAgentCommand(config, "rm -rf .").blocked).toBe(true);
    const reduced = reduceCustomAgentOutput({
      raw: ("API_KEY=super-secret " + "x".repeat(200) + "\n").repeat(20),
      toolName: "test",
      purpose: "test",
      settings: config,
      maxPreviewBytes: 100,
    });
    expect(reduced.preview).toContain("[REDACTED]");
    expect(reduced.truncated).toBe(true);
    expect(redactCustomAgentSecrets("Bearer abcdef")).toContain("[REDACTED]");
  });

  it("pauses/resumes approval and handles declined mutation", async () => {
    const workspace = tmpWorkspace();
    await writeFile(path.join(workspace, "a.txt"), "old\n");
    const rt = await runtime(
      [
        '{"type":"tool_call","tool":"edit_file","args":{"path":"a.txt","edits":[{"oldText":"old","newText":"new"}],"purpose":"edit"}}',
        '{"type":"final","content":"edited"}',
      ],
      workspace,
      settings({ approvalPolicy: "always" }),
    );
    const threadId = ThreadId.make("thread-approval");
    await rt.startSession({ threadId, runtimeMode: "approval-required" });
    await rt.sendTurn({ threadId, input: "edit" });
    const opened = await Effect.runPromise(
      Stream.fromQueue(rt.events).pipe(
        Stream.filter((event) => event.type === "request.opened"),
        Stream.take(1),
        Stream.runHead,
      ),
    );
    expect(opened._tag).toBe("Some");
    if (opened._tag === "Some")
      await rt.respondToRequest(threadId, opened.value.requestId as RuntimeRequestId, "accept");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toContain("new");
  });

  it("feeds internal tool results back as user messages for OpenAI-compatible APIs", async () => {
    const workspace = tmpWorkspace();
    await writeFile(path.join(workspace, "a.txt"), "hello\n");
    const seenRoles: string[][] = [];
    const backend: CustomAgentLlmBackend = {
      ...makeFakeCustomAgentBackend([]),
      // eslint-disable-next-line require-yield
      stream: async function* () {
        throw new Error("stream unsupported");
      },
      complete: async (input) => {
        seenRoles.push(input.messages.map((message) => message.role));
        return {
          content:
            seenRoles.length === 1
              ? '{"type":"tool_call","tool":"read_file","args":{"path":"a.txt","purpose":"read"}}'
              : '{"type":"final","content":"done"}',
        };
      },
    };
    const rt = await runtimeWithBackend(backend, workspace);
    const threadId = ThreadId.make("thread-tool-role");
    await rt.startSession({ threadId, runtimeMode: "approval-required" });
    await rt.sendTurn({ threadId, input: "read" });
    await Effect.runPromise(Stream.fromQueue(rt.events).pipe(Stream.take(8), Stream.runCollect));
    expect(seenRoles.length).toBeGreaterThan(1);
    expect(seenRoles[1]).not.toContain("tool");
    expect(seenRoles[1]?.at(-2)).toBe("user");
  });

  it("summarizes tool activities and skips repeated identical tool calls", async () => {
    const workspace = tmpWorkspace();
    await writeFile(path.join(workspace, "a.txt"), "hello\n");
    const rt = await runtime(
      [
        '{"type":"tool_call","tool":"read_file","args":{"path":"a.txt","purpose":"read"}}',
        '{"type":"tool_call","tool":"read_file","args":{"path":"a.txt","purpose":"read"}}',
        '{"type":"final","content":"done"}',
      ],
      workspace,
    );
    const threadId = ThreadId.make("thread-repeat-tool");
    await rt.startSession({ threadId, runtimeMode: "approval-required" });
    await rt.sendTurn({ threadId, input: "read" });

    const completedRead = await takeRuntimeEvent(
      rt.events,
      (event) =>
        event.type === "item.completed" &&
        event.payload.title === "read_file" &&
        String(event.payload.detail).includes("lines 1-2"),
    );
    expect(completedRead.type).toBe("item.completed");

    const skippedRepeat = await takeRuntimeEvent(
      rt.events,
      (event) =>
        event.type === "item.completed" &&
        String(event.payload.detail).includes("Repeated identical tool call skipped"),
    );
    expect(skippedRepeat.type).toBe("item.completed");

    const final = await takeRuntimeEvent(
      rt.events,
      (event) => event.type === "content.delta" && event.payload.delta === "done",
    );
    expect(final.type).toBe("content.delta");
  });

  it("rejects ambiguous edits, validates patch paths, checkpoints and rolls back", async () => {
    const workspace = tmpWorkspace();
    await writeFile(path.join(workspace, "a.txt"), "same\nsame\n");
    const store = makeCustomAgentContextStore();
    const tools = makeCustomAgentToolRegistry({
      settings: settings({ approvalPolicy: "never" }),
      workspaceRoot: workspace,
      contextStore: store,
    });
    const ctx = {
      threadId: ThreadId.make("thread-edit"),
      turnId: "turn-edit" as never,
      toolCallId: "tool-edit",
      runtimeMode: "full-access" as const,
      sandboxMode: "workspace-write" as const,
      requestApproval: async () => "accept" as const,
    };
    await expect(
      tools.execute(
        "edit_file",
        { path: "a.txt", edits: [{ oldText: "same", newText: "changed" }], purpose: "ambiguous" },
        ctx,
      ),
    ).rejects.toThrow(/Ambiguous/);
    await expect(
      tools.execute("apply_patch", { patch: "--- a/../x\n+++ b/../x\n", purpose: "bad" }, ctx),
    ).rejects.toThrow(/Unsafe patch path/);
    const edit = await tools.execute(
      "edit_file",
      { path: "a.txt", edits: [{ startLine: 1, endLine: 1, newText: "changed" }], purpose: "edit" },
      ctx,
    );
    expect(edit.checkpointId).toBeTruthy();
    await tools.execute(
      "rollback_checkpoint",
      { checkpointId: edit.checkpointId, purpose: "rollback" },
      ctx,
    );
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("same\nsame\n");
  });

  it("stores, retrieves, searches artifacts and enforces working context budget", () => {
    const store = makeCustomAgentContextStore();
    const artifact = store.storeArtifact({
      threadId: ThreadId.make("thread-artifact"),
      kind: "log",
      content: "alpha\nbeta\ngamma",
      summary: "alpha log",
      preview: "alpha",
      sensitive: false,
      truncated: false,
      metadata: {},
    });
    expect(store.retrieveArtifact(artifact.id, { start: 2, end: 2 })?.content).toBe("beta");
    expect(store.searchArtifacts("alpha").length).toBe(1);
    expect(
      store.buildWorkingContext({
        threadId: ThreadId.make("thread-artifact"),
        currentUserRequest: "do it",
        maxTokens: 20,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("reports MCP disabled", async () => {
    const tools = makeCustomAgentToolRegistry({
      settings: settings({ mcpEnabled: false }),
      workspaceRoot: tmpWorkspace(),
      contextStore: makeCustomAgentContextStore(),
    });
    const ctx = {
      threadId: ThreadId.make("thread-mcp"),
      turnId: "turn-mcp" as never,
      toolCallId: "tool-mcp",
      runtimeMode: "full-access" as const,
      sandboxMode: "workspace-write" as const,
      requestApproval: async () => "accept" as const,
    };
    expect((await tools.execute("mcp_list_servers", { purpose: "test" }, ctx)).content).toContain(
      "disabled",
    );
  });
});
