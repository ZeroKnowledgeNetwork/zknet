import { useEffect, useState } from 'react';
import * as log from '@tauri-apps/plugin-log';
import { Child, Command } from '@tauri-apps/plugin-shell';
import { NetworkTable } from '../components';
import { useStore } from '../store';
import { notifyAPIClientsOfStatusChange } from '../services/api';
import {
  CmdError,
  FetchEvent,
  autoFillId,
  fetchNetwork,
  getWalletshieldListenAddress,
  getZKNetClientCfg,
  listNetworks,
} from '../utils';
import { walletshieldSpawn } from '../utils/walletshield';

// A rejected command carries a CmdError; anything else is shown as is.
const errorText = (error: unknown) =>
  typeof error === 'object' && error !== null && 'message' in error
    ? (error as CmdError).message
    : `${error}`;

export function Networks() {
  const [networkId, setNetworkId] = useState('');
  const [reloading, setReloading] = useState(false);

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
    setReloading(true);
    try {
      setNetworks(await listNetworks());
    } catch (error: unknown) {
      log.error(errorText(error));
    } finally {
      setReloading(false);
    }
  }

  // nothing chosen yet: fill in the newest live network, the list's top row
  useEffect(() => {
    const id = autoFillId(networks, networkId);
    if (id) setNetworkId(id);
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
    const { walletshieldLogLevel } = await getZKNetClientCfg();

    ////////////////////////////////////////////////////////////////////////
    // make the network ready at its own source (zknet_core::network::prepare)
    ////////////////////////////////////////////////////////////////////////
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
    const prepared = await fetchNetwork(networkId, false, onEvent).catch((error: CmdError) => {
      log.warn(`network fetch: ${error.kind}: ${error.message}`);
      throw new Error(
        error.kind === 'notFound' ? `Network ${networkId} is not published` : error.message,
      );
    });
    const dirNetwork = prepared.dir;
    if (prepared.sourceLabel && prepared.source !== networks.launchSource) {
      consoleAddLine(`${networkId} is published at ${prepared.sourceLabel}`);
    }
    consoleAddLine(
      prepared.build
        ? `Network client verified: build ${prepared.build}`
        : 'Network client UNSIGNED: accepted for a local source in a dev build',
    );

    ////////////////////////////////////////////////////////////////////////
    // execute the walletshield client with the client.toml
    ////////////////////////////////////////////////////////////////////////
    setMessage('info', 'Starting network client...');
    const cmd = 'walletshield';
    const wla = await getWalletshieldListenAddress();
    const { scope, args } = walletshieldSpawn(wla, walletshieldLogLevel);
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
            <NetworkTable
              listing={networks}
              selected={networkId}
              loading={reloading}
              onSelect={setNetworkId}
              onReload={refreshNetworks}
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
