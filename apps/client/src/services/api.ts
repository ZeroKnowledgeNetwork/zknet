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
    const reply = await handle(payload.data);
    await invoke("api_reply", { connId: payload.conn_id, data: reply });
  },
);

export const enum RpcCode {
  PARSE = -32700,
  INVALID_REQUEST = -32600,
  NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL = -32603,
  // -32000 - -32099 reserved for app-specific server errors
}

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

const err = (id: number | string | null, e: RpcError) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: e.code,
      message: e.message,
      ...(e.data !== undefined && { data: e.data }),
    },
  });

async function handle(raw: string): Promise<string | void> {
  let req: any;

  try {
    req = JSON.parse(raw);
  } catch {
    return err(null, new RpcError(RpcCode.PARSE, "Parse error"));
  }

  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return err(
      req.id ?? null,
      new RpcError(RpcCode.INVALID_REQUEST, "Invalid request"),
    );
  }

  const isNotification = req.id === undefined;

  try {
    const result = await route(req.method, req.params);
    if (isNotification) return; // no response ⇒ notification
    return JSON.stringify({ jsonrpc: "2.0", id: req.id, result });
  } catch (e: any) {
    if (isNotification) return; // swallow notif errors
    const rpcErr =
      e instanceof RpcError
        ? e
        : new RpcError(RpcCode.INTERNAL, "Internal error", String(e));
    return err(req.id ?? null, rpcErr);
  }
}

async function route(method: string, params: any) {
  switch (method) {
    case "getStatus":
      return await getClientStatus();

    case "echo":
      return params;

    default:
      throw new RpcError(RpcCode.NOT_FOUND, "Method not found");
  }
}
