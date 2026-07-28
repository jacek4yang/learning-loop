import { requestUrl } from "obsidian";

import { TRANSPORT_PROBE, probeMatches } from "./probe";

export interface TransportCheck {
  readonly ok: boolean;
  readonly status: number;
  readonly bytes: number;
  readonly detail: string;
}

export async function runTransportCheck(endpoint: string): Promise<TransportCheck> {
  const response = await requestUrl({
    url: endpoint,
    method: "POST",
    contentType: "application/octet-stream",
    body: TRANSPORT_PROBE.buffer.slice(0),
    throw: false,
  });
  const bytes = response.arrayBuffer.byteLength;
  const matches = response.status === 200 && probeMatches(response.arrayBuffer);

  return {
    ok: matches,
    status: response.status,
    bytes,
    detail: matches
      ? "Binary request and response matched exactly."
      : "The endpoint did not return the exact binary probe.",
  };
}
