// The on-chain half of the bed, through the specifier project's own tools: a
// local anvil, a content-addressed keccak resolver, and WorkerSpecifier
// deployments pinning bundles by keccak256.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import type { Server } from "node:http";
import { createResolverServer, put, resolverUrl } from "../../specifier/scripts/resolver.mjs";
import { RUN_DIR, SPECIFIER_SCRIPTS } from "./paths.js";

/** A free TCP port on loopback (anvil needs one up front). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

// Asynchronous on purpose: deploy.mjs fetches from the resolver this process serves.
function specifierCli(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [join(SPECIFIER_SCRIPTS, script), ...args],
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${script} ${args.join(" ")} failed:\n${stdout}${stderr}`));
        else resolve(stdout);
      },
    );
  });
}

export interface Chain {
  rpcUrl: string;
  /** Resolver origin, e.g. http://127.0.0.1:PORT */
  resolverOrigin: string;
  /** Store a bundle in the resolver and return its content-addressed URL. */
  serve(bundle: string): Promise<string>;
  /**
   * Deploy a WorkerSpecifier pinning `bundle`, listing `resolvers` (default:
   * its URL on this resolver). `unchecked` skips the pre-deploy resolver check,
   * for specifiers whose resolvers deliberately serve other bytes.
   */
  deploy(bundle: string, opts?: { resolvers?: string[]; unchecked?: boolean }): Promise<string>;
  stop(): Promise<void>;
}

export async function startChain(): Promise<Chain> {
  const port = await freePort();
  await specifierCli("anvil.mjs", ["start", "--port", String(port)]);
  const rpcUrl = `http://127.0.0.1:${port}`;

  mkdirSync(RUN_DIR, { recursive: true });
  const scratch = mkdtempSync(join(RUN_DIR, "chain-"));
  const store = join(scratch, "keccak");
  const resolver: Server = createResolverServer(store);
  await new Promise<void>((r) => resolver.listen(0, "127.0.0.1", () => r()));
  const resolverPort = (resolver.address() as AddressInfo).port;
  let deployments = 0;

  return {
    rpcUrl,
    resolverOrigin: `http://127.0.0.1:${resolverPort}`,
    async serve(bundle) {
      const digest = await put(bundle, store);
      return resolverUrl("127.0.0.1", resolverPort, digest.keccak256);
    },
    async deploy(bundle, opts = {}) {
      const resolvers = opts.resolvers ?? [await this.serve(bundle)];
      // A record directory per deployment: every call deploys a new contract.
      const dir = join(scratch, `deployment-${deployments++}`);
      const args = ["--bundle", bundle, "--rpc-url", rpcUrl, "--deployments", dir];
      for (const r of resolvers) args.push("--resolver", r);
      if (opts.unchecked) args.push("--skip-resolver-check");
      const out = (await specifierCli("deploy.mjs", args)).trim().split("\n");
      const address = out[out.length - 1] ?? "";
      if (!/^0x[0-9a-fA-F]{40}$/.test(address))
        throw new Error(`deploy printed no address:\n${out.join("\n")}`);
      return address;
    },
    async stop() {
      await specifierCli("anvil.mjs", ["stop", "--port", String(port)]);
      await new Promise<void>((r) => resolver.close(() => r()));
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
