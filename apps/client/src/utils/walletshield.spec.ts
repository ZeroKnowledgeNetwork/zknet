import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walletshieldSpawn } from './walletshield';

const tauri = join(import.meta.dirname, '../../src-tauri');
const readJson = (file: string) => JSON.parse(readFileSync(join(tauri, file), 'utf8'));

type Arg = string | { validator: string };
type SpawnScope = { name: string; cmd: string; args: Arg[] };
type Permission = string | { identifier: string; allow?: unknown[] };
type Capability = { identifier: string; permissions: Permission[] };
type Config = { app?: { security?: { capabilities?: (string | Capability)[] } } };

// Without a configured list, a build enables every capability file.
const capabilityFiles: Capability[] = readdirSync(join(tauri, 'capabilities')).map((f) =>
  readJson(join('capabilities', f)),
);
const shipped = readJson('tauri.conf.json');
const devLocal = readJson('tauri.dev-local.conf.json');

const enabledCapabilities = (config?: Config): Capability[] => {
  const listed = config?.app?.security?.capabilities;
  return listed
    ? listed.map((c) => {
        if (typeof c !== 'string') return c;
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
    ['production', shipped],
    ['dev-local', devLocal],
  ])('%s executes exactly the arguments the client passes', (_, config) => {
    const logLevel = { ...shipped.plugins.zknet, ...config.plugins.zknet }.walletshieldLogLevel;
    const { scope, args } = walletshieldSpawn('127.0.0.1:7070', logLevel);
    expect(resolveArgv(spawnScopes(enabledCapabilities(config)), scope, args)).toEqual(args);
  });

  it('runs shipped clients at INFO and the dev-local app at DEBUG', () => {
    expect(shipped.plugins.zknet.walletshieldLogLevel).toBe('INFO');
    expect(devLocal.plugins.zknet.walletshieldLogLevel).toBe('DEBUG');
  });

  it.each(['TRACE', 'info', 'INFO -thin', ''])('rejects the log level %j', (logLevel) => {
    const { scope, args } = walletshieldSpawn(':7070', logLevel);
    expect(() => resolveArgv(spawnScopes(enabledCapabilities()), scope, args)).toThrow('rejected');
  });

  // WalletShield picks full or thin mode from the network's config.
  it('never passes -thin, in any build', () => {
    expect(walletshieldSpawn(':7070', 'INFO').args).not.toContain('-thin');
    for (const config of [undefined, devLocal]) {
      const templates = spawnScopes(enabledCapabilities(config)).flatMap((s) => s.args);
      expect(templates).not.toContain('-thin');
    }
  });

  it('gives the dev-local app no capability of its own', () => {
    expect(devLocal.app).toBeUndefined();
    expect(Object.keys(devLocal.plugins.zknet).sort()).toEqual([
      'allowUnsigned', // unsigned assets from the loopback source (zknet_core gates it)
      'urlNetwork',
      'walletshieldLogLevel',
    ]);
  });

  it('keeps spawn scope names unique, so no scope shadows another', () => {
    const names = spawnScopes(enabledCapabilities()).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// Network assets are fetched in Rust (zknet_core::network through the
// network_fetch command), so the webview holds no network or download grant.
describe('network access', () => {
  it('grants no http, upload or chmod access', () => {
    const ids = enabledCapabilities()
      .flatMap((c) => c.permissions)
      .map((p) => (typeof p === 'string' ? p : p.identifier));
    expect(ids.filter((id) => /^(http|upload):/.test(id))).toEqual([]);
    expect(ids).not.toContain('shell:allow-execute');
    expect(ids.filter((id) => /^fs:allow-(mkdir|write|exists|read-dir)/.test(id))).toEqual([]);
  });
});
