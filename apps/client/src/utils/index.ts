import { BaseDirectory, readTextFile } from '@tauri-apps/plugin-fs';
import { path } from '@tauri-apps/api';
import { Channel, invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';

// This matches exactly what is in tauri.conf.json:plugins.zknet.
export interface ZKNetClientCfg {
  apiListenAddress: string;
  defaultWalletshieldListenAddress: string;
  urlNetwork: string;
  walletshieldLogLevel: string;
  walletshieldThin: boolean;
  updater: boolean;
}

export const getZKNetClientCfg = async (): Promise<ZKNetClientCfg> => {
  return invoke<ZKNetClientCfg>('cfg');
};

// get the user's preference, or fallback to the default
export const getWalletshieldListenAddress = async (): Promise<string> => {
  const wla = useStore.getState().walletshieldListenAddress;
  if (wla) return wla;
  const cfg = await getZKNetClientCfg();
  return cfg.defaultWalletshieldListenAddress;
};

// The published platform name of this build, e.g. `linux-x64`
export const getPlatform = (): Promise<string> => invoke<string>('platform');

// zknet_core::network, serialized: the network list and the asset fetch
export type NetworkEntry = {
  id: string;
  status: 'ready' | 'available' | 'cached' | 'unlisted' | 'otherSource';
  entry: { id: string; kind: string; name: string; created: string } | null;
};

export type Listing = { networks: NetworkEntry[]; indexError: string | null };

export type Asset = 'clientToml' | 'servicesJson' | 'walletshield';

export type FetchEvent =
  | { event: 'started'; data: { asset: Asset; total: number } }
  | {
      event: 'progress';
      data: {
        asset: Asset;
        progress: { progress: number; progressTotal: number; total: number; transferSpeed: number };
      };
    }
  | { event: 'cached'; data: { asset: Asset } }
  | { event: 'finished'; data: { asset: Asset } };

// Rejections of the network commands: `kind` is zknet_core's FetchError::kind()
export type CmdError = { kind: string; message: string };

// Live networks from the index merged with those cached on this device
export const listNetworks = (): Promise<Listing> => invoke<Listing>('networks_list');

// Ensure a network's assets are on disk; resolves to the network's directory
export const fetchNetwork = (
  networkId: string,
  refresh: boolean,
  onEvent: (e: FetchEvent) => void,
): Promise<string> => {
  const channel = new Channel<FetchEvent>();
  channel.onmessage = onEvent;
  return invoke<string>('network_fetch', { networkId, refresh, onEvent: channel });
};

export const readNetworkAssetFile = async (networkId: string, asset: string) => {
  const filePath = await path.join('networks', networkId, asset);
  return await readTextFile(filePath, { baseDir: BaseDirectory.AppLocalData });
};

export type NetworkServices = {
  RPCEndpoints: {
    chain: string;
    network: string;
    chainId: number | null;
    rpcPath: string;
    isTestnet: boolean;
  }[];
};

export type ZKNetClientStatus = {
  app: {
    version: string;
  };
  network: {
    isConnected: boolean;
  };
  settings: {
    walletshield: {
      listenAddress: string;
    };
  };
};

export const getClientStatus = async (): Promise<ZKNetClientStatus> => {
  const s = useStore.getState();
  const wla = await getWalletshieldListenAddress();

  return {
    app: {
      version: s.appVersion,
    },
    network: {
      isConnected: s.isConnected,
    },
    settings: {
      walletshield: {
        listenAddress: wla,
      },
    },
  };
};
