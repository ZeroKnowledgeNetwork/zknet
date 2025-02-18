import { create } from "zustand";
import { combine } from "zustand/middleware";

export const useStore = create(
  combine(
    {
      appVersion: "",
      clientPid: 0,
      isConnected: false,
      isPlatformSupported: false,
      message: "",
      messageType: "",
      networkConnected: "",
      networks: [] as string[],
      platformArch: "",
      walletshieldListenAddress: "",
    },
    (set) => ({
      setAppVersion: (appVersion: string) => set({ appVersion }),
      setClientPid: (clientPid: number) => set({ clientPid }),
      setIsConnected: (isConnected: boolean) => set({ isConnected }),
      setIsPlatformSupported: (isPlatformSupported: boolean) =>
        set({ isPlatformSupported }),
      setMessage: (
        messageType: "error" | "info" | "success",
        message: string,
      ) => set({ message, messageType }),
      setNetworkConnected: (networkConnected: string) =>
        set({ networkConnected }),
      setNetworks: (networks: string[]) => set({ networks }),
      setPlatformArch: (platformArch: string) => set({ platformArch }),
      setWalletshieldListenAddress: (walletshieldListenAddress: string) =>
        set({ walletshieldListenAddress }),
    }),
  ),
);
