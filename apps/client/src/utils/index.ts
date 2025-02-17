import { BaseDirectory, readDir } from "@tauri-apps/plugin-fs";
import { arch, platform } from "@tauri-apps/plugin-os";

export const urlNetwork = "https://test.net.zknet.io";

// Map the os platform and architecture to a supported ZKN format
export const getPlatformArch = (): string => {
  const platArch = `${platform()}-${arch()}`;
  switch (platArch) {
    case "linux-aarch64":
      return "linux-arm64";
    case "linux-x86_64":
      return "linux-x64";
    case "macos-aarch64":
    case "macos-x86_64":
      return "macos";
    case "windows-x86_64":
      return "windows-x64";
    default:
      throw new Error(`Unsupported Operating System: ${platArch}`);
  }
};

// Get networks with previously downloaded assets
export const getNetworks = async () => {
  const entries = await readDir("networks", {
    baseDir: BaseDirectory.AppLocalData,
  });
  return entries.filter((i) => i.isDirectory).map((i) => i.name);
};
