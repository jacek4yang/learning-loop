export type HexId = string;
export type ObjectType = 1 | 2 | 3 | 4 | 5 | 6;
export type PendingKind = "create" | "modify" | "rename" | "delete" | "merge";

export interface LocalFile {
  readonly path: string;
  readonly size: number;
  readonly extension: string;
}

export interface VaultPort {
  listFiles(): Promise<readonly LocalFile[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, content: Uint8Array, text: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface PortableCore {
  canonicalizePath(path: string): string;
  collisionKey(path: string): string;
  canonicalizeText(bytes: Uint8Array): Uint8Array;
  hash(bytes: Uint8Array): HexId;
  newObjectId(): HexId;
}

export interface SyncRecord {
  readonly objectId: HexId;
  readonly path: string;
  readonly revision: string;
  readonly objectType: ObjectType;
  readonly canonicalHash: HexId;
  readonly encryptedPathBlobId?: HexId;
  readonly contentBlobId?: HexId;
  readonly metadataBlobId?: HexId;
  readonly lastCommitId?: HexId;
  readonly tombstone: boolean;
}

export interface PendingOperation {
  readonly operationId: HexId;
  readonly kind: PendingKind;
  readonly objectId: HexId;
  readonly path: string;
  readonly previousPath?: string;
  readonly baseRevision: string;
  readonly revision: string;
  readonly canonicalHash?: HexId;
  readonly detectedAt: string;
}

export interface UploadProgress {
  readonly ciphertextHash: HexId;
  readonly uploadId?: HexId;
  readonly offset: string;
  readonly total: string;
}

export interface StagedObject {
  readonly logicalKey: string;
  readonly ciphertextHash: HexId;
}

export interface PreparedCommit {
  readonly signedCommitHex: string;
  readonly operationIds: readonly HexId[];
  readonly records: readonly SyncRecord[];
  readonly parents: readonly HexId[];
  readonly manifestRoot: HexId;
  readonly manifestBlobId: HexId;
  readonly deviceId: HexId;
  readonly deviceSequence: string;
  readonly lamport: string;
  readonly stagedKeys: readonly string[];
}

export interface CommitSummary {
  readonly commitId: HexId;
  readonly parents: readonly HexId[];
  readonly deviceId: HexId;
  readonly deviceSequence: string;
  readonly logicalTimestamp: string;
  readonly manifestRoot: HexId;
  readonly manifestBlobId: HexId;
}

export interface SyncState {
  readonly schema: 1;
  readonly initializedFromRemote: boolean;
  readonly deviceSequence: string;
  readonly lamport: string;
  readonly knownCommitIds: readonly HexId[];
  readonly commits: readonly CommitSummary[];
  readonly heads: readonly HexId[];
  readonly records: readonly SyncRecord[];
  readonly pending: readonly PendingOperation[];
  readonly uploads: readonly UploadProgress[];
  readonly stagedObjects: readonly StagedObject[];
  readonly preparedCommit?: PreparedCommit;
}

export const EMPTY_SYNC_STATE: SyncState = {
  schema: 1,
  initializedFromRemote: false,
  deviceSequence: "0",
  lamport: "0",
  knownCommitIds: [],
  commits: [],
  heads: [],
  records: [],
  pending: [],
  uploads: [],
  stagedObjects: [],
};

export interface ReconciliationIssue {
  readonly code: "invalid_path" | "portable_collision" | "read_failure";
  readonly paths: readonly string[];
}

export interface ReconciliationResult {
  readonly operations: readonly PendingOperation[];
  readonly issues: readonly ReconciliationIssue[];
}
