import { TextGenerationError, type CustomAgentSettings } from "@t3tools/contracts";
import { Effect } from "effect";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import type { TextGenerationShape } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  extractJsonObject,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import type { CustomAgentLlmBackend } from "../provider/Layers/CustomAgentLlmBackend.ts";

async function runJson(
  backend: CustomAgentLlmBackend,
  settings: CustomAgentSettings,
  operation: string,
  prompt: string,
): Promise<unknown> {
  const output = await backend.complete({
    model: settings.model,
    messages: [
      { role: "system", content: "Return only JSON matching the requested schema." },
      { role: "user", content: prompt },
    ],
  });
  return JSON.parse(extractJsonObject(output.content));
}

function fail(operation: string, cause: unknown): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail: String((cause as Error).message ?? cause),
    cause,
  });
}

export function makeCustomAgentTextGeneration(
  settings: CustomAgentSettings,
  backend: CustomAgentLlmBackend,
): TextGenerationShape {
  return {
    generateCommitMessage: (input) =>
      Effect.tryPromise({
        try: async () => {
          const { prompt } = buildCommitMessagePrompt({
            branch: input.branch,
            stagedSummary: input.stagedSummary,
            stagedPatch: input.stagedPatch,
            includeBranch: input.includeBranch === true,
          });
          const json = (await runJson(backend, settings, "generateCommitMessage", prompt)) as {
            subject?: string;
            body?: string;
            branch?: string;
          };
          return {
            subject: sanitizeCommitSubject(json.subject ?? "Update code"),
            body: (json.body ?? "").trim(),
            ...(json.branch ? { branch: sanitizeFeatureBranchName(json.branch) } : {}),
          };
        },
        catch: (cause) => fail("generateCommitMessage", cause),
      }),
    generatePrContent: (input) =>
      Effect.tryPromise({
        try: async () => {
          const { prompt } = buildPrContentPrompt({
            baseBranch: input.baseBranch,
            headBranch: input.headBranch,
            commitSummary: input.commitSummary,
            diffSummary: input.diffSummary,
            diffPatch: input.diffPatch,
          });
          const json = (await runJson(backend, settings, "generatePrContent", prompt)) as {
            title?: string;
            body?: string;
          };
          return {
            title: sanitizePrTitle(json.title ?? "Update code"),
            body: (json.body ?? "").trim(),
          };
        },
        catch: (cause) => fail("generatePrContent", cause),
      }),
    generateBranchName: (input) =>
      Effect.tryPromise({
        try: async () => {
          const { prompt } = buildBranchNamePrompt({
            message: input.message,
            attachments: input.attachments,
          });
          const json = (await runJson(backend, settings, "generateBranchName", prompt)) as {
            branch?: string;
          };
          return { branch: sanitizeBranchFragment(json.branch ?? "update-code") };
        },
        catch: (cause) => fail("generateBranchName", cause),
      }),
    generateThreadTitle: (input) =>
      Effect.tryPromise({
        try: async () => {
          const { prompt } = buildThreadTitlePrompt({
            message: input.message,
            attachments: input.attachments,
          });
          const json = (await runJson(backend, settings, "generateThreadTitle", prompt)) as {
            title?: string;
          };
          return { title: sanitizeThreadTitle(json.title ?? "New thread") };
        },
        catch: (cause) => fail("generateThreadTitle", cause),
      }),
  };
}
