// Builds the widget (dist/widget) and the server files as plain JS (dist/server).
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: { "review-kit": "widget/src/index.ts" },
  outdir: "dist/widget",
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  target: ["es2020", "safari14"],
  chunkNames: "review-kit-[hash]",
  legalComments: "none",
  logLevel: "info",
});

await build({
  entryPoints: ["server/core.ts", "server/next.ts", "server/node.ts", "server/vercel.ts", "server/netlify.ts", "server/cloudflare.ts"],
  outdir: "dist/server",
  outbase: "server",
  bundle: true,
  format: "esm",
  platform: "neutral",
  external: ["node:*"],
  target: "es2022",
  logLevel: "info",
});
