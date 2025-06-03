import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

listen<number>("api_conn_open", (e) => console.log("peer joined", e.payload));
listen<number>("api_conn_close", (e) => console.log("peer left", e.payload));

listen<{ conn_id: number; data: string }>(
  "api_request",
  async ({ payload }) => {
    const reply = handle(payload.data);
    await invoke("api_reply", { connId: payload.conn_id, data: reply });
  },
);

function handle(input: string): string {
  // TODO: Parse JSON-RPC, do work, produce JSON
  console.log("[API] handle message:", input);
  return JSON.stringify({ ok: true, echo: input });
}
