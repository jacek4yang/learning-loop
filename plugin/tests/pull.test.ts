import { describe, expect, it } from "vitest";

import { EchoSuppressor } from "../src/sync/echo";
import type { CommitBodyInput, ManifestInput } from "../src/sync/engine";
import {
  PullEngine,
  type PullCore,
  type PullDevice,
  type PullRemote,
} from "../src/sync/pull";
import { MemoryStateRepository } from "../src/sync/state";
import {
  EMPTY_SYNC_STATE,
  type LocalFile,
  type SyncState,
  type VaultPort,
} from "../src/sync/types";
import type { DecodedCommit } from "../src/wasm/runtime";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEVICE_ID = "11".repeat(16);
const DEVICE_KEY = "22".repeat(32);
const VAULT_ID = "33".repeat(16);

class PullTestCore implements PullCore {
  canonicalizePath(path: string): string {
    return path.normalize("NFC");
  }

  collisionKey(path: string): string {
    return path.normalize("NFC").toLocaleLowerCase("und");
  }

  canonicalizeText(bytes: Uint8Array): Uint8Array {
    return encoder.encode(
      decoder.decode(bytes).replace(/^\uFEFF/u, "").replaceAll(/\r\n?/gu, "\n"),
    );
  }

  hash(bytes: Uint8Array): string {
    let value = 0x811c9dc5;
    for (const byte of bytes) {
      value = Math.imul(value ^ byte, 0x01000193) >>> 0;
    }
    return value.toString(16).padStart(8, "0").repeat(8);
  }

  decryptObject(ciphertext: Uint8Array): Uint8Array {
    return ciphertext.slice();
  }

  decodeManifest(encoded: Uint8Array): ManifestInput {
    return JSON.parse(decoder.decode(encoded)) as ManifestInput;
  }

  manifestRoot(input: ManifestInput): string {
    return this.hash(encoder.encode(JSON.stringify(input)));
  }

  decodeSignedCommit(
    signedCommit: Uint8Array,
    publicKey: Uint8Array,
  ): DecodedCommit {
    if (publicKey.length !== 32) {
      throw new Error("invalid test public key");
    }
    return JSON.parse(decoder.decode(signedCommit)) as DecodedCommit;
  }
}

class PullTestVault implements VaultPort {
  constructor(readonly files: Map<string, Uint8Array>) {}

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

class PullTestRemote implements PullRemote {
  readonly blobs = new Map<string, Uint8Array>();
  readonly commits: Uint8Array[] = [];
  heads: string[] = [];
  devices: PullDevice[] = [{
    device_id_hex: DEVICE_ID,
    public_key_hex: DEVICE_KEY,
    revoked: false,
  }];

  listDevices(): Promise<readonly PullDevice[]> {
    return Promise.resolve(this.devices);
  }

  getHeads(): Promise<readonly string[]> {
    return Promise.resolve(this.heads);
  }

  getChanges(): Promise<{
    readonly signedCommits: readonly Uint8Array[];
    readonly hasMore: boolean;
  }> {
    return Promise.resolve({
      signedCommits: this.commits,
      hasMore: false,
    });
  }

  getBlob(blobId: string): Promise<Uint8Array> {
    const value = this.blobs.get(blobId);
    return value === undefined
      ? Promise.reject(new Error("missing test blob"))
      : Promise.resolve(value.slice());
  }
}

interface EntryInput {
  readonly objectId?: string;
  readonly path: string;
  readonly content?: string | Uint8Array;
  readonly revision: string;
  readonly tombstone?: boolean;
}

function addCommit(
  core: PullTestCore,
  remote: PullTestRemote,
  commitId: string,
  parents: readonly string[],
  timestamp: string,
  entries: readonly EntryInput[],
): DecodedCommit {
  const manifestEntries = entries.map((input, index) => {
    const objectId = input.objectId ?? "44".repeat(16);
    const pathBlob = `${commitId}-path-${index.toString()}`;
    remote.blobs.set(pathBlob, encoder.encode(input.path));
    const contentBlob = input.tombstone
      ? null
      : `${commitId}-content-${index.toString()}`;
    const bytes = typeof input.content === "string"
      ? encoder.encode(input.content)
      : input.content ?? new Uint8Array();
    if (contentBlob !== null) {
      remote.blobs.set(contentBlob, bytes);
    }
    return {
      object_id_hex: objectId,
      revision: input.revision,
      object_type: input.path.endsWith(".md") ? 1 as const : 5 as const,
      encrypted_path_blob_id_hex: pathBlob,
      content_blob_id_hex: contentBlob,
      metadata_blob_id_hex: null,
      canonical_plaintext_hash_hex: core.hash(
        input.path.endsWith(".md") ? core.canonicalizeText(bytes) : bytes,
      ),
      tombstone: input.tombstone ?? false,
    };
  });
  const manifest: ManifestInput = {
    vault_id_hex: VAULT_ID,
    entries: manifestEntries,
  };
  const manifestBlobId = `${commitId}-manifest`;
  remote.blobs.set(manifestBlobId, encoder.encode(JSON.stringify(manifest)));
  const body: CommitBodyInput = {
    logical_timestamp: timestamp,
    operations: [],
    manifest_root_hex: core.manifestRoot(manifest),
    manifest_blob_id_hex: manifestBlobId,
    merge_base_hex: null,
    conflict_object_ids_hex: [],
  };
  return {
    commitId,
    parents,
    deviceId: DEVICE_ID,
    deviceSequence: timestamp,
    body,
  };
}

function initialState(
  core: PullTestCore,
  base: DecodedCommit,
  path: string,
  content: Uint8Array,
  contentBlobId: string,
): SyncState {
  return {
    ...EMPTY_SYNC_STATE,
    initializedFromRemote: true,
    knownCommitIds: [base.commitId],
    commits: [{
      commitId: base.commitId,
      parents: base.parents,
      deviceId: base.deviceId,
      deviceSequence: base.deviceSequence,
      logicalTimestamp: base.body.logical_timestamp,
      manifestRoot: base.body.manifest_root_hex,
      manifestBlobId: base.body.manifest_blob_id_hex,
    }],
    heads: [base.commitId],
    records: [{
      objectId: "44".repeat(16),
      path,
      revision: "1",
      objectType: path.endsWith(".md") ? 1 : 5,
      canonicalHash: core.hash(content),
      encryptedPathBlobId: `${base.commitId}-path-0`,
      contentBlobId,
      lastCommitId: base.commitId,
      tombstone: false,
    }],
  };
}

function encoded(commit: DecodedCommit): Uint8Array {
  return encoder.encode(JSON.stringify(commit));
}

describe("verified pull and conflict handling", () => {
  it("applies a verified remote change when the local file is unchanged", async () => {
    const core = new PullTestCore();
    const remote = new PullTestRemote();
    const base = addCommit(core, remote, "base", [], "1", [{
      path: "note.md",
      content: "base\n",
      revision: "1",
    }]);
    const next = addCommit(core, remote, "next", ["base"], "2", [{
      path: "note.md",
      content: "remote\n",
      revision: "2",
    }]);
    remote.commits.push(encoded(next));
    remote.heads = ["next"];
    const vault = new PullTestVault(
      new Map([["note.md", encoder.encode("base\r\n")]]),
    );
    const states = new MemoryStateRepository(
      initialState(core, base, "note.md", encoder.encode("base\n"), "base-content-0"),
    );

    const state = await new PullEngine(
      VAULT_ID,
      vault,
      core,
      remote,
      states,
      new EchoSuppressor(),
      "desktop",
    ).pull();

    expect(decoder.decode(await vault.read("note.md"))).toBe("remote\n");
    expect(state.heads).toEqual(["next"]);
    expect(state.records[0]?.revision).toBe("2");
  });

  it("performs a clean line merge for concurrent Markdown edits", async () => {
    const core = new PullTestCore();
    const remote = new PullTestRemote();
    const baseText = "first\nsecond\n";
    const base = addCommit(core, remote, "base", [], "1", [{
      path: "note.md",
      content: baseText,
      revision: "1",
    }]);
    const next = addCommit(core, remote, "next", ["base"], "2", [{
      path: "note.md",
      content: "first\nremote second\n",
      revision: "2",
    }]);
    remote.commits.push(encoded(next));
    remote.heads = ["next"];
    const vault = new PullTestVault(
      new Map([["note.md", encoder.encode("local first\nsecond\n")]]),
    );
    const states = new MemoryStateRepository(
      initialState(core, base, "note.md", encoder.encode(baseText), "base-content-0"),
    );

    await new PullEngine(
      VAULT_ID,
      vault,
      core,
      remote,
      states,
      new EchoSuppressor(),
      "desktop",
    ).pull();

    expect(decoder.decode(await vault.read("note.md")))
      .toBe("local first\nremote second\n");
    expect([...vault.files.keys()].filter((path) => path.includes("conflict-")))
      .toEqual([]);
  });

  it("preserves both binary versions and writes a conflict record", async () => {
    const core = new PullTestCore();
    const remote = new PullTestRemote();
    const baseBytes = Uint8Array.of(1);
    const base = addCommit(core, remote, "base", [], "1", [{
      path: "image.bin",
      content: baseBytes,
      revision: "1",
    }]);
    const next = addCommit(core, remote, "next", ["base"], "2", [{
      path: "image.bin",
      content: Uint8Array.of(3),
      revision: "2",
    }]);
    remote.commits.push(encoded(next));
    remote.heads = ["next"];
    const vault = new PullTestVault(
      new Map([["image.bin", Uint8Array.of(2)]]),
    );
    const states = new MemoryStateRepository(
      initialState(core, base, "image.bin", baseBytes, "base-content-0"),
    );

    await new PullEngine(
      VAULT_ID,
      vault,
      core,
      remote,
      states,
      new EchoSuppressor(() => 0),
      "desktop",
      () => new Date("2026-07-28T01:02:03Z"),
    ).pull();

    expect([...await vault.read("image.bin")]).toEqual([3]);
    const conflict = [...vault.files].find(([path]) =>
      path.includes("conflict-desktop-20260728T010203Z")
    );
    expect(conflict?.[1]).toEqual(Uint8Array.of(2));
    expect([...vault.files.keys()].some((path) =>
      path.startsWith("00-Inbox/Sync Conflicts/")
    )).toBe(true);
  });

  it("preserves a same-key local creation without leaving a portable collision", async () => {
    const core = new PullTestCore();
    const remote = new PullTestRemote();
    const root = addCommit(core, remote, "root", [], "1", [{
      path: "note.md",
      content: "remote\n",
      revision: "1",
    }]);
    remote.commits.push(encoded(root));
    remote.heads = ["root"];
    const vault = new PullTestVault(
      new Map([["Note.md", encoder.encode("local\n")]]),
    );
    const states = new MemoryStateRepository();

    await new PullEngine(
      VAULT_ID,
      vault,
      core,
      remote,
      states,
      new EchoSuppressor(),
      "desktop",
      () => new Date("2026-07-28T01:02:03Z"),
    ).pull();

    expect(vault.files.has("Note.md")).toBe(false);
    expect(decoder.decode(await vault.read("note.md"))).toBe("remote\n");
    expect([...vault.files.keys()].some((path) =>
      path.includes("Note (conflict-desktop-")
    )).toBe(true);
  });
});
