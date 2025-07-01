import { BaseDirectory, readDir, readTextFile } from '@tauri-apps/plugin-fs';
import { path } from '@tauri-apps/api';
import { arch, platform } from '@tauri-apps/plugin-os';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';

// This matches exactly what is in tauri.conf.json:plugins.zknet.
export interface ZKNetClientCfg {
  apiListenAddress: string;
  defaultWalletshieldListenAddress: string;
  urlNetwork: string;
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

// Map the os platform and architecture to a supported ZKN format
export const getPlatformArch = (): string => {
  const platArch = `${platform()}-${arch()}`;
  switch (platArch) {
    case 'linux-aarch64':
      return 'linux-arm64';
    case 'linux-x86_64':
      return 'linux-x64';
    case 'macos-aarch64':
    case 'macos-x86_64':
      return 'macos';
    case 'windows-x86_64':
      return 'windows-x64';
    default:
      throw new Error(`Unsupported Operating System: ${platArch}`);
  }
};

// Get networks with previously downloaded assets
export const getNetworks = async () => {
  const entries = await readDir('networks', {
    baseDir: BaseDirectory.AppLocalData,
  });
  return entries.filter((i) => i.isDirectory).map((i) => i.name);
};

export const readNetworkAssetFile = async (
  networkId: string,
  asset: string,
) => {
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
