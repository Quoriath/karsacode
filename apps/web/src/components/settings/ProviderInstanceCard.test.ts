import { describe, expect, it } from "vitest";
import type { ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  renameCustomAgentApiKeyEnvironmentVariable,
  upsertSensitiveProviderEnvironmentValue,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("Custom Agent API key environment helpers", () => {
  it("stores direct API keys as sensitive provider environment variables", () => {
    expect(upsertSensitiveProviderEnvironmentValue([], "test", "sk-test")).toEqual([
      { name: "test", value: "sk-test", sensitive: true },
    ]);

    expect(
      upsertSensitiveProviderEnvironmentValue(
        [{ name: "test", value: "", sensitive: true, valueRedacted: true }],
        "test",
        "sk-new",
      ),
    ).toEqual([{ name: "test", value: "sk-new", sensitive: true, valueRedacted: false }]);
  });

  it("renames the stored API key env row when the configured variable name changes", () => {
    expect(
      renameCustomAgentApiKeyEnvironmentVariable({
        environment: [{ name: "OPENAI_API_KEY", value: "", sensitive: true, valueRedacted: true }],
        previousName: "OPENAI_API_KEY",
        nextName: "test",
      }),
    ).toEqual([{ name: "test", value: "", sensitive: true, valueRedacted: true }]);
  });
});
