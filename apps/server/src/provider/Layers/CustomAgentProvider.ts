import type { CustomAgentSettings, ServerProviderModel } from "@t3tools/contracts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

export interface CustomAgentProviderDraft extends ServerProviderDraft {
  readonly warnings: ReadonlyArray<string>;
}

export function makePendingCustomAgentProvider(
  config: CustomAgentSettings,
): CustomAgentProviderDraft {
  const warnings =
    !config.apiKeyEnvVar || !process.env[config.apiKeyEnvVar]
      ? [`API key environment variable '${config.apiKeyEnvVar}' is not set`]
      : [];
  const models: ServerProviderModel[] = [
    { slug: config.model, name: config.model, isCustom: true, capabilities: null },
  ];
  return {
    displayName: "Custom Agent",
    enabled: config.enabled,
    installed: warnings.length === 0,
    version: "native",
    status: warnings.length === 0 ? "ready" : "error",
    auth: { status: warnings.length === 0 ? "authenticated" : "unauthenticated" },
    checkedAt: new Date().toISOString(),
    ...(warnings.length > 0
      ? {
          availability: "unavailable",
          unavailableReason: warnings.join(", "),
          message: warnings.join(", "),
        }
      : { availability: "available" }),
    models,
    slashCommands: [],
    skills: [],
    warnings,
  };
}
