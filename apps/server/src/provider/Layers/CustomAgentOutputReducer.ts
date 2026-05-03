import type { CustomAgentSettings } from "@t3tools/contracts";

export interface CustomAgentReducedOutput {
  readonly preview: string;
  readonly summary: string;
  readonly importantSnippets: ReadonlyArray<string>;
  readonly omittedBytes: number;
  readonly truncated: boolean;
  readonly suggestedNextAction?: string | undefined;
}

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /([A-Z0-9_]*(?:API|TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*\s*[=:]\s*)([^\s'`"]+)/gi,
  /(bearer\s+)[a-z0-9._~+/=-]+/gi,
  /(-----BEGIN [^-]+ PRIVATE KEY-----)[\s\S]*?(-----END [^-]+ PRIVATE KEY-----)/gi,
];

export function redactCustomAgentSecrets(input: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern) =>
      text.replace(pattern, (...parts: Array<unknown>) => {
        const prefix = typeof parts[1] === "string" ? parts[1] : "";
        const suffix =
          typeof parts[2] === "string" && parts[2].startsWith("-----END") ? parts[2] : "";
        return `${prefix}[REDACTED]${suffix}`;
      }),
    input,
  );
}

// ── Smart Filtering (RTK-style) ──────────────────────────────

function removeComments(source: string, extension?: string): string {
  const ext = extension?.toLowerCase();
  const isJsLike = ["js", "ts", "jsx", "tsx", "mjs", "cjs"].includes(ext ?? "");
  const isPy = ext === "py";
  const isRust = ext === "rs";
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (isJsLike || isRust) {
      if (trimmed.startsWith("//")) continue;
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlock = true;
        continue;
      }
      if (inBlock) {
        if (trimmed.includes("*/")) inBlock = false;
        continue;
      }
    }
    if (isPy && trimmed.startsWith("#")) continue;
    if (isRust && trimmed.startsWith("///")) continue;
    out.push(line);
  }
  return out.join("\n");
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
}

function removeBoilerplate(lines: string[]): string[] {
  const out: string[] = [];
  let prevEmpty = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (!prevEmpty) out.push("");
      prevEmpty = true;
      continue;
    }
    prevEmpty = false;
    // Skip ASCII art / decorative borders
    if (
      /^[┌┐└┘├┤┬┴┼─│═║╒╓╔╕╖╗╘╙╚╛╜╝┄┅┆┇┈┉┊┋┍┎┏┑┒┓┕┖┗┙┚┛┝┞┟┠┡┢┣┥┦┧┨┩┪┫┭┮┯┰┱┲┳┵┶┷┸┹┺┻┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍]+$/u.test(
        trimmed,
      )
    )
      continue;
    out.push(line);
  }
  return out;
}

// ── Grouping (RTK-style) ──────────────────────────────────────

type GroupedLines = Array<{
  readonly group: string;
  readonly lines: ReadonlyArray<string>;
  readonly count: number;
}>;

function groupByPattern(
  lines: string[],
  pattern: RegExp,
  extractGroup: (match: RegExpExecArray) => string,
): GroupedLines {
  const map = new Map<string, string[]>();
  for (const line of lines) {
    const m = pattern.exec(line);
    pattern.lastIndex = 0;
    const key = m ? extractGroup(m) : "_ungrouped";
    map.set(key, [...(map.get(key) ?? []), line]);
  }
  return [...map.entries()].map(([group, lines]) => ({ group, lines, count: lines.length }));
}

// ── Deduplication ─────────────────────────────────────────────

function deduplicateLines(lines: string[]): string[] {
  const out: string[] = [];
  let current: { line: string; count: number } | null = null;
  for (const line of lines) {
    if (current && current.line === line) {
      current.count++;
    } else {
      if (current)
        out.push(current.count > 1 ? `${current.line} [x${current.count}]` : current.line);
      current = { line, count: 1 };
    }
  }
  if (current) out.push(current.count > 1 ? `${current.line} [x${current.count}]` : current.line);
  return out;
}

// ── Truncation ────────────────────────────────────────────────

function truncateBytes(
  input: string,
  maxBytes: number,
): { text: string; omittedBytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes <= maxBytes) return { text: input, omittedBytes: 0, truncated: false };
  const buffer = Buffer.from(input, "utf8").subarray(0, Math.max(0, maxBytes));
  return { text: buffer.toString("utf8"), omittedBytes: bytes - buffer.length, truncated: true };
}

function smartTruncate(text: string, maxLines: number, preserveImportant = true): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  if (!preserveImportant) return lines.slice(0, maxLines).join("\n");
  const important = lines.filter((l) =>
    /error|fail|exception|panic|assert|undefined|null|not found|cannot|unable|invalid|warning|WARN|ERR|FATAL/i.test(
      l,
    ),
  );
  if (important.length > 0 && important.length <= maxLines) {
    return [
      `...${lines.length - maxLines} lines omitted...`,
      ...important.slice(0, maxLines - 1),
    ].join("\n");
  }
  return [
    ...lines.slice(0, Math.floor(maxLines * 0.6)),
    `...${lines.length - maxLines} lines omitted...`,
    ...lines.slice(-Math.floor(maxLines * 0.4)),
  ].join("\n");
}

// ── Summarization ─────────────────────────────────────────────

function summarizeLines(raw: string, maxLines = 20): ReadonlyArray<string> {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const failures = lines.filter((line) =>
    /fail|error|exception|expected|received|\bTS\d+\b|eslint|vitest|jest|pytest|panic|assert|undefined|null|not found|cannot|unable|invalid|warning|WARN|ERR|FATAL/i.test(
      line,
    ),
  );
  const selected = failures.length > 0 ? failures : lines;
  return selected.slice(0, maxLines);
}

// ── Test Output Compaction ─────────────────────────────────────

function compactTestOutput(text: string): string {
  const lines = text.split(/\r?\n/);
  const failures: string[] = [];
  let currentSuite = "";
  const suites = new Map<string, { pass: number; fail: number }>();
  for (const line of lines) {
    const suiteMatch = line.match(/^\s*(?:Suite|Describe|#)\s+(.+)/i);
    if (suiteMatch) currentSuite = suiteMatch[1]!;
    if (/\b(failed|failure|FAIL|error|Error)\b/i.test(line)) {
      failures.push(line);
      const s = suites.get(currentSuite) ?? { pass: 0, fail: 0 };
      suites.set(currentSuite, { ...s, fail: s.fail + 1 });
    } else if (/\b(pass|ok|✓|✔|success)\b/i.test(line)) {
      const s = suites.get(currentSuite) ?? { pass: 0, fail: 0 };
      suites.set(currentSuite, { ...s, pass: s.pass + 1 });
    }
  }
  const suiteSummary = [...suites.entries()]
    .map(([name, { pass, fail }]) => `${name}: ${pass} pass, ${fail} fail`)
    .join("\n");
  if (failures.length === 0) return `All tests passed.\n${suiteSummary}`;
  return [
    `Test failures: ${failures.length}`,
    suiteSummary,
    "Failed tests:",
    ...failures.slice(0, 30),
    failures.length > 30 ? `...and ${failures.length - 30} more failures` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Git Output Compaction ─────────────────────────────────────

function compactGitStatus(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const staged = lines.filter(
    (l) => l.startsWith("M ") || l.startsWith("A ") || l.startsWith("D "),
  );
  const unstaged = lines.filter(
    (l) => l.startsWith(" M") || l.startsWith(" D") || l.startsWith("??"),
  );
  return [
    staged.length > 0
      ? `Staged (${staged.length}): ${staged.slice(0, 10).join(", ")}${staged.length > 10 ? `...` : ""}`
      : "",
    unstaged.length > 0
      ? `Unstaged (${unstaged.length}): ${unstaged.slice(0, 10).join(", ")}${unstaged.length > 10 ? `...` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function compactGitDiff(text: string): string {
  const lines = text.split(/\r?\n/);
  const hunks = lines.filter((l) => l.startsWith("@@") || l.startsWith("+")).slice(0, 100);
  if (hunks.length < lines.length) {
    return [
      `Diff: ${lines.length} lines, ${hunks.filter((l) => l.startsWith("+")).length} added, ${hunks.filter((l) => l.startsWith("-")).length} removed`,
      ...hunks,
    ].join("\n");
  }
  return text;
}

// ── Search Output Compaction ──────────────────────────────────

function compactSearchResults(text: string, toolName: string): string {
  if (toolName !== "search_repo") return text;
  const lines = text.split(/\r?\n/);
  const fileMap = new Map<string, string[]>();
  for (const line of lines) {
    const m = line.match(/^(.+?):(\d+):\s*(.+)$/);
    if (m) {
      const [, file] = m;
      fileMap.set(file!, [...(fileMap.get(file!) ?? []), line]);
    }
  }
  if (fileMap.size === 0) return text;
  return [
    `Found in ${fileMap.size} files:`,
    ...[...fileMap.entries()].map(([file, lns]) => `  ${file}: ${lns.length} matches`),
    "",
    "Top matches:",
    ...[...fileMap.values()].flat().slice(0, 50),
  ].join("\n");
}

// ── Main Reduction Entrypoint ──────────────────────────────────

export function reduceCustomAgentOutput(input: {
  readonly raw: string;
  readonly toolName: string;
  readonly purpose: string;
  readonly settings: CustomAgentSettings;
  readonly maxPreviewBytes?: number | undefined;
  readonly fileExtension?: string | undefined;
}): CustomAgentReducedOutput {
  const redacted = input.settings.redactSecrets ? redactCustomAgentSecrets(input.raw) : input.raw;
  const maxPreviewBytes = input.maxPreviewBytes ?? input.settings.maxToolPreviewBytes;

  let processed = redacted;

  // Apply RTK-style compaction based on tool type
  switch (input.toolName) {
    case "read_file": {
      processed = removeComments(processed, input.fileExtension);
      processed = collapseWhitespace(processed);
      processed = smartTruncate(processed, 80, true);
      break;
    }
    case "search_repo": {
      processed = compactSearchResults(processed, input.toolName);
      processed = smartTruncate(processed, 40, true);
      break;
    }
    case "run_command": {
      processed = compactTestOutput(processed);
      processed = smartTruncate(processed, 60, true);
      break;
    }
    case "git_status": {
      processed = compactGitStatus(processed);
      break;
    }
    case "git_diff": {
      processed = compactGitDiff(processed);
      processed = smartTruncate(processed, 80, true);
      break;
    }
    case "list_files": {
      const lines = processed.split(/\r?\n/);
      const grouped = groupByPattern(lines, /^(.+\/)/, (m) => m[1]!);
      if (grouped.length > 1) {
        processed = grouped.map((g) => `  ${g.group} (${g.count} items)`).join("\n");
      }
      processed = smartTruncate(processed, 50, false);
      break;
    }
    default: {
      // General compaction: deduplicate, collapse whitespace, truncate
      let lines = processed.split(/\r?\n/);
      lines = removeBoilerplate(lines);
      lines = deduplicateLines(lines);
      processed = lines.join("\n");
      processed = collapseWhitespace(processed);
      processed = smartTruncate(processed, 60, true);
    }
  }

  const truncated = truncateBytes(processed, maxPreviewBytes);
  const snippets = summarizeLines(redacted);

  const summary = [
    `${input.toolName} output: ${Buffer.byteLength(redacted, "utf8")} bytes → ${Buffer.byteLength(truncated.text, "utf8")} bytes`,
    truncated.truncated
      ? `${truncated.omittedBytes} bytes omitted; full output stored as artifact.`
      : "Output fits preview budget.",
    snippets.length > 0 ? `Key lines: ${snippets.slice(0, 3).join(" | ")}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    preview: truncated.text,
    summary,
    importantSnippets: snippets,
    omittedBytes: truncated.omittedBytes,
    truncated: truncated.truncated,
    ...(truncated.truncated
      ? { suggestedNextAction: "retrieve_artifact for exact slices if needed" }
      : {}),
  };
}

export function estimateCustomAgentTokens(input: string): number {
  // Approximation: 1 token ≈ 4 chars for English/code
  return Math.ceil(input.length / 4);
}

// ── Context Budget Management ─────────────────────────────────

export function fitToTokenBudget(input: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (input.length <= maxChars) return input;
  // Try to preserve structure: keep first 30% and last 30%
  const headLen = Math.floor(maxChars * 0.3);
  const tailLen = Math.floor(maxChars * 0.3);
  return [
    input.slice(0, headLen),
    `\n... [${input.length - headLen - tailLen} chars omitted] ...\n`,
    input.slice(-tailLen),
  ].join("");
}
