import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const protocolLimits = readFileSync(
  new URL("../../crates/ll-protocol/src/limits.rs", import.meta.url),
  "utf8",
);
const sessionSource = readFileSync(
  new URL("../src/transport/session.ts", import.meta.url),
  "utf8",
);

function numericConstant(source: string, name: string): number {
  const match = new RegExp(
    `const ${name}(?:: [^=]+)? = ([0-9_* +]+);`,
    "u",
  ).exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`missing numeric constant ${name}`);
  }
  const factors = match[1].split("*").map((part) =>
    Number(part.trim().replaceAll("_", ""))
  );
  if (factors.some((factor) => !Number.isFinite(factor))) {
    throw new Error(`invalid numeric constant ${name}`);
  }
  return factors.reduce((product, factor) => product * factor, 1);
}

describe("cross-language transport limits", () => {
  it("never asks the Rust server for an oversized blob range", () => {
    expect(numericConstant(sessionSource, "MAX_BLOB_CHUNK_BYTES"))
      .toBeLessThanOrEqual(numericConstant(protocolLimits, "MAX_CHUNK_BYTES"));
  });

  it("never asks the Rust decoder for an oversized changes page", () => {
    expect(numericConstant(sessionSource, "MAX_CHANGE_PAGE"))
      .toBeLessThanOrEqual(
        numericConstant(protocolLimits, "MAX_CHANGES_PER_RESPONSE"),
      );
  });
});
