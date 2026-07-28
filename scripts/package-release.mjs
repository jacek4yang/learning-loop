import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";

const repository = resolve(import.meta.dirname, "..");
const pluginDirectory = join(repository, "plugin");
const releaseDirectory = join(repository, "release");
const manifest = JSON.parse(
  await readFile(join(pluginDirectory, "manifest.json"), "utf8"),
);
const version = requiredString(manifest.version, "plugin manifest version");
const argumentsByName = parseArguments(process.argv.slice(2));
const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1
      ? 0xedb88320 ^ (value >>> 1)
      : value >>> 1;
  }
  return value >>> 0;
});

await mkdir(releaseDirectory, { recursive: true });

if (argumentsByName.has("--plugin")) {
  await packagePlugin();
}
if (argumentsByName.has("--server")) {
  const binary = requiredArgument(argumentsByName, "--server");
  const target = requiredArgument(argumentsByName, "--target");
  await packageServer(resolve(binary), target);
}
if (!argumentsByName.has("--plugin") && !argumentsByName.has("--server")) {
  throw new Error("select --plugin and/or --server <binary> --target <name>");
}

await writeReleaseChecksums();

async function packagePlugin() {
  const names = [
    "manifest.json",
    "main.js",
    "styles.css",
    "core.wasm",
    "versions.json",
  ];
  const entries = await filesAsEntries(pluginDirectory, names);
  entries.push({
    name: "LICENSE",
    bytes: await readFile(join(repository, "LICENSE")),
  });
  entries.push(checksumEntry(entries));
  const output = join(
    releaseDirectory,
    `learning-loop-plugin-${version}.zip`,
  );
  await writeFile(output, zip(entries));
  console.log(output);
}

async function packageServer(binary, target) {
  const metadata = await stat(binary);
  if (!metadata.isFile()) {
    throw new Error(`server binary is not a file: ${binary}`);
  }
  const executableName = target.startsWith("windows-")
    ? "ll-server.exe"
    : "ll-server";
  const entries = [
    { name: executableName, bytes: await readFile(binary) },
    {
      name: "config.example.toml",
      bytes: await readFile(join(repository, "config.example.toml")),
    },
    {
      name: "README.md",
      bytes: await readFile(join(repository, "crates", "ll-server", "README.md")),
    },
    {
      name: "docs/installation.md",
      bytes: await readFile(join(repository, "docs", "installation.md")),
    },
    {
      name: "docs/operations.md",
      bytes: await readFile(join(repository, "docs", "operations.md")),
    },
    {
      name: "docs/release-validation.md",
      bytes: await readFile(join(repository, "docs", "release-validation.md")),
    },
    { name: "LICENSE", bytes: await readFile(join(repository, "LICENSE")) },
  ];
  entries.push(checksumEntry(entries));
  const output = join(
    releaseDirectory,
    `learning-loop-server-${version}-${safeTarget(target)}.zip`,
  );
  await writeFile(output, zip(entries));
  console.log(output);
}

async function writeReleaseChecksums() {
  const names = (await readdir(releaseDirectory))
    .filter((name) =>
      name !== ".gitkeep"
      && name !== "SHA256SUMS"
      && !name.endsWith(".tmp")
    )
    .sort();
  const entries = [];
  for (const name of names) {
    const path = join(releaseDirectory, name);
    if ((await stat(path)).isFile()) {
      entries.push(`${sha256(await readFile(path))}  ${name}`);
    }
  }
  await writeFile(
    join(releaseDirectory, "SHA256SUMS"),
    `${entries.join("\n")}\n`,
  );
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of [...entries].sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
    const clear = Buffer.from(entry.bytes);
    const compressed = deflateRawSync(clear, { level: 9 });
    const checksum = crc32(clear);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5c21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(clear.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5c21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(clear.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function checksumEntry(entries) {
  const lines = [...entries]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `${sha256(entry.bytes)}  ${entry.name}`);
  return {
    name: "SHA256SUMS",
    bytes: Buffer.from(`${lines.join("\n")}\n`, "utf8"),
  };
}

async function filesAsEntries(directory, names) {
  return Promise.all(
    names.map(async (name) => ({
      name,
      bytes: await readFile(join(directory, name)),
    })),
  );
}

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!name?.startsWith("--")) {
      throw new Error(`unexpected argument: ${name ?? ""}`);
    }
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed.set(name, next);
      index += 1;
    } else {
      parsed.set(name, true);
    }
  }
  return parsed;
}

function requiredArgument(values, name) {
  const value = values.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function safeTarget(value) {
  if (!/^[a-z0-9_-]{1,80}$/u.test(value)) {
    throw new Error("invalid release target name");
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
