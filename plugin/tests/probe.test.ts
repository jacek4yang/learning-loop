import { describe, expect, it } from "vitest";

import { TRANSPORT_PROBE, probeMatches } from "../src/spikes/probe";

describe("binary transport probe", () => {
  it("accepts an exact byte-for-byte echo", () => {
    expect(probeMatches(TRANSPORT_PROBE.buffer.slice(0))).toBe(true);
  });

  it("rejects truncation and corruption", () => {
    expect(probeMatches(TRANSPORT_PROBE.slice(0, -1).buffer)).toBe(false);
    const corrupted = TRANSPORT_PROBE.slice();
    corrupted[0] = 0xff;
    expect(probeMatches(corrupted.buffer)).toBe(false);
  });
});
