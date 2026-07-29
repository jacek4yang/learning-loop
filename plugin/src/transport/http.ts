import { requestUrl } from "obsidian";

export const BOOTSTRAP_ROUTE = "/v1/bootstrap";
export const HANDSHAKE_ROUTE = "/v1/handshake";
export const ENVELOPE_ROUTE = "/v1/envelope";

export class FixedRouteHttpTransport {
  constructor(private readonly baseUrl: string) {}

  static fromHostAndPort(host: string, port: number): FixedRouteHttpTransport {
    const normalizedHost = host.trim().toLowerCase();
    if (
      normalizedHost.length === 0
      || normalizedHost.length > 253
      || /[/@?#\s]/u.test(normalizedHost)
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
    ) {
      throw new Error("invalid server host or port");
    }
    const candidate = new URL(`http://${normalizedHost}:${port.toString()}`);
    if (
      candidate.username !== ""
      || candidate.password !== ""
      || candidate.pathname !== "/"
      || candidate.search !== ""
      || candidate.hash !== ""
    ) {
      throw new Error("invalid server host or port");
    }
    return new FixedRouteHttpTransport(candidate.origin);
  }

  async bootstrap(): Promise<Uint8Array> {
    return this.get(BOOTSTRAP_ROUTE);
  }

  async handshake(body: Uint8Array): Promise<Uint8Array> {
    return this.post(HANDSHAKE_ROUTE, body);
  }

  async envelope(body: Uint8Array): Promise<Uint8Array> {
    return this.post(ENVELOPE_ROUTE, body);
  }

  private async get(route: typeof BOOTSTRAP_ROUTE): Promise<Uint8Array> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}${route}`,
        method: "GET",
        throw: false,
      });
      return exactResponse(response.status, response.arrayBuffer);
    } catch (error) {
      if (error instanceof TransportError) {
        throw error;
      }
      throw new TransportError(0);
    }
  }

  private async post(
    route: typeof HANDSHAKE_ROUTE | typeof ENVELOPE_ROUTE,
    body: Uint8Array,
  ): Promise<Uint8Array> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}${route}`,
        method: "POST",
        contentType: "application/octet-stream",
        body: exactArrayBuffer(body),
        throw: false,
      });
      return exactResponse(response.status, response.arrayBuffer);
    } catch (error) {
      if (error instanceof TransportError) {
        throw error;
      }
      throw new TransportError(0);
    }
  }
}

function exactResponse(status: number, body: ArrayBuffer): Uint8Array {
  if (status !== 200 || body.byteLength === 0) {
    throw new TransportError(status);
  }
  return new Uint8Array(body);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export class TransportError extends Error {
  constructor(readonly status: number) {
    super(
      status === 0
        ? "server is unreachable"
        : status === 429
        ? "server rate limit is active"
        : `server returned HTTP ${status.toString()}`,
    );
    this.name = "TransportError";
  }
}
