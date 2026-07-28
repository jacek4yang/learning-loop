import type { Plugin } from "obsidian";

export interface ServerSettings {
  readonly host: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly deviceName: string;
}

export interface VaultKeySettings {
  readonly vaultIdHex: string;
  readonly wrappedVaultKeyHex: string;
  readonly encryptedDeviceIdentityHex: string;
}

export interface LearningLoopSettings {
  readonly schema: 1;
  readonly serverPasswordSecretId: string;
  readonly server?: ServerSettings;
  readonly vault?: VaultKeySettings;
}

export class SettingsRepository {
  private value: LearningLoopSettings | undefined;

  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<LearningLoopSettings> {
    if (this.value !== undefined) {
      return structuredClone(this.value);
    }
    const raw = await this.plugin.loadData() as unknown;
    this.value = parseSettings(raw);
    if (!isCurrentSettings(raw)) {
      await this.plugin.saveData(this.value);
    }
    return structuredClone(this.value);
  }

  async save(value: LearningLoopSettings): Promise<void> {
    const parsed = parseSettings(value);
    await this.plugin.saveData(parsed);
    this.value = parsed;
  }

  async completeSetup(
    server: ServerSettings,
    vault: VaultKeySettings,
    serverPassword: string,
  ): Promise<LearningLoopSettings> {
    const current = await this.load();
    this.plugin.app.secretStorage.setSecret(
      current.serverPasswordSecretId,
      serverPassword,
    );
    const next: LearningLoopSettings = {
      ...current,
      server: validateServer(server),
      vault: validateVault(vault),
    };
    await this.save(next);
    return next;
  }
}

export function strongClientPassword(password: string): boolean {
  if (password.length < 14 || password.length > 1024) {
    return false;
  }
  const categories = [
    /[a-z]/u,
    /[A-Z]/u,
    /\p{N}/u,
    /[^\p{L}\p{N}\s]/u,
    /\s/u,
    /\P{ASCII}/u,
  ].filter((pattern) => pattern.test(password)).length;
  return categories >= 3 || (password.length >= 20 && categories >= 2);
}

function parseSettings(value: unknown): LearningLoopSettings {
  if (!isObject(value)) {
    return emptySettings();
  }
  const secret = typeof value.serverPasswordSecretId === "string"
    && /^[a-z0-9-]{1,64}$/u.test(value.serverPasswordSecretId)
    ? value.serverPasswordSecretId
    : randomSecretId();
  const server = isObject(value.server)
    ? tryValidate(() => validateServer(value.server as ServerSettings))
    : undefined;
  const vault = isObject(value.vault)
    ? tryValidate(() => validateVault(value.vault as VaultKeySettings))
    : undefined;
  return {
    schema: 1,
    serverPasswordSecretId: secret,
    ...(server === undefined ? {} : { server }),
    ...(vault === undefined ? {} : { vault }),
  };
}

function validateServer(server: ServerSettings): ServerSettings {
  const host = server.host.trim().toLowerCase();
  const fingerprint = server.fingerprint.trim();
  const deviceName = server.deviceName.trim();
  if (
    host.length === 0
    || host.length > 253
    || /[/@?#\s]/u.test(host)
    || !Number.isInteger(server.port)
    || server.port < 1
    || server.port > 65_535
    || !/^SHA256:[A-Z2-7]{52}$/u.test(fingerprint)
    || deviceName.length === 0
    || deviceName.length > 96
  ) {
    throw new Error("invalid Learning Loop connection settings");
  }
  return {
    host,
    port: server.port,
    fingerprint,
    deviceName,
  };
}

function validateVault(vault: VaultKeySettings): VaultKeySettings {
  if (
    !isHex(vault.vaultIdHex, 16)
    || !isBoundedHex(vault.wrappedVaultKeyHex, 32, 512)
    || !isBoundedHex(vault.encryptedDeviceIdentityHex, 64, 1024)
  ) {
    throw new Error("invalid encrypted local vault settings");
  }
  return { ...vault };
}

function emptySettings(): LearningLoopSettings {
  return {
    schema: 1,
    serverPasswordSecretId: randomSecretId(),
  };
}

function randomSecretId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const suffix = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `learning-loop-${suffix}`;
}

function isHex(value: string, bytes: number): boolean {
  return new RegExp(`^[0-9a-f]{${(bytes * 2).toString()}}$`, "u").test(value);
}

function isBoundedHex(value: string, minimumBytes: number, maximumBytes: number): boolean {
  return /^(?:[0-9a-f]{2})+$/u.test(value)
    && value.length >= minimumBytes * 2
    && value.length <= maximumBytes * 2;
}

function tryValidate<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCurrentSettings(value: unknown): boolean {
  return isObject(value)
    && value.schema === 1
    && typeof value.serverPasswordSecretId === "string";
}
