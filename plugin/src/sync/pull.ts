import { conflictCopyPath, conflictRecord, mergeText } from "./merge";
import {
  portablePathConflictGroups,
  portablePathsConflict,
} from "./paths";
import type { ManifestInput } from "./engine";
import type { StateRepository } from "./state";
import {
  type CommitSummary,
  type HexId,
  type ObjectType,
  type SyncRecord,
  type SyncState,
  type VaultPort,
} from "./types";
import type { EchoSuppressor } from "./echo";
import type { DecodedCommit } from "../wasm/runtime";

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

export interface PullCore {
  canonicalizePath(path: string): string;
  collisionKey(path: string): string;
  canonicalizeText(bytes: Uint8Array): Uint8Array;
  hash(bytes: Uint8Array): HexId;
  decryptObject(ciphertext: Uint8Array): Uint8Array;
  decodeManifest(encoded: Uint8Array): ManifestInput;
  manifestRoot(input: ManifestInput): HexId;
  decodeSignedCommit(
    signedCommit: Uint8Array,
    publicKey: Uint8Array,
  ): DecodedCommit;
}

export interface PullDevice {
  readonly device_id_hex: HexId;
  readonly public_key_hex: HexId;
  readonly revoked: boolean;
}

export interface PullRemote {
  listDevices(): Promise<readonly PullDevice[]>;
  getHeads(): Promise<readonly HexId[]>;
  getChanges(knownCommitIds: readonly HexId[]): Promise<{
    readonly signedCommits: readonly Uint8Array[];
    readonly hasMore: boolean;
  }>;
  getBlob(blobId: HexId): Promise<Uint8Array>;
}

interface ManifestEntry {
  readonly object_id_hex: HexId;
  readonly revision: string;
  readonly object_type: ObjectType;
  readonly encrypted_path_blob_id_hex: HexId;
  readonly content_blob_id_hex: HexId | null;
  readonly metadata_blob_id_hex: HexId | null;
  readonly canonical_plaintext_hash_hex: HexId;
  readonly tombstone: boolean;
}

interface SnapshotEntry {
  readonly headId: HexId;
  readonly path: string;
  readonly entry: ManifestEntry;
}

interface SelectedEntry {
  readonly selected: SnapshotEntry;
  readonly conflicts: readonly SnapshotEntry[];
}

interface LocalSnapshot {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly canonical: Uint8Array;
  readonly hash: HexId;
}

export class PullEngine {
  private readonly blobCleartexts = new Map<HexId, Uint8Array>();
  private readonly snapshots = new Map<HexId, Map<HexId, SnapshotEntry>>();

  constructor(
    private readonly vaultId: HexId,
    private readonly vault: VaultPort,
    private readonly core: PullCore,
    private readonly remote: PullRemote,
    private readonly states: StateRepository,
    private readonly echoes: EchoSuppressor,
    private readonly localDeviceName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async pull(): Promise<SyncState> {
    try {
      return await this.pullVerified();
    } finally {
      for (const plaintext of this.blobCleartexts.values()) {
        plaintext.fill(0);
      }
      this.blobCleartexts.clear();
      this.snapshots.clear();
    }
  }

  private async pullVerified(): Promise<SyncState> {
    const original = await this.states.read();
    const devices = (await this.remote.listDevices())
      .filter((device) => !device.revoked)
      .sort((left, right) => left.device_id_hex.localeCompare(right.device_id_hex));
    if (devices.length === 0) {
      throw new Error("the server has no active verification keys");
    }

    const commits = new Map(
      original.commits.map((commit) => [commit.commitId, commit]),
    );
    const known = new Set(original.knownCommitIds);
    let hasMore = true;
    while (hasMore) {
      const page = await this.remote.getChanges([...known].sort());
      if (page.signedCommits.length === 0 && page.hasMore) {
        throw new Error("server returned a non-progressing change page");
      }
      for (const encoded of page.signedCommits) {
        const decoded = verifyWithRegisteredDevice(this.core, encoded, devices);
        if (known.has(decoded.commitId)) {
          continue;
        }
        if (decoded.parents.some((parent) => !known.has(parent))) {
          throw new Error("server returned a commit before an unknown parent");
        }
        const summary: CommitSummary = {
          commitId: decoded.commitId,
          parents: [...decoded.parents].sort(),
          deviceId: decoded.deviceId,
          deviceSequence: decoded.deviceSequence,
          logicalTimestamp: decoded.body.logical_timestamp,
          manifestRoot: decoded.body.manifest_root_hex,
          manifestBlobId: decoded.body.manifest_blob_id_hex,
        };
        commits.set(summary.commitId, summary);
        known.add(summary.commitId);
      }
      hasMore = page.hasMore;
    }

    const heads = uniqueSorted(await this.remote.getHeads());
    for (const head of heads) {
      if (!commits.has(head)) {
        throw new Error("server head has no verified commit");
      }
    }
    if (heads.length === 0) {
      return this.states.update((state) => ({
        ...state,
        initializedFromRemote: true,
        knownCommitIds: [...known].sort(),
        commits: sortedCommits(commits.values()),
        heads,
      }));
    }

    const graph = new Map(commits);
    const baseId = nearestCommonAncestor(heads, graph);
    const base = baseId === undefined
      ? new Map<HexId, SnapshotEntry>()
      : await this.loadSnapshot(required(graph.get(baseId)));
    const headSnapshots = await Promise.all(
      heads.map(async (head) => ({
        head,
        snapshot: await this.loadSnapshot(required(graph.get(head))),
      })),
    );
    const selected = selectEntries(base, headSnapshots, graph);
    validateSelectedPaths(selected, this.core);
    const local = await this.scanLocal();
    const prior = new Map(original.records.map((record) => [record.objectId, record]));
    const nextRecords: SyncRecord[] = [];

    for (const objectId of [...selected.keys()].sort()) {
      const choice = required(selected.get(objectId));
      const record = recordFromSnapshot(choice.selected);
      await this.applyEntry(prior.get(objectId), choice.selected, local);
      for (const alternate of choice.conflicts) {
        await this.preserveRemoteConflict(alternate, "concurrent remote versions");
      }
      nextRecords.push(record);
    }

    const maximumLamport = [...commits.values()].reduce(
      (maximum, commit) =>
        BigInt(commit.logicalTimestamp) > maximum
          ? BigInt(commit.logicalTimestamp)
          : maximum,
      BigInt(original.lamport),
    );
    return this.states.update((state) => ({
      ...state,
      initializedFromRemote: true,
      lamport: maximumLamport.toString(),
      knownCommitIds: [...known].sort(),
      commits: sortedCommits(commits.values()),
      heads,
      records: nextRecords,
    }));
  }

  private async loadSnapshot(
    commit: CommitSummary,
  ): Promise<Map<HexId, SnapshotEntry>> {
    const cached = this.snapshots.get(commit.commitId);
    if (cached !== undefined) {
      return cached;
    }
    const manifestBytes = await this.clearBlob(commit.manifestBlobId);
    const manifest = this.core.decodeManifest(manifestBytes);
    if (
      manifest.vault_id_hex !== this.vaultId
      || this.core.manifestRoot(manifest) !== commit.manifestRoot
    ) {
      throw new Error("verified commit references an invalid manifest");
    }
    const snapshot = new Map<HexId, SnapshotEntry>();
    for (const raw of manifest.entries) {
      const entry: ManifestEntry = raw;
      const pathBytes = await this.clearBlob(entry.encrypted_path_blob_id_hex);
      const path = this.core.canonicalizePath(
        new TextDecoder("utf-8", { fatal: true }).decode(pathBytes),
      );
      if (snapshot.has(entry.object_id_hex)) {
        throw new Error("manifest repeats an object identifier");
      }
      snapshot.set(entry.object_id_hex, {
        headId: commit.commitId,
        path,
        entry,
      });
    }
    this.snapshots.set(commit.commitId, snapshot);
    return snapshot;
  }

  private async scanLocal(): Promise<Map<string, LocalSnapshot>> {
    const output = new Map<string, LocalSnapshot>();
    const files = await this.vault.listFiles();
    if (
      portablePathConflictGroups(
        files.map((file) => file.path),
        this.core,
      ).length > 0
    ) {
      throw new Error("local vault has a portable path collision");
    }
    for (const file of files) {
      const bytes = await this.vault.read(file.path);
      const canonical = isText(file.path)
        ? this.core.canonicalizeText(bytes)
        : bytes;
      output.set(file.path, {
        path: file.path,
        bytes,
        canonical,
        hash: this.core.hash(canonical),
      });
    }
    return output;
  }

  private async applyEntry(
    base: SyncRecord | undefined,
    remote: SnapshotEntry,
    localFiles: Map<string, LocalSnapshot>,
  ): Promise<void> {
    const local = locateLocal(base, localFiles);
    if (remote.entry.tombstone) {
      if (local === undefined) {
        return;
      }
      if (
        base !== undefined
        && local.hash === base.canonicalHash
        && local.path === base.path
      ) {
        await this.remove(local.path);
        return;
      }
      await this.preserveLocalConflict(
        local,
        "remote deletion conflicts with a local modification or rename",
      );
      await this.remove(local.path);
      return;
    }

    const remoteBytes = await this.remoteContent(remote);
    if (base === undefined) {
      const collision = portableLocalCollision(
        remote.path,
        localFiles,
        this.core,
      );
      if (collision !== undefined) {
        await this.preserveLocalConflict(
          collision,
          "concurrent creation at the same portable path",
        );
        await this.remove(collision.path);
      } else if (await this.vault.exists(remote.path)) {
        await this.preserveRemoteConflict(
          remote,
          "a local folder blocks the remote file path",
        );
        return;
      }
      await this.write(remote.path, remoteBytes, isText(remote.path));
      return;
    }

    const remoteChanged = !sameAsBase(remote, base);
    if (local === undefined) {
      if (remoteChanged) {
        await this.preserveBytes(
          remote.path,
          remoteBytes,
          "remote modification conflicts with a local deletion",
          "remote",
        );
      }
      return;
    }
    const localChanged =
      local.hash !== base.canonicalHash || local.path !== base.path;
    if (!localChanged) {
      await this.applyRemoteWinner(local, remote, remoteBytes, localFiles);
      return;
    }
    if (!remoteChanged) {
      return;
    }

    if (
      isMarkdown(remote.path)
      && isMarkdown(local.path)
      && local.path === base.path
      && remote.path === base.path
      && base.contentBlobId !== undefined
    ) {
      const baseBytes = await this.clearBlob(base.contentBlobId);
      const merged = mergeText(
        decodeText(baseBytes),
        decodeText(local.canonical),
        decodeText(remoteBytes),
      );
      if (merged.choice !== "conflict" && merged.content !== undefined) {
        await this.write(
          remote.path,
          new TextEncoder().encode(merged.content),
          true,
        );
        return;
      }
    }

    await this.preserveLocalConflict(
      local,
      "concurrent changes could not be merged safely",
    );
    await this.applyRemoteWinner(local, remote, remoteBytes, localFiles);
  }

  private async applyRemoteWinner(
    local: LocalSnapshot,
    remote: SnapshotEntry,
    remoteBytes: Uint8Array,
    localFiles: Map<string, LocalSnapshot>,
  ): Promise<void> {
    if (local.path !== remote.path) {
      const destination = portableLocalCollision(
        remote.path,
        localFiles,
        this.core,
        local.path,
      );
      if (destination !== undefined || await this.vault.exists(remote.path)) {
        if (destination !== undefined) {
          await this.preserveLocalConflict(
            destination,
            "remote rename destination already exists",
          );
          await this.remove(destination.path);
        } else {
          await this.preserveRemoteConflict(
            remote,
            "a local folder blocks the remote rename destination",
          );
          return;
        }
      }
      this.echoes.recordPath(local.path);
      this.echoes.recordPath(remote.path);
      await this.vault.rename(local.path, remote.path);
    }
    await this.write(remote.path, remoteBytes, isText(remote.path));
  }

  private async preserveRemoteConflict(
    remote: SnapshotEntry,
    reason: string,
  ): Promise<void> {
    if (remote.entry.tombstone || remote.entry.content_blob_id_hex === null) {
      await this.writeConflictRecord(remote.path, remote.path, reason);
      return;
    }
    await this.preserveBytes(
      remote.path,
      await this.remoteContent(remote),
      reason,
      "remote",
    );
  }

  private async preserveLocalConflict(
    local: LocalSnapshot,
    reason: string,
  ): Promise<void> {
    await this.preserveBytes(
      local.path,
      local.bytes,
      reason,
      this.localDeviceName,
    );
  }

  private async preserveBytes(
    originalPath: string,
    bytes: Uint8Array,
    reason: string,
    deviceName: string,
  ): Promise<void> {
    const timestamp = this.now();
    const candidate = conflictCopyPath(originalPath, deviceName, timestamp);
    const conflictPath = await this.uniquePath(candidate);
    await this.write(conflictPath, bytes, isText(originalPath));
    await this.writeConflictRecord(originalPath, conflictPath, reason, timestamp);
  }

  private async writeConflictRecord(
    originalPath: string,
    conflictPath: string,
    reason: string,
    timestamp: Date = this.now(),
  ): Promise<void> {
    const record = conflictRecord(
      originalPath,
      conflictPath,
      reason,
      timestamp,
    );
    const path = await this.uniquePath(record.path);
    await this.write(path, new TextEncoder().encode(record.content), true);
  }

  private async uniquePath(candidate: string): Promise<string> {
    if (!(await this.vault.exists(candidate))) {
      return candidate;
    }
    const dot = candidate.lastIndexOf(".");
    const stem = dot < 0 ? candidate : candidate.slice(0, dot);
    const extension = dot < 0 ? "" : candidate.slice(dot);
    let suffix = 2;
    let result = `${stem} ${suffix.toString()}${extension}`;
    while (await this.vault.exists(result)) {
      suffix += 1;
      result = `${stem} ${suffix.toString()}${extension}`;
    }
    return result;
  }

  private async remoteContent(remote: SnapshotEntry): Promise<Uint8Array> {
    const blobId = remote.entry.content_blob_id_hex;
    if (blobId === null) {
      throw new Error("active manifest entry has no content object");
    }
    const clear = await this.clearBlob(blobId);
    const canonical = isText(remote.path)
      ? this.core.canonicalizeText(clear)
      : clear;
    if (this.core.hash(canonical) !== remote.entry.canonical_plaintext_hash_hex) {
      throw new Error("remote plaintext does not match the signed manifest");
    }
    return canonical;
  }

  private async clearBlob(blobId: HexId): Promise<Uint8Array> {
    const cached = this.blobCleartexts.get(blobId);
    if (cached !== undefined) {
      return cached;
    }
    const clear = this.core.decryptObject(await this.remote.getBlob(blobId));
    this.blobCleartexts.set(blobId, clear);
    return clear;
  }

  private async write(
    path: string,
    bytes: Uint8Array,
    text: boolean,
  ): Promise<void> {
    const canonical = text ? this.core.canonicalizeText(bytes) : bytes;
    this.echoes.record(path, this.core.hash(canonical));
    await this.vault.write(path, canonical, text);
  }

  private async remove(path: string): Promise<void> {
    this.echoes.recordPath(path);
    await this.vault.remove(path);
  }
}

function verifyWithRegisteredDevice(
  core: PullCore,
  encoded: Uint8Array,
  devices: readonly PullDevice[],
): DecodedCommit {
  for (const device of devices) {
    try {
      const decoded = core.decodeSignedCommit(
        encoded,
        decodeHex(device.public_key_hex, 32),
      );
      if (decoded.deviceId === device.device_id_hex) {
        return decoded;
      }
    } catch {
      // A signature mismatch is expected while selecting the registered signer.
    }
  }
  throw new Error("commit signature does not match an active registered device");
}

function selectEntries(
  base: Map<HexId, SnapshotEntry>,
  heads: readonly {
    readonly head: HexId;
    readonly snapshot: Map<HexId, SnapshotEntry>;
  }[],
  graph: Map<HexId, CommitSummary>,
): Map<HexId, SelectedEntry> {
  const objectIds = new Set<HexId>(base.keys());
  for (const head of heads) {
    for (const objectId of head.snapshot.keys()) {
      objectIds.add(objectId);
    }
  }
  const selected = new Map<HexId, SelectedEntry>();
  for (const objectId of objectIds) {
    const baseEntry = base.get(objectId);
    const variants = uniqueVariants(
      heads
        .map((head) => head.snapshot.get(objectId))
        .filter((entry): entry is SnapshotEntry => entry !== undefined),
    );
    if (variants.length === 0) {
      if (baseEntry !== undefined) {
        selected.set(objectId, { selected: baseEntry, conflicts: [] });
      }
      continue;
    }
    const changed = baseEntry === undefined
      ? variants
      : variants.filter((variant) => !sameEntry(variant, baseEntry));
    const candidates = changed.length === 0
      ? variants
      : changed;
    const winner = [...candidates].sort((left, right) =>
      compareCommitPriority(
        required(graph.get(left.headId)),
        required(graph.get(right.headId)),
      )
    ).at(-1);
    if (winner === undefined) {
      continue;
    }
    selected.set(objectId, {
      selected: winner,
      conflicts: changed.filter((variant) => !sameEntry(variant, winner)),
    });
  }
  return selected;
}

function validateSelectedPaths(
  selected: Map<HexId, SelectedEntry>,
  core: PullCore,
): void {
  const paths = new Map<string, string>();
  const selectedPaths: string[] = [];
  for (const choice of selected.values()) {
    if (choice.selected.entry.tombstone) {
      continue;
    }
    const key = core.collisionKey(choice.selected.path);
    const existing = paths.get(key);
    if (existing !== undefined && existing !== choice.selected.path) {
      throw new Error("remote manifests contain a portable path collision");
    }
    if (existing !== undefined) {
      throw new Error("remote manifests assign one path to multiple objects");
    }
    paths.set(key, choice.selected.path);
    selectedPaths.push(choice.selected.path);
  }
  if (portablePathConflictGroups(selectedPaths, core).length > 0) {
    throw new Error("remote manifests contain a portable path collision");
  }
}

function nearestCommonAncestor(
  heads: readonly HexId[],
  graph: Map<HexId, CommitSummary>,
): HexId | undefined {
  if (heads.length === 0) {
    return undefined;
  }
  const sets = heads.map((head) => ancestors(head, graph));
  const common = [...required(sets[0]).keys()].filter((id) =>
    sets.every((set) => set.has(id))
  );
  return common.sort((left, right) =>
    compareCommitPriority(required(graph.get(left)), required(graph.get(right)))
  ).at(-1);
}

function ancestors(
  head: HexId,
  graph: Map<HexId, CommitSummary>,
): Map<HexId, number> {
  const output = new Map<HexId, number>();
  const queue: { readonly id: HexId; readonly distance: number }[] = [{
    id: head,
    distance: 0,
  }];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || output.has(next.id)) {
      continue;
    }
    output.set(next.id, next.distance);
    for (const parent of required(graph.get(next.id)).parents) {
      queue.push({ id: parent, distance: next.distance + 1 });
    }
  }
  return output;
}

function locateLocal(
  base: SyncRecord | undefined,
  files: Map<string, LocalSnapshot>,
): LocalSnapshot | undefined {
  if (base === undefined) {
    return undefined;
  }
  const exact = files.get(base.path);
  if (exact !== undefined) {
    return exact;
  }
  const matches = [...files.values()].filter(
    (file) => file.hash === base.canonicalHash,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function portableLocalCollision(
  remotePath: string,
  files: Map<string, LocalSnapshot>,
  core: PullCore,
  excludedPath?: string,
): LocalSnapshot | undefined {
  return [...files.values()].find(
    (file) =>
      file.path !== excludedPath
      && portablePathsConflict(file.path, remotePath, core),
  );
}

function sameAsBase(remote: SnapshotEntry, base: SyncRecord): boolean {
  return remote.path === base.path
    && remote.entry.revision === base.revision
    && remote.entry.canonical_plaintext_hash_hex === base.canonicalHash
    && remote.entry.tombstone === base.tombstone;
}

function recordFromSnapshot(snapshot: SnapshotEntry): SyncRecord {
  const entry = snapshot.entry;
  return {
    objectId: entry.object_id_hex,
    path: snapshot.path,
    revision: entry.revision,
    objectType: entry.object_type,
    canonicalHash: entry.canonical_plaintext_hash_hex,
    encryptedPathBlobId: entry.encrypted_path_blob_id_hex,
    ...(entry.content_blob_id_hex === null
      ? {}
      : { contentBlobId: entry.content_blob_id_hex }),
    ...(entry.metadata_blob_id_hex === null
      ? {}
      : { metadataBlobId: entry.metadata_blob_id_hex }),
    lastCommitId: snapshot.headId,
    tombstone: entry.tombstone,
  };
}

function uniqueVariants(entries: readonly SnapshotEntry[]): SnapshotEntry[] {
  const byValue = new Map<string, SnapshotEntry>();
  for (const entry of entries) {
    byValue.set(entryKey(entry), entry);
  }
  return [...byValue.values()];
}

function sameEntry(left: SnapshotEntry, right: SnapshotEntry): boolean {
  return entryKey(left) === entryKey(right);
}

function entryKey(value: SnapshotEntry): string {
  return JSON.stringify({
    path: value.path,
    entry: value.entry,
  });
}

function compareCommitPriority(
  left: CommitSummary,
  right: CommitSummary,
): number {
  const timestamp = compareBigInt(
    BigInt(left.logicalTimestamp),
    BigInt(right.logicalTimestamp),
  );
  return timestamp === 0
    ? left.commitId.localeCompare(right.commitId)
    : timestamp;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedCommits(values: Iterable<CommitSummary>): CommitSummary[] {
  return [...values].sort((left, right) =>
    left.commitId.localeCompare(right.commitId)
  );
}

function decodeHex(value: string, expectedLength: number): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) {
    throw new Error("invalid lowercase hexadecimal value");
  }
  const decoded = Uint8Array.from(
    value.match(/.{2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
  if (decoded.length !== expectedLength) {
    throw new Error("hexadecimal value has an invalid length");
  }
  return decoded;
}

function decodeText(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function isMarkdown(path: string): boolean {
  return extensionOf(path) === "md";
}

function isText(path: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(path));
}

function extensionOf(path: string): string {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("required verified graph value is absent");
  }
  return value;
}
