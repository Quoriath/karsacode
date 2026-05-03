import { CustomAgentSettings } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { CustomAgentDriver } from "./CustomAgentDriver.ts";

describe("CustomAgentDriver", () => {
  it("has expected driver metadata and registration", () => {
    expect(CustomAgentDriver.driverKind).toBe("customAgent");
    expect(CustomAgentDriver.metadata.displayName).toBe("Custom Agent");
    expect(CustomAgentDriver.metadata.supportsMultipleInstances).toBe(true);
    expect(BUILT_IN_DRIVERS).toContain(CustomAgentDriver);
  });

  it("decodes default and custom config", () => {
    const defaultConfig = CustomAgentDriver.defaultConfig();
    expect(defaultConfig.enabled).toBe(false);
    expect(defaultConfig.model).toBe("gpt-4.1");
    expect(defaultConfig.approvalPolicy).toBe("on-mutation");
    expect(defaultConfig.sandboxMode).toBe("workspace-write");
    const config = Schema.decodeSync(CustomAgentSettings)({
      enabled: true,
      model: "gpt-4",
      apiBaseUrl: "https://api.example.com/v1",
      apiKeyEnvVar: "CUSTOM_API_KEY",
      apiKeyHeader: "api-key",
      apiKeyPrefix: "",
      apiKeyRequired: false,
      apiKey: "sk-custom",
    });
    expect(config.enabled).toBe(true);
    expect(config.model).toBe("gpt-4");
    expect(config.apiBaseUrl).toBe("https://api.example.com/v1");
    expect(config.apiKeyEnvVar).toBe("CUSTOM_API_KEY");
    expect(config.apiKeyHeader).toBe("api-key");
    expect(config.apiKeyPrefix).toBe("");
    expect(config.apiKeyRequired).toBe(false);
    expect(config.apiKey).toBe("sk-custom");
  });
});
