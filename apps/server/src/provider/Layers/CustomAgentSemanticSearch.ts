import type { CustomAgentSettings } from "@t3tools/contracts";
import { searchCustomAgentRepo } from "./CustomAgentSearch.ts";

export async function semanticSearchCustomAgent(input: {
  settings: CustomAgentSettings;
  workspaceRoot: string;
  query: string;
  path?: string;
  glob?: string;
  maxResults?: number;
}) {
  if (!input.settings.semanticSearchEnabled) {
    return {
      enabled: false,
      message: "Semantic search is disabled for this provider instance.",
      results: [] as ReadonlyArray<unknown>,
    };
  }
  const lexical = await searchCustomAgentRepo({
    ...input,
    regex: false,
    caseSensitive: false,
    contextLines: 2,
  });
  return {
    enabled: true,
    message: "Hybrid lexical semantic fallback results.",
    results: lexical.snippets.map((snippet) => ({
      path: snippet.path,
      line: snippet.line,
      text: snippet.text,
      score: 1,
      summary: snippet.text,
      suggestedRead: {
        path: snippet.path,
        startLine: Math.max(1, snippet.line - 5),
        endLine: snippet.line + 5,
      },
    })),
  };
}
