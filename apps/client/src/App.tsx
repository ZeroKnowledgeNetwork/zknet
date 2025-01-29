import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [connectMsg, setConnectMsg] = useState("");
  const [networkId, setNetworkId] = useState("");

  async function connect() {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    setConnectMsg(await invoke("network_connect", { networkId }));
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
      <p>{connectMsg}</p>
    </main>
  );
}

export default App;
