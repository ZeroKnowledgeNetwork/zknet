import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { combine } from "zustand/middleware";

const store = new LazyStore("settings.json");

export const useStore = create(
  combine(
    {
      appVersion: "",
      clientPid: 0,
      consoleLines: [] as string[],
      consoleLinesLimit: 100,
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
      consoleAddLine: (line: string) =>
        set(({ consoleLines, consoleLinesLimit }) => {
          const next = [line, ...consoleLines].slice(0, consoleLinesLimit);
          return { consoleLines: next };
        }),

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

      setWalletshieldListenAddress: async (
        walletshieldListenAddress: string,
      ) => {
        set({ walletshieldListenAddress });
        await store.set("walletshieldListenAddress", walletshieldListenAddress);
        await store.save();
      },

      loadPersistedSettings: async () => {
        const wla = await store.get<string>("walletshieldListenAddress");
        if (wla) set({ walletshieldListenAddress: wla });
      },
    }),
  ),
);

// Load persisted settings on app start
useStore.getState().loadPersistedSettings();
