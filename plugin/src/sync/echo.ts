import type { HexId } from "./types";

interface SuppressedWrite {
  readonly hash?: HexId;
  readonly expiresAt: number;
}

export class EchoSuppressor {
  private readonly writes = new Map<string, SuppressedWrite>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly lifetimeMs = 30_000,
  ) {}

  record(path: string, hash: HexId): void {
    this.purge();
    this.writes.set(path, {
      hash,
      expiresAt: this.now() + this.lifetimeMs,
    });
  }

  recordPath(path: string): void {
    this.purge();
    this.writes.set(path, {
      expiresAt: this.now() + this.lifetimeMs,
    });
  }

  consume(path: string, hash: HexId): boolean {
    this.purge();
    const expected = this.writes.get(path);
    if (expected?.hash !== hash) {
      return false;
    }
    this.writes.delete(path);
    return true;
  }

  consumePath(path: string): boolean {
    this.purge();
    if (!this.writes.has(path)) {
      return false;
    }
    this.writes.delete(path);
    return true;
  }

  private purge(): void {
    const now = this.now();
    for (const [path, write] of this.writes) {
      if (write.expiresAt <= now) {
        this.writes.delete(path);
      }
    }
  }
}
