import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { arch, platform } from "@tauri-apps/plugin-os";
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

  async function connect() {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    try {
      const platformArch = getPlatformArch();
      const response = await invoke("network_connect", { networkId });
      setMsg(`${response}, OS: ${platformArch}`);
      setMsgType("info");
    } catch (error: any) {
      setMsg(`${error}`);
      setMsgType("error");
    }
  }

  return (
    <main className="container">
      <h1>Zero Knowledge Network</h1>

      <div className="row">
        <img src="/zkn.svg" className="logo ZKN" alt="ZKN logo" />
      </div>

      <p>
        Enter a <i>networkd id</i> for access.
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
