import {
  WasmClientChannel,
  type WasmDeviceIdentity,
  type WasmResponse,
} from "../../../wasm/ll-client-core/pkg/ll_client_core.js";
import type { RemotePort } from "../sync/engine";
import type { HexId } from "../sync/types";
import { bytesToHex, hexToBytes } from "../wasm/runtime";
import type { WasmEncryptedCore } from "../wasm/runtime";
import type { FixedRouteHttpTransport } from "./http";

const RESPONSE = {
  authenticated: 1,
  deviceRegistered: 2,
  devices: 3,
  deviceRevoked: 4,
  uploadReady: 5,
  chunkAccepted: 6,
  uploadCommitted: 7,
  blobChunk: 8,
  pong: 9,
  commitStored: 10,
  commitRecord: 11,
  heads: 12,
  changes: 13,
  vaultKeyEnvelopeStored: 14,
  vaultKeyEnvelope: 15,
  error: 255,
} as const;

const MAX_BLOB_CHUNK_BYTES = 512 * 1024;
const MAX_CHANGE_PAGE = 256;
const VAULT_KEY_ENVELOPE_NOT_FOUND = 18;

export interface ConnectionResult {
  readonly session: AuthenticatedSession;
  readonly vaultId: HexId;
  readonly deviceAuthenticated: boolean;
}

export interface RemoteDevice {
  readonly device_id_hex: HexId;
  readonly public_key_hex: HexId;
  readonly encrypted_name_hex: string;
  readonly revoked: boolean;
}

export interface ChangePage {
  readonly signedCommits: readonly Uint8Array[];
  readonly hasMore: boolean;
}

export class AuthenticatedSession implements RemotePort {
  private closed = false;

  private constructor(
    private readonly http: FixedRouteHttpTransport,
    private readonly channel: WasmClientChannel,
  ) {}

  static async connect(
    http: FixedRouteHttpTransport,
    pinnedFingerprint: string,
    serverPassword: string,
    identity?: WasmDeviceIdentity,
  ): Promise<ConnectionResult> {
    let channel: WasmClientChannel | undefined;
    try {
      channel = new WasmClientChannel(
        await http.bootstrap(),
        pinnedFingerprint.trim(),
      );
      const handshake = channel.takeHandshakeMessage();
      channel.completeHandshake(await http.handshake(handshake));
      const authentication = identity === undefined
        ? channel.authenticateNewDevice(serverPassword)
        : channel.authenticateExistingDevice(serverPassword, identity);
      const response = channel.response(await http.envelope(authentication));
      try {
        requireKind(response, RESPONSE.authenticated);
        const vaultId = fixedHex(response.id(), 16);
        const deviceAuthenticated = response.flag();
        if (identity !== undefined && !deviceAuthenticated) {
          throw new Error("stored device is not authorized");
        }
        return {
          session: new AuthenticatedSession(http, channel),
          vaultId,
          deviceAuthenticated,
        };
      } finally {
        response.free();
      }
    } catch (error) {
      channel?.free();
      throw error;
    }
  }

  async registerDevice(core: WasmEncryptedCore, name: string): Promise<void> {
    await this.exchange(
      (channel) =>
        channel.registerDevice(
          core.transportIdentity(),
          core.encryptedDeviceName(name.trim()),
        ),
      (response) => {
        requireKind(response, RESPONSE.deviceRegistered);
      },
    );
  }

  async tryGetVaultKeyEnvelope(): Promise<Uint8Array | undefined> {
    return this.exchange(
      (channel) => channel.getVaultKeyEnvelope(),
      (response) => {
        if (
          response.kind() === RESPONSE.error
          && response.errorCode() === VAULT_KEY_ENVELOPE_NOT_FOUND
        ) {
          return undefined;
        }
        requireKind(response, RESPONSE.vaultKeyEnvelope);
        return response.bytes();
      },
    );
  }

  async putVaultKeyEnvelope(envelope: Uint8Array): Promise<void> {
    await this.exchange(
      (channel) => channel.putVaultKeyEnvelope(envelope),
      (response) => {
        requireKind(response, RESPONSE.vaultKeyEnvelopeStored);
      },
    );
  }

  async listDevices(): Promise<readonly RemoteDevice[]> {
    return this.exchange(
      (channel) => channel.listDevices(),
      (response) => {
        requireKind(response, RESPONSE.devices);
        return Array.from(
          { length: response.count() },
          (_, index) => JSON.parse(response.device(index)) as RemoteDevice,
        );
      },
    );
  }

  async revokeDevice(deviceId: HexId): Promise<void> {
    await this.exchange(
      (channel) => channel.revokeDevice(hexToBytes(deviceId, 16)),
      (response) => {
        requireKind(response, RESPONSE.deviceRevoked);
      },
    );
  }

  async beginUpload(
    expectedSize: string,
    expectedHash: HexId,
  ): Promise<{ readonly uploadId: HexId; readonly offset: string }> {
    return this.exchange(
      (channel) =>
        channel.beginUpload(expectedSize, hexToBytes(expectedHash, 32)),
      (response) => {
        requireKind(response, RESPONSE.uploadReady);
        return {
          uploadId: fixedHex(response.id(), 16),
          offset: response.offset(),
        };
      },
    );
  }

  async uploadChunk(
    uploadId: HexId,
    offset: string,
    chunk: Uint8Array,
  ): Promise<string> {
    return this.exchange(
      (channel) =>
        channel.uploadChunk(hexToBytes(uploadId, 16), offset, chunk),
      (response) => {
        requireKind(response, RESPONSE.chunkAccepted);
        return response.offset();
      },
    );
  }

  async commitUpload(uploadId: HexId): Promise<HexId> {
    return this.exchange(
      (channel) => channel.commitUpload(hexToBytes(uploadId, 16)),
      (response) => {
        requireKind(response, RESPONSE.uploadCommitted);
        return fixedHex(response.id(), 32);
      },
    );
  }

  async putCommit(
    signedCommit: Uint8Array,
  ): Promise<{ readonly commitId: HexId; readonly heads: readonly HexId[] }> {
    return this.exchange(
      (channel) => channel.putCommit(signedCommit),
      (response) => {
        requireKind(response, RESPONSE.commitStored);
        return {
          commitId: fixedHex(response.id(), 32),
          heads: splitFixedHex(response.headsFlat(), 32),
        };
      },
    );
  }

  async getHeads(): Promise<readonly HexId[]> {
    return this.exchange(
      (channel) => channel.getHeads(),
      (response) => {
        requireKind(response, RESPONSE.heads);
        return splitFixedHex(response.headsFlat(), 32);
      },
    );
  }

  async getChanges(knownCommitIds: readonly HexId[]): Promise<ChangePage> {
    return this.exchange(
      (channel) =>
        channel.getChanges(flattenFixedHex(knownCommitIds, 32), MAX_CHANGE_PAGE),
      (response) => {
        requireKind(response, RESPONSE.changes);
        return {
          signedCommits: Array.from(
            { length: response.count() },
            (_, index) => response.commit(index),
          ),
          hasMore: response.flag(),
        };
      },
    );
  }

  async getCommit(commitId: HexId): Promise<Uint8Array> {
    return this.exchange(
      (channel) => channel.getCommit(hexToBytes(commitId, 32)),
      (response) => {
        requireKind(response, RESPONSE.commitRecord);
        return response.bytes();
      },
    );
  }

  async getBlob(blobId: HexId): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let offset = 0n;
    let total: bigint | undefined;
    while (total === undefined || offset < total) {
      const result = await this.exchange(
        (channel) =>
          channel.getBlob(
            hexToBytes(blobId, 32),
            offset.toString(),
            MAX_BLOB_CHUNK_BYTES,
          ),
        (response) => {
          requireKind(response, RESPONSE.blobChunk);
          return {
            offset: BigInt(response.offset()),
            total: BigInt(response.total()),
            complete: response.flag(),
            chunk: response.bytes(),
          };
        },
      );
      if (result.offset !== offset || (total !== undefined && result.total !== total)) {
        this.close();
        throw new Error("server returned an inconsistent blob range");
      }
      total = result.total;
      chunks.push(result.chunk);
      offset += BigInt(result.chunk.length);
      if (result.complete) {
        break;
      }
      if (result.chunk.length === 0 || offset > total) {
        this.close();
        throw new Error("server returned an invalid blob range");
      }
    }
    if (total === undefined || offset !== total || total > BigInt(Number.MAX_SAFE_INTEGER)) {
      this.close();
      throw new Error("server returned an invalid blob length");
    }
    const output = new Uint8Array(Number(total));
    let cursor = 0;
    for (const chunk of chunks) {
      output.set(chunk, cursor);
      cursor += chunk.length;
    }
    return output;
  }

  async ping(): Promise<void> {
    await this.exchange(
      (channel) => channel.ping(),
      (response) => {
        requireKind(response, RESPONSE.pong);
      },
    );
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.channel.free();
    }
  }

  private async exchange<T>(
    build: (channel: WasmClientChannel) => Uint8Array,
    interpret: (response: WasmResponse) => T,
  ): Promise<T> {
    if (this.closed) {
      throw new Error("encrypted session is closed");
    }
    let response: WasmResponse | undefined;
    try {
      const request = build(this.channel);
      response = this.channel.response(await this.http.envelope(request));
      return interpret(response);
    } catch (error) {
      this.close();
      throw error;
    } finally {
      response?.free();
    }
  }
}

export class EncryptedProtocolError extends Error {
  constructor(readonly code: number) {
    super(`server rejected the encrypted operation (code ${code.toString()})`);
    this.name = "EncryptedProtocolError";
  }
}

function requireKind(response: WasmResponse, expected: number): void {
  if (response.kind() === RESPONSE.error) {
    throw new EncryptedProtocolError(response.errorCode());
  }
  if (response.kind() !== expected) {
    throw new Error("server returned an unexpected encrypted response");
  }
}

function fixedHex(bytes: Uint8Array, length: number): HexId {
  if (bytes.length !== length) {
    throw new Error("server returned an identifier with invalid length");
  }
  return bytesToHex(bytes);
}

function splitFixedHex(bytes: Uint8Array, length: number): HexId[] {
  if (!bytes.length || bytes.length % length !== 0) {
    return bytes.length === 0
      ? []
      : (() => {
        throw new Error("server returned a malformed identifier list");
      })();
  }
  const values: HexId[] = [];
  for (let index = 0; index < bytes.length; index += length) {
    values.push(bytesToHex(bytes.slice(index, index + length)));
  }
  return values;
}

function flattenFixedHex(values: readonly HexId[], length: number): Uint8Array {
  const output = new Uint8Array(values.length * length);
  values.forEach((value, index) => {
    output.set(hexToBytes(value, length), index * length);
  });
  return output;
}
