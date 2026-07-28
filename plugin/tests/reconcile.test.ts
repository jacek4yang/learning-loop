import { describe, expect, it } from "vitest";

import { Reconciler } from "../src/sync/reconcile";
import {
  EMPTY_SYNC_STATE,
  type LocalFile,
  type PortableCore,
  type SyncState,
  type VaultPort,
} from "../src/sync/types";

class TestCore implements PortableCore {
  private next = 0;

  canonicalizePath(path: string): string {
    if (path.includes("..")) {
      throw new Error("invalid");
    }
    return path.normalize("NFC");
  }

  collisionKey(path: string): string {
    return path.normalize("NFC").toLocaleLowerCase("und");
  }

  canonicalizeText(bytes: Uint8Array): Uint8Array {
    const text = new TextDecoder().decode(bytes)
      .replace(/^\uFEFF/u, "")
      .replaceAll(/\r\n?|\n/gu, "\n");
    return new TextEncoder().encode(text);
  }

  hash(bytes: Uint8Array): string {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  newObjectId(): string {
    this.next += 1;
    return this.next.toString(16).padStart(32, "0");
  }
}

class LargeFileCore extends TestCore {
  override hash(bytes: Uint8Array): string {
    return `size-${bytes.length.toString()}`;
  }
}

class TestVault implements VaultPort {
  constructor(private readonly files: Map<string, Uint8Array>) {}

  listFiles(): Promise<readonly LocalFile[]> {
    return Promise.resolve([...this.files.entries()].map(([path, bytes]) => ({
      path,
      size: bytes.length,
      extension: path.split(".").pop() ?? "",
    })));
  }

  read(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (value === undefined) {
      return Promise.reject(new Error("missing"));
    }
    return Promise.resolve(value);
  }

  write(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  async rename(from: string, to: string): Promise<void> {
    const content = await this.read(from);
    this.files.delete(from);
    this.files.set(to, content);
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
}

const encoder = new TextEncoder();

describe("reconciliation", () => {
  it("detects create, modify, rename, and tombstone without storing content", async () => {
    const core = new TestCore();
    const oldHash = core.hash(encoder.encode("old\n"));
    const movedHash = core.hash(encoder.encode("same\n"));
    const state: SyncState = {
      ...EMPTY_SYNC_STATE,
      initializedFromRemote: true,
      records: [
        {
          objectId: "01".padStart(32, "0"),
          path: "changed.md",
          revision: "2",
          objectType: 1,
          canonicalHash: oldHash,
          tombstone: false,
        },
        {
          objectId: "02".padStart(32, "0"),
          path: "old-name.md",
          revision: "4",
          objectType: 1,
          canonicalHash: movedHash,
          tombstone: false,
        },
        {
          objectId: "03".padStart(32, "0"),
          path: "deleted.md",
          revision: "1",
          objectType: 1,
          canonicalHash: "ff",
          tombstone: false,
        },
      ],
    };
    const vault = new TestVault(new Map([
      ["changed.md", encoder.encode("new\n")],
      ["new-name.md", encoder.encode("same\n")],
      ["created.md", encoder.encode("created\n")],
    ]));
    const result = await new Reconciler(
      vault,
      core,
      () => new Date("2026-07-28T00:00:00Z"),
    ).scan(state);
    expect(result.operations.map((operation) => operation.kind).sort()).toEqual([
      "create",
      "delete",
      "modify",
      "rename",
    ]);
    expect(JSON.stringify(result.operations)).not.toContain("created\\n");
  });

  it("does not interpret a new empty vault as remote deletion", async () => {
    const state: SyncState = {
      ...EMPTY_SYNC_STATE,
      records: [{
        objectId: "01".padStart(32, "0"),
        path: "remote.md",
        revision: "1",
        objectType: 1,
        canonicalHash: "aa",
        tombstone: false,
      }],
    };
    const result = await new Reconciler(
      new TestVault(new Map()),
      new TestCore(),
    ).scan(state);
    expect(result.operations).toEqual([]);
  });

  it("blocks portable path collisions", async () => {
    const result = await new Reconciler(
      new TestVault(new Map([
        ["Note.md", encoder.encode("one")],
        ["note.md", encoder.encode("two")],
      ])),
      new TestCore(),
    ).scan(EMPTY_SYNC_STATE);
    expect(result.operations).toEqual([]);
    expect(result.issues).toEqual([{
      code: "portable_collision",
      paths: ["Note.md", "note.md"],
    }]);
  });

  it("scans the required multilingual and 100 MiB+ binary matrix", async () => {
    const large = new Uint8Array(100 * 1024 * 1024 + 1);
    large[0] = 0x25;
    large[large.length - 1] = 0xff;
    const files = new Map<string, Uint8Array>([
      ["中文/问题.md", encoder.encode("\uFEFF第一行\r\n第二行\r")],
      ["日本語/設計.canvas", encoder.encode('{"nodes":[],"edges":[]}')],
      ["한국어/자료.base", encoder.encode("filters:\n  and: []\n")],
      ["emoji/🧪 image.png", Uint8Array.of(0x89, 0x50, 0x4e, 0x47)],
      ["attachments/archive.multi.part.pdf", Uint8Array.of(0x25, 0x50, 0x44, 0x46)],
      ["attachments/audio.mp3", Uint8Array.of(0x49, 0x44, 0x33)],
      ["attachments/large.bin", large],
    ]);
    const result = await new Reconciler(
      new TestVault(files),
      new LargeFileCore(),
    ).scan(EMPTY_SYNC_STATE);
    expect(result.issues).toEqual([]);
    expect(result.operations).toHaveLength(files.size);
    expect(
      result.operations.find((operation) => operation.path.endsWith("large.bin"))
        ?.canonicalHash,
    ).toBe(`size-${large.length.toString()}`);
  });
});
