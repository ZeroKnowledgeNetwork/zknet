import { defineConfig } from "@playwright/test";

// One worker: each spec file owns an anvil, a resolver and port-bound stubs.
export default defineConfig({
  testDir: "tests",
  testMatch: /\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: ".run/test-results",
  reporter: [["list"]],
  use: { browserName: "chromium", headless: true, trace: "retain-on-failure" },
  projects: [
    // `e2e`: the npm-pinned harness, and the egress control. CI-portable.
    { name: "pinned", testMatch: /(harness-pinned|egress)\.spec\.ts$/ },
    // `e2e-fork`: a harness built from ANON_RPC_REPO; skips without it.
    { name: "fork", testMatch: /fork\.spec\.ts$/ },
    // `live`: a real WalletShield over a real mixnet; run by a human.
    { name: "live", testMatch: /live\.spec\.ts$/, timeout: 300_000 },
  ],
});
