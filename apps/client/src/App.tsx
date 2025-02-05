import { useState } from "react";
import * as path from "@tauri-apps/api/path";
import { arch, platform } from "@tauri-apps/plugin-os";
import { download } from "@tauri-apps/plugin-upload";
import { fetch } from "@tauri-apps/plugin-http";
import { Command } from "@tauri-apps/plugin-shell";
import { mkdir, exists } from "@tauri-apps/plugin-fs";
import "./App.css";

// Map the os platform and architecture to a supported ZKN format
const getPlatformArch = (): String => {
  const platArch = `${platform()}-${arch()}`;
  switch (platArch) {
    case "linux-aarch64":
      return "linux-arm64";
    case "linux-x86_64":
      return "linux-x64";
    case "macos-aarch64":
    case "macos-x86_x64":
      return "macos";
    case "windows-x86_x64":
      return "windows-x64";
    default:
      throw new Error(`Unsupported OS: ${platArch}`);
  }
};

function App() {
  const [msg, setMsg] = useState("");
  const [msgType, setMsgType] = useState(""); // error, info, success
  const [networkId, setNetworkId] = useState("");
  const [dlProgress, setDlProgress] = useState(0);

  async function connect() {
    try {
      await clientStart();
    } catch (error: any) {
      console.log(error);
      setMsgType("error");
      setMsg(`${error}`);
    }
  }

  async function clientStart() {
    const platformArch = getPlatformArch();
    const urlClientCfg = `https://test.net.0kn.io/${networkId}/client.toml`;
    const urlWalletshield = `https://test.net.0kn.io/${networkId}/walletshield-${platformArch}`;
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
    setMsgType(() => "info");
    setMsg(() => `Checking network...`);
    const response = await fetch(urlClientCfg, {
      method: "GET",
      connectTimeout: 5000,
    });
    if (!response.ok || response.body === null) {
      console.log(`Failed to download client config: ${response.statusText}`);
      throw new Error("Invalid network id (or local network error)");
    }

    ////////////////////////////////////////////////////////////////////////
    // save the network's client.toml in a network-specific directory
    ////////////////////////////////////////////////////////////////////////
    console.log("dirNetwork:", dirNetwork);
    if (!(await exists(dirNetworks))) {
      await mkdir(dirNetworks);
      await mkdir(dirNetwork);
    }
    await download(urlClientCfg, fileClientCfg);
    setMsgType(() => "success");
    setMsg(() => "Retrieved network client configuration");

    ////////////////////////////////////////////////////////////////////////
    // save the network's walletshield binary
    ////////////////////////////////////////////////////////////////////////
    if (!(await exists(fileWalletshield))) {
      setMsgType(() => "info");
      setMsg(() => `Downloading network client...`);
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
            setMsg(() => msg);
            setDlProgress(() => percentComplete);
          }
        },
      );
    }

    ////////////////////////////////////////////////////////////////////////
    // prepare the walletshield binary for execution
    ////////////////////////////////////////////////////////////////////////
    if (platform() === "linux" || platform() === "macos") {
      const output = await Command.create("chmod+x", [
        "+x",
        fileWalletshield,
      ]).execute();
      if (output.code !== 0) {
        throw new Error(`Failed to chmod+x walletshield: ${output.stderr}`);
      }
    }

    ////////////////////////////////////////////////////////////////////////
    // execute the walletshield client with the client.toml
    ////////////////////////////////////////////////////////////////////////
    setMsgType(() => "info");
    setMsg(() => `Starting network client...`);
    const command = Command.create(
      "walletshield-listen",
      ["-listen", ":7070", "-config", fileClientCfg],
      {
        cwd: dirNetwork,
        env: {
          PATH: dirNetwork,
        },
      },
    );
    command.on("close", (data) => {
      console.log(
        `command finished with code ${data.code} and signal ${data.signal}`,
      );
      setMsgType(() => "info");
      setMsg(() => `Network client stopped.`);
    });
    command.on("error", (error) => console.error(`command error: "${error}"`));
    command.stdout.on("data", (line) =>
      console.log(`command stdout: "${line}"`),
    );
    command.stderr.on("data", (line) =>
      console.log(`command stderr: "${line}"`),
    );

    const child = await command.spawn();
    console.log("pid:", child.pid);
  }

  return (
    <main className="container">
      <h1>Zero Knowledge Network</h1>

      <div className="row">
        <img src="/zkn.svg" className="logo ZKN" alt="ZKN logo" />
      </div>

      <p>
        Enter a <i>network id</i> for access.
      </p>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          connect();
        }}
      >
        <input
          id="connect-input"
          onChange={(e) => setNetworkId(e.currentTarget.value)}
          placeholder="Enter a network_id..."
        />
        <button type="submit">Connect</button>
      </form>
      <p className={`message ${msgType}`}>{msg}</p>
    </main>
  );
}

export default App;
