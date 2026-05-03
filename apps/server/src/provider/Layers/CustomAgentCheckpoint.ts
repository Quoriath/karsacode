import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ThreadId, TurnId } from "@t3tools/contracts";

export interface CustomAgentCheckpointFile {
  readonly path: string;
  readonly beforeHash: string | null;
  readonly afterHash?: string | null | undefined;
  readonly beforeContent: string | null;
  readonly afterContent?: string | null | undefined;
}

export interface CustomAgentCheckpoint {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly timestamp: string;
  readonly purpose: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly files: ReadonlyArray<CustomAgentCheckpointFile>;
  readonly unifiedDiff?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly userApprovalId?: string | undefined;
}

export interface CustomAgentCheckpointStore {
  readonly createCheckpoint: (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
    readonly purpose: string;
    readonly files: ReadonlyArray<string>;
    readonly workspaceRoot: string;
    readonly toolCallId?: string | undefined;
    readonly unifiedDiff?: string | undefined;
  }) => Promise<CustomAgentCheckpoint>;
  readonly finalizeCheckpoint: (
    id: string,
    workspaceRoot: string,
  ) => Promise<CustomAgentCheckpoint | undefined>;
  readonly listCheckpoints: (threadId?: ThreadId) => ReadonlyArray<CustomAgentCheckpoint>;
  readonly rollbackCheckpoint: (
    id: string,
    workspaceRoot: string,
  ) => Promise<CustomAgentCheckpoint>;
}

export function customAgentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readMaybe(file: string): Promise<string | null> {
  if (!existsSync(file)) return null;
  return readFile(file, "utf8");
}

export function makeCustomAgentCheckpointStore(): CustomAgentCheckpointStore {
  const checkpoints = new Map<string, CustomAgentCheckpoint>();
  return {
    createCheckpoint: async (input) => {
      const files = await Promise.all(
        input.files.map(async (file) => {
          const full = path.resolve(input.workspaceRoot, file);
          const content = await readMaybe(full);
          return {
            path: path.relative(input.workspaceRoot, full),
            beforeHash: content === null ? null : customAgentHash(content),
            beforeContent: content,
          } satisfies CustomAgentCheckpointFile;
        }),
      );
      const checkpoint: CustomAgentCheckpoint = {
        id: `checkpoint_${randomUUID()}`,
        threadId: input.threadId,
        turnId: input.turnId,
        timestamp: new Date().toISOString(),
        purpose: input.purpose,
        changedFiles: files.map((file) => file.path),
        files,
        unifiedDiff: input.unifiedDiff,
        toolCallId: input.toolCallId,
      };
      checkpoints.set(checkpoint.id, checkpoint);
      return checkpoint;
    },
    finalizeCheckpoint: async (id, workspaceRoot) => {
      const checkpoint = checkpoints.get(id);
      if (!checkpoint) return undefined;
      const files = await Promise.all(
        checkpoint.files.map(async (file) => {
          const content = await readMaybe(path.resolve(workspaceRoot, file.path));
          return {
            ...file,
            afterContent: content,
            afterHash: content === null ? null : customAgentHash(content),
          };
        }),
      );
      const next = { ...checkpoint, files };
      checkpoints.set(id, next);
      return next;
    },
    listCheckpoints: (threadId) =>
      [...checkpoints.values()].filter(
        (checkpoint) => !threadId || checkpoint.threadId === threadId,
      ),
    rollbackCheckpoint: async (id, workspaceRoot) => {
      const checkpoint = checkpoints.get(id);
      if (!checkpoint) throw new Error(`Checkpoint not found: ${id}`);
      for (const file of checkpoint.files) {
        const full = path.resolve(workspaceRoot, file.path);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, file.beforeContent ?? "", "utf8");
      }
      return checkpoint;
    },
  };
}
