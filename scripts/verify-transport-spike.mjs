import { once } from "node:events";

import { createTransportSpikeServer } from "./transport-spike-server.mjs";

const expected = Uint8Array.from([
  0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff, 0x4c, 0x4c, 0x50, 0x31,
]);
const server = createTransportSpikeServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("transport spike did not bind a TCP port");
  }
  const response = await fetch(
    `http://127.0.0.1:${address.port}/v1/transport-spike`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: expected,
    },
  );
  const actual = new Uint8Array(await response.arrayBuffer());
  const matches =
    response.status === 200 &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
  if (!matches) {
    throw new Error("binary transport spike response did not match");
  }
  process.stdout.write("Binary HTTP transport spike passed.\n");
} finally {
  server.close();
  await once(server, "close");
}
