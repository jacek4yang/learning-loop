import { normalizePath, type App } from "obsidian";

import {
  WasmDeviceIdentity,
  WasmVault,
  blake3_hash_bytes,
  canonicalize_path,
  canonicalize_text_bytes,
  decode_manifest_json,
  encode_manifest_json,
  initSync,
  manifest_root_json,
  new_object_id_bytes,
  portable_collision_key,
} from "../../../wasm/ll-client-core/pkg/ll_client_core.js";
import type {
  CommitBodyInput,
  EncryptedCore,
  ManifestInput,
} from "../sync/engine";
import type { HexId, ObjectType } from "../sync/types";

let initialized = false;

export async function initializeCore(app: App, pluginId: string): Promise<void> {
  if (initialized) {
    return;
  }
  const wasmPath = normalizePath(
    `${app.vault.configDir}/plugins/${pluginId}/core.wasm`,
  );
  const bytes = await app.vault.adapter.readBinary(wasmPath);
  initSync({ module: bytes });
  initialized = true;
}

export interface NewVaultMaterial {
  readonly core: WasmEncryptedCore;
  readonly wrappedVaultKey: Uint8Array;
  readonly encryptedDeviceIdentity: Uint8Array;
}

export class WasmEncryptedCore implements EncryptedCore {
  private locked = false;

  private constructor(
    private readonly vault: WasmVault,
    private readonly device: WasmDeviceIdentity,
  ) {}

  static create(
    vaultId: HexId,
    clientPassword: string,
    android: boolean,
  ): NewVaultMaterial {
    const vault = WasmVault.create(hexToBytes(vaultId, 16), clientPassword, android);
    let device: WasmDeviceIdentity | undefined;
    try {
      const wrappedVaultKey = vault.takeCreatedEnvelope();
      device = WasmDeviceIdentity.generate();
      const encryptedDeviceIdentity = device.encryptForStorage(vault);
      return {
        core: new WasmEncryptedCore(vault, device),
        wrappedVaultKey,
        encryptedDeviceIdentity,
      };
    } catch (error) {
      device?.free();
      vault.free();
      throw error;
    }
  }

  static addDevice(
    vaultId: HexId,
    clientPassword: string,
    wrappedVaultKey: Uint8Array,
  ): {
    readonly core: WasmEncryptedCore;
    readonly encryptedDeviceIdentity: Uint8Array;
  } {
    const vault = WasmVault.unlock(
      hexToBytes(vaultId, 16),
      clientPassword,
      wrappedVaultKey,
    );
    let device: WasmDeviceIdentity | undefined;
    try {
      device = WasmDeviceIdentity.generate();
      return {
        core: new WasmEncryptedCore(vault, device),
        encryptedDeviceIdentity: device.encryptForStorage(vault),
      };
    } catch (error) {
      device?.free();
      vault.free();
      throw error;
    }
  }

  static unlock(
    vaultId: HexId,
    clientPassword: string,
    wrappedVaultKey: Uint8Array,
    encryptedDeviceIdentity: Uint8Array,
  ): WasmEncryptedCore {
    const vault = WasmVault.unlock(
      hexToBytes(vaultId, 16),
      clientPassword,
      wrappedVaultKey,
    );
    try {
      const device = WasmDeviceIdentity.restore(vault, encryptedDeviceIdentity);
      return new WasmEncryptedCore(vault, device);
    } catch (error) {
      vault.free();
      throw error;
    }
  }

  canonicalizePath(path: string): string {
    this.requireUnlocked();
    return canonicalize_path(path);
  }

  collisionKey(path: string): string {
    this.requireUnlocked();
    return portable_collision_key(path);
  }

  canonicalizeText(bytes: Uint8Array): Uint8Array {
    this.requireUnlocked();
    return canonicalize_text_bytes(bytes);
  }

  hash(bytes: Uint8Array): HexId {
    this.requireUnlocked();
    return bytesToHex(blake3_hash_bytes(bytes));
  }

  newObjectId(): HexId {
    this.requireUnlocked();
    return bytesToHex(new_object_id_bytes());
  }

  encryptObject(
    objectId: HexId,
    revision: string,
    objectType: ObjectType,
    cleartext: Uint8Array,
  ): Uint8Array {
    this.requireUnlocked();
    return this.vault.encrypt(
      hexToBytes(objectId, 16),
      revision,
      objectType,
      cleartext,
    );
  }

  decryptObject(ciphertext: Uint8Array): Uint8Array {
    this.requireUnlocked();
    return this.vault.decrypt(ciphertext);
  }

  encodeManifest(input: ManifestInput): Uint8Array {
    this.requireUnlocked();
    return encode_manifest_json(JSON.stringify(input));
  }

  decodeManifest(encoded: Uint8Array): ManifestInput {
    this.requireUnlocked();
    return JSON.parse(decode_manifest_json(encoded)) as ManifestInput;
  }

  manifestRoot(input: ManifestInput): HexId {
    this.requireUnlocked();
    return bytesToHex(manifest_root_json(JSON.stringify(input)));
  }

  createSignedCommit(
    parents: readonly HexId[],
    deviceSequence: string,
    body: CommitBodyInput,
  ): Uint8Array {
    this.requireUnlocked();
    return this.vault.createSignedCommit(
      this.device,
      flattenHex(parents, 32),
      deviceSequence,
      JSON.stringify(body),
    );
  }

  deviceId(): HexId {
    this.requireUnlocked();
    return bytesToHex(this.device.id());
  }

  decodeSignedCommit(
    signedCommit: Uint8Array,
    publicKey: Uint8Array,
  ): DecodedCommit {
    this.requireUnlocked();
    const decoded = JSON.parse(
      this.vault.decodeSignedCommit(signedCommit, publicKey),
    ) as RawDecodedCommit;
    return {
      commitId: decoded.commit_id_hex,
      parents: decoded.parent_ids_hex,
      deviceId: decoded.device_id_hex,
      deviceSequence: decoded.device_sequence,
      body: decoded.body,
    };
  }

  encryptedDeviceName(name: string): Uint8Array {
    this.requireUnlocked();
    return this.device.encryptName(this.vault, name);
  }

  deviceIdBytes(): Uint8Array {
    this.requireUnlocked();
    return this.device.id();
  }

  devicePublicKey(): Uint8Array {
    this.requireUnlocked();
    return this.device.publicKey();
  }

  transportIdentity(): WasmDeviceIdentity {
    this.requireUnlocked();
    return this.device;
  }

  lock(): void {
    if (this.locked) {
      return;
    }
    this.locked = true;
    this.device.free();
    this.vault.free();
  }

  private requireUnlocked(): void {
    if (this.locked) {
      throw new Error("vault is locked");
    }
  }
}

export interface DecodedCommit {
  readonly commitId: HexId;
  readonly parents: readonly HexId[];
  readonly deviceId: HexId;
  readonly deviceSequence: string;
  readonly body: CommitBodyInput;
}

interface RawDecodedCommit {
  readonly commit_id_hex: HexId;
  readonly parent_ids_hex: readonly HexId[];
  readonly device_id_hex: HexId;
  readonly device_sequence: string;
  readonly body: CommitBodyInput;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(value: string, expectedLength?: number): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) {
    throw new Error("invalid lowercase hexadecimal value");
  }
  const bytes = Uint8Array.from(
    value.match(/.{2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new Error("hexadecimal value has an invalid length");
  }
  return bytes;
}

function flattenHex(values: readonly HexId[], length: number): Uint8Array {
  const output = new Uint8Array(values.length * length);
  values.forEach((value, index) => {
    output.set(hexToBytes(value, length), index * length);
  });
  return output;
}
