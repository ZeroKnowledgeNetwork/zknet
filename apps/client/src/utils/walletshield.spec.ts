import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walletshieldSpawn } from './walletshield';

const tauri = join(import.meta.dirname, '../../src-tauri');
const readJson = (file: string) => JSON.parse(readFileSync(join(tauri, file), 'utf8'));

type Arg = string | { validator: string };
type SpawnScope = { name: string; cmd: string; args: Arg[] };
type Permission = string | { identifier: string; allow?: unknown[] };
type Capability = { identifier: string; permissions: Permission[] };

// Without a configured list, a build enables every capability file.
const capabilityFiles: Capability[] = readdirSync(join(tauri, 'capabilities')).map((f) =>
  readJson(join('capabilities', f)),
);
const shipped = readJson('tauri.conf.json');
const devLocal = readJson('tauri.dev-local.conf.json');

const enabledCapabilities = (config?: {
  app: { security: { capabilities: (string | Capability)[] } };
}): Capability[] =>
  config
    ? config.app.security.capabilities.map((c) => {
        if (typeof c !== 'string') return c;
        const file = capabilityFiles.find((f) => f.identifier === c);
        if (!file) throw new Error(`capability ${c} not found`);
        return file;
      })
    : capabilityFiles;

const spawnScopes = (capabilities: Capability[]) =>
  capabilities
    .toSorted((a, b) => a.identifier.localeCompare(b.identifier))
    .flatMap((c) => c.permissions)
    .flatMap((p) =>
      typeof p === 'object' && p.identifier === 'shell:allow-spawn'
        ? (p.allow as SpawnScope[])
        : [],
    );

// The argv tauri-plugin-shell 2.x actually executes (`Scope::_prepare`): the
// first scope with a matching name wins, and argv follows its template.
const resolveArgv = (scopes: SpawnScope[], name: string, args: string[]) => {
  const scope = scopes.find((s) => s.name === name);
  if (!scope) throw new Error(`no shell scope named ${name}`);
  return scope.args.map((arg, i) => {
    if (typeof arg === 'string') return arg;
    if (!new RegExp(arg.validator).test(args[i] ?? '')) throw new Error(`argument ${i} rejected`);
    return args[i];
  });
};

describe('walletshield spawn', () => {
  it.each([
    ['production', enabledCapabilities(), false, shipped.plugins.zknet.walletshieldLogLevel],
    ['dev-local', enabledCapabilities(devLocal), true, devLocal.plugins.zknet.walletshieldLogLevel],
  ])('%s executes exactly the arguments the client passes', (_, capabilities, thin, logLevel) => {
    const { scope, args } = walletshieldSpawn('127.0.0.1:7070', thin, logLevel);
    expect(resolveArgv(spawnScopes(capabilities), scope, args)).toEqual(args);
    expect(args.includes('-thin')).toBe(thin);
  });

  it('runs shipped clients at INFO and the dev-local app at DEBUG', () => {
    expect(shipped.plugins.zknet.walletshieldLogLevel).toBe('INFO');
    expect(devLocal.plugins.zknet.walletshieldLogLevel).toBe('DEBUG');
  });

  it.each(['TRACE', 'info', 'INFO -thin', ''])('rejects the log level %j', (logLevel) => {
    for (const [capabilities, thin] of [
      [enabledCapabilities(), false],
      [enabledCapabilities(devLocal), true],
    ] as const) {
      const { scope, args } = walletshieldSpawn(':7070', thin, logLevel);
      expect(() => resolveArgv(spawnScopes(capabilities), scope, args)).toThrow('rejected');
    }
  });

  it('keeps spawn scope names unique, so no scope shadows another', () => {
    const names = spawnScopes(enabledCapabilities(devLocal)).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('adds to every production capability rather than replacing one', () => {
    const ids = enabledCapabilities(devLocal).map((c) => c.identifier);
    expect(ids).toEqual(expect.arrayContaining(capabilityFiles.map((c) => c.identifier)));
  });

  it('keeps the thin scope out of production builds', () => {
    const { scope } = walletshieldSpawn(':7070', true, 'INFO');
    expect(spawnScopes(enabledCapabilities()).some((s) => s.name === scope)).toBe(false);
  });
});

// Network assets are fetched in Rust (zknet_core::network through the
// network_fetch command), so the webview holds no network or download grant.
describe('network access', () => {
  const identifiers = (capabilities: Capability[]) =>
    capabilities
      .flatMap((c) => c.permissions)
      .map((p) => (typeof p === 'string' ? p : p.identifier));

  it.each([
    ['production', enabledCapabilities()],
    ['dev-local', enabledCapabilities(devLocal)],
  ])('%s grants no http, upload or chmod access', (_, capabilities) => {
    const ids = identifiers(capabilities);
    expect(ids.filter((id) => /^(http|upload):/.test(id))).toEqual([]);
    expect(ids).not.toContain('shell:allow-execute');
    expect(ids.filter((id) => /^fs:allow-(mkdir|write|exists|read-dir)/.test(id))).toEqual([]);
  });
});
