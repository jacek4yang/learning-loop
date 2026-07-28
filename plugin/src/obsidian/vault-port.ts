import {
  TFile,
  TFolder,
  normalizePath,
  type App,
} from "obsidian";

import type { LocalFile, VaultPort } from "../sync/types";

export class ObsidianVaultPort implements VaultPort {
  constructor(private readonly app: App) {}

  listFiles(): Promise<readonly LocalFile[]> {
    const configPrefix = `${normalizePath(this.app.vault.configDir)}/`;
    return Promise.resolve(
      this.app.vault.getFiles()
        .filter((file) => !normalizePath(file.path).startsWith(configPrefix))
        .map((file) => ({
          path: normalizePath(file.path),
          size: file.stat.size,
          extension: file.extension,
        })),
    );
  }

  async read(path: string): Promise<Uint8Array> {
    this.requireUserPath(path);
    const file = this.requireFile(path);
    return new Uint8Array(await this.app.vault.readBinary(file));
  }

  async write(
    path: string,
    content: Uint8Array,
    text: boolean,
  ): Promise<void> {
    const normalized = normalizePath(path);
    this.requireUserPath(normalized);
    await this.ensureParent(normalized);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing !== null && !(existing instanceof TFile)) {
      throw new Error("a folder blocks the synchronized file path");
    }
    if (text) {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(content);
      if (existing instanceof TFile) {
        await this.app.vault.process(existing, () => value);
      } else {
        await this.app.vault.create(normalized, value);
      }
      return;
    }
    const binary = exactArrayBuffer(content);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, binary);
    } else {
      await this.app.vault.createBinary(normalized, binary);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    this.requireUserPath(from);
    const destination = normalizePath(to);
    this.requireUserPath(destination);
    if (this.app.vault.getAbstractFileByPath(destination) !== null) {
      throw new Error("the synchronized rename destination already exists");
    }
    await this.ensureParent(destination);
    await this.app.fileManager.renameFile(this.requireFile(from), destination);
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path);
    this.requireUserPath(normalized);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing === null) {
      return;
    }
    if (!(existing instanceof TFile)) {
      throw new Error("a folder blocks the synchronized file path");
    }
    await this.app.vault.delete(existing);
  }

  exists(path: string): Promise<boolean> {
    this.requireUserPath(path);
    return Promise.resolve(
      this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null,
    );
  }

  private requireFile(path: string): TFile {
    const normalized = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      throw new Error("synchronized file does not exist");
    }
    return file;
  }

  private requireUserPath(path: string): void {
    const normalized = normalizePath(path);
    const config = normalizePath(this.app.vault.configDir);
    if (normalized === config || normalized.startsWith(`${config}/`)) {
      throw new Error("synchronization cannot access Obsidian configuration files");
    }
  }

  private async ensureParent(path: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash < 0) {
      return;
    }
    const components = path.slice(0, slash).split("/");
    let current = "";
    for (const component of components) {
      current = current === "" ? component : `${current}/${component}`;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing === null) {
        await this.app.vault.createFolder(current);
      } else if (!isFolder(existing)) {
        throw new Error("a file blocks the synchronized parent folder");
      }
    }
  }
}

function isFolder(value: unknown): value is TFolder {
  return value instanceof TFolder;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
