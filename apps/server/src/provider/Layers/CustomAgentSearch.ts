import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CustomAgentSettings } from "@t3tools/contracts";
import { normalizeCustomAgentPath } from "./CustomAgentSandbox.ts";

const execFileAsync = promisify(execFile);

export interface CustomAgentSearchResult {
  readonly totalMatches: number;
  readonly topFiles: ReadonlyArray<string>;
  readonly snippets: ReadonlyArray<{ path: string; line: number; text: string }>;
  readonly suggestedReads: ReadonlyArray<{ path: string; startLine: number; endLine: number }>;
  readonly raw: string;
}

async function commandExists(binary: string): Promise<boolean> {
  try {
    await execFileAsync("/bin/sh", ["-lc", `command -v ${binary}`], { timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

async function walk(root: string, max = 5000): Promise<string[]> {
  const output: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (output.length >= max) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) output.push(full);
      if (output.length >= max) return;
    }
  }
  await visit(root);
  return output;
}

export async function listCustomAgentFiles(input: {
  settings: CustomAgentSettings;
  workspaceRoot: string;
  path?: string;
  glob?: string;
  maxResults?: number;
  includeHidden?: boolean;
}): Promise<{ files: ReadonlyArray<string>; raw: string; summary: string }> {
  const root = normalizeCustomAgentPath(input.settings, input.workspaceRoot, input.path ?? ".");
  const max = input.maxResults ?? input.settings.maxSearchResults;
  let files: string[];
  if (input.settings.preferFd && (await commandExists("fd"))) {
    const args = [
      "--type",
      "f",
      "--max-results",
      String(max),
      ...(input.includeHidden ? ["--hidden"] : []),
      input.glob ?? ".",
      root,
    ];
    const result = await execFileAsync("fd", args, {
      cwd: input.workspaceRoot,
      timeout: 5000,
      maxBuffer: 512_000,
    });
    files = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => path.relative(input.workspaceRoot, path.resolve(file)));
  } else {
    files = (await walk(root, max))
      .filter((file) => input.includeHidden || !path.basename(file).startsWith("."))
      .map((file) => path.relative(input.workspaceRoot, file))
      .slice(0, max);
  }
  const counts = new Map<string, number>();
  for (const file of files)
    counts.set(
      path.extname(file) || "<none>",
      (counts.get(path.extname(file) || "<none>") ?? 0) + 1,
    );
  return {
    files,
    raw: files.join("\n"),
    summary: `${files.length} files. Extensions: ${[...counts.entries()]
      .slice(0, 10)
      .map(([ext, count]) => `${ext}:${count}`)
      .join(", ")}`,
  };
}

export async function searchCustomAgentRepo(input: {
  settings: CustomAgentSettings;
  workspaceRoot: string;
  query: string;
  path?: string;
  glob?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
  contextLines?: number;
}): Promise<CustomAgentSearchResult> {
  const root = normalizeCustomAgentPath(input.settings, input.workspaceRoot, input.path ?? ".");
  const max = input.maxResults ?? input.settings.maxSearchResults;
  let raw = "";
  if (input.settings.preferRipgrep && (await commandExists("rg"))) {
    const args = [
      "--line-number",
      "--with-filename",
      "--color",
      "never",
      "--max-count",
      String(Math.max(1, max)),
      ...(input.caseSensitive ? [] : ["--ignore-case"]),
      ...(input.regex ? [] : ["--fixed-strings"]),
      ...(input.contextLines ? ["--context", String(input.contextLines)] : []),
      ...(input.glob ? ["--glob", input.glob] : []),
      input.query,
      root,
    ];
    try {
      const result = await execFileAsync("rg", args, {
        cwd: input.workspaceRoot,
        timeout: 10000,
        maxBuffer: 2_000_000,
      });
      raw = result.stdout;
    } catch (error) {
      const e = error as { stdout?: string };
      raw = e.stdout ?? "";
    }
  } else {
    const files = await walk(root);
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= max) break;
      const text = await readFile(file, "utf8").catch(() => "");
      const lines = text.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        const hay = input.caseSensitive ? line : line.toLowerCase();
        if (hay.includes(needle))
          matches.push(`${path.relative(input.workspaceRoot, file)}:${index + 1}:${line}`);
        if (matches.length >= max) break;
      }
    }
    raw = matches.join("\n");
  }
  const snippets = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, max)
    .flatMap((line) => {
      const match = line.match(/^(.*?):(\d+):(.*)$/);
      if (!match) return [];
      const matchedPath = match[1];
      const matchedLine = match[2];
      const matchedText = match[3];
      if (!matchedPath || !matchedLine || matchedText === undefined) return [];
      const file = path.relative(input.workspaceRoot, path.resolve(matchedPath));
      return [{ path: file, line: Number(matchedLine), text: matchedText.trim() }];
    });
  const counts = new Map<string, number>();
  for (const snippet of snippets) counts.set(snippet.path, (counts.get(snippet.path) ?? 0) + 1);
  const topFiles = [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([file]) => file)
    .slice(0, 10);
  return {
    totalMatches: raw.split(/\r?\n/).filter(Boolean).length,
    topFiles,
    snippets,
    suggestedReads: snippets
      .slice(0, 10)
      .map((s) => ({ path: s.path, startLine: Math.max(1, s.line - 3), endLine: s.line + 3 })),
    raw,
  };
}
