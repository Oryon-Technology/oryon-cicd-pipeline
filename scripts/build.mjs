import { build } from "esbuild";

await build({
  entryPoints: ["src/action.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/action.cjs",
  sourcemap: false,
  banner: {
    js: "/* Oryon public CI wrapper. No scanner engine, rules, or proprietary analysis code is bundled here. */"
  }
});

