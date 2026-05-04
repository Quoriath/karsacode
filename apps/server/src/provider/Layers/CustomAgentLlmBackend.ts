import type { CustomAgentSettings } from "@t3tools/contracts";

export interface CustomAgentChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface CustomAgentLlmInput {
  readonly messages: ReadonlyArray<CustomAgentChatMessage>;
  readonly model: string;
  readonly temperature?: number | undefined;
  readonly stream?: boolean | undefined;
}

export interface CustomAgentLlmOutput {
  readonly content: string;
  readonly usage?: Record<string, unknown> | undefined;
}

export interface CustomAgentLlmBackend {
  readonly complete: (input: CustomAgentLlmInput) => Promise<CustomAgentLlmOutput>;
  readonly stream: (input: CustomAgentLlmInput) => AsyncIterable<string>;
  readonly getLastUsage?: (() => Record<string, unknown> | undefined) | undefined;
  readonly getModelContextWindow?: ((model: string) => Promise<number | undefined>) | undefined;
  readonly countTokens?: ((input: CustomAgentLlmInput) => Promise<number>) | undefined;
  readonly supportsNativeToolCalling: boolean;
  readonly supportsJsonMode: boolean;
  readonly supportsReasoningEffort: boolean;
}

export function resolveCustomAgentChatCompletionsUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim();
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = pathname.endsWith("/chat/completions") ? pathname : `${pathname}/chat/completions`;
  return url.toString();
}

export function resolveCustomAgentModelsUrl(apiBaseUrl: string): string {
  const chatUrl = new URL(resolveCustomAgentChatCompletionsUrl(apiBaseUrl));
  chatUrl.pathname = chatUrl.pathname.replace(/\/chat\/completions$/u, "/models");
  return chatUrl.toString();
}

function describeFetchFailure(error: unknown, url: string): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const causeMessage =
    cause && typeof cause === "object" && "message" in cause
      ? String((cause as { message?: unknown }).message)
      : "";
  const message = String((error as Error).message ?? error);
  return [
    `Failed to reach Custom Agent API endpoint: ${url}`,
    causeMessage || message,
    "Check API endpoint/base URL, network access, TLS/proxy settings, and whether the endpoint supports OpenAI-compatible /chat/completions.",
  ].join(" ");
}

export function buildCustomAgentAuthHeaders(
  settings: CustomAgentSettings,
  apiKey: string,
): Record<string, string> {
  if (!settings.apiKeyRequired) return {};
  const headerName = settings.apiKeyHeader.trim();
  if (!headerName || !apiKey) return {};
  return { [headerName]: `${settings.apiKeyPrefix}${apiKey}` };
}

function isLocalCustomAgentEndpoint(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function localAuthFallbackHeaders(
  settings: CustomAgentSettings,
  apiKey: string,
): ReadonlyArray<Record<string, string>> {
  const candidates = [
    buildCustomAgentAuthHeaders(settings, apiKey),
    { "X-LocalAI-API-Key": apiKey },
    {},
    { Authorization: apiKey },
    { "api-key": apiKey },
    { "x-api-key": apiKey },
  ];
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex((other) => JSON.stringify(other) === JSON.stringify(candidate)) ===
      index,
  );
}

function localAuthFallbackUrls(url: string, apiKey: string): ReadonlyArray<string> {
  return ["key", "api_key", "api-key", "query-key"].map((param) => {
    const nextUrl = new URL(url);
    nextUrl.searchParams.set(param, apiKey);
    return nextUrl.toString();
  });
}

function buildRequestBody(input: CustomAgentLlmInput, stream: boolean): string {
  const baseBody = {
    model: input.model,
    messages: input.messages,
    temperature: input.temperature ?? 0.2,
    stream,
  };
  return JSON.stringify(
    stream
      ? { ...baseBody, stream_options: { include_usage: true } }
      : { ...baseBody, response_format: { type: "json_object" } },
  );
}

type OpenAiCompatibleStreamChunk = {
  readonly usage?: Record<string, unknown> | null | undefined;
  readonly choices?: ReadonlyArray<{
    readonly delta?: { readonly content?: string | null } | undefined;
    readonly message?: { readonly content?: string | null } | undefined;
  }>;
};

function extractOpenAiCompatibleStreamChunk(data: string):
  | { readonly content?: string | undefined; readonly usage?: Record<string, unknown> | undefined }
  | undefined {
  let json: OpenAiCompatibleStreamChunk;
  try {
    json = JSON.parse(data) as OpenAiCompatibleStreamChunk;
  } catch {
    return undefined;
  }
  return {
    content: json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? undefined,
    ...(json.usage && typeof json.usage === "object" ? { usage: json.usage } : {}),
  };
}

function normalizeStreamingLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return undefined;
  return trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
}

export function makeOpenAiCompatibleCustomAgentBackend(
  settings: CustomAgentSettings,
  env: NodeJS.ProcessEnv,
): CustomAgentLlmBackend {
  const apiKey =
    settings.apiKey || env[settings.apiKeyEnvVar] || process.env[settings.apiKeyEnvVar];
  const chatCompletionsUrl = resolveCustomAgentChatCompletionsUrl(settings.apiBaseUrl);
  const modelsUrl = resolveCustomAgentModelsUrl(settings.apiBaseUrl);
  const apiKeyValue = apiKey ?? "";
  let lastUsage: Record<string, unknown> | undefined;
  const modelContextWindowCache = new Map<string, number | undefined>();
  const post = async (
    url: string,
    authHeaders: Record<string, string>,
    body: string,
  ): Promise<Response> =>
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
        ...settings.apiHeaders,
      },
      body,
    });
  const getJson = async (
    url: string,
    authHeaders: Record<string, string>,
  ): Promise<Response> =>
    await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...authHeaders,
        ...settings.apiHeaders,
      },
    });
  const postWithLocalAuthFallbacks = async (
    body: string,
    authHeaders: Record<string, string>,
  ): Promise<Response> => {
    let response = await post(chatCompletionsUrl, authHeaders, body);
    if (response.status !== 401 || !apiKeyValue || !isLocalCustomAgentEndpoint(chatCompletionsUrl))
      return response;
    for (const fallbackHeaders of localAuthFallbackHeaders(settings, apiKeyValue).slice(1)) {
      response = await post(chatCompletionsUrl, fallbackHeaders, body);
      if (response.ok || response.status !== 401) return response;
    }
    for (const fallbackUrl of localAuthFallbackUrls(chatCompletionsUrl, apiKeyValue)) {
      response = await post(fallbackUrl, {}, body);
      if (response.ok || response.status !== 401) return response;
    }
    for (const fallbackUrl of localAuthFallbackUrls(chatCompletionsUrl, apiKeyValue)) {
      response = await post(fallbackUrl, authHeaders, body);
      if (response.ok || response.status !== 401) return response;
    }
    return response;
  };
  const fetchChatCompletions = async (
    input: CustomAgentLlmInput,
    stream: boolean,
  ): Promise<Response> => {
    if (settings.apiKeyRequired && !apiKey)
      throw new Error(`Missing API key environment variable: ${settings.apiKeyEnvVar}`);
    try {
      const authHeaders = buildCustomAgentAuthHeaders(settings, apiKeyValue);
      return await postWithLocalAuthFallbacks(buildRequestBody(input, stream), authHeaders);
    } catch (error) {
      throw new Error(describeFetchFailure(error, chatCompletionsUrl), { cause: error });
    }
  };
  const fetchModels = async (): Promise<Response> => {
    if (settings.apiKeyRequired && !apiKey)
      throw new Error(`Missing API key environment variable: ${settings.apiKeyEnvVar}`);
    try {
      const authHeaders = buildCustomAgentAuthHeaders(settings, apiKeyValue);
      return await getJson(modelsUrl, authHeaders);
    } catch (error) {
      throw new Error(describeFetchFailure(error, modelsUrl), { cause: error });
    }
  };
  const complete = async (input: CustomAgentLlmInput): Promise<CustomAgentLlmOutput> => {
    lastUsage = undefined;
    const response = await fetchChatCompletions(input, false);
    if (!response.ok)
      throw new Error(
        `Custom Agent API error ${response.status} ${response.statusText}: ${await response.text()}`,
      );
    let json: {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, unknown>;
    };
    try {
      json = (await response.json()) as typeof json;
    } catch (error) {
      throw new Error(`Custom Agent API returned invalid JSON from ${chatCompletionsUrl}`, {
        cause: error,
      });
    }
    lastUsage = json.usage;
    return { content: json.choices?.[0]?.message?.content ?? "", usage: json.usage };
  };
  const getModelContextWindow = async (model: string): Promise<number | undefined> => {
    if (modelContextWindowCache.has(model)) return modelContextWindowCache.get(model);
    const response = await fetchModels().catch(() => undefined);
    if (!response?.ok) {
      modelContextWindowCache.set(model, undefined);
      return undefined;
    }
    const json = (await response.json().catch(() => undefined)) as unknown;
    const contextWindow = extractModelContextWindow(json, model);
    modelContextWindowCache.set(model, contextWindow);
    return contextWindow;
  };
  const stream = async function* (input: CustomAgentLlmInput): AsyncIterable<string> {
    lastUsage = undefined;
    const response = await fetchChatCompletions(input, true);
    if (!response.ok)
      throw new Error(
        `Custom Agent API error ${response.status} ${response.statusText}: ${await response.text()}`,
      );
    if (!response.body) throw new Error("Custom Agent API streaming response had no body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const processLine = function* (line: string): Generator<string, boolean> {
      const data = normalizeStreamingLine(line);
      if (!data) return false;
      if (data === "[DONE]") return true;
      const chunk = extractOpenAiCompatibleStreamChunk(data);
      if (chunk?.usage) lastUsage = chunk.usage;
      if (chunk?.content) {
        yield chunk.content;
        return false;
      }
      if (!line.trim().startsWith("data:")) yield data;
      return false;
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const chunks = processLine(line);
        while (true) {
          const next = chunks.next();
          if (next.done) {
            if (next.value) return;
            break;
          }
          yield next.value;
        }
      }
    }
    const trailing = decoder.decode();
    if (trailing) buffer += trailing;
    for (const line of buffer.split(/\r?\n/)) {
      const chunks = processLine(line);
      while (true) {
        const next = chunks.next();
        if (next.done) {
          if (next.value) return;
          break;
        }
        yield next.value;
      }
    }
  };
  return {
    complete,
    stream,
    getLastUsage: () => lastUsage,
    getModelContextWindow,
    countTokens: async (input) =>
      Math.ceil(input.messages.map((message) => message.content).join("\n").length / 4),
    supportsNativeToolCalling: false,
    supportsJsonMode: true,
    supportsReasoningEffort: false,
  };
}

export function makeFakeCustomAgentBackend(outputs: ReadonlyArray<string>): CustomAgentLlmBackend {
  const queue = [...outputs];
  return {
    complete: async () => ({
      content: queue.shift() ?? JSON.stringify({ type: "final", content: "Done." }),
    }),
    stream: async function* () {
      yield queue.shift() ?? JSON.stringify({ type: "final", content: "Done." });
    },
    countTokens: async (input) =>
      Math.ceil(input.messages.map((message) => message.content).join("\n").length / 4),
    supportsNativeToolCalling: false,
    supportsJsonMode: true,
    supportsReasoningEffort: false,
  };
}

export type CustomAgentModelCommand =
  | {
      readonly type: "tool_call";
      readonly tool: string;
      readonly args: Record<string, unknown>;
      readonly reason?: string | undefined;
    }
  | { readonly type: "final"; readonly content: string };

export function parseCustomAgentModelCommand(
  raw: string,
): { ok: true; command: CustomAgentModelCommand } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Model output was not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object")
    return { ok: false, error: "Model output must be a JSON object." };
  const record = parsed as Record<string, unknown>;
  if (record.type === "final" && typeof record.content === "string")
    return { ok: true, command: { type: "final", content: record.content } };
  if (
    record.type === "tool_call" &&
    typeof record.tool === "string" &&
    (!record.args || (typeof record.args === "object" && !Array.isArray(record.args)))
  )
    return {
      ok: true,
      command: {
        type: "tool_call",
        tool: record.tool,
        args: (record.args ?? {}) as Record<string, unknown>,
        reason: typeof record.reason === "string" ? record.reason : undefined,
      },
    };
  return {
    ok: false,
    error: "Model JSON must be {type:'tool_call', tool, args} or {type:'final', content}.",
  };
}
