// The desktop client's backend, faked: what the Tauri commands answer in the
// screenshots. The data is typed against the client's own types, so a change to
// the backend contract breaks the typecheck rather than rendering a blank screen.
import type {
  Listing,
  NetworkRow,
  NetworkServices,
  Prepared,
  ZKNetClientCfg,
} from "../../../apps/client/src/utils/index.ts";
import tauriConf from "../../../apps/client/src-tauri/tauri.conf.json" with { type: "json" };

// "audit": every state the UI can show, for the contrast check · "guide": what a
// new user sees, modelled on the live network and the shipped settings
export type Scenario = "audit" | "guide";

// "normal": everything answers · "connecting": the network fetch never settles ·
// "fetch-error": the network fetch is rejected as not published
export type Mode = "normal" | "connecting" | "fetch-error";

const SOURCE = "https://dist.zknet.io/networks";
const HOUR = 3600e3;

const row = (
  id: string,
  name: string,
  kind: string,
  status: NetworkRow["status"],
  hours: number,
  source: string,
  sourceLabel: string | null,
  now: number,
): NetworkRow => ({
  id,
  status,
  entry: { id, kind, name, created: new Date(now - hours * HOUR).toISOString() },
  source,
  sourceLabel,
  createdAgo: hours < 24 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`,
});

// Two live networks, one only on this device because its source is unreachable,
// and one no longer published: every status the table shows
export const listing = (now = Date.now()): Listing => ({
  launchSource: SOURCE,
  launchLabel: null,
  networks: [
    row("zknet-testnet-7", "ZKNet Testnet", "testnet", "ready", 11, SOURCE, null, now),
    row("zknet-devnet-3", "ZKNet Devnet", "devnet", "available", 52, SOURCE, null, now),
    {
      ...row(
        "lab-net-2",
        "Lab Net 2",
        "devnet",
        "cached",
        140,
        "https://lab.example.org/networks",
        "lab.example.org",
        now,
      ),
      entry: null,
      createdAgo: null,
    },
    {
      ...row(
        "zknet-testnet-5",
        "ZKNet Testnet 5",
        "testnet",
        "unpublished",
        600,
        SOURCE,
        null,
        now,
      ),
      entry: null,
      createdAgo: null,
    },
  ],
  unreachable: [
    {
      source: "https://lab.example.org/networks",
      sourceLabel: "lab.example.org",
      error: "connection timed out",
    },
  ],
  defaultId: "zknet-testnet-7",
});

export const cfg: ZKNetClientCfg = {
  apiListenAddress: ":7072",
  defaultWalletshieldListenAddress: ":7071",
  urlNetwork: SOURCE,
  walletshieldLogLevel: "INFO",
  updater: true,
};

export const services: NetworkServices = {
  RPCEndpoints: [
    {
      chain: "Ethereum",
      network: "mainnet",
      chainId: 1,
      rpcPath: "/eth/mainnet",
      isTestnet: false,
    },
    {
      chain: "Ethereum",
      network: "sepolia",
      chainId: 11155111,
      rpcPath: "/eth/sepolia",
      isTestnet: true,
    },
    {
      chain: "Base",
      network: "mainnet",
      chainId: 8453,
      rpcPath: "/base/mainnet",
      isTestnet: false,
    },
    { chain: "Arbitrum", network: "one", chainId: 42161, rpcPath: "/arb/one", isTestnet: false },
    {
      chain: "Bitcoin",
      network: "mainnet",
      chainId: null,
      rpcPath: "/btc/mainnet",
      isTestnet: false,
    },
  ],
};

export const prepared = (networkId: string): Prepared => ({
  dir: `/home/user/.local/share/zknet/networks/${networkId}`,
  source: SOURCE,
  sourceLabel: null,
  build: "a1b2c3d",
});

export type Backend = {
  mode: Mode;
  version: string; // the app's, shown in the footer
  listing: Listing;
  cfg: ZKNetClientCfg;
  services: NetworkServices;
  prepared: Prepared; // for the default network; `dir` is rewritten per network id
};

// The guide's network is the one live on 2026-11-12, as `zknet list` showed it
// before its first connect; the shots are regenerated when the network changes
const GUIDE_NETWORK = {
  id: "devnet-78c3fdc8",
  name: "Devnet · 2026-11-04",
  kind: "devnet",
  created: "2026-11-04T08:26:08Z",
};

export const guideListing = (now = Date.now()): Listing => {
  const { id, name, kind, created } = GUIDE_NETWORK;
  // whole days, as the client writes CREATED
  const days = Math.floor((now - Date.parse(created)) / (24 * HOUR));
  return {
    launchSource: SOURCE,
    launchLabel: null,
    networks: [
      {
        id,
        status: "available",
        entry: { id, kind, name, created },
        source: SOURCE,
        sourceLabel: null,
        createdAgo: `${days} days ago`,
      },
    ],
    unreachable: [],
    defaultId: id,
  };
};

// The shipped settings: WalletShield's port is the one a user will type into a wallet
export const guideCfg: ZKNetClientCfg = tauriConf.plugins.zknet;

// What that network's services.json lists
export const guideServices: NetworkServices = {
  RPCEndpoints: [
    { chain: "Ethereum", network: "Mainnet", chainId: 1, rpcPath: "/ethereum", isTestnet: false },
    { chain: "Polygon", network: "Mainnet", chainId: 137, rpcPath: "/polygon", isTestnet: false },
    { chain: "BSC", network: "Mainnet", chainId: 56, rpcPath: "/bsc", isTestnet: false },
  ],
};

export const backend = (mode: Mode, scenario: Scenario = "audit"): Backend => {
  if (scenario === "guide") {
    const l = guideListing();
    return {
      mode,
      version: "0.2.0-beta.1",
      listing: l,
      cfg: guideCfg,
      services: guideServices,
      prepared: { ...prepared(GUIDE_NETWORK.id), build: "client@0.2.0-beta.6" },
    };
  }
  const l = listing();
  return {
    mode,
    version: "0.1.0",
    listing: l,
    cfg,
    services,
    prepared: prepared(l.defaultId ?? ""),
  };
};

// Installs the fake backend in the page, before its scripts run. Playwright
// serializes this function into the page, so it must not reach anything outside
// its own body.
export function installBackend(b: Backend) {
  const callbacks = new Map<number, (payload: unknown) => void>();
  let nextId = 1;
  const store: Record<string, unknown> = {};
  type Args = Record<string, any>;
  const handlers: Record<string, (a: Args) => unknown> = {
    "plugin:app|name": () => "ZKNetwork Client",
    "plugin:app|version": () => b.version,
    platform: () => "linux-x64",
    cfg: () => b.cfg,
    networks_list: () => b.listing,
    network_fetch: (a) => {
      if (b.mode === "connecting") return new Promise(() => {});
      if (b.mode === "fetch-error")
        return Promise.reject({ kind: "notFound", message: "not found" });
      return { ...b.prepared, dir: b.prepared.dir.replace(/[^/]*$/, a.networkId) };
    },
    walletshield_spawn: () => ({
      scope: "walletshield",
      args: ["-listen", b.cfg.defaultWalletshieldListenAddress],
    }),
    "plugin:shell|spawn": () => 4242,
    "plugin:fs|read_text_file": () => new TextEncoder().encode(JSON.stringify(b.services)),
    "plugin:path|join": (a) => (a.paths || []).join("/"),
    "plugin:path|resolve_directory": () => "/home/user/.local/share/zknet",
    "plugin:updater|check": () => null,
    "plugin:clipboard-manager|write_text": () => null,
    "plugin:store|load": () => 1,
    "plugin:store|get_store": () => 1,
    "plugin:store|get": (a) => [store[a.key] ?? null, a.key in store],
    "plugin:store|set": (a) => {
      store[a.key] = a.value;
      return null;
    },
    "plugin:store|save": () => null,
    "plugin:event|listen": () => nextId++,
    "plugin:event|unlisten": () => null,
    "plugin:log|log": () => null,
  };
  const w = window as any;
  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    transformCallback(cb: ((p: unknown) => void) | undefined, once: boolean) {
      const id = nextId++;
      callbacks.set(id, (p) => {
        if (once) callbacks.delete(id);
        cb?.(p);
      });
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc: (p: string) => p,
    async invoke(cmd: string, args: Args = {}) {
      const h = handlers[cmd];
      if (!h) {
        console.warn("[ui-shots] unhandled invoke", cmd);
        return null;
      }
      // a Channel's messages arrive through its callback: the walletshield binary is cached
      if (cmd === "network_fetch" && args.onEvent && b.mode === "normal")
        callbacks.get(args.onEvent.id)?.({
          index: 0,
          message: { event: "cached", data: { asset: "walletshield" } },
        });
      return h(args);
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  w.__TAURI_OS_PLUGIN_INTERNALS__ = {
    eol: "\n",
    platform: "linux",
    version: "6.8.0",
    family: "unix",
    os_type: "linux",
    arch: "x86_64",
    exe_extension: "",
  };
}
