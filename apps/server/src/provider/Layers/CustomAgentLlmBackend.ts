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

export function makeOpenAiCompatibleCustomAgentBackend(
  settings: CustomAgentSettings,
  env: NodeJS.ProcessEnv,
): CustomAgentLlmBackend {
  const apiKey =
    settings.apiKey || env[settings.apiKeyEnvVar] || process.env[settings.apiKeyEnvVar];
  const chatCompletionsUrl = resolveCustomAgentChatCompletionsUrl(settings.apiBaseUrl);
  const apiKeyValue = apiKey ?? "";
  const buildRequestBody = (input: CustomAgentLlmInput, stream: boolean) =>
    JSON.stringify({
      model: input.model,
      messages: input.messages,
      temperature: input.temperature ?? 0.2,
      response_format: { type: "json_object" },
      stream,
    });
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
  const complete = async (input: CustomAgentLlmInput): Promise<CustomAgentLlmOutput> => {
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
    return { content: json.choices?.[0]?.message?.content ?? "", usage: json.usage };
  };
  const stream = async function* (input: CustomAgentLlmInput): AsyncIterable<string> {
    const response = await fetchChatCompletions(input, true);
    if (!response.ok)
      throw new Error(
        `Custom Agent API error ${response.status} ${response.statusText}: ${await response.text()}`,
      );
    if (!response.body) throw new Error("Custom Agent API streaming response had no body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (data === "[DONE]") return;
        let json: {
          choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
        };
        try {
          json = JSON.parse(data) as typeof json;
        } catch {
          continue;
        }
        const content = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content;
        if (content) yield content;
      }
    }
    const trailing = decoder.decode();
    if (trailing) buffer += trailing;
    if (buffer.trim() && !buffer.trim().startsWith("data:")) yield buffer.trim();
  };
  return {
    complete,
    stream,
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
