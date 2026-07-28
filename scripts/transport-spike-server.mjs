import http from "node:http";
import { pathToFileURL } from "node:url";

const MAX_PROBE_BYTES = 4096;

export function createTransportSpikeServer() {
  return http.createServer((request, response) => {
    if (
      request.method !== "POST" ||
      request.url !== "/v1/transport-spike"
    ) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }

    const chunks = [];
    let received = 0;
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_PROBE_BYTES) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": body.length,
        "content-type": "application/octet-stream",
      });
      response.end(body);
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const server = createTransportSpikeServer();
  server.listen(48633, "127.0.0.1", () => {
    process.stdout.write(
      "Transport spike listening: http://127.0.0.1:48633/v1/transport-spike\n",
    );
  });
}
