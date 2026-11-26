import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.resolve(here, "../custom_components/loyalty_hub/frontend");

// §12.9: old chunks must not pile up (their names carry a content hash).
await rm(path.join(outdir, "chunks"), { recursive: true, force: true });

await build({
  bundle: true,
  format: "esm",
  splitting: true,
  minify: true,
  target: "es2021",
  platform: "browser",
  conditions: ["browser"],
  legalComments: "none",
  logLevel: "info",
  tsconfig: path.join(here, "tsconfig.json"),
  entryPoints: {
    "loyalty-hub-panel": path.join(here, "src/panel.ts"),
    "loyalty-hub-card": path.join(here, "src/card.ts"),
  },
  outdir,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
});
