import { defineConfig } from "vitest/config";

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: "../../node_modules/.vite/packages/ui-shots",
  test: {
    name: "@zknet/ui-shots",
    watch: false,
    environment: "node",
    include: ["src/**/*.spec.ts"],
    reporters: ["default"],
  },
}));
