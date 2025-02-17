import { useState } from "react";
import * as log from "@tauri-apps/plugin-log";
import * as path from "@tauri-apps/api/path";
import { exists, mkdir } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { platform } from "@tauri-apps/plugin-os";
import { Child, Command } from "@tauri-apps/plugin-shell";
import { download } from "@tauri-apps/plugin-upload";
import { useStore } from "../store";
import { getNetworks, urlNetwork } from "../utils";

export function Networks() {
  const [clientPid, setClientPid] = useState(0);
  const [dlProgress, setDlProgress] = useState(0);
  const [networkId, setNetworkId] = useState("");

  const isConnected = useStore((s) => s.isConnected);
  const isPlatformSupported = useStore((s) => s.isPlatformSupported);
  const networks = useStore((s) => s.networks);
  const platformArch = useStore((s) => s.platformArch);

  const setIsConnected = useStore((s) => s.setIsConnected);
  const setMessage = useStore((s) => s.setMessage);
  const setNetworks = useStore((s) => s.setNetworks);

  async function connect() {
    try {
      const pid = await clientStart();
      setClientPid(pid);
      setMessage("info", "");
      setIsConnected(true);
      setNetworks(await getNetworks());
    } catch (error: any) {
      log.error(`${error}`);
      setMessage("error", `${error}`);
    }
  }

  async function disconnect() {
    try {
      await clientStop();
      setClientPid(0);
      setMessage("info", "Disconnected from Network");
      setIsConnected(false);
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
    const urlClientCfg = `${urlNetwork}/${networkId}/client.toml`;
    const urlWalletshield = `${urlNetwork}/${networkId}/walletshield-${platformArch}`;
    const appLocalDataDirPath = await path.appLocalDataDir();
    const dirNetworks = await path.join(appLocalDataDirPath, "networks");
    const dirNetwork = await path.join(dirNetworks, networkId);
    const fileClientCfg = await path.join(dirNetwork, "client.toml");
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
    // save the network's client.toml in a network-specific directory
    ////////////////////////////////////////////////////////////////////////
    log.debug(`local network directory: ${dirNetwork}`);
    if (!(await exists(dirNetwork)))
      await mkdir(dirNetwork, { recursive: true });
    await download(urlClientCfg, fileClientCfg);
    setMessage("info", "Retrieved network client configuration");

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
    const args = ["-listen", ":7070", "-config", "client.toml"];
    const command = Command.create("walletshield-listen", args, {
      cwd: dirNetwork,
      env: {
        PATH: dirNetwork,
      },
    });
    log.debug(`spawning command: ${cmd} ${args.join(" ")}`);
    command.on("close", (data) => {
      log.debug(`closed: ${cmd} code=${data.code} signal=${data.signal}`);
      setMessage("info", "Network client stopped.");
    });
    command.on("error", (e) => log.error(`${cmd}: ${e.trim()}`));
    command.stdout.on("data", (d) => log.info(`${cmd}: ${d.trim()}`));
    command.stderr.on("data", (d) => log.error(`${cmd}: ${d.trim()}`));

    const child = await command.spawn();
    return child.pid;
  }

  return (
    <div className="flex flex-col items-center justify-center gap-5 mt-10">
      <h1 className="text-3xl font-extrabold">Zero Knowledge Network</h1>

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
            <p className="text-lg font-bold">Connected Network: {networkId}</p>
            <button onClick={disconnect} className="btn btn-secondary">
              Disconnect
            </button>
          </>
        ))}
    </div>
  );
}
