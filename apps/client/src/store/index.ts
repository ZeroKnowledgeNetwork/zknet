import { create } from "zustand";
import { combine } from "zustand/middleware";

export const useStore = create(
  combine(
    {
      appVersion: "",
      isConnected: false,
      isPlatformSupported: false,
      networks: [] as string[],
      platformArch: "",
    },
    (set) => ({
      setAppVersion: (appVersion: string) => set({ appVersion }),
      setIsConnected: (isConnected: boolean) => set({ isConnected }),
      setIsPlatformSupported: (isPlatformSupported: boolean) =>
        set({ isPlatformSupported }),
      setNetworks: (networks: string[]) => set({ networks }),
      setPlatformArch: (platformArch: string) => set({ platformArch }),
    }),
  ),
);
