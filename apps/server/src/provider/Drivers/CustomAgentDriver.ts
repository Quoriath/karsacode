import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { CustomAgentSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { Effect, Schema, Stream } from "effect";
import { ServerConfig } from "../../config.ts";
import { makeCustomAgentTextGeneration } from "../../textGeneration/CustomAgentTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCustomAgentAdapter } from "../Layers/CustomAgentAdapter.ts";
import { makeOpenAiCompatibleCustomAgentBackend } from "../Layers/CustomAgentLlmBackend.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const DRIVER_KIND = ProviderDriverKind.make("customAgent");

export type CustomAgentDriverEnv = ServerConfig;

function resolveWorkspace(configured: string, fallback: string): string {
  return path.resolve(configured || fallback);
}

async function commandExists(binary: string): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve) =>
    execFile("/bin/sh", ["-lc", `command -v ${binary}`], (error) => resolve(!error)),
  );
}

async function buildSnapshot(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly enabled: boolean;
  readonly config: CustomAgentSettings;
  readonly workspaceRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly continuationKey: string;
}): Promise<ServerProvider> {
  const warnings: string[] = [];
  const apiKey =
    input.config.apiKey ||
    input.environment[input.config.apiKeyEnvVar] ||
    process.env[input.config.apiKeyEnvVar];
  if (input.config.apiKeyRequired && !apiKey)
    warnings.push(`Missing API key environment variable: ${input.config.apiKeyEnvVar}`);
  if (!existsSync(input.workspaceRoot) || !statSync(input.workspaceRoot).isDirectory())
    warnings.push(`Invalid workspace root: ${input.workspaceRoot}`);
  if (
    input.config.systemPromptPath &&
    !existsSync(path.resolve(input.workspaceRoot, input.config.systemPromptPath))
  )
    warnings.push(`Invalid system prompt path: ${input.config.systemPromptPath}`);
  if (input.config.preferRipgrep && !(await commandExists("rg")))
    warnings.push("ripgrep not found; search_repo will use fallback search.");
  if (input.config.preferFd && !(await commandExists("fd")))
    warnings.push("fd not found; list_files will use fallback listing.");
  const unavailable = warnings.some(
    (warning) => warning.startsWith("Missing API key") || warning.startsWith("Invalid workspace"),
  );
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    displayName: input.displayName ?? (input.config.displayName || "Custom Agent"),
    ...((input.accentColor ?? input.config.accentColor)
      ? { accentColor: input.accentColor ?? input.config.accentColor }
      : {}),
    badgeLabel: "Native",
    continuation: { groupKey: input.continuationKey },
    showInteractionModeToggle: true,
    enabled: input.enabled && input.config.enabled,
    installed: !unavailable,
    version: "native",
    status:
      !input.enabled || !input.config.enabled
        ? "disabled"
        : unavailable
          ? "error"
          : warnings.length > 0
            ? "warning"
            : "ready",
    auth: {
      status: apiKey ? "authenticated" : "unauthenticated",
      type: "api-key",
      label: input.config.apiKeyEnvVar,
    },
    checkedAt: new Date().toISOString(),
    ...(warnings.length > 0 ? { message: warnings.join(" ") } : {}),
    availability: unavailable ? "unavailable" : "available",
    ...(unavailable ? { unavailableReason: warnings.join(" ") } : {}),
    models: [
      { slug: input.config.model, name: input.config.model, isCustom: true, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  };
}

export const CustomAgentDriver: ProviderDriver<CustomAgentSettings, CustomAgentDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Custom Agent", supportsMultipleInstances: true },
  configSchema: CustomAgentSettings,
  defaultConfig: (): CustomAgentSettings => Schema.decodeSync(CustomAgentSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies CustomAgentSettings;
      const workspaceRoot = resolveWorkspace(effectiveConfig.workspaceRoot, serverConfig.cwd);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const backend = makeOpenAiCompatibleCustomAgentBackend(effectiveConfig, processEnv);
      const adapter = yield* makeCustomAgentAdapter({
        instanceId,
        settings: effectiveConfig,
        workspaceRoot,
        backend,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build CustomAgent adapter: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const textGeneration = makeCustomAgentTextGeneration(effectiveConfig, backend);
      let currentSnapshot = yield* Effect.promise(() =>
        buildSnapshot({
          instanceId,
          displayName,
          accentColor,
          enabled,
          config: effectiveConfig,
          workspaceRoot,
          environment: processEnv,
          continuationKey: continuationIdentity.continuationKey,
        }),
      );
      const refresh = Effect.promise(async () => {
        currentSnapshot = await buildSnapshot({
          instanceId,
          displayName,
          accentColor,
          enabled,
          config: effectiveConfig,
          workspaceRoot,
          environment: processEnv,
          continuationKey: continuationIdentity.continuationKey,
        });
        return currentSnapshot;
      });
      const snapshot = {
        getSnapshot: Effect.sync(() => currentSnapshot),
        refresh,
        streamChanges: Stream.make(currentSnapshot),
      };
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
