import { build } from "esbuild";

await build({
  banner: {
    js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
  },
  bundle: true,
  entryPoints: ["src/index.ts"],
  external: ["openclaw", "openclaw/*"],
  format: "esm",
  legalComments: "none",
  outfile: "dist/index.js",
  platform: "node",
  target: "node22",
});
