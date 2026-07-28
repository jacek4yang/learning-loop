import { describe, expect, it } from "vitest";

import { MemoryCiphertextCache } from "../src/sync/cache";
import {
  type CommitBodyInput,
  type EncryptedCore,
  type ManifestInput,
  type RemotePort,
  SyncEngine,
  bytesToHex,
} from "../src/sync/engine";
import { MemoryStateRepository } from "../src/sync/state";
import {
  EMPTY_SYNC_STATE,
  type LocalFile,
  type ObjectType,
  type SyncState,
  type VaultPort,
} from "../src/sync/types";

const encoder = new TextEncoder();

class EngineCore implements EncryptedCore {
  encryptions = 0;
  private nextId = 0;

  canonicalizePath(path: string): string {
    return path.normalize("NFC");
  }

  collisionKey(path: string): string {
    return path.normalize("NFC").toLocaleLowerCase("und");
  }

  canonicalizeText(bytes: Uint8Array): Uint8Array {
    return bytes;
  }

  hash(bytes: Uint8Array): string {
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    for (const byte of bytes) {
      left = Math.imul(left ^ byte, 0x01000193) >>> 0;
      right = Math.imul(right ^ byte, 0x85ebca6b) >>> 0;
    }
    return `${left.toString(16).padStart(8, "0")}${
      right.toString(16).padStart(8, "0")
    }`;
  }

  newObjectId(): string {
    this.nextId += 1;
    return this.nextId.toString(16).padStart(32, "0");
  }

  deviceId(): string {
    return "device-1";
  }

  encryptObject(
    objectId: string,
    revision: string,
    objectType: ObjectType,
    cleartext: Uint8Array,
  ): Uint8Array {
    this.encryptions += 1;
    const header = encoder.encode(
      `cipher-${this.encryptions}:${objectId}:${revision}:${objectType}:`,
    );
    const output = new Uint8Array(header.length + cleartext.length);
    output.set(header);
    output.set(cleartext, header.length);
    return output;
  }

  encodeManifest(input: ManifestInput): Uint8Array {
    return encoder.encode(JSON.stringify(input));
  }

  manifestRoot(input: ManifestInput): string {
    return this.hash(this.encodeManifest(input));
  }

  createSignedCommit(
    parents: readonly string[],
    deviceSequence: string,
    body: CommitBodyInput,
  ): Uint8Array {
    return encoder.encode(JSON.stringify({ parents, deviceSequence, body }));
  }
}

class EngineVault implements VaultPort {
  constructor(private readonly files: Map<string, Uint8Array>) {}

  listFiles(): Promise<readonly LocalFile[]> {
    return Promise.resolve([...this.files].map(([path, bytes]) => ({
      path,
      size: bytes.length,
      extension: path.slice(path.lastIndexOf(".") + 1),
    })));
  }

  read(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    return bytes === undefined
      ? Promise.reject(new Error("missing test file"))
      : Promise.resolve(bytes.slice());
  }

  write(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, content.slice());
    return Promise.resolve();
  }

  async rename(from: string, to: string): Promise<void> {
    const bytes = await this.read(from);
    this.files.delete(from);
    this.files.set(to, bytes);
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
}

class FaultRemote implements RemotePort {
  readonly beginHashes: string[] = [];
  readonly commitAttempts: string[] = [];
  failLargeChunkOnce = false;
  failCommitAfterAcceptOnce = false;
  private acceptedCommit: string | undefined;
  private readonly uploadsByHash = new Map<string, {
    readonly uploadId: string;
    readonly expectedSize: number;
    bytes: Uint8Array;
  }>();
  private readonly uploadsById = new Map<string, {
    readonly hash: string;
    readonly expectedSize: number;
    bytes: Uint8Array;
  }>();

  beginUpload(
    expectedSize: string,
    expectedHash: string,
  ): Promise<{ readonly uploadId: string; readonly offset: string }> {
    this.beginHashes.push(expectedHash);
    const existing = this.uploadsByHash.get(expectedHash);
    if (existing !== undefined) {
      return Promise.resolve({
        uploadId: existing.uploadId,
        offset: existing.bytes.length.toString(),
      });
    }
    const uploadId = `upload-${this.uploadsByHash.size + 1}`;
    const upload = {
      uploadId,
      expectedSize: Number(expectedSize),
      bytes: new Uint8Array(),
    };
    this.uploadsByHash.set(expectedHash, upload);
    this.uploadsById.set(uploadId, {
      hash: expectedHash,
      expectedSize: upload.expectedSize,
      bytes: upload.bytes,
    });
    return Promise.resolve({ uploadId, offset: "0" });
  }

  uploadChunk(
    uploadId: string,
    offset: string,
    chunk: Uint8Array,
  ): Promise<string> {
    const upload = this.uploadsById.get(uploadId);
    if (upload === undefined || upload.bytes.length !== Number(offset)) {
      return Promise.reject(new Error("invalid test upload offset"));
    }
    const next = new Uint8Array(upload.bytes.length + chunk.length);
    next.set(upload.bytes);
    next.set(chunk, upload.bytes.length);
    upload.bytes = next;
    const byHash = this.uploadsByHash.get(upload.hash);
    if (byHash !== undefined) {
      byHash.bytes = next;
    }
    if (this.failLargeChunkOnce && chunk.length >= 256 * 1024) {
      this.failLargeChunkOnce = false;
      return Promise.reject(new Error("injected lost chunk response"));
    }
    return Promise.resolve(next.length.toString());
  }

  commitUpload(uploadId: string): Promise<string> {
    const upload = this.uploadsById.get(uploadId);
    if (upload === undefined || upload.bytes.length !== upload.expectedSize) {
      return Promise.reject(new Error("incomplete test upload"));
    }
    return Promise.resolve(upload.hash);
  }

  putCommit(
    signedCommit: Uint8Array,
  ): Promise<{ readonly commitId: string; readonly heads: readonly string[] }> {
    const exact = bytesToHex(signedCommit);
    this.commitAttempts.push(exact);
    this.acceptedCommit ??= `commit-${exact.slice(0, 16)}`;
    if (this.failCommitAfterAcceptOnce) {
      this.failCommitAfterAcceptOnce = false;
      return Promise.reject(new Error("injected lost commit response"));
    }
    return Promise.resolve({
      commitId: this.acceptedCommit,
      heads: [this.acceptedCommit],
    });
  }
}

function pendingState(canonicalHash: string): SyncState {
  return {
    ...EMPTY_SYNC_STATE,
    initializedFromRemote: true,
    pending: [{
      operationId: "operation-1",
      kind: "create",
      objectId: "object-1",
      path: "large.bin",
      baseRevision: "0",
      revision: "1",
      canonicalHash,
      detectedAt: "2026-07-28T00:00:00.000Z",
    }],
  };
}

function engine(
  core: EngineCore,
  remote: FaultRemote,
  states: MemoryStateRepository,
  cache: MemoryCiphertextCache,
  content: Uint8Array,
): SyncEngine {
  return new SyncEngine(
    "vault-1",
    new EngineVault(new Map([["large.bin", content]])),
    core,
    remote,
    states,
    cache,
  );
}

describe("sync engine crash recovery", () => {
  it("resumes from a durable server offset with the exact staged ciphertext", async () => {
    const content = new Uint8Array(300_000).fill(0x5a);
    const core = new EngineCore();
    const initial = pendingState(core.hash(content));
    const states = new MemoryStateRepository(initial);
    const cache = new MemoryCiphertextCache();
    const remote = new FaultRemote();
    remote.failLargeChunkOnce = true;

    await expect(engine(core, remote, states, cache, content).push())
      .rejects.toThrow("injected lost chunk response");
    const encryptionsAtCrash = core.encryptions;
    const crashed = await states.read();
    expect(crashed.stagedObjects).toHaveLength(2);
    const contentHash = crashed.stagedObjects.find(
      (item) => item.logicalKey.endsWith(":content"),
    )?.ciphertextHash;
    expect(contentHash).toBeDefined();

    const recovered = await engine(core, remote, states, cache, content).push();
    expect(core.encryptions).toBe(encryptionsAtCrash + 1);
    expect(remote.beginHashes.filter((hash) => hash === contentHash)).toHaveLength(2);
    expect(recovered.pending).toEqual([]);
    expect(recovered.uploads).toEqual([]);
    expect(recovered.stagedObjects).toEqual([]);
  });

  it("retries byte-identical signed commit after acceptance response is lost", async () => {
    const content = encoder.encode("small");
    const core = new EngineCore();
    const initial = pendingState(core.hash(content));
    const states = new MemoryStateRepository(initial);
    const cache = new MemoryCiphertextCache();
    const remote = new FaultRemote();
    remote.failCommitAfterAcceptOnce = true;

    await expect(engine(core, remote, states, cache, content).push())
      .rejects.toThrow("injected lost commit response");
    const prepared = (await states.read()).preparedCommit;
    expect(prepared).toBeDefined();

    const recovered = await engine(core, remote, states, cache, content).push();
    expect(remote.commitAttempts).toEqual([
      prepared?.signedCommitHex,
      prepared?.signedCommitHex,
    ]);
    expect(recovered.preparedCommit).toBeUndefined();
    expect(recovered.records[0]?.lastCommitId).toBe(recovered.heads[0]);
    expect(recovered.stagedObjects).toEqual([]);
  });
});
