import { Reconciler } from "./reconcile";
import type { CiphertextCache } from "./cache";
import type { StateRepository } from "./state";
import {
  type HexId,
  type ObjectType,
  type PendingOperation,
  type PortableCore,
  type PreparedCommit,
  type SyncRecord,
  type SyncState,
  type UploadProgress,
  type VaultPort,
} from "./types";

const UPLOAD_CHUNK_BYTES = 256 * 1024;
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

export interface EncryptedCore extends PortableCore {
  deviceId(): HexId;
  encryptObject(
    objectId: HexId,
    revision: string,
    objectType: ObjectType,
    cleartext: Uint8Array,
  ): Uint8Array;
  encodeManifest(input: ManifestInput): Uint8Array;
  manifestRoot(input: ManifestInput): HexId;
  createSignedCommit(
    parents: readonly HexId[],
    deviceSequence: string,
    body: CommitBodyInput,
  ): Uint8Array;
}

export interface RemotePort {
  beginUpload(
    expectedSize: string,
    expectedHash: HexId,
  ): Promise<{ readonly uploadId: HexId; readonly offset: string }>;
  uploadChunk(
    uploadId: HexId,
    offset: string,
    chunk: Uint8Array,
  ): Promise<string>;
  commitUpload(uploadId: HexId): Promise<HexId>;
  putCommit(
    signedCommit: Uint8Array,
  ): Promise<{ readonly commitId: HexId; readonly heads: readonly HexId[] }>;
}

export interface ManifestInput {
  readonly vault_id_hex: HexId;
  readonly entries: readonly {
    readonly object_id_hex: HexId;
    readonly revision: string;
    readonly object_type: ObjectType;
    readonly encrypted_path_blob_id_hex: HexId;
    readonly content_blob_id_hex: HexId | null;
    readonly metadata_blob_id_hex: HexId | null;
    readonly canonical_plaintext_hash_hex: HexId;
    readonly tombstone: boolean;
  }[];
}

export interface CommitBodyInput {
  readonly logical_timestamp: string;
  readonly operations: readonly {
    readonly kind: 1 | 2 | 3 | 4 | 5;
    readonly object_id_hex: HexId;
    readonly base_revision: string;
    readonly revision: string;
    readonly encrypted_path_blob_id_hex: HexId | null;
    readonly content_blob_id_hex: HexId | null;
  }[];
  readonly manifest_root_hex: HexId;
  readonly manifest_blob_id_hex: HexId;
  readonly merge_base_hex: HexId | null;
  readonly conflict_object_ids_hex: readonly HexId[];
}

export class SyncEngine {
  constructor(
    private readonly vaultId: HexId,
    private readonly vault: VaultPort,
    private readonly core: EncryptedCore,
    private readonly remote: RemotePort,
    private readonly states: StateRepository,
    private readonly ciphertexts: CiphertextCache,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcile(): Promise<SyncState> {
    const state = await this.states.read();
    const result = await new Reconciler(this.vault, this.core, this.now).scan(state);
    if (result.issues.length > 0) {
      throw new ReconciliationBlockedError(result.issues);
    }
    return this.states.update((current) => ({
      ...current,
      pending: result.operations,
    }));
  }

  async push(): Promise<SyncState> {
    let state = await this.states.read();
    await this.cleanupUnreferencedStagedObjects(state);
    state = await this.states.read();
    if (state.preparedCommit !== undefined) {
      return this.publishPrepared(state.preparedCommit);
    }
    if (state.pending.length === 0) {
      return state;
    }

    const records = new Map(state.records.map((record) => [record.objectId, record]));
    const completed: PendingOperation[] = [];
    for (const operation of state.pending) {
      const next = await this.prepareOperation(operation, records.get(operation.objectId));
      records.set(next.objectId, next);
      completed.push(operation);
    }

    const manifest = manifestInput(this.vaultId, [...records.values()]);
    const manifestBytes = this.core.encodeManifest(manifest);
    const manifestObjectId = this.core.newObjectId();
    const manifestKey = `manifest:${completed
      .map((operation) => operation.operationId)
      .sort()
      .join(",")}`;
    const manifestBlobId = await this.stageAndUpload(
      manifestKey,
      () => this.core.encryptObject(
        manifestObjectId,
        "1",
        3,
        manifestBytes,
      ),
    );
    state = await this.states.read();
    const deviceSequence = (BigInt(state.deviceSequence) + 1n).toString();
    const lamport = (BigInt(state.lamport) + 1n).toString();
    const body: CommitBodyInput = {
      logical_timestamp: lamport,
      operations: completed.map((operation) =>
        operationToCommit(operation, required(records.get(operation.objectId)))
      ),
      manifest_root_hex: this.core.manifestRoot(manifest),
      manifest_blob_id_hex: manifestBlobId,
      merge_base_hex: null,
      conflict_object_ids_hex: [],
    };
    const signedCommit = this.core.createSignedCommit(
      [...state.heads].sort(),
      deviceSequence,
      body,
    );
    const prepared: PreparedCommit = {
      signedCommitHex: bytesToHex(signedCommit),
      operationIds: completed.map((operation) => operation.operationId),
      records: [...records.values()].sort((left, right) =>
        left.objectId.localeCompare(right.objectId)
      ),
      parents: [...state.heads].sort(),
      manifestRoot: body.manifest_root_hex,
      manifestBlobId: body.manifest_blob_id_hex,
      deviceId: this.core.deviceId(),
      deviceSequence,
      lamport,
      stagedKeys: [
        ...completed.flatMap((operation) => [
          `operation:${operation.operationId}:path`,
          `operation:${operation.operationId}:content`,
        ]),
        manifestKey,
      ],
    };
    await this.states.update((current) => ({
      ...current,
      preparedCommit: prepared,
    }));
    return this.publishPrepared(prepared);
  }

  private async publishPrepared(prepared: PreparedCommit): Promise<SyncState> {
    const accepted = await this.remote.putCommit(hexToBytes(prepared.signedCommitHex));
    await this.states.update((current) => {
      if (current.preparedCommit?.signedCommitHex !== prepared.signedCommitHex) {
        throw new Error("prepared commit changed during publication");
      }
      const completed = new Set(prepared.operationIds);
      const completedObjects = new Set(
        current.pending
          .filter((operation) => completed.has(operation.operationId))
          .map((operation) => operation.objectId),
      );
      const commit = {
        commitId: accepted.commitId,
        parents: prepared.parents,
        deviceId: prepared.deviceId,
        deviceSequence: prepared.deviceSequence,
        logicalTimestamp: prepared.lamport,
        manifestRoot: prepared.manifestRoot,
        manifestBlobId: prepared.manifestBlobId,
      };
      return {
        schema: 1,
        initializedFromRemote: true,
        deviceSequence: prepared.deviceSequence,
        lamport: prepared.lamport,
        knownCommitIds: uniqueSorted([...current.knownCommitIds, accepted.commitId]),
        commits: [
          ...current.commits.filter(
            (candidate) => candidate.commitId !== accepted.commitId,
          ),
          commit,
        ].sort((left, right) => left.commitId.localeCompare(right.commitId)),
        heads: uniqueSorted(accepted.heads),
        records: prepared.records.map((record) =>
          completedObjects.has(record.objectId)
            ? { ...record, lastCommitId: accepted.commitId }
            : record
        ),
        pending: current.pending.filter(
          (operation) => !completed.has(operation.operationId),
        ),
        uploads: current.uploads,
        stagedObjects: current.stagedObjects,
      };
    });
    await this.cleanupStagedKeys(prepared.stagedKeys);
    return this.states.read();
  }

  private async prepareOperation(
    operation: PendingOperation,
    existing: SyncRecord | undefined,
  ): Promise<SyncRecord> {
    if (operation.kind === "delete") {
      if (existing?.encryptedPathBlobId === undefined) {
        throw new Error("cannot tombstone an object without an encrypted path");
      }
      return {
        objectId: existing.objectId,
        path: operation.path,
        revision: operation.revision,
        objectType: existing.objectType,
        canonicalHash: existing.canonicalHash,
        encryptedPathBlobId: existing.encryptedPathBlobId,
        ...(existing.metadataBlobId === undefined
          ? {}
          : { metadataBlobId: existing.metadataBlobId }),
        ...(existing.lastCommitId === undefined
          ? {}
          : { lastCommitId: existing.lastCommitId }),
        tombstone: true,
      };
    }

    const extension = extensionOf(operation.path);
    const text = TEXT_EXTENSIONS.has(extension);
    const clear = await this.vault.read(operation.path);
    const canonical = text ? this.core.canonicalizeText(clear) : clear;
    const hash = this.core.hash(canonical);
    if (hash !== operation.canonicalHash) {
      throw new Error("local file changed after reconciliation");
    }
    const pathChanged = operation.kind === "create" || operation.kind === "rename";
    const contentChanged = operation.kind !== "rename";
    const encryptedPathBlobId = pathChanged
      ? await this.stageAndUpload(
        `operation:${operation.operationId}:path`,
        () => this.core.encryptObject(
          operation.objectId,
          operation.revision,
          2,
          new TextEncoder().encode(operation.path),
        ),
      )
      : existing?.encryptedPathBlobId;
    const objectType: ObjectType = operation.kind === "rename"
      ? required(existing).objectType
      : text ? 1 : 5;
    const contentBlobId = contentChanged
      ? await this.stageAndUpload(
        `operation:${operation.operationId}:content`,
        () => this.core.encryptObject(
          operation.objectId,
          operation.revision,
          objectType,
          canonical,
        ),
      )
      : existing?.contentBlobId;
    if (encryptedPathBlobId === undefined || contentBlobId === undefined) {
      throw new Error("operation is missing an immutable ciphertext object");
    }
    return {
      objectId: operation.objectId,
      path: operation.path,
      revision: operation.revision,
      objectType,
      canonicalHash: hash,
      encryptedPathBlobId,
      contentBlobId,
      ...(existing?.metadataBlobId === undefined
        ? {}
        : { metadataBlobId: existing.metadataBlobId }),
      ...(existing?.lastCommitId === undefined
        ? {}
        : { lastCommitId: existing.lastCommitId }),
      tombstone: false,
    };
  }

  private async uploadCiphertext(ciphertext: Uint8Array): Promise<HexId> {
    const ciphertextHash = this.core.hash(ciphertext);
    const allocation = await this.remote.beginUpload(
      ciphertext.length.toString(),
      ciphertextHash,
    );
    let offset = parseOffset(allocation.offset, ciphertext.length);
    await this.saveUpload({
      ciphertextHash,
      uploadId: allocation.uploadId,
      offset: offset.toString(),
      total: ciphertext.length.toString(),
    });
    while (offset < ciphertext.length) {
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, ciphertext.length);
      const next = await this.remote.uploadChunk(
        allocation.uploadId,
        offset.toString(),
        ciphertext.slice(offset, end),
      );
      offset = parseOffset(next, ciphertext.length);
      await this.saveUpload({
        ciphertextHash,
        uploadId: allocation.uploadId,
        offset: offset.toString(),
        total: ciphertext.length.toString(),
      });
    }
    const blobId = await this.remote.commitUpload(allocation.uploadId);
    if (blobId !== ciphertextHash) {
      throw new Error("server returned a different ciphertext hash");
    }
    await this.states.update((state) => ({
      ...state,
      uploads: state.uploads.filter(
        (upload) => upload.ciphertextHash !== ciphertextHash,
      ),
    }));
    return blobId;
  }

  private async stageAndUpload(
    logicalKey: string,
    create: () => Uint8Array,
  ): Promise<HexId> {
    let state = await this.states.read();
    const staged = state.stagedObjects.find(
      (candidate) => candidate.logicalKey === logicalKey,
    );
    let ciphertext = staged === undefined
      ? undefined
      : await this.ciphertexts.get(staged.ciphertextHash);
    if (staged !== undefined && ciphertext === undefined) {
      await this.states.update((current) => ({
        ...current,
        stagedObjects: current.stagedObjects.filter(
          (candidate) => candidate.logicalKey !== logicalKey,
        ),
      }));
    }
    if (ciphertext === undefined) {
      ciphertext = create();
      const ciphertextHash = this.core.hash(ciphertext);
      await this.ciphertexts.put(ciphertextHash, ciphertext);
      state = await this.states.update((current) => ({
        ...current,
        stagedObjects: [
          ...current.stagedObjects.filter(
            (candidate) => candidate.logicalKey !== logicalKey,
          ),
          { logicalKey, ciphertextHash },
        ].sort((left, right) => left.logicalKey.localeCompare(right.logicalKey)),
      }));
      const recorded = state.stagedObjects.find(
        (candidate) => candidate.logicalKey === logicalKey,
      );
      if (recorded?.ciphertextHash !== ciphertextHash) {
        throw new Error("failed to durably stage ciphertext");
      }
    }
    return this.uploadCiphertext(ciphertext);
  }

  private async cleanupStagedKeys(keys: readonly string[]): Promise<void> {
    const keySet = new Set(keys);
    const state = await this.states.read();
    const obsolete = state.stagedObjects.filter((item) => keySet.has(item.logicalKey));
    for (const item of obsolete) {
      await this.ciphertexts.remove(item.ciphertextHash);
    }
    await this.states.update((current) => ({
      ...current,
      stagedObjects: current.stagedObjects.filter(
        (item) => !keySet.has(item.logicalKey),
      ),
    }));
  }

  private async cleanupUnreferencedStagedObjects(state: SyncState): Promise<void> {
    const referenced = new Set(
      state.pending.flatMap((operation) => [
        `operation:${operation.operationId}:path`,
        `operation:${operation.operationId}:content`,
      ]),
    );
    for (const key of state.preparedCommit?.stagedKeys ?? []) {
      referenced.add(key);
    }
    await this.cleanupStagedKeys(
      state.stagedObjects
        .filter((item) => !referenced.has(item.logicalKey))
        .map((item) => item.logicalKey),
    );
  }

  private async saveUpload(progress: UploadProgress): Promise<void> {
    await this.states.update((state) => ({
      ...state,
      uploads: [
        ...state.uploads.filter(
          (upload) => upload.ciphertextHash !== progress.ciphertextHash,
        ),
        progress,
      ].sort((left, right) =>
        left.ciphertextHash.localeCompare(right.ciphertextHash)
      ),
    }));
  }
}

export class ReconciliationBlockedError extends Error {
  constructor(
    readonly issues: readonly {
      readonly code: string;
      readonly paths: readonly string[];
    }[],
  ) {
    super("synchronization is blocked by local path issues");
    this.name = "ReconciliationBlockedError";
  }
}

function manifestInput(vaultId: HexId, records: readonly SyncRecord[]): ManifestInput {
  return {
    vault_id_hex: vaultId,
    entries: records
      .filter((record) => record.encryptedPathBlobId !== undefined)
      .sort((left, right) => left.objectId.localeCompare(right.objectId))
      .map((record) => ({
        object_id_hex: record.objectId,
        revision: record.revision,
        object_type: record.objectType,
        encrypted_path_blob_id_hex: required(record.encryptedPathBlobId),
        content_blob_id_hex: record.contentBlobId ?? null,
        metadata_blob_id_hex: record.metadataBlobId ?? null,
        canonical_plaintext_hash_hex: record.canonicalHash,
        tombstone: record.tombstone,
      })),
  };
}

function operationToCommit(
  operation: PendingOperation,
  record: SyncRecord,
): CommitBodyInput["operations"][number] {
  const kind = {
    create: 1,
    modify: 2,
    rename: 3,
    delete: 4,
    merge: 5,
  }[operation.kind] as 1 | 2 | 3 | 4 | 5;
  return {
    kind,
    object_id_hex: operation.objectId,
    base_revision: operation.baseRevision,
    revision: operation.revision,
    encrypted_path_blob_id_hex:
      operation.kind === "create" || operation.kind === "rename"
        ? required(record.encryptedPathBlobId)
        : null,
    content_blob_id_hex:
      operation.kind === "create"
      || operation.kind === "modify"
      || operation.kind === "merge"
        ? required(record.contentBlobId)
        : null,
  };
}

function extensionOf(path: string): string {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

function parseOffset(value: string, maximum: number): number {
  const parsed = BigInt(value);
  if (parsed < 0 || parsed > BigInt(maximum)) {
    throw new Error("server returned an invalid upload offset");
  }
  return Number(parsed);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("required value is absent");
  }
  return value;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/u.test(value)) {
    throw new Error("invalid lowercase hex");
  }
  return Uint8Array.from(
    value.match(/.{2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}
