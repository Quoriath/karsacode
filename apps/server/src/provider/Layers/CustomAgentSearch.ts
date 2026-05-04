import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CustomAgentSettings } from "@t3tools/contracts";
import { normalizeCustomAgentPath } from "./CustomAgentSandbox.ts";

const execFileAsync = promisify(execFile);
const WALK_CACHE_TTL_MS = 10_000;
const COMMAND_EXISTS_CACHE = new Map<string, boolean>();
const WALK_CACHE = new Map<
  string,
  { readonly createdAt: number; readonly files: ReadonlyArray<string> }
>();
const IGNORED_DIRS = new Set([
  ".git",
  ".gradle",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

export interface CustomAgentSearchResult {
  readonly totalMatches: number;
  readonly topFiles: ReadonlyArray<string>;
  readonly snippets: ReadonlyArray<{ path: string; line: number; text: string }>;
  readonly suggestedReads: ReadonlyArray<{ path: string; startLine: number; endLine: number }>;
  readonly raw: string;
}

async function commandExists(binary: string): Promise<boolean> {
  const cached = COMMAND_EXISTS_CACHE.get(binary);
  if (cached !== undefined) return cached;
  try {
    await execFileAsync("/bin/sh", ["-lc", `command -v ${binary}`], { timeout: 1000 });
    COMMAND_EXISTS_CACHE.set(binary, true);
    return true;
  } catch {
    COMMAND_EXISTS_CACHE.set(binary, false);
    return false;
  }
}

async function walk(root: string, max = 5000): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  const cacheKey = `${resolvedRoot}:${max}`;
  const cached = WALK_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.createdAt <= WALK_CACHE_TTL_MS) return [...cached.files];
  const output: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (output.length >= max) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) output.push(full);
      if (output.length >= max) return;
    }
  }
  await visit(resolvedRoot);
  WALK_CACHE.set(cacheKey, { createdAt: Date.now(), files: output });
  return output;
}

function extensionLabel(file: string): string {
  return path.extname(file).slice(1).toLowerCase() || "<none>";
}

function topEntries(
  counts: Map<string, number>,
  limit: number,
): ReadonlyArray<{
  readonly name: string;
  readonly count: number;
}> {
  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function detectPackageManagers(workspaceRoot: string): ReadonlyArray<string> {
  return [
    ["bun", "bun.lock"],
    ["pnpm", "pnpm-lock.yaml"],
    ["npm", "package-lock.json"],
    ["yarn", "yarn.lock"],
    ["cargo", "Cargo.toml"],
    ["gradle", "build.gradle"],
    ["flutter", "pubspec.yaml"],
    ["go", "go.mod"],
    ["python", "pyproject.toml"],
  ]
    .filter(([, file]) => existsSync(path.join(workspaceRoot, file!)))
    .map(([name]) => name!);
}

function detectProjectSignals(workspaceRoot: string): ReadonlyArray<string> {
  return [
    ["package.json", "Node/TypeScript"],
    ["vite.config.ts", "Vite"],
    ["turbo.json", "Turborepo"],
    ["bun.lock", "Bun"],
    ["Cargo.toml", "Rust"],
    ["pubspec.yaml", "Dart/Flutter"],
    ["go.mod", "Go"],
    ["pyproject.toml", "Python"],
    ["apps/server", "server app"],
    ["apps/web", "web app"],
    ["packages/contracts", "shared contracts"],
  ]
    .filter(([file]) => existsSync(path.join(workspaceRoot, file!)))
    .map(([, label]) => label!);
}

export async function getCustomAgentProjectContext(input: {
  settings: CustomAgentSettings;
  workspaceRoot: string;
  maxFiles?: number;
}): Promise<{
  readonly workspaceRoot: string;
  readonly projectName: string;
  readonly totalFiles: number;
  readonly truncated: boolean;
  readonly extensions: ReadonlyArray<{ readonly name: string; readonly count: number }>;
  readonly topLevelDirs: ReadonlyArray<{ readonly name: string; readonly count: number }>;
  readonly packageManagers: ReadonlyArray<string>;
  readonly projectSignals: ReadonlyArray<string>;
  readonly system: {
    readonly platform: string;
    readonly release: string;
    readonly arch: string;
    readonly node: string;
    readonly cwd: string;
  };
  readonly summary: string;
}> {
  const root = normalizeCustomAgentPath(input.settings, input.workspaceRoot, ".");
  const maxFiles = input.maxFiles ?? 20_000;
  const files = await walk(root, maxFiles + 1);
  const visibleFiles = files
    .slice(0, maxFiles)
    .map((file) => path.relative(input.workspaceRoot, file));
  const extensionCounts = new Map<string, number>();
  const dirCounts = new Map<string, number>();
  for (const file of visibleFiles) {
    const ext = extensionLabel(file);
    extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
    const parts = file.split(path.sep);
    const top = parts.length > 1 ? parts[0]! : "<root>";
    dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
  }
  const extensions = topEntries(extensionCounts, 20);
  const packageManagers = detectPackageManagers(input.workspaceRoot);
  const projectSignals = detectProjectSignals(input.workspaceRoot);
  const summary = [
    `${path.basename(input.workspaceRoot)}: ${visibleFiles.length}${files.length > maxFiles ? "+" : ""} indexed files`,
    `Extensions: ${extensions.map((entry) => `${entry.count} ${entry.name}`).join(", ") || "none"}`,
    `Signals: ${projectSignals.join(", ") || "unknown"}`,
    `System: ${os.platform()} ${os.release()} ${os.arch()}, Node ${process.version}`,
  ].join("\n");
  return {
    workspaceRoot: input.workspaceRoot,
    projectName: path.basename(input.workspaceRoot),
    totalFiles: visibleFiles.length,
    truncated: files.length > maxFiles,
    extensions,
    topLevelDirs: topEntries(dirCounts, 16),
    packageManagers,
    projectSignals,
    system: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      node: process.version,
      cwd: process.cwd(),
    },
    summary,
  };
}

export async function findCustomAgentFiles(input: {
  settings: CustomAgentSettings;
  workspaceRoot: string;
  query?: string;
  extension?: string;
  path?: string;
  maxResults?: number;
}): Promise<{
  readonly totalMatches: number;
  readonly files: ReadonlyArray<string>;
  readonly summary: string;
}> {
  const maxResults = input.maxResults ?? Math.min(input.settings.maxSearchResults, 100);
  const root = normalizeCustomAgentPath(input.settings, input.workspaceRoot, input.path ?? ".");
  const query = input.query?.toLowerCase().trim();
  const extension = input.extension?.replace(/^\./, "").toLowerCase().trim();
  const files = (await walk(root, 20_000))
    .map((file) => path.relative(input.workspaceRoot, file))
    .filter((file) => {
      if (query && !file.toLowerCase().includes(query)) return false;
      if (extension && extensionLabel(file) !== extension) return false;
      return true;
    });
  return {
    totalMatches: files.length,
    files: files.slice(0, maxResults),
    summary: `${files.length} matching files${files.length > maxResults ? `; showing ${maxResults}` : ""}`,
  };
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
    counts.set(extensionLabel(file), (counts.get(extensionLabel(file)) ?? 0) + 1);
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
