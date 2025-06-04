import { useState } from "react";
import * as log from "@tauri-apps/plugin-log";
import * as path from "@tauri-apps/api/path";
import { exists, mkdir } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { platform } from "@tauri-apps/plugin-os";
import { Child, Command } from "@tauri-apps/plugin-shell";
import { download } from "@tauri-apps/plugin-upload";
import { useStore } from "../store";
import {
  getNetworks,
  getWalletshieldListenAddress,
  getZKNetClientCfg,
} from "../utils";

export function Networks() {
  const [dlProgress, setDlProgress] = useState(0);
  const [networkId, setNetworkId] = useState("");

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
      setMessage("info", "");
      setIsConnected(true);
      setNetworkConnected(networkId);
      setNetworks(await getNetworks());
    } catch (error: any) {
      log.error(`${error}`);
      setMessage("error", `${error}`);
      consoleAddLine(`${error}`);
    }
  }

  async function disconnect() {
    try {
      setIsStopping(true);
      await clientStop();
      setMessage("info", "Disconnected from Network");
    } catch (error: any) {
      log.error(`${error}`);
      setMessage("error", `${error}`);
    }
  }

  async function clientStop() {
    if (clientPid > 0) {
      const c = new Child(clientPid);
      c.kill();
    }
  }

  async function clientStart() {
    const { urlNetwork } = await getZKNetClientCfg();

    const urlClientCfg = `${urlNetwork}/${networkId}/client.toml`;
    const urlServices = `${urlNetwork}/${networkId}/services.json`;
    const urlWalletshield = `${urlNetwork}/${networkId}/walletshield-${platformArch}`;
    const appLocalDataDirPath = await path.appLocalDataDir();
    const dirNetworks = await path.join(appLocalDataDirPath, "networks");
    const dirNetwork = await path.join(dirNetworks, networkId);
    const fileClientCfg = await path.join(dirNetwork, "client.toml");
    const fileServices = await path.join(dirNetwork, "services.json");
    const fileWalletshield =
      (await path.join(dirNetwork, "walletshield")) +
      (platform() === "windows" ? ".exe" : "");
    const updateInterval = 1; // download progress update interval

    ////////////////////////////////////////////////////////////////////////
    // check network existence
    ////////////////////////////////////////////////////////////////////////
    setMessage("info", `Checking network...`);
    const response = await fetch(urlClientCfg, {
      method: "GET",
      connectTimeout: 5000,
    });
    if (!response.ok || response.body === null) {
      log.warn(`Failed to download client config: ${response.statusText}`);
      throw new Error("Invalid network id (or local network error)");
    }

    ////////////////////////////////////////////////////////////////////////
    // save the network's assets in a network-specific directory
    ////////////////////////////////////////////////////////////////////////
    log.debug(`local network directory: ${dirNetwork}`);
    if (!(await exists(dirNetwork)))
      await mkdir(dirNetwork, { recursive: true });
    await download(urlClientCfg, fileClientCfg);
    await download(urlServices, fileServices);
    setMessage("info", "Retrieved network assets");

    ////////////////////////////////////////////////////////////////////////
    // save the network's walletshield binary
    ////////////////////////////////////////////////////////////////////////
    if (!(await exists(fileWalletshield))) {
      setMessage("info", "Downloading network client...");
      await download(
        urlWalletshield,
        fileWalletshield,
        ({ progressTotal, total }) => {
          const percentComplete = Math.floor((progressTotal / total) * 100);
          if (
            (dlProgress !== percentComplete &&
              percentComplete % updateInterval === 0) ||
            progressTotal === total
          ) {
            let msg = `Downloading client... ${percentComplete}%`;
            if (progressTotal === total)
              msg = `Downloaded client for OS: ${platformArch}`;
            setMessage("info", msg);
            setDlProgress(() => percentComplete);
          }
        },
      );
    }

    ////////////////////////////////////////////////////////////////////////
    // prepare the walletshield binary for execution
    ////////////////////////////////////////////////////////////////////////
    if (platform() === "linux" || platform() === "macos") {
      log.debug(`executing command: chmod +x walletshield`);
      const output = await Command.create(
        "chmod-walletshield",
        ["+x", "walletshield"],
        {
          cwd: dirNetwork,
        },
      ).execute();
      if (output.code !== 0) {
        throw new Error(`Failed to chmod+x walletshield: ${output.stderr}`);
      }
    }

    ////////////////////////////////////////////////////////////////////////
    // execute the walletshield client with the client.toml
    ////////////////////////////////////////////////////////////////////////
    setMessage("info", "Starting network client...");
    const cmd = "walletshield";
    const wla = await getWalletshieldListenAddress();
    const args = ["-listen", wla, "-config", "client.toml"];
    const command = Command.create("walletshield-listen", args, {
      cwd: dirNetwork,
      env: {
        PATH: dirNetwork,
      },
    });
    const o = (d: string) => `${d.trim()}`;
    log.debug(`spawning command: ${cmd} ${args.join(" ")}`);

    command.on("close", (data) => {
      log.debug(`closed: ${cmd} code=${data.code} signal=${data.signal}`);
      const isStopping = useStore.getState().isStopping;
      if (isStopping !== true) {
        setMessage("error", "Error: Network connection failed.");
        consoleAddLine(`Network connection failed: ${networkId}`);
      }
      consoleAddLine(`Disconnected from network: ${networkId}`);
      setClientPid(0);
      setIsConnected(false);
      setIsStopping(false);
      setNetworkConnected("");
    });

    command.on("error", (e) => log.error(o(e)));

    command.stdout.on("data", (d) => {
      log.info(o(d));
      if (d.match(/client2/) === null) consoleAddLine(o(d));
    });

    command.stderr.on("data", (d) => {
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
        className={`logo ${isConnected ? "pulsing" : ""}`}
      />

      {isPlatformSupported &&
        (clientPid === 0 ? (
          <>
            <p>Enter a network identifier for access.</p>
            <form
              className="join"
              onSubmit={(e) => {
                e.preventDefault();
                connect();

                // blur the input field to clear visual artifact
                e.currentTarget.querySelector("input")?.blur();
              }}
            >
              <input
                className="input validator focus:outline-none join-item"
                onChange={(e) => setNetworkId(e.currentTarget.value)}
                placeholder="Enter a network id..."
                maxLength={36}
                minLength={5}
                required
                list="networks"
              />
              <datalist id="networks">
                {networks.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <button className="btn btn-primary join-item" type="submit">
                Connect
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="text-lg font-bold">
              Connected Network: {networkConnected}
            </p>
            <button onClick={disconnect} className="btn btn-secondary">
              Disconnect
            </button>
          </>
        ))}
    </div>
  );
}
