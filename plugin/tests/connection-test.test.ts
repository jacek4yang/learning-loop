import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type { SettingsRepository } from "../src/settings";

const { connect } = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("../src/transport/session", () => ({
  AuthenticatedSession: { connect },
  EncryptedProtocolError: class EncryptedProtocolError extends Error {
    constructor(readonly code: number) {
      super(`protocol error ${code.toString()}`);
    }
  },
}));

import { SyncController } from "../src/sync/controller";

const FINGERPRINT = `SHA256:${"A".repeat(52)}`;

describe("connection diagnostics", () => {
  it("reuses the stored server password and closes the read-only test session", async () => {
    const close = vi.fn();
    connect.mockResolvedValueOnce({
      session: { close },
      vaultId: "11".repeat(16),
      deviceAuthenticated: false,
    });
    const repository = {
      serverPassword: vi.fn(() =>
        Promise.resolve("stored-server-password")
      ),
    } as unknown as SettingsRepository;
    const controller = new SyncController(
      {} as App,
      "learning-loop",
      repository,
      vi.fn(),
    );

    await controller.testConnection({
      host: "notes.example.net",
      port: 48_632,
      fingerprint: FINGERPRINT,
      deviceName: "连接测试",
      serverPassword: "",
    });

    expect(connect).toHaveBeenCalledWith(
      expect.anything(),
      FINGERPRINT,
      "stored-server-password",
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
