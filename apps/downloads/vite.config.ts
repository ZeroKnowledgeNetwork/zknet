/// <reference types='vitest' />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Pages' _headers: nothing loads from anywhere but this origin, except the
// release files the page reads from VITE_DOWNLOADS_BASE's origin.
function headers(downloadsBase: string): Plugin {
  const connect = ["'self'", ...(downloadsBase ? [new URL(downloadsBase).origin] : [])].join(" ");
  const csp = [
    "default-src 'self'",
    `connect-src ${connect}`,
    "img-src 'self'",
    "font-src 'self'",
    "style-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    name: "downloads-headers",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: [
          "/*",
          `  Content-Security-Policy: ${csp}`,
          "  Referrer-Policy: no-referrer",
          "  X-Content-Type-Options: nosniff",
          "  Permissions-Policy: browsing-topics=()",
          "/downloads/*",
          "  Cache-Control: public, max-age=60",
          "",
        ].join("\n"),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "VITE_");
  return {
    plugins: [react(), tailwindcss(), headers((env.VITE_DOWNLOADS_BASE ?? "").trim())],
    server: { port: 3003 },
    test: {
      name: "@zknet/downloads",
      watch: false,
      globals: true,
      environment: "node",
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      reporters: ["default"],
    },
  };
});
