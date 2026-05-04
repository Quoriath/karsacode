import { parsePatchFiles } from "@pierre/diffs";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export function parseTurnDiffFilesFromUnifiedDiff(
  diff: string,
): ReadonlyArray<TurnDiffFileSummary> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const parsedPatches = parsePatchFiles(normalized);
  const files = parsedPatches.flatMap((patch) =>
    patch.files.map((file) => ({
      path: file.name,
      additions: file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
      deletions: file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
    })),
  );

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

export function inferTurnDiffFileKind(
  diff: string,
  filePath: string,
): "added" | "deleted" | "modified" {
  const normalized = diff.replace(/\r\n/g, "\n");
  const fileBlock = findDiffBlock(normalized, filePath);
  if (!fileBlock) return "modified";
  if (fileBlock.includes("\ndeleted file mode ") || fileBlock.includes(`\n+++ /dev/null`)) {
    return "deleted";
  }
  if (fileBlock.includes("\nnew file mode ") || fileBlock.includes(`\n--- /dev/null`)) {
    return "added";
  }
  return "modified";
}

function findDiffBlock(diff: string, filePath: string): string | null {
  const headerPattern = /^diff --git a\/(.+) b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(diff))) {
    const start = match.index;
    const nextMatch = headerPattern.exec(diff);
    const end = nextMatch?.index ?? diff.length;
    headerPattern.lastIndex = nextMatch?.index ?? diff.length;
    const oldPath = match[1] ?? "";
    const newPath = match[2] ?? "";
    if (oldPath === filePath || newPath === filePath) {
      return diff.slice(start, end);
    }
  }

  const escaped = escapeRegExp(filePath);
  const fallback = new RegExp(
    `(?:^|\\n)--- (?:a/${escaped}|/dev/null)\\n\\+\\+\\+ (?:b/${escaped}|/dev/null)(?:\\n[\\s\\S]*?)(?=\\n--- |\\ndiff --git |$)`,
  ).exec(diff);
  return fallback?.[0] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
