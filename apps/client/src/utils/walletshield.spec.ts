import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const tauri = join(import.meta.dirname, "../../src-tauri");
const readJson = (file: string) => JSON.parse(readFileSync(join(tauri, file), "utf8"));

type Arg = string | { validator: string };
type SpawnScope = { name: string; cmd: string; args: Arg[] };
type Permission = string | { identifier: string; allow?: unknown[] };
type Capability = { identifier: string; permissions: Permission[] };
type Config = { app?: { security?: { capabilities?: (string | Capability)[] } } };

// Without a configured list, a build enables every capability file.
const capabilityFiles: Capability[] = readdirSync(join(tauri, "capabilities")).map((f) =>
  readJson(join("capabilities", f)),
);
const shipped = readJson("tauri.conf.json");
const devLocal = readJson("tauri.dev-local.conf.json");

const enabledCapabilities = (config?: Config): Capability[] => {
  const listed = config?.app?.security?.capabilities;
  return listed
    ? listed.map((c) => {
        if (typeof c !== "string") return c;
        const file = capabilityFiles.find((f) => f.identifier === c);
        if (!file) throw new Error(`capability ${c} not found`);
        return file;
      })
    : capabilityFiles;
};

const spawnScopes = (capabilities: Capability[]) =>
  capabilities
    .toSorted((a, b) => a.identifier.localeCompare(b.identifier))
    .flatMap((c) => c.permissions)
    .flatMap((p) =>
      typeof p === "object" && p.identifier === "shell:allow-spawn"
        ? (p.allow as SpawnScope[])
        : [],
    );

// The arguments are built in Rust (zknet_client_core::walletshield); the
// desktop's walletshield.rs tests that they fit this scope's template, listen
// address then log level. Here: the values the config supplies pass its
// validators, as tauri-plugin-shell 2.x checks them (`Scope::_prepare`: the
// first scope with a matching name wins).
const SCOPE = "walletshield-listen";

const validators = (scopes: SpawnScope[]) => {
  const scope = scopes.find((s) => s.name === SCOPE);
  if (!scope) throw new Error(`no shell scope named ${SCOPE}`);
  const [listen, logLevel] = scope.args
    .filter((a): a is { validator: string } => typeof a !== "string")
    .map((a) => new RegExp(`^${a.validator}$`));
  return { listen, logLevel };
};

describe("walletshield spawn", () => {
  it.each([
    ["production", shipped],
    ["dev-local", devLocal],
  ])("%s spawns with values its scope accepts", (_, config) => {
    const logLevel = { ...shipped.plugins.zknet, ...config.plugins.zknet }.walletshieldLogLevel;
    const v = validators(spawnScopes(enabledCapabilities(config)));
    expect(v.logLevel.test(logLevel)).toBe(true);
    for (const listen of [
      "127.0.0.1:7070",
      ":7070",
      shipped.plugins.zknet.defaultWalletshieldListenAddress,
    ]) {
      expect(v.listen.test(listen)).toBe(true);
    }
  });

  it("runs shipped clients at INFO and the dev-local app at DEBUG", () => {
    expect(shipped.plugins.zknet.walletshieldLogLevel).toBe("INFO");
    expect(devLocal.plugins.zknet.walletshieldLogLevel).toBe("DEBUG");
  });

  it.each(["TRACE", "info", "INFO -thin", ""])("rejects the log level %j", (logLevel) => {
    expect(validators(spawnScopes(enabledCapabilities())).logLevel.test(logLevel)).toBe(false);
  });

  // WalletShield picks full or thin mode from the network's config.
  it("never passes -thin, in any build", () => {
    for (const config of [undefined, devLocal]) {
      const templates = spawnScopes(enabledCapabilities(config)).flatMap((s) => s.args);
      expect(templates).not.toContain("-thin");
    }
  });

  it("gives the dev-local app no capability of its own", () => {
    expect(devLocal.app).toBeUndefined();
    expect(Object.keys(devLocal.plugins.zknet).sort()).toEqual([
      "allowUnsigned", // unsigned assets from the loopback source (zknet_client_core gates it)
      "urlNetwork",
      "walletshieldLogLevel",
    ]);
  });

  it("keeps spawn scope names unique, so no scope shadows another", () => {
    const names = spawnScopes(enabledCapabilities()).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// Network assets are fetched in Rust (zknet_client_core::network through the
// network_fetch command), so the webview holds no network or download grant.
describe("network access", () => {
  it("grants no http, upload or chmod access", () => {
    const ids = enabledCapabilities()
      .flatMap((c) => c.permissions)
      .map((p) => (typeof p === "string" ? p : p.identifier));
    expect(ids.filter((id) => /^(http|upload):/.test(id))).toEqual([]);
    expect(ids).not.toContain("shell:allow-execute");
    expect(ids.filter((id) => /^fs:allow-(mkdir|write|exists|read-dir)/.test(id))).toEqual([]);
  });
});
