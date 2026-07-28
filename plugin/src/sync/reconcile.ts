import {
  type LocalFile,
  type PendingKind,
  type PendingOperation,
  type PortableCore,
  type ReconciliationIssue,
  type ReconciliationResult,
  type SyncRecord,
  type SyncState,
  type VaultPort,
} from "./types";

interface ScannedFile {
  readonly file: LocalFile;
  readonly path: string;
  readonly canonicalHash: string;
}

const TEXT_EXTENSIONS = new Set([
  "base",
  "canvas",
  "css",
  "csv",
  "js",
  "json",
  "md",
  "ts",
  "tsv",
  "txt",
  "yaml",
  "yml",
]);

export class Reconciler {
  constructor(
    private readonly vault: VaultPort,
    private readonly core: PortableCore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async scan(state: SyncState): Promise<ReconciliationResult> {
    const issues: ReconciliationIssue[] = [];
    const scanned = await this.scanFiles(issues);
    const safe = rejectCollisions(scanned, this.core, issues);
    const recordsByPath = new Map(
      state.records.filter((record) => !record.tombstone).map((record) => [record.path, record]),
    );
    const remainingRecords = new Map(recordsByPath);
    const remainingFiles = new Map(safe.map((file) => [file.path, file]));
    const operations: PendingOperation[] = [];

    for (const file of safe) {
      const record = recordsByPath.get(file.path);
      if (record === undefined) {
        continue;
      }
      remainingFiles.delete(file.path);
      remainingRecords.delete(file.path);
      if (record.canonicalHash !== file.canonicalHash) {
        operations.push(this.operation("modify", record, file));
      }
    }

    const missingByHash = groupBy(
      [...remainingRecords.values()],
      (record) => record.canonicalHash,
    );
    const newByHash = groupBy([...remainingFiles.values()], (file) => file.canonicalHash);
    for (const [hash, oldRecords] of missingByHash) {
      const newFiles = newByHash.get(hash);
      if (oldRecords.length !== 1 || newFiles?.length !== 1) {
        continue;
      }
      const record = oldRecords[0];
      const file = newFiles[0];
      if (record === undefined || file === undefined) {
        continue;
      }
      operations.push(this.operation("rename", record, file));
      remainingRecords.delete(record.path);
      remainingFiles.delete(file.path);
    }

    for (const file of remainingFiles.values()) {
      operations.push(this.createOperation(file));
    }
    if (state.initializedFromRemote) {
      for (const record of remainingRecords.values()) {
        operations.push(this.deleteOperation(record));
      }
    }

    return {
      operations: mergeWithPending(state.pending, operations),
      issues,
    };
  }

  private async scanFiles(issues: ReconciliationIssue[]): Promise<ScannedFile[]> {
    const output: ScannedFile[] = [];
    for (const file of await this.vault.listFiles()) {
      let path: string;
      try {
        path = this.core.canonicalizePath(file.path);
      } catch {
        issues.push({ code: "invalid_path", paths: [file.path] });
        continue;
      }
      try {
        const bytes = await this.vault.read(file.path);
        const canonical = TEXT_EXTENSIONS.has(file.extension.toLowerCase())
          ? this.core.canonicalizeText(bytes)
          : bytes;
        output.push({
          file,
          path,
          canonicalHash: this.core.hash(canonical),
        });
      } catch {
        issues.push({ code: "read_failure", paths: [file.path] });
      }
    }
    return output;
  }

  private operation(
    kind: Extract<PendingKind, "modify" | "rename">,
    record: SyncRecord,
    file: ScannedFile,
  ): PendingOperation {
    const revision = (BigInt(record.revision) + 1n).toString();
    return {
      operationId: this.core.newObjectId(),
      kind,
      objectId: record.objectId,
      path: file.path,
      ...(kind === "rename" ? { previousPath: record.path } : {}),
      baseRevision: record.revision,
      revision,
      canonicalHash: file.canonicalHash,
      detectedAt: this.now().toISOString(),
    };
  }

  private createOperation(file: ScannedFile): PendingOperation {
    return {
      operationId: this.core.newObjectId(),
      kind: "create",
      objectId: this.core.newObjectId(),
      path: file.path,
      baseRevision: "0",
      revision: "1",
      canonicalHash: file.canonicalHash,
      detectedAt: this.now().toISOString(),
    };
  }

  private deleteOperation(record: SyncRecord): PendingOperation {
    return {
      operationId: this.core.newObjectId(),
      kind: "delete",
      objectId: record.objectId,
      path: record.path,
      baseRevision: record.revision,
      revision: (BigInt(record.revision) + 1n).toString(),
      detectedAt: this.now().toISOString(),
    };
  }
}

function rejectCollisions(
  files: readonly ScannedFile[],
  core: PortableCore,
  issues: ReconciliationIssue[],
): ScannedFile[] {
  const byKey = groupBy(files, (file) => core.collisionKey(file.path));
  const rejected = new Set<string>();
  for (const group of byKey.values()) {
    if (group.length < 2) {
      continue;
    }
    const paths = group.map((file) => file.path).sort();
    issues.push({ code: "portable_collision", paths });
    for (const path of paths) {
      rejected.add(path);
    }
  }
  return files.filter((file) => !rejected.has(file.path));
}

function mergeWithPending(
  pending: readonly PendingOperation[],
  scanned: readonly PendingOperation[],
): PendingOperation[] {
  const next = new Map(pending.map((operation) => [operation.objectId, operation]));
  for (const operation of scanned) {
    next.set(operation.objectId, operation);
  }
  return [...next.values()].sort((left, right) =>
    left.objectId.localeCompare(right.objectId),
  );
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const group = groups.get(groupKey) ?? [];
    group.push(value);
    groups.set(groupKey, group);
  }
  return groups;
}
