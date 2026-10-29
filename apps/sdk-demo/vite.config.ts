import { defaultClientConditions, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Resolve workspace packages to their TypeScript source, matching the
    // customConditions entry in the root tsconfig.base.json.
    conditions: ["@zknet/source", ...defaultClientConditions],
  },
  server: {
    port: 3002,
  },
});
