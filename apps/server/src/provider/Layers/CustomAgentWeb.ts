import { Exa } from "exa-js";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;
const DEFAULT_SEARCH_TEXT_CHARS = 1_200;
const DEFAULT_FETCH_TEXT_CHARS = 6_000;
const MAX_FETCH_URLS = 5;
const MAX_QUERY_CHARS = 500;

interface ExaClient {
  search: (
    query: string,
    options: {
      readonly numResults: number;
      readonly contents: false | { readonly text: { readonly maxCharacters: number } };
    },
  ) => Promise<unknown>;
  getContents: (
    urls: string | string[],
    options: { readonly text: { readonly maxCharacters: number } },
  ) => Promise<unknown>;
}

export interface CustomAgentWebResult {
  readonly title?: string | undefined;
  readonly url: string;
  readonly publishedDate?: string | undefined;
  readonly author?: string | undefined;
  readonly text?: string | undefined;
  readonly provider: { readonly name: "exa" };
}

export interface CustomAgentWebFailure {
  readonly url?: string | undefined;
  readonly error: string;
}

export interface CustomAgentWebSearchOutput {
  readonly provider: { readonly name: "exa" };
  readonly query: string;
  readonly resultCount: number;
  readonly results: ReadonlyArray<CustomAgentWebResult>;
  readonly truncated: boolean;
}

export interface CustomAgentWebFetchOutput {
  readonly provider: { readonly name: "exa" };
  readonly requestedUrls: ReadonlyArray<string>;
  readonly pageCount: number;
  readonly pages: ReadonlyArray<CustomAgentWebResult>;
  readonly failures: ReadonlyArray<CustomAgentWebFailure>;
  readonly truncated: boolean;
}

export interface CustomAgentWebClientOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly clientFactory?: ((apiKey: string) => ExaClient) | undefined;
}

function apiKeyFromEnvironment(environment?: NodeJS.ProcessEnv): string {
  const apiKey =
    environment && "EXA_API_KEY" in environment ? environment.EXA_API_KEY : process.env.EXA_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim().length > 0) return apiKey.trim();
  throw new Error("EXA_API_KEY is not configured for server-side web search/fetch.");
}

function makeClient(options: CustomAgentWebClientOptions): ExaClient {
  const apiKey = apiKeyFromEnvironment(options.environment);
  return options.clientFactory?.(apiKey) ?? (new Exa(apiKey) as ExaClient);
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function truncateText(value: unknown, maxCharacters: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxCharacters
    ? `${trimmed.slice(0, maxCharacters).trimEnd()}...`
    : trimmed;
}

function normalizeResult(value: unknown, maxTextCharacters: number): CustomAgentWebResult | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string" || record.url.trim().length === 0) return null;
  const text = truncateText(record.text, maxTextCharacters);
  return {
    ...(typeof record.title === "string" && record.title.trim().length > 0
      ? { title: record.title.trim() }
      : {}),
    url: record.url.trim(),
    ...(typeof record.publishedDate === "string" && record.publishedDate.trim().length > 0
      ? { publishedDate: record.publishedDate.trim() }
      : {}),
    ...(typeof record.author === "string" && record.author.trim().length > 0
      ? { author: record.author.trim() }
      : {}),
    ...(text ? { text } : {}),
    provider: { name: "exa" },
  };
}

function normalizeResponseResults(
  value: unknown,
  maxTextCharacters: number,
): CustomAgentWebResult[] {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const results = Array.isArray(record.results) ? record.results : [];
  return results.flatMap((entry) => {
    const normalized = normalizeResult(entry, maxTextCharacters);
    return normalized ? [normalized] : [];
  });
}

function safeErrorMessage(error: unknown): string {
  const raw = String((error as Error).message ?? error ?? "Unknown Exa error");
  if (/\b(api[_-]?key|authorization|bearer|secret|token)\b/i.test(raw))
    return "Exa request failed. Check EXA_API_KEY and provider configuration.";
  if (/\b429|rate limit|too many requests\b/i.test(raw)) return "Exa rate limit reached.";
  if (/\btimeout|timed out\b/i.test(raw)) return "Exa request timed out.";
  if (/\babort/i.test(raw)) return "Exa request was aborted.";
  return raw.slice(0, 240);
}

function isRetryable(error: unknown): boolean {
  const message = String((error as Error).message ?? error);
  return /\b(timeout|timed out|econnreset|socket|network|fetch failed|429|500|502|503|504)\b/i.test(
    message,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function withTimeout<T>(
  promise: Promise<T>,
  input: { readonly timeoutMs: number; readonly signal?: AbortSignal | undefined },
): Promise<T> {
  throwIfAborted(input.signal);
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Exa request timed out.")), input.timeoutMs);
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    input.signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function retryOnce<T>(
  operation: () => Promise<T>,
  input: { readonly timeoutMs: number; readonly signal?: AbortSignal | undefined },
): Promise<T> {
  try {
    return await withTimeout(operation(), input);
  } catch (error) {
    if (!isRetryable(error)) throw error;
    throwIfAborted(input.signal);
    return await withTimeout(operation(), input);
  }
}

function validateSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) throw new Error("web_search query must not be empty.");
  if (trimmed.length > MAX_QUERY_CHARS)
    throw new Error(`web_search query is too long. Max ${MAX_QUERY_CHARS} characters.`);
  return trimmed;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function validateHttpUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Invalid URL: ${rawUrl.slice(0, 120)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("169.254.") ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80") ||
    (net.isIP(hostname) === 4 && isPrivateIpv4(hostname))
  ) {
    throw new Error("Refusing to fetch localhost or private network URL.");
  }
  parsed.hash = "";
  return parsed.toString();
}

export async function customAgentWebSearch(input: {
  readonly query: string;
  readonly maxResults?: number | undefined;
  readonly includeText?: boolean | undefined;
  readonly maxTextCharacters?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly clientFactory?: ((apiKey: string) => ExaClient) | undefined;
}): Promise<CustomAgentWebSearchOutput> {
  const query = validateSearchQuery(input.query);
  const numResults = clampInt(input.maxResults, DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
  const maxTextCharacters = clampInt(input.maxTextCharacters, DEFAULT_SEARCH_TEXT_CHARS, 80, 4_000);
  const client = makeClient(input);
  const response = await retryOnce(
    () =>
      client.search(query, {
        numResults,
        contents:
          input.includeText === false ? false : { text: { maxCharacters: maxTextCharacters } },
      }),
    {
      timeoutMs: clampInt(input.timeoutMs, DEFAULT_TIMEOUT_MS, 2_000, 30_000),
      signal: input.signal,
    },
  ).catch((error: unknown) => {
    throw new Error(safeErrorMessage(error));
  });
  const results = normalizeResponseResults(response, maxTextCharacters).slice(0, numResults);
  return {
    provider: { name: "exa" },
    query,
    resultCount: results.length,
    results,
    truncated: results.some((result) => (result.text?.length ?? 0) >= maxTextCharacters),
  };
}

export async function customAgentWebFetch(input: {
  readonly urls: ReadonlyArray<string>;
  readonly maxTextCharacters?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly clientFactory?: ((apiKey: string) => ExaClient) | undefined;
}): Promise<CustomAgentWebFetchOutput> {
  const requestedUrls = input.urls.slice(0, MAX_FETCH_URLS).map(validateHttpUrl);
  if (requestedUrls.length === 0) throw new Error("web_fetch needs at least one URL.");
  const maxTextCharacters = clampInt(
    input.maxTextCharacters,
    DEFAULT_FETCH_TEXT_CHARS,
    500,
    12_000,
  );
  const client = makeClient(input);
  const timeoutMs = clampInt(input.timeoutMs, DEFAULT_TIMEOUT_MS, 2_000, 30_000);
  const settled = await Promise.allSettled(
    requestedUrls.map(async (url) => {
      const response = await retryOnce(
        () => client.getContents(url, { text: { maxCharacters: maxTextCharacters } }),
        { timeoutMs, signal: input.signal },
      );
      return normalizeResponseResults(response, maxTextCharacters)[0] ?? null;
    }),
  );
  const pages: CustomAgentWebResult[] = [];
  const failures: CustomAgentWebFailure[] = [];
  settled.forEach((result, index) => {
    const url = requestedUrls[index];
    if (result.status === "fulfilled" && result.value) {
      pages.push(result.value);
      return;
    }
    failures.push({
      ...(url ? { url } : {}),
      error:
        result.status === "rejected"
          ? safeErrorMessage(result.reason)
          : "Exa returned no extractable content.",
    });
  });
  return {
    provider: { name: "exa" },
    requestedUrls,
    pageCount: pages.length,
    pages,
    failures,
    truncated: pages.some((page) => (page.text?.length ?? 0) >= maxTextCharacters),
  };
}
