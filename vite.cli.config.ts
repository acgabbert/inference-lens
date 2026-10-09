import { defineConfig } from "vite";

// Bundles the headless CLI into one self-contained ES module, dependencies
// included, so the container image can run it without the TypeScript sources
// or a node_modules tree. `npm run cli` keeps running the sources directly.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: "packages/cli/src/main.ts",
    outDir: "dist/cli",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "inference-lens.mjs",
        banner: "#!/usr/bin/env node",
      },
    },
  },
  ssr: {
    target: "node",
    noExternal: true,
  },
});
