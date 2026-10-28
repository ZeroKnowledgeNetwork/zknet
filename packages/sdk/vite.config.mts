/// <reference types='vitest' />
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import * as path from "path";

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: "../../node_modules/.vite/packages/sdk",
  plugins: [
    dts({ entryRoot: "src", tsconfigPath: path.join(import.meta.dirname, "tsconfig.lib.json") }),
  ],
  // Library mode: https://vite.dev/guide/build.html#library-mode
  build: {
    outDir: "./dist",
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: "src/index.ts",
      name: "sdk",
      fileName: "index",
      // Keep in step with the package.json exports, which publish ESM only.
      formats: ["es" as const],
    },
    rolldownOptions: {
      // External packages that should not be bundled into the library.
      external: [],
    },
  },
  test: {
    name: "@zknet/sdk",
    watch: false,
    globals: true,
    environment: "node",
    include: ["{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    reporters: ["default"],
  },
}));
