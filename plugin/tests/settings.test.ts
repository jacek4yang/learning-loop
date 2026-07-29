import type { Plugin } from "obsidian";
import { describe, expect, it } from "vitest";

import {
  type LearningLoopSettings,
  SettingsRepository,
  normalizeServerSettings,
} from "../src/settings";

const FINGERPRINT = `SHA256:${"A".repeat(52)}`;

describe("settings persistence", () => {
  it("persists a first-run connection draft and server secret before networking", async () => {
    const fake = fakePlugin();
    const repository = new SettingsRepository(fake.plugin);

    const saved = await repository.saveInitialSetupDraft(
      {
        host: " Notes.Example.Net ",
        port: 48_632,
        fingerprint: ` ${FINGERPRINT} `,
        deviceName: " My laptop ",
      },
      "server-access-passphrase",
    );

    expect(saved.server).toEqual({
      host: "notes.example.net",
      port: 48_632,
      fingerprint: FINGERPRINT,
      deviceName: "My laptop",
    });
    expect(saved.focusMode).toBe(true);
    expect(await repository.serverPassword()).toBe("server-access-passphrase");
    expect(fake.saved()).toEqual(saved);

    const afterRestart = new SettingsRepository(fake.plugin);
    expect((await afterRestart.load()).server).toEqual(saved.server);
    expect(await afterRestart.hasServerPassword()).toBe(true);
  });

  it("does not replace a working vault or its secret with a failed reconfiguration draft", async () => {
    const fake = fakePlugin();
    const repository = new SettingsRepository(fake.plugin);
    const originalServer = normalizeServerSettings({
      host: "notes.example.net",
      port: 48_632,
      fingerprint: FINGERPRINT,
      deviceName: "Laptop",
    });
    const complete = await repository.completeSetup(
      originalServer,
      {
        vaultIdHex: "11".repeat(16),
        wrappedVaultKeyHex: "22".repeat(32),
        encryptedDeviceIdentityHex: "33".repeat(64),
      },
      "working-server-password",
    );

    const result = await repository.saveInitialSetupDraft(
      {
        host: "mistyped.example.net",
        port: 49_999,
        fingerprint: FINGERPRINT,
        deviceName: "Replacement",
      },
      "replacement-password",
    );

    expect(result).toEqual(complete);
    expect(await repository.serverPassword()).toBe("working-server-password");
    expect(fake.saved()).toEqual(complete);
  });

  it("persists the focused Learning Loop workspace preference", async () => {
    const fake = fakePlugin();
    const repository = new SettingsRepository(fake.plugin);

    expect((await repository.load()).focusMode).toBe(true);
    await repository.setFocusMode(false);

    const afterRestart = new SettingsRepository(fake.plugin);
    expect((await afterRestart.load()).focusMode).toBe(false);
  });
});

function fakePlugin(): {
  readonly plugin: Plugin;
  readonly saved: () => LearningLoopSettings | undefined;
} {
  let data: LearningLoopSettings | undefined;
  const secrets = new Map<string, string>();
  const plugin = {
    app: {
      secretStorage: {
        getSecret(id: string): string | null {
          return secrets.get(id) ?? null;
        },
        setSecret(id: string, secret: string): void {
          secrets.set(id, secret);
        },
      },
    },
    loadData(): Promise<unknown> {
      return Promise.resolve(
        data === undefined ? null : structuredClone(data),
      );
    },
    saveData(value: LearningLoopSettings): Promise<void> {
      data = structuredClone(value);
      return Promise.resolve();
    },
  } as unknown as Plugin;
  return {
    plugin,
    saved: () => data === undefined ? undefined : structuredClone(data),
  };
}
