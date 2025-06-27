import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getClientStatus } from "../utils";

// connected API clients
const clients = new Set<number>();

// Notify all connected API clients of a method call with parameters.
export const notifyAPIClients = async (method: string, params: any) => {
  const data = JSON.stringify({ jsonrpc: "2.0", method, params });
  clients.forEach(async (connId) => {
    await invoke("api_reply", { connId, data });
  });
};

// Notify all connected API clients of a status change.
export const notifyAPIClientsOfStatusChange = async () => {
  const params = await getClientStatus();
  await notifyAPIClients("status", params);
};

listen<number>("api_conn_open", (e) => {
  clients.add(e.payload);
  console.log("API client joined", e.payload);
});

listen<number>("api_conn_close", (e) => {
  clients.delete(e.payload);
  console.log("API client left", e.payload);
});

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
