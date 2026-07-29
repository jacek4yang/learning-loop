import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  WasmDeviceIdentity,
  WasmVault,
  initSync,
} from "../../wasm/ll-client-core/pkg/ll_client_core.js";

describe("WASM runtime", () => {
  it("creates, persists, unlocks, and restores encrypted device material", () => {
    const password = "LearningLoop-Wasm-Smoke-2026!";
    const vaultId = Uint8Array.from(
      { length: 16 },
      (_, index) => index + 1,
    );
    const wasm = readFileSync(
      new URL(
        "../../wasm/ll-client-core/pkg/ll_client_core_bg.wasm",
        import.meta.url,
      ),
    );
    initSync({ module: wasm });

    const created = WasmVault.create(vaultId, password, false);
    const envelope = created.takeCreatedEnvelope();
    const device = WasmDeviceIdentity.generate();
    const encryptedDevice = device.encryptForStorage(created);
    device.free();
    created.free();

    const reopened = WasmVault.unlock(vaultId, password, envelope);
    const restoredDevice = WasmDeviceIdentity.restore(
      reopened,
      encryptedDevice,
    );
    restoredDevice.free();
    reopened.free();

    expect(envelope.length).toBeGreaterThan(0);
    expect(encryptedDevice.length).toBeGreaterThan(0);
  });
});
