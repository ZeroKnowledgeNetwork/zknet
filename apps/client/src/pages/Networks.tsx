import { useEffect, useState } from 'react';
import * as log from '@tauri-apps/plugin-log';
import { Child, Command } from '@tauri-apps/plugin-shell';
import { useStore } from '../store';
import { notifyAPIClientsOfStatusChange } from '../services/api';
import {
  CmdError,
  FetchEvent,
  NetworkEntry,
  fetchNetwork,
  getWalletshieldListenAddress,
  getZKNetClientCfg,
  listNetworks,
} from '../utils';
import { walletshieldSpawn } from '../utils/walletshield';

const isLive = (n: NetworkEntry) => n.status === 'ready' || n.status === 'available';

// A rejected command carries a CmdError; anything else is shown as is.
const errorText = (error: unknown) =>
  typeof error === 'object' && error !== null && 'message' in error
    ? (error as CmdError).message
    : `${error}`;

// "3 hours ago" for an RFC 3339 time
const age = (created: string) => {
  const minutes = Math.round((Date.now() - Date.parse(created)) / 60000);
  if (Number.isNaN(minutes)) return '';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, 'minute');
  if (Math.abs(minutes) < 60 * 24) return rtf.format(-Math.round(minutes / 60), 'hour');
  return rtf.format(-Math.round(minutes / 60 / 24), 'day');
};

export function Networks() {
  const [networkId, setNetworkId] = useState('');

  const clientPid = useStore((s) => s.clientPid);
  const isConnected = useStore((s) => s.isConnected);
  const isPlatformSupported = useStore((s) => s.isPlatformSupported);
  const networkConnected = useStore((s) => s.networkConnected);
  const networks = useStore((s) => s.networks);
  const platformArch = useStore((s) => s.platformArch);

  const consoleAddLine = useStore((s) => s.consoleAddLine);
  const setClientPid = useStore((s) => s.setClientPid);
  const setIsConnected = useStore((s) => s.setIsConnected);
  const setIsStopping = useStore((s) => s.setIsStopping);
  const setMessage = useStore((s) => s.setMessage);
  const setNetworkConnected = useStore((s) => s.setNetworkConnected);
  const setNetworks = useStore((s) => s.setNetworks);

  async function connect() {
    try {
      consoleAddLine(`Connecting to network: ${networkId}`);
      const pid = await clientStart();
      setClientPid(pid);
      setMessage('info', '');
      setIsConnected(true);
      setNetworkConnected(networkId);
      notifyAPIClientsOfStatusChange();
    } catch (error: unknown) {
      log.error(errorText(error));
      setMessage('error', errorText(error));
      consoleAddLine(errorText(error));
    }
    refreshNetworks();
  }

  async function refreshNetworks() {
    try {
      setNetworks(await listNetworks());
    } catch (error: unknown) {
      log.error(errorText(error));
    }
  }

  // with exactly one live network and nothing chosen yet, choose it
  useEffect(() => {
    const live = networks.networks.filter((n) => isLive(n));
    if (networkId === '' && live.length === 1) setNetworkId(live[0].id);
  }, [networks]);

  async function disconnect() {
    try {
      setIsStopping(true);
      await clientStop();
      setMessage('info', 'Disconnected from Network');
    } catch (error: any) {
      log.error(`${error}`);
      setMessage('error', `${error}`);
    }
  }

  async function clientStop() {
    if (clientPid > 0) {
      const c = new Child(clientPid);
      c.kill();
    }
  }

  async function clientStart() {
    const { walletshieldLogLevel, walletshieldThin } = await getZKNetClientCfg();

    ////////////////////////////////////////////////////////////////////////
    // ensure the network's assets are on disk (zknet_core::network)
    ////////////////////////////////////////////////////////////////////////
    // A thin-mode network is a local development build: its binary changes with
    // every rebuild, so a cached copy would be stale.
    setMessage('info', 'Checking network...');
    let percent = -1;
    const onEvent = (e: FetchEvent) => {
      if (e.data.asset !== 'walletshield') return;
      if (e.event === 'cached') setMessage('info', 'Using the cached network client');
      if (e.event === 'started') setMessage('info', 'Downloading network client...');
      if (e.event === 'progress' && e.data.progress.total > 0) {
        const { progressTotal, total } = e.data.progress;
        const p = Math.floor((progressTotal / total) * 100);
        if (p !== percent) {
          percent = p;
          setMessage('info', `Downloading client... ${p}%`);
        }
      }
      if (e.event === 'finished') setMessage('info', `Downloaded client for OS: ${platformArch}`);
    };
    const dirNetwork = await fetchNetwork(networkId, walletshieldThin, onEvent).catch(
      (error: CmdError) => {
        log.warn(`network fetch: ${error.kind}: ${error.message}`);
        throw new Error(
          error.kind === 'notFound' ? `Network ${networkId} is not published` : error.message,
        );
      },
    );

    ////////////////////////////////////////////////////////////////////////
    // execute the walletshield client with the client.toml
    ////////////////////////////////////////////////////////////////////////
    setMessage('info', 'Starting network client...');
    const cmd = 'walletshield';
    const wla = await getWalletshieldListenAddress();
    const { scope, args } = walletshieldSpawn(wla, walletshieldThin, walletshieldLogLevel);
    const command = Command.create(scope, args, {
      cwd: dirNetwork,
      env: {
        PATH: dirNetwork,
      },
    });
    const o = (d: string) => `${d.trim()}`;
    log.debug(`spawning command: ${cmd} ${args.join(' ')}`);

    command.on('close', (data) => {
      log.debug(`closed: ${cmd} code=${data.code} signal=${data.signal}`);
      const isStopping = useStore.getState().isStopping;
      if (isStopping !== true) {
        setMessage('error', 'Error: Network connection failed.');
        consoleAddLine(`Network connection failed: ${networkId}`);
      }
      consoleAddLine(`Disconnected from network: ${networkId}`);
      setClientPid(0);
      setIsConnected(false);
      setIsStopping(false);
      setNetworkConnected('');
      notifyAPIClientsOfStatusChange();
      refreshNetworks();
    });

    command.on('error', (e) => log.error(o(e)));

    command.stdout.on('data', (d) => {
      log.info(o(d));
      if (d.match(/client2/) === null) consoleAddLine(o(d));
    });

    command.stderr.on('data', (d) => {
      log.error(o(d));
      if (d.match(/client2/) === null) consoleAddLine(o(d));
    });

    const child = await command.spawn();
    return child.pid;
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4">
      <img
        src="/zkn.svg"
        alt="ZKN"
        onClick={() => isConnected && disconnect()}
        className={`logo ${isConnected ? 'pulsing' : ''}`}
      />

      {isPlatformSupported &&
        (clientPid === 0 ? (
          <>
            <p>Choose a network, or enter its identifier.</p>
            <form
              className="join"
              onSubmit={(e) => {
                e.preventDefault();
                connect();

                // blur the input field to clear visual artifact
                e.currentTarget.querySelector('input')?.blur();
              }}
            >
              <input
                className="input validator focus:outline-none join-item"
                onChange={(e) => setNetworkId(e.currentTarget.value)}
                value={networkId}
                placeholder="Enter a network id..."
                maxLength={64}
                pattern="[a-z0-9][a-z0-9._\-]*"
                title="lowercase letters, digits, '.', '_' and '-'"
                required
              />
              <button className="btn btn-primary join-item" type="submit">
                Connect
              </button>
            </form>
            <NetworkPicker
              entries={networks.networks}
              indexError={networks.indexError}
              selected={networkId}
              onSelect={setNetworkId}
              onRefresh={refreshNetworks}
            />
          </>
        ) : (
          <>
            <p className="text-lg font-bold">Connected Network: {networkConnected}</p>
            <button onClick={disconnect} className="btn btn-secondary">
              Disconnect
            </button>
          </>
        ))}
    </div>
  );
}

function NetworkPicker(props: {
  entries: NetworkEntry[];
  indexError: string | null;
  selected: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  const live = props.entries.filter(isLive);
  const local = props.entries.filter((n) => !isLive(n));
  const row = (n: NetworkEntry) => (
    <li key={n.id}>
      <button
        type="button"
        className={`flex justify-between ${props.selected === n.id ? 'menu-active' : ''} ${isLive(n) ? '' : 'opacity-60'}`}
        onClick={() => props.onSelect(n.id)}
      >
        <span>
          {n.entry?.name ?? n.id}
          {n.entry && n.entry.name !== n.id && (
            <span className="ml-2 text-xs opacity-60">{n.id}</span>
          )}
        </span>
        <span className="text-xs opacity-60">
          {isLive(n) && n.entry ? age(n.entry.created) : 'not listed — may be retired'}
          {n.status === 'ready' && <span className="badge badge-xs ml-2">cached</span>}
        </span>
      </button>
    </li>
  );

  return (
    <div className="w-full max-w-md">
      {props.indexError && (
        <p className="text-xs opacity-70 mb-2" title={props.indexError}>
          Couldn't load the network list — showing networks on this device.
        </p>
      )}
      <ul className="menu w-full bg-base-200 rounded-box">
        <li className="menu-title flex flex-row justify-between items-center">
          <span>Live networks</span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={props.onRefresh}
            title="Reload the network list"
          >
            ↻
          </button>
        </li>
        {live.length > 0 ? live.map(row) : <li className="disabled px-4 text-xs">None listed</li>}
        {local.length > 0 && <li className="menu-title">On this device</li>}
        {local.map(row)}
      </ul>
    </div>
  );
}
