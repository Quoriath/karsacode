import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL, ProviderOptionSelections } from "./model.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceConfig, ProviderInstanceId } from "./providerInstance.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";

export const ClientSettingsSchema = Schema.Struct({
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl =
  | "text"
  | "password"
  | "textarea"
  | "switch"
  | "number"
  | "string-list"
  | "json-record";

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Claude HOME path",
        description:
          "Custom HOME used when running this Claude instance. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("agent").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Cursor agent binary.",
        providerSettingsForm: { placeholder: "agent", clearWhenEmpty: "omit" },
      }),
    ),
    apiEndpoint: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API endpoint",
        description: "Override the Cursor API endpoint for this instance.",
        providerSettingsForm: {
          placeholder: "https://...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "apiEndpoint"],
  },
);
export type CursorSettings = typeof CursorSettings.Type;
export const OpenCodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OpenCode binary.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server URL",
        description: "Leave blank to let T3 Code spawn the server when needed.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server password",
        description: "Stored in plain text on disk.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const CustomAgentRuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "full-access",
]);
export type CustomAgentRuntimeMode = typeof CustomAgentRuntimeMode.Type;

export const CustomAgentSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type CustomAgentSandboxMode = typeof CustomAgentSandboxMode.Type;

export const CustomAgentNetworkPolicy = Schema.Literals(["deny", "approval-required", "allow"]);
export type CustomAgentNetworkPolicy = typeof CustomAgentNetworkPolicy.Type;

export const CustomAgentApprovalPolicy = Schema.Literals([
  "always",
  "on-risk",
  "on-mutation",
  "never",
]);
export type CustomAgentApprovalPolicy = typeof CustomAgentApprovalPolicy.Type;

const CustomAgentStringArray = Schema.Array(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);

export const CustomAgentSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    displayName: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("Custom Agent")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    accentColor: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("#7c3aed")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    model: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("gpt-4.1")),
      Schema.annotateKey({
        title: "Model",
        description: "Default chat-completions model slug sent to this OpenAI-compatible endpoint.",
        providerSettingsForm: { placeholder: "gpt-4.1", clearWhenEmpty: "omit" },
      }),
    ),
    apiBaseUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("https://api.openai.com/v1")),
      Schema.annotateKey({
        title: "API endpoint",
        description: "Base URL for an OpenAI-compatible API. Include the /v1 suffix when required.",
        providerSettingsForm: {
          placeholder: "https://api.openai.com/v1",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    apiKeyEnvVar: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("OPENAI_API_KEY")),
      Schema.annotateKey({
        title: "API key environment variable",
        description:
          "Name of the environment variable that contains the API key. Add its value in Environment variables below.",
        providerSettingsForm: { placeholder: "OPENAI_API_KEY", clearWhenEmpty: "omit" },
      }),
    ),
    apiKeyRequired: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "API key required",
        description:
          "Disable this for local OpenAI-compatible servers that reject auth headers or do not require auth.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
    apiKeyHeader: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("Authorization")),
      Schema.annotateKey({
        title: "API key header",
        description:
          "Header used for the API key. Use Authorization for OpenAI/OpenRouter, api-key for Azure-like endpoints, or leave blank to omit auth.",
        providerSettingsForm: { placeholder: "Authorization", clearWhenEmpty: "omit" },
      }),
    ),
    apiKeyPrefix: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("Bearer ")),
      Schema.annotateKey({
        title: "API key prefix",
        description:
          "Prefix prepended before the API key value. Use 'Bearer ' for OpenAI/OpenRouter or blank for api-key/x-api-key headers.",
        providerSettingsForm: { placeholder: "Bearer ", clearWhenEmpty: "persist" },
      }),
    ),
    apiKey: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    apiHeaders: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed({})),
      Schema.annotateKey({
        title: "Extra API headers",
        description: "Optional JSON object of additional request headers.",
        providerSettingsForm: {
          control: "json-record",
          placeholder: '{ "HTTP-Referer": "https://example.com" }',
          clearWhenEmpty: "omit",
        },
      }),
    ),
    systemPromptPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "System prompt path",
        description: "Optional path to a custom system prompt file, relative to the workspace.",
        providerSettingsForm: {
          placeholder: ".devin/custom-agent-system.md",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    workspaceRoot: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Workspace root",
        description: "Workspace used by the native runtime. Leave blank to use the server cwd.",
        providerSettingsForm: { placeholder: "/path/to/workspace", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Home path",
        description: "Optional isolated home path for the custom agent runtime.",
        providerSettingsForm: { placeholder: "~/.karsacode-custom-agent", clearWhenEmpty: "omit" },
      }),
    ),
    defaultRuntimeMode: CustomAgentRuntimeMode.pipe(
      Schema.withDecodingDefault(Effect.succeed("approval-required" as const)),
      Schema.annotateKey({
        title: "Runtime mode",
        description: "approval-required, auto-accept-edits, or full-access.",
        providerSettingsForm: { placeholder: "approval-required", clearWhenEmpty: "omit" },
      }),
    ),
    approvalPolicy: CustomAgentApprovalPolicy.pipe(
      Schema.withDecodingDefault(Effect.succeed("on-mutation" as const)),
      Schema.annotateKey({
        title: "Approval policy",
        description: "always, on-risk, on-mutation, or never.",
        providerSettingsForm: { placeholder: "on-mutation", clearWhenEmpty: "omit" },
      }),
    ),
    sandboxMode: CustomAgentSandboxMode.pipe(
      Schema.withDecodingDefault(Effect.succeed("workspace-write" as const)),
      Schema.annotateKey({
        title: "Sandbox mode",
        description: "read-only, workspace-write, or danger-full-access.",
        providerSettingsForm: { placeholder: "workspace-write", clearWhenEmpty: "omit" },
      }),
    ),
    maxToolOutputBytes: Schema.Number.pipe(
      Schema.withDecodingDefault(Effect.succeed(1_000_000)),
      Schema.annotateKey({
        title: "Max tool output bytes",
        description: "Maximum raw output captured from one tool call.",
        providerSettingsForm: {
          control: "number",
          placeholder: "1000000",
          clearWhenEmpty: "omit",
          hidden: true,
        },
      }),
    ),
    maxToolPreviewBytes: Schema.Number.pipe(
      Schema.withDecodingDefault(Effect.succeed(8_000)),
      Schema.annotateKey({
        title: "Max tool preview bytes",
        description: "Maximum output preview sent back into the model context.",
        providerSettingsForm: {
          control: "number",
          placeholder: "8000",
          clearWhenEmpty: "omit",
          hidden: true,
        },
      }),
    ),
    maxContextTokens: Schema.Number.pipe(
      Schema.withDecodingDefault(Effect.succeed(0)),
      Schema.annotateKey({
        title: "Max context tokens",
        description:
          "Total context window (input + output). If 0 and endpoint doesn't provide info, uses safe fallback (250k). Set manually for accuracy.",
        providerSettingsForm: {
          control: "number",
          placeholder: "0 = auto (250k fallback)",
          clearWhenEmpty: "omit",
          hidden: true,
        },
      }),
    ),
    forceEndpointContextDetection: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Force endpoint context detection",
        description:
          "If true, requires context window to be detected from API endpoint. Fails if endpoint doesn't provide context info.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit", hidden: true },
      }),
    ),
    maxInputTokens: Schema.Number.pipe(
      Schema.withDecodingDefault(Effect.succeed(0)),
      Schema.annotateKey({
        title: "Max input tokens",
        description:
          "Maximum input tokens (prompt). If 0, auto-calculated from detected context window minus output. Set manually for precision control.",
        providerSettingsForm: {
          control: "number",
          placeholder: "0 = auto-calculate",
          clearWhenEmpty: "omit",
          hidden: true,
        },
      }),
    ),
    maxOutputTokens: Schema.Number.pipe(
      Schema.withDecodingDefault(Effect.succeed(4_000)),
      Schema.annotateKey({
        title: "Max output tokens",
        description: "Maximum completion tokens (output). Reserved from context window.",
        providerSettingsForm: { control: "number", placeholder: "4000", clearWhenEmpty: "omit" },
      }),
    ),
    modelContextWindows: Schema.Record(Schema.String, Schema.Number).pipe(
      Schema.withDecodingDefault(Effect.succeed({})),
      Schema.annotateKey({
        title: "Per-model context windows",
        description:
          'Map of model names to their max context tokens. Overrides endpoint detection and global settings for specific models. Example: { "gpt-4": 128000, "gpt-4-turbo": 128000 }',
        providerSettingsForm: {
          control: "textarea",
          placeholder: '{\n  "gpt-4": 128000,\n  "gpt-4-turbo": 128000\n}',
          clearWhenEmpty: "omit",
          hidden: true,
        },
      }),
    ),
    maxFileReadBytes: Schema.Number.pipe(
      Schema.withDecodingDefault(Effect.succeed(80_000)),
      Schema.annotateKey({
        title: "Max file read bytes",
        description: "Maximum bytes read from a single file tool call.",
        providerSettingsForm: { control: "number", placeholder: "80000", clearWhenEmpty: "omit" },
      }),
    ),
    maxSearchResults: Schema.Number.pipe(
      Schema.withDecodingDefault(Effect.succeed(50)),
      Schema.annotateKey({
        title: "Max search results",
        description: "Maximum repository search/list results returned to the model.",
        providerSettingsForm: { control: "number", placeholder: "50", clearWhenEmpty: "omit" },
      }),
    ),
    contextCompressionEnabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Compress context",
        description: "Summarize large outputs before feeding them back into the model.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
    contextStorePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Context store path",
        description: "Optional path for persisted runtime context artifacts.",
        providerSettingsForm: { placeholder: ".t3/custom-agent-context", clearWhenEmpty: "omit" },
      }),
    ),
    semanticSearchEnabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Enable semantic search",
        description: "Enable semantic-search tool integration when an index is configured.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
    semanticIndexPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Semantic index path",
        description: "Optional path to a semantic search index.",
        providerSettingsForm: { placeholder: ".cocoindex_code", clearWhenEmpty: "omit" },
      }),
    ),
    checkpointEnabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Enable checkpoints",
        description: "Allow the runtime to checkpoint and roll back workspace edits.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
    checkpointPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Checkpoint path",
        description: "Optional path for checkpoint metadata.",
        providerSettingsForm: {
          placeholder: ".t3/custom-agent-checkpoints",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    mcpEnabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Enable MCP",
        description: "Enable MCP tool bridge when a config path is supplied.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
    mcpConfigPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "MCP config path",
        description: "Optional MCP server configuration file.",
        providerSettingsForm: { placeholder: ".devin/mcp.json", clearWhenEmpty: "omit" },
      }),
    ),
    networkPolicy: CustomAgentNetworkPolicy.pipe(
      Schema.withDecodingDefault(Effect.succeed("deny" as const)),
      Schema.annotateKey({
        title: "Network policy",
        description: "deny, approval-required, or allow.",
        providerSettingsForm: { placeholder: "deny", clearWhenEmpty: "omit" },
      }),
    ),
    allowedCommands: CustomAgentStringArray.pipe(
      Schema.annotateKey({
        title: "Allowed commands",
        description: "Optional allow-list, one shell command prefix per line.",
        providerSettingsForm: { control: "string-list", clearWhenEmpty: "omit" },
      }),
    ),
    blockedCommands: CustomAgentStringArray.pipe(
      Schema.annotateKey({
        title: "Blocked commands",
        description: "Command prefixes that should never run, one per line.",
        providerSettingsForm: { control: "string-list", clearWhenEmpty: "omit" },
      }),
    ),
    allowedPaths: CustomAgentStringArray.pipe(
      Schema.annotateKey({
        title: "Allowed paths",
        description: "Optional path allow-list, one workspace-relative or absolute path per line.",
        providerSettingsForm: { control: "string-list", clearWhenEmpty: "omit" },
      }),
    ),
    blockedPaths: CustomAgentStringArray.pipe(
      Schema.annotateKey({
        title: "Blocked paths",
        description: "Path block-list, one workspace-relative or absolute path per line.",
        providerSettingsForm: { control: "string-list", clearWhenEmpty: "omit" },
      }),
    ),
    redactSecrets: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Redact secrets",
        description: "Redact likely secrets from model-visible tool output.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
    autoSummarizeLargeOutputs: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Auto-summarize large outputs",
        description: "Compress large tool results before returning them to the model.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
    defaultSearchEngine: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("ripgrep")),
      Schema.annotateKey({
        title: "Default search engine",
        description: "Search backend preference used by repository search.",
        providerSettingsForm: { placeholder: "ripgrep", clearWhenEmpty: "omit" },
      }),
    ),
    preferRipgrep: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Prefer ripgrep",
        description: "Use rg for repository search when it is available.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
    preferFd: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Prefer fd",
        description: "Use fd for file listing when it is available.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
    commandTimeoutMs: Schema.Number.pipe(
      Schema.withDecodingDefault(Effect.succeed(30_000)),
      Schema.annotateKey({
        title: "Command timeout ms",
        description: "Timeout for shell command tool calls.",
        providerSettingsForm: { control: "number", placeholder: "30000", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: CustomAgentStringArray.pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [
      "model",
      "apiBaseUrl",
      "apiKeyEnvVar",
      "apiKeyRequired",
      "apiKeyHeader",
      "apiKeyPrefix",
      "apiKey",
      "apiHeaders",
      "systemPromptPath",
      "workspaceRoot",
      "homePath",
      "defaultRuntimeMode",
      "approvalPolicy",
      "sandboxMode",
      "networkPolicy",
      "allowedCommands",
      "blockedCommands",
      "allowedPaths",
      "blockedPaths",
      "contextCompressionEnabled",
      "maxContextTokens",
      "forceEndpointContextDetection",
      "maxInputTokens",
      "maxOutputTokens",
      "redactSecrets",
      "autoSummarizeLargeOutputs",
      "checkpointEnabled",
      "mcpEnabled",
      "semanticSearchEnabled",
    ],
  },
);
export type CustomAgentSettings = typeof CustomAgentSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      }),
    ),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    customAgent: CustomAgentSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  shadowHomePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(Schema.String),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  apiEndpoint: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  serverUrl: Schema.optionalKey(Schema.String),
  serverPassword: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const CustomAgentSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  displayName: Schema.optionalKey(Schema.String),
  accentColor: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  apiBaseUrl: Schema.optionalKey(Schema.String),
  apiKeyEnvVar: Schema.optionalKey(Schema.String),
  apiKeyRequired: Schema.optionalKey(Schema.Boolean),
  apiKeyHeader: Schema.optionalKey(Schema.String),
  apiKeyPrefix: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
  apiHeaders: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  systemPromptPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  workspaceRoot: Schema.optionalKey(Schema.String),
  defaultRuntimeMode: Schema.optionalKey(CustomAgentRuntimeMode),
  approvalPolicy: Schema.optionalKey(CustomAgentApprovalPolicy),
  sandboxMode: Schema.optionalKey(CustomAgentSandboxMode),
  maxToolOutputBytes: Schema.optionalKey(Schema.Number),
  maxToolPreviewBytes: Schema.optionalKey(Schema.Number),
  maxContextTokens: Schema.optionalKey(Schema.Number),
  maxFileReadBytes: Schema.optionalKey(Schema.Number),
  maxSearchResults: Schema.optionalKey(Schema.Number),
  contextCompressionEnabled: Schema.optionalKey(Schema.Boolean),
  contextStorePath: Schema.optionalKey(Schema.String),
  semanticSearchEnabled: Schema.optionalKey(Schema.Boolean),
  semanticIndexPath: Schema.optionalKey(Schema.String),
  checkpointEnabled: Schema.optionalKey(Schema.Boolean),
  checkpointPath: Schema.optionalKey(Schema.String),
  mcpEnabled: Schema.optionalKey(Schema.Boolean),
  mcpConfigPath: Schema.optionalKey(Schema.String),
  networkPolicy: Schema.optionalKey(CustomAgentNetworkPolicy),
  allowedCommands: Schema.optionalKey(Schema.Array(Schema.String)),
  blockedCommands: Schema.optionalKey(Schema.Array(Schema.String)),
  allowedPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  blockedPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  redactSecrets: Schema.optionalKey(Schema.Boolean),
  autoSummarizeLargeOutputs: Schema.optionalKey(Schema.Boolean),
  defaultSearchEngine: Schema.optionalKey(Schema.String),
  preferRipgrep: Schema.optionalKey(Schema.Boolean),
  preferFd: Schema.optionalKey(Schema.Boolean),
  commandTimeoutMs: Schema.optionalKey(Schema.Number),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  // Server settings
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  addProjectBaseDirectory: Schema.optionalKey(Schema.String),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(Schema.String),
      otlpMetricsUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
      customAgent: Schema.optionalKey(CustomAgentSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  autoOpenPlanSidebar: Schema.optionalKey(Schema.Boolean),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  diffWordWrap: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderInstanceId,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  providerModelPreferences: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        hiddenModels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
        modelOrder: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
      }),
    ),
  ),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  timestampFormat: Schema.optionalKey(TimestampFormat),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
