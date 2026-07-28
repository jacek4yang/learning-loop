import esbuild from "esbuild";
import { copyFile } from "node:fs/promises";

const production = process.argv[2] === "production";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "browser",
  target: "es2022",
  define: {
    "import.meta.url": "undefined",
  },
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  outfile: "main.js",
});

await copyFile(
  "../wasm/ll-client-core/pkg/ll_client_core_bg.wasm",
  "core.wasm",
);
