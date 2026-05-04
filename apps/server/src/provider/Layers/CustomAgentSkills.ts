import type { CustomAgentSettings } from "@t3tools/contracts";
import type { CustomAgentContextStore } from "./CustomAgentContextStore.ts";
import { reduceCustomAgentOutput } from "./CustomAgentOutputReducer.ts";
import { getCustomAgentProjectContext, searchCustomAgentRepo } from "./CustomAgentSearch.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface CustomAgentSkillParameter {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly type: "string" | "number" | "boolean" | "array";
}

export interface CustomAgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly parameters: ReadonlyArray<CustomAgentSkillParameter>;
  readonly examples: ReadonlyArray<string>;
  readonly estimatedTokensSaved: string;
  readonly execute: (
    args: Record<string, unknown>,
    context: SkillExecutionContext,
  ) => Promise<SkillResult>;
}

export interface SkillExecutionContext {
  readonly workspaceRoot: string;
  readonly settings: CustomAgentSettings;
  readonly contextStore: CustomAgentContextStore;
}

export interface SkillResult {
  readonly ok: boolean;
  readonly content: string;
  readonly summary: string;
  readonly suggestedNextSteps?: ReadonlyArray<string> | undefined;
}

export type CustomAgentSkillName =
  | "skill_project_orientation"
  | "skill_code_review"
  | "skill_refactor"
  | "skill_test_generation"
  | "skill_documentation"
  | "skill_debug_trace"
  | "skill_dependency_check"
  | "skill_security_audit"
  | "skill_performance_check";

function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}

// ── Built-in Skills ───────────────────────────────────────────

const projectOrientationSkill: CustomAgentSkill = {
  id: "skill_project_orientation",
  name: "Project Orientation",
  description:
    "Builds a compact workspace orientation from indexed file counts, extensions, top-level shape, stack signals, package managers, and OS/runtime context.",
  whenToUse:
    "Use at the start of broad repo analysis, onboarding, or when the user asks what project is active without needing exact file contents.",
  parameters: [
    {
      name: "maxFiles",
      description: "Maximum files to count before reporting truncation",
      required: false,
      type: "number",
    },
  ],
  examples: [
    '{"type":"tool_call","tool":"skill_execute","args":{"skillId":"skill_project_orientation","args":{"maxFiles":20000},"purpose":"Orient on active repo"}}',
  ],
  estimatedTokensSaved: "80% - replaces broad file listing with compact project metadata",
  execute: async (args, ctx) => {
    const maxFiles =
      typeof args.maxFiles === "number" && Number.isFinite(args.maxFiles)
        ? args.maxFiles
        : undefined;
    const context = await getCustomAgentProjectContext({
      settings: ctx.settings,
      workspaceRoot: ctx.workspaceRoot,
      ...(maxFiles !== undefined ? { maxFiles } : {}),
    });
    return {
      ok: true,
      content: [
        context.summary,
        "",
        `Workspace: ${context.workspaceRoot}`,
        `Top-level dirs: ${context.topLevelDirs.map((entry) => `${entry.name}:${entry.count}`).join(", ")}`,
        `Package managers: ${context.packageManagers.join(", ") || "unknown"}`,
        "No file names were expanded beyond top-level directory names and aggregate counts.",
      ].join("\n"),
      summary: context.summary,
      suggestedNextSteps: [
        "Use find_files for filename discovery",
        "Use search_repo or semantic_search before reading files",
      ],
    };
  },
};

const codeReviewSkill: CustomAgentSkill = {
  id: "skill_code_review",
  name: "Code Review",
  description:
    "Performs targeted code review on a file or diff, checking for common issues, style consistency, and potential bugs.",
  whenToUse:
    "Use after writing or modifying code to catch issues before committing. Also useful when asked to review existing code quality.",
  parameters: [
    { name: "filePath", description: "Path to the file to review", required: true, type: "string" },
    {
      name: "focus",
      description: "Review focus: 'bugs', 'style', 'performance', 'all'",
      required: false,
      type: "string",
    },
    {
      name: "diff",
      description: "Optional patch/diff to review instead of full file",
      required: false,
      type: "string",
    },
  ],
  examples: [
    '{"type":"tool_call","tool":"skill_code_review","args":{"filePath":"src/auth.ts","focus":"bugs","purpose":"Review auth module"}}',
    '{"type":"tool_call","tool":"skill_code_review","args":{"filePath":"src/api.ts","diff":"*** Begin Patch\\n...","purpose":"Review PR changes"}}',
  ],
  estimatedTokensSaved: "60% - avoids loading entire codebase for review",
  execute: async (args, ctx) => {
    const filePath = String(args.filePath ?? "");
    const focus = String(args.focus ?? "all");
    const diff = args.diff ? String(args.diff) : undefined;
    const absPath = path.resolve(ctx.workspaceRoot, filePath);

    let content: string;
    try {
      content = await readText(absPath);
    } catch {
      return { ok: false, content: `Cannot read file: ${filePath}`, summary: "File read failed" };
    }

    reduceCustomAgentOutput({
      raw: content,
      toolName: "read_file",
      purpose: "code review input",
      settings: ctx.settings,
      fileExtension: path.extname(filePath).slice(1),
    });

    const issues: string[] = [];
    const lines = content.split(/\r?\n/);

    // Simple heuristic checks
    if (focus === "all" || focus === "bugs") {
      if (
        /console\.(log|warn|error|debug)\([^)]*\)/.test(content) &&
        !/console\.(log|warn|error|debug)\(.*debug|dev/.test(content)
      ) {
        issues.push("Contains console.* statements that should be removed or use proper logging");
      }
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(content)) {
        issues.push("Empty catch blocks hide errors");
      }
      if (/TODO|FIXME|HACK|XXX|BUG/.test(content)) {
        issues.push("Contains unresolved TODO/FIXME/HACK markers");
      }
    }

    if (focus === "all" || focus === "style") {
      const hasMixedQuotes =
        /['"`].*['"`]/.test(content) && content.includes("'") && content.includes('"');
      if (hasMixedQuotes) issues.push("Mixed quote styles detected");
    }

    if (focus === "all" || focus === "performance") {
      if (/for\s*\(\s*let\s+\w+\s*=\s*0/.test(content) && /\.length/.test(content)) {
        issues.push("Consider caching .length in loops");
      }
    }

    if (diff) {
      issues.push(`Reviewing diff of ${filePath}`);
    }

    const summary =
      issues.length > 0
        ? `Found ${issues.length} potential issues in ${filePath}`
        : `No obvious issues in ${filePath}`;

    return {
      ok: issues.length === 0,
      content: [
        summary,
        "",
        "Issues:",
        ...issues,
        "",
        "Preview (first 30 lines):",
        lines.slice(0, 30).join("\n"),
        lines.length > 30 ? `...${lines.length - 30} more lines` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      summary,
      suggestedNextSteps:
        issues.length > 0 ? ["Use edit_file to fix issues", "Run tests after fixes"] : undefined,
    };
  },
};

const refactorSkill: CustomAgentSkill = {
  id: "skill_refactor",
  name: "Smart Refactor",
  description:
    "Suggests and applies safe refactoring patterns like extracting functions, simplifying conditionals, or renaming variables.",
  whenToUse:
    "Use when code is duplicated, functions are too long (>50 lines), or when asked to improve code quality.",
  parameters: [
    { name: "filePath", description: "File to refactor", required: true, type: "string" },
    {
      name: "pattern",
      description:
        "What to refactor: 'extract-function', 'simplify-conditional', 'rename', 'deduplicate'",
      required: true,
      type: "string",
    },
    {
      name: "target",
      description: "Line number or function name to target",
      required: false,
      type: "string",
    },
  ],
  examples: [
    '{"type":"tool_call","tool":"skill_refactor","args":{"filePath":"src/utils.ts","pattern":"extract-function","target":"lines 45-80","purpose":"Extract validation logic"}}',
  ],
  estimatedTokensSaved: "50% - avoids manual search for duplication",
  execute: async (args, ctx) => {
    const filePath = String(args.filePath ?? "");
    const pattern = String(args.pattern ?? "");
    const absPath = path.resolve(ctx.workspaceRoot, filePath);

    let content: string;
    try {
      content = await readText(absPath);
    } catch {
      return { ok: false, content: `Cannot read file: ${filePath}`, summary: "File read failed" };
    }

    const lines = content.split(/\r?\n/);
    const suggestions: string[] = [];

    if (pattern === "extract-function") {
      const longBlocks = lines.reduce<Array<{ start: number; length: number }>>((acc, _, i) => {
        if (i > 0 && lines[i - 1]?.trim() === "{" && !lines[i]?.trim().startsWith("//")) {
          const last = acc.at(-1);
          if (last && last.start + last.length === i) last.length++;
          else acc.push({ start: i, length: 1 });
        }
        return acc;
      }, []);
      const candidates = longBlocks.filter((b) => b.length > 30);
      if (candidates.length > 0) {
        suggestions.push(
          `Found ${candidates.length} long blocks (>30 lines) that could be extracted`,
        );
      }
    }

    if (pattern === "deduplicate") {
      const seen = new Map<string, number[]>();
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.length > 20) {
          const existing = seen.get(trimmed) ?? [];
          existing.push(i + 1);
          seen.set(trimmed, existing);
        }
      });
      const dups = [...seen.entries()].filter(([, indices]) => indices.length > 1);
      if (dups.length > 0) {
        suggestions.push(`Found ${dups.length} duplicated line patterns`);
        dups.slice(0, 5).forEach(([line, indices]) => {
          suggestions.push(`  Lines ${indices.join(", ")}: ${line.slice(0, 60)}...`);
        });
      }
    }

    return {
      ok: suggestions.length > 0,
      content: [
        `Refactor analysis for ${filePath} (pattern: ${pattern})`,
        "",
        ...suggestions,
        suggestions.length === 0 ? "No clear refactoring opportunities found" : "",
      ]
        .filter(Boolean)
        .join("\n"),
      summary: `${suggestions.length} refactoring suggestions for ${filePath}`,
    };
  },
};

const testGenerationSkill: CustomAgentSkill = {
  id: "skill_test_generation",
  name: "Test Generator",
  description:
    "Analyzes code and generates focused test cases for functions, edge cases, and error paths.",
  whenToUse:
    "Use when creating tests for new functions, adding regression tests, or increasing code coverage.",
  parameters: [
    {
      name: "filePath",
      description: "Source file to generate tests for",
      required: true,
      type: "string",
    },
    {
      name: "testFile",
      description: "Target test file path (optional, will suggest)",
      required: false,
      type: "string",
    },
    {
      name: "coverage",
      description: "Coverage focus: 'unit', 'integration', 'edge-cases', 'all'",
      required: false,
      type: "string",
    },
  ],
  examples: [
    '{"type":"tool_call","tool":"skill_test_generation","args":{"filePath":"src/calc.ts","coverage":"edge-cases","purpose":"Add boundary tests"}}',
  ],
  estimatedTokensSaved: "70% - generates focused tests without loading test framework docs",
  execute: async (args, ctx) => {
    const filePath = String(args.filePath ?? "");
    const coverage = String(args.coverage ?? "all");
    const absPath = path.resolve(ctx.workspaceRoot, filePath);

    let content: string;
    try {
      content = await readText(absPath);
    } catch {
      return { ok: false, content: `Cannot read file: ${filePath}`, summary: "File read failed" };
    }

    // Extract function signatures
    const functionMatches = [
      ...content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)/g),
    ];
    const methodMatches = [
      ...content.matchAll(/(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g),
    ];
    const arrowMatches = [
      ...content.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g),
    ];

    const functions = [...functionMatches, ...methodMatches, ...arrowMatches]
      .map((m) => m[1])
      .filter((f): f is string => Boolean(f));

    const tests: string[] = [];
    for (const fn of functions.slice(0, 10)) {
      tests.push(`describe("${fn}", () => {`);
      if (coverage === "all" || coverage === "unit") {
        tests.push(`  it("should handle normal input", () => { /* TODO */ });`);
      }
      if (coverage === "all" || coverage === "edge-cases") {
        tests.push(
          `  it("should handle edge cases", () => { /* TODO: null, empty, max values */ });`,
        );
      }
      tests.push(`});`);
    }

    const suggestedTestFile = args.testFile
      ? String(args.testFile)
      : filePath.replace(/\.ts$/, ".test.ts").replace(/\.js$/, ".test.js");

    return {
      ok: functions.length > 0,
      content: [
        `Test generation for ${filePath}`,
        `Found ${functions.length} functions: ${functions.join(", ")}`,
        "",
        "Suggested test file:",
        suggestedTestFile,
        "",
        "Test templates:",
        ...tests,
      ].join("\n"),
      summary: `Generated test templates for ${functions.length} functions`,
      suggestedNextSteps: [`Write tests to ${suggestedTestFile}`, "Run tests to verify"],
    };
  },
};

const documentationSkill: CustomAgentSkill = {
  id: "skill_documentation",
  name: "Documentation Generator",
  description:
    "Generates or updates documentation from code comments, types, and function signatures.",
  whenToUse:
    "Use when asked to document code, update README, or generate API docs. Also useful after adding new public functions.",
  parameters: [
    { name: "filePath", description: "File to document", required: true, type: "string" },
    {
      name: "format",
      description: "Output format: 'jsdoc', 'tsdoc', 'markdown', 'readme-section'",
      required: false,
      type: "string",
    },
  ],
  examples: [
    '{"type":"tool_call","tool":"skill_documentation","args":{"filePath":"src/api.ts","format":"tsdoc","purpose":"Generate API docs"}}',
  ],
  estimatedTokensSaved: "65% - auto-generates from signatures without manual analysis",
  execute: async (args, ctx) => {
    const filePath = String(args.filePath ?? "");
    const format = String(args.format ?? "tsdoc");
    const absPath = path.resolve(ctx.workspaceRoot, filePath);

    let content: string;
    try {
      content = await readText(absPath);
    } catch {
      return { ok: false, content: `Cannot read file: ${filePath}`, summary: "File read failed" };
    }

    const lines = content.split(/\r?\n/);
    const docs: string[] = [];

    // Find exported functions/classes
    const exports = lines.reduce<
      Array<{ line: number; type: string; name: string; signature: string }>
    >((acc, line, i) => {
      const fn = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
      const cls = line.match(/(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?/);
      const iface = line.match(/(?:export\s+)?interface\s+(\w+)/);
      if (fn) acc.push({ line: i + 1, type: "function", name: fn[1]!, signature: fn[0]! });
      if (cls) acc.push({ line: i + 1, type: "class", name: cls[1]!, signature: cls[0]! });
      if (iface)
        acc.push({ line: i + 1, type: "interface", name: iface[1]!, signature: iface[0]! });
      return acc;
    }, []);

    if (format === "markdown" || format === "readme-section") {
      docs.push(`## ${path.basename(filePath)}`);
      docs.push("");
      for (const e of exports) {
        docs.push(`### ${e.name}`);
        docs.push(`\`\`\`typescript\n${e.signature}\n\`\`\``);
        docs.push("");
      }
    } else {
      for (const e of exports) {
        docs.push(`/**`);
        docs.push(` * ${e.name} - TODO: add description`);
        docs.push(` * @since ${new Date().toISOString().split("T")[0]}`);
        docs.push(` */`);
      }
    }

    return {
      ok: exports.length > 0,
      content: [`Documentation for ${filePath} (${exports.length} exports)`, "", ...docs].join(
        "\n",
      ),
      summary: `Generated ${format} docs for ${exports.length} exports`,
      suggestedNextSteps: ["Insert docs into file", "Update README with generated section"],
    };
  },
};

const debugTraceSkill: CustomAgentSkill = {
  id: "skill_debug_trace",
  name: "Debug Trace",
  description: "Traces error patterns through the codebase to find root causes and suggests fixes.",
  whenToUse:
    "Use when debugging errors, tracing unknown error origins, or finding why a specific behavior occurs.",
  parameters: [
    {
      name: "errorPattern",
      description: "Error message, stack trace snippet, or symptom to trace",
      required: true,
      type: "string",
    },
    {
      name: "entryPoint",
      description: "File where the error was first observed",
      required: false,
      type: "string",
    },
  ],
  examples: [
    '{"type":"tool_call","tool":"skill_debug_trace","args":{"errorPattern":"Cannot read property of undefined","entryPoint":"src/app.ts","purpose":"Trace null reference"}}',
  ],
  estimatedTokensSaved: "75% - targeted search instead of broad file reading",
  execute: async (args, ctx) => {
    const errorPattern = String(args.errorPattern ?? "");
    const entryPoint = args.entryPoint ? String(args.entryPoint) : undefined;

    // Search for the error pattern
    const search = await searchCustomAgentRepo({
      settings: ctx.settings,
      workspaceRoot: ctx.workspaceRoot,
      query: errorPattern,
      maxResults: 20,
      contextLines: 2,
    });

    const traces: string[] = [];
    if (entryPoint) {
      traces.push(`Entry point: ${entryPoint}`);
    }
    traces.push(`Found ${search.totalMatches} references to error pattern`);
    traces.push("Top files:");
    for (const file of search.topFiles.slice(0, 5)) {
      traces.push(`  ${file}`);
    }

    // Analyze snippets for common patterns
    const nullChecks = search.snippets.filter((s) => /null|undefined|\?\.|!\./.test(s.text));
    if (nullChecks.length > 0) {
      traces.push(`\n${nullChecks.length} snippets mention null/undefined handling`);
    }

    return {
      ok: search.totalMatches > 0,
      content: [
        `Debug trace: "${errorPattern}"`,
        "",
        ...traces,
        "",
        "Relevant code snippets:",
        ...search.snippets.slice(0, 10).map((s) => `  ${s.path}:${s.line}: ${s.text.slice(0, 80)}`),
      ].join("\n"),
      summary: `Traced "${errorPattern}" to ${search.totalMatches} locations`,
      suggestedNextSteps: [
        "Read specific files at identified locations",
        "Add defensive null checks",
      ],
    };
  },
};

const dependencyCheckSkill: CustomAgentSkill = {
  id: "skill_dependency_check",
  name: "Dependency Check",
  description:
    "Checks dependencies for known issues, outdated versions, security advisories, and unused packages.",
  whenToUse:
    "Use when asked to audit dependencies, before major updates, or when build/package issues occur.",
  parameters: [
    {
      name: "packageFile",
      description: "Package file: 'package.json', 'Cargo.toml', 'requirements.txt', etc.",
      required: true,
      type: "string",
    },
    {
      name: "checkType",
      description: "Check type: 'outdated', 'security', 'unused', 'all'",
      required: false,
      type: "string",
    },
  ],
  examples: [
    '{"type":"tool_call","tool":"skill_dependency_check","args":{"packageFile":"package.json","checkType":"security","purpose":"Audit dependencies"}}',
  ],
  estimatedTokensSaved: "55% - focused analysis without loading lock files",
  execute: async (args, ctx) => {
    const packageFile = String(args.packageFile ?? "");
    const checkType = String(args.checkType ?? "all");
    const absPath = path.resolve(ctx.workspaceRoot, packageFile);

    let content: string;
    try {
      content = await readText(absPath);
    } catch {
      return {
        ok: false,
        content: `Cannot read file: ${packageFile}`,
        summary: "File read failed",
      };
    }

    const isNode = packageFile.includes("package");
    const deps: string[] = [];

    if (isNode) {
      try {
        const parsed = JSON.parse(content);
        deps.push(...Object.keys(parsed.dependencies ?? {}));
        deps.push(...Object.keys(parsed.devDependencies ?? {}));
      } catch {
        return { ok: false, content: "Invalid package.json", summary: "Parse failed" };
      }
    }

    const issues: string[] = [];
    if (checkType === "all" || checkType === "unused") {
      const imports = await searchCustomAgentRepo({
        settings: ctx.settings,
        workspaceRoot: ctx.workspaceRoot,
        query: `from "(${deps.slice(0, 10).join("|")})"`,
        regex: true,
        maxResults: 50,
      });
      const usedDeps = new Set(
        imports.snippets.map((s) => {
          const m = s.text.match(/from\s+["']([^"']+)["']/);
          return m?.[1] ?? "";
        }),
      );
      const unused = deps.filter((d) => !usedDeps.has(d) && !usedDeps.has(d.split("/")[0]!));
      if (unused.length > 0) {
        issues.push(`Potentially unused dependencies: ${unused.join(", ")}`);
      }
    }

    return {
      ok: issues.length === 0,
      content: [
        `Dependency check for ${packageFile}`,
        `Found ${deps.length} dependencies`,
        "",
        ...issues,
        issues.length === 0 ? "No obvious issues detected" : "",
      ]
        .filter(Boolean)
        .join("\n"),
      summary: `${issues.length} issues found in ${deps.length} dependencies`,
    };
  },
};

const securityAuditSkill: CustomAgentSkill = {
  id: "skill_security_audit",
  name: "Security Audit",
  description:
    "Scans code for common security issues: secrets in code, SQL injection risks, XSS vectors, insecure randomness, etc.",
  whenToUse:
    "Use before deploying, when handling user input, or when asked to audit security posture.",
  parameters: [
    {
      name: "filePath",
      description: "File or directory to audit (use '.' for entire workspace)",
      required: true,
      type: "string",
    },
    {
      name: "severity",
      description: "Minimum severity: 'critical', 'high', 'medium', 'low'",
      required: false,
      type: "string",
    },
  ],
  examples: [
    '{"type":"tool_call","tool":"skill_security_audit","args":{"filePath":"src/auth.ts","severity":"high","purpose":"Audit auth security"}}',
  ],
  estimatedTokensSaved: "70% - targeted security scan vs full file reads",
  execute: async (args, ctx) => {
    const filePath = String(args.filePath ?? "");
    const severity = String(args.severity ?? "medium");

    let filesToScan: string[];
    if (filePath === ".") {
      const search = await searchCustomAgentRepo({
        settings: ctx.settings,
        workspaceRoot: ctx.workspaceRoot,
        query: ".",
        maxResults: 100,
      });
      filesToScan = [...search.topFiles];
    } else {
      filesToScan = [filePath];
    }

    const findings: string[] = [];
    const patterns = [
      { pattern: /eval\s*\(/, severity: "critical", desc: "Use of eval()" },
      { pattern: /innerHTML\s*=/, severity: "high", desc: "innerHTML assignment (XSS risk)" },
      { pattern: /document\.write\s*\(/, severity: "high", desc: "document.write (XSS risk)" },
      {
        pattern: /Math\.random\s*\(\)/,
        severity: "medium",
        desc: "Math.random() for security (use crypto)",
      },
      {
        pattern: /password\s*[=:]\s*["'][^"']{3,}["']/,
        severity: "critical",
        desc: "Hardcoded password",
      },
      { pattern: /SELECT\s+.*\+.*FROM/, severity: "high", desc: "Possible SQL injection" },
    ];

    for (const file of filesToScan.slice(0, 20)) {
      const absPath = path.resolve(ctx.workspaceRoot, file);
      let content: string;
      try {
        content = await readText(absPath);
      } catch {
        continue;
      }
      for (const { pattern, severity: sev, desc } of patterns) {
        if (content.match(pattern)) {
          findings.push(`[${sev}] ${file}: ${desc}`);
        }
      }
    }

    const severityOrder = ["critical", "high", "medium", "low"];
    const minIdx = severityOrder.indexOf(severity);
    const filtered = findings.filter((f) => {
      const match = f.match(/^\[(\w+)\]/);
      if (!match) return true;
      return severityOrder.indexOf(match[1]!) >= minIdx;
    });

    return {
      ok: filtered.length === 0,
      content: [
        `Security audit: ${filesToScan.length} files scanned`,
        filtered.length > 0
          ? `Found ${filtered.length} issues:`
          : "No issues found at this severity level",
        "",
        ...filtered,
      ]
        .filter(Boolean)
        .join("\n"),
      summary: `${filtered.length} security findings`,
      suggestedNextSteps:
        filtered.length > 0
          ? ["Review findings and fix critical first", "Use edit_file for targeted fixes"]
          : undefined,
    };
  },
};

const performanceCheckSkill: CustomAgentSkill = {
  id: "skill_performance_check",
  name: "Performance Check",
  description:
    "Identifies performance bottlenecks, unnecessary re-renders, heavy computations, and suggests optimizations.",
  whenToUse:
    "Use when code is slow, when optimizing hot paths, or when asked to improve performance.",
  parameters: [
    { name: "filePath", description: "File to analyze", required: true, type: "string" },
    {
      name: "focus",
      description: "Focus: 'render', 'loop', 'memory', 'async', 'all'",
      required: false,
      type: "string",
    },
  ],
  examples: [
    '{"type":"tool_call","tool":"skill_performance_check","args":{"filePath":"src/components/List.tsx","focus":"render","purpose":"Optimize list rendering"}}',
  ],
  estimatedTokensSaved: "60% - targeted performance scan vs manual profiling",
  execute: async (args, ctx) => {
    const filePath = String(args.filePath ?? "");
    const focus = String(args.focus ?? "all");
    const absPath = path.resolve(ctx.workspaceRoot, filePath);

    let content: string;
    try {
      content = await readText(absPath);
    } catch {
      return { ok: false, content: `Cannot read file: ${filePath}`, summary: "File read failed" };
    }

    const issues: string[] = [];

    if (focus === "all" || focus === "render") {
      if (/\bmap\s*\([^)]*\)\s*\.(?:map|filter|reduce)/.test(content)) {
        issues.push("Nested array operations detected - consider combining or memoizing");
      }
      if (/useEffect\s*\(\s*\(\)\s*=>\s*\{[^}]*setState/.test(content)) {
        issues.push("useEffect with setState may cause unnecessary re-renders");
      }
    }

    if (focus === "all" || focus === "loop") {
      if (/for\s*\(\s*let\s+\w+\s*=\s*0;\s*\w+\s*<\s*\w+\.length/.test(content)) {
        issues.push("Loop accessing .length each iteration - cache it");
      }
    }

    if (focus === "all" || focus === "async") {
      if (/await\s+\w+\s*;\s*\n\s*await\s+\w+/.test(content) && !/Promise\.all/.test(content)) {
        issues.push("Sequential awaits detected - consider Promise.all for parallel execution");
      }
    }

    return {
      ok: issues.length === 0,
      content: [
        `Performance check for ${filePath}`,
        issues.length > 0
          ? `Found ${issues.length} potential issues:`
          : "No obvious performance issues",
        "",
        ...issues,
      ]
        .filter(Boolean)
        .join("\n"),
      summary: `${issues.length} performance suggestions`,
      suggestedNextSteps:
        issues.length > 0
          ? ["Apply targeted optimizations", "Run benchmarks to measure improvement"]
          : undefined,
    };
  },
};

// ── Skill Registry ──────────────────────────────────────────────

export interface CustomAgentSkillListItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly parameters: ReadonlyArray<CustomAgentSkillParameter>;
  readonly examples: ReadonlyArray<string>;
  readonly estimatedTokensSaved: string;
}

export interface CustomAgentSkillRegistry {
  readonly list: () => ReadonlyArray<CustomAgentSkillListItem>;
  readonly get: (id: string) => CustomAgentSkill | undefined;
  readonly execute: (
    id: string,
    args: Record<string, unknown>,
    context: SkillExecutionContext,
  ) => Promise<SkillResult>;
  readonly names: ReadonlyArray<string>;
}

const BUILT_IN_SKILLS: ReadonlyArray<CustomAgentSkill> = [
  projectOrientationSkill,
  codeReviewSkill,
  refactorSkill,
  testGenerationSkill,
  documentationSkill,
  debugTraceSkill,
  dependencyCheckSkill,
  securityAuditSkill,
  performanceCheckSkill,
];

export function makeCustomAgentSkillRegistry(): CustomAgentSkillRegistry {
  const map = new Map(BUILT_IN_SKILLS.map((s) => [s.id, s]));
  return {
    list: () =>
      BUILT_IN_SKILLS.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse,
        parameters: s.parameters,
        examples: s.examples,
        estimatedTokensSaved: s.estimatedTokensSaved,
      })),
    get: (id) => map.get(id),
    execute: async (id, args, context) => {
      const skill = map.get(id);
      if (!skill) {
        return {
          ok: false,
          content: `Unknown skill: ${id}. Available: ${BUILT_IN_SKILLS.map((s) => s.id).join(", ")}`,
          summary: "Skill not found",
        };
      }
      return skill.execute(args, context);
    },
    names: BUILT_IN_SKILLS.map((s) => s.id),
  };
}

export function formatSkillListForPrompt(skills: ReadonlyArray<CustomAgentSkillListItem>): string {
  return skills
    .map((s) =>
      [
        `- ${s.id}: ${s.name}`,
        `  When: ${s.whenToUse}`,
        `  Params: ${s.parameters.map((p) => `${p.name}${p.required ? "*" : ""}(${p.type})`).join(", ")}`,
        `  Saves: ${s.estimatedTokensSaved}`,
      ].join("\n"),
    )
    .join("\n\n");
}
