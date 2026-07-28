import { Platform, type App } from "obsidian";

import { ObsidianVaultPort } from "../obsidian/vault-port";
import {
  type LearningLoopSettings,
  type SettingsRepository,
  strongClientPassword,
} from "../settings";
import type { SetupCredentials } from "../ui/credentials-modal";
import {
  WasmEncryptedCore,
  bytesToHex,
  hexToBytes,
  initializeCore,
} from "../wasm/runtime";
import { FixedRouteHttpTransport } from "../transport/http";
import { AuthenticatedSession } from "../transport/session";
import {
  IndexedDbCiphertextCache,
  type CiphertextCache,
} from "./cache";
import { EchoSuppressor } from "./echo";
import { SyncEngine } from "./engine";
import { PullEngine } from "./pull";
import {
  IndexedDbStateRepository,
  type StateRepository,
} from "./state";

const DEBOUNCE_MS = 2_000;

export type SyncStatus =
  | "locked"
  | "connecting"
  | "waiting"
  | "syncing"
  | "synced"
  | "error";

export class SyncController {
  private core: WasmEncryptedCore | undefined;
  private session: AuthenticatedSession | undefined;
  private states: StateRepository | undefined;
  private cache: CiphertextCache | undefined;
  private settings: LearningLoopSettings | undefined;
  private readonly vault: ObsidianVaultPort;
  private readonly echoes = new EchoSuppressor();
  private syncTail: Promise<void> = Promise.resolve();
  private debounceTimer: number | undefined;
  private currentStatus: SyncStatus = "locked";

  constructor(
    private readonly app: App,
    private readonly pluginId: string,
    private readonly repository: SettingsRepository,
    private readonly statusChanged: (status: SyncStatus, detail?: string) => void,
  ) {
    this.vault = new ObsidianVaultPort(app);
  }

  async initialize(): Promise<void> {
    await initializeCore(this.app, this.pluginId);
    this.settings = await this.repository.load();
    this.setStatus("locked");
  }

  get status(): SyncStatus {
    return this.currentStatus;
  }

  get configured(): boolean {
    return this.settings?.server !== undefined && this.settings.vault !== undefined;
  }

  async configure(credentials: SetupCredentials): Promise<void> {
    if (
      !strongClientPassword(credentials.clientPassword)
      || credentials.clientPassword === credentials.serverPassword
    ) {
      throw new Error(
        "client password must be strong and different from the server password",
      );
    }
    this.setStatus("connecting");
    const http = FixedRouteHttpTransport.fromHostAndPort(
      credentials.host,
      credentials.port,
    );
    let session: AuthenticatedSession | undefined;
    let core: WasmEncryptedCore | undefined;
    try {
      const connection = await AuthenticatedSession.connect(
        http,
        credentials.fingerprint,
        credentials.serverPassword,
      );
      session = connection.session;
      const existingEnvelope = await session.tryGetVaultKeyEnvelope();
      let encryptedDeviceIdentity: Uint8Array;
      let wrappedVaultKey: Uint8Array;
      if (existingEnvelope === undefined) {
        const created = WasmEncryptedCore.create(
          connection.vaultId,
          credentials.clientPassword,
          Platform.isAndroidApp,
        );
        core = created.core;
        wrappedVaultKey = created.wrappedVaultKey;
        encryptedDeviceIdentity = created.encryptedDeviceIdentity;
        await session.putVaultKeyEnvelope(wrappedVaultKey);
      } else {
        const created = WasmEncryptedCore.addDevice(
          connection.vaultId,
          credentials.clientPassword,
          existingEnvelope,
        );
        core = created.core;
        wrappedVaultKey = existingEnvelope;
        encryptedDeviceIdentity = created.encryptedDeviceIdentity;
      }
      await session.registerDevice(core, credentials.deviceName);
      const next = await this.repository.completeSetup(
        {
          host: credentials.host,
          port: credentials.port,
          fingerprint: credentials.fingerprint,
          deviceName: credentials.deviceName,
        },
        {
          vaultIdHex: connection.vaultId,
          wrappedVaultKeyHex: bytesToHex(wrappedVaultKey),
          encryptedDeviceIdentityHex: bytesToHex(encryptedDeviceIdentity),
        },
        credentials.serverPassword,
      );
      this.lock();
      this.settings = next;
      this.core = core;
      this.session = session;
      this.initializeLocalStores(connection.vaultId);
      core = undefined;
      session = undefined;
      await this.syncNow();
    } catch (error) {
      session?.close();
      core?.lock();
      this.setStatus("error", safeMessage(error));
      throw error;
    }
  }

  async unlock(clientPassword: string): Promise<void> {
    if (this.core !== undefined) {
      return;
    }
    const settings = this.settings ?? await this.repository.load();
    if (settings.server === undefined || settings.vault === undefined) {
      throw new Error("encrypted synchronization is not configured");
    }
    this.setStatus("connecting");
    let core: WasmEncryptedCore | undefined;
    try {
      core = WasmEncryptedCore.unlock(
        settings.vault.vaultIdHex,
        clientPassword,
        hexToBytes(settings.vault.wrappedVaultKeyHex),
        hexToBytes(settings.vault.encryptedDeviceIdentityHex),
      );
      this.core = core;
      core = undefined;
      this.initializeLocalStores(settings.vault.vaultIdHex);
      await this.ensureSession();
      await this.syncNow();
    } catch (error) {
      core?.lock();
      this.lock();
      this.setStatus("error", safeMessage(error));
      throw error;
    }
  }

  lock(): void {
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.session?.close();
    this.session = undefined;
    this.core?.lock();
    this.core = undefined;
    this.states = undefined;
    this.cache = undefined;
    this.setStatus("locked");
  }

  syncNow(): Promise<void> {
    const run = this.syncTail.then(async () => {
      if (this.core === undefined) {
        throw new Error("Learning Loop is locked");
      }
      this.setStatus(Platform.isMobile ? "waiting" : "syncing");
      let firstError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.runOnce();
          this.setStatus("synced");
          return;
        } catch (error) {
          firstError ??= error;
          this.session?.close();
          this.session = undefined;
        }
      }
      this.setStatus("error", safeMessage(firstError));
      throw firstError;
    });
    this.syncTail = run.catch(() => undefined);
    return run;
  }

  async handleContentEvent(path: string): Promise<void> {
    if (this.core === undefined) {
      return;
    }
    try {
      const bytes = await this.vault.read(path);
      const canonical = isText(path)
        ? this.core.canonicalizeText(bytes)
        : bytes;
      if (this.echoes.consume(path, this.core.hash(canonical))) {
        return;
      }
    } catch {
      // Reconciliation will classify a racing delete or read failure safely.
    }
    this.scheduleSync();
  }

  handlePathEvent(...paths: readonly string[]): void {
    if (this.core === undefined) {
      return;
    }
    if (paths.some((path) => this.echoes.consumePath(path))) {
      return;
    }
    this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = undefined;
      void this.syncNow().catch(() => undefined);
    }, DEBOUNCE_MS);
  }

  private async runOnce(): Promise<void> {
    const core = required(this.core);
    const state = required(this.states);
    const cache = required(this.cache);
    const settings = required(this.settings);
    const server = required(settings.server);
    const vault = required(settings.vault);
    const session = await this.ensureSession();
    this.setStatus("syncing");
    await new PullEngine(
      vault.vaultIdHex,
      this.vault,
      core,
      session,
      state,
      this.echoes,
      server.deviceName,
    ).pull();
    const push = new SyncEngine(
      vault.vaultIdHex,
      this.vault,
      core,
      session,
      state,
      cache,
    );
    await push.reconcile();
    await push.push();
  }

  private async ensureSession(): Promise<AuthenticatedSession> {
    if (this.session !== undefined) {
      return this.session;
    }
    const core = required(this.core);
    const settings = required(this.settings);
    const server = required(settings.server);
    const vault = required(settings.vault);
    const serverPassword = this.app.secretStorage.getSecret(
      settings.serverPasswordSecretId,
    );
    if (serverPassword === null) {
      throw new Error("server password is absent from Obsidian SecretStorage");
    }
    const connection = await AuthenticatedSession.connect(
      FixedRouteHttpTransport.fromHostAndPort(server.host, server.port),
      server.fingerprint,
      serverPassword,
      core.transportIdentity(),
    );
    if (
      connection.vaultId !== vault.vaultIdHex
      || !connection.deviceAuthenticated
    ) {
      connection.session.close();
      throw new Error("server vault or device identity changed");
    }
    this.session = connection.session;
    return connection.session;
  }

  private initializeLocalStores(vaultId: string): void {
    this.states = new IndexedDbStateRepository(
      `learning-loop-state-${vaultId}`,
    );
    this.cache = new IndexedDbCiphertextCache(
      `learning-loop-ciphertext-${vaultId}`,
    );
  }

  private setStatus(status: SyncStatus, detail?: string): void {
    this.currentStatus = status;
    this.statusChanged(status, detail);
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "encrypted synchronization failed";
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Learning Loop runtime is not ready");
  }
  return value;
}

function isText(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return new Set([
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
  ]).has(extension);
}
