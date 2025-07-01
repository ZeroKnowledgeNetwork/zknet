/* JSON-RPC 2.0 WebSocket client */

export interface JsonRpcSuccess<T = any> {
  jsonrpc: '2.0';
  result: T;
  id: number | string;
}
export interface JsonRpcError {
  jsonrpc: '2.0';
  error: { code: number; message: string; data?: any };
  id: number | string | null;
}
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

type Resolver = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
};

export class JsonRpcWebSocket {
  // current WebSocket (may be null between reconnect attempts)
  private ws: WebSocket | null = null;
  private url: string;
  private nextId = 1;
  private pending = new Map<number | string, Resolver>();
  private notifyCb?: (method: string, params: any) => void;
  private openCb?: (self: JsonRpcWebSocket) => void;
  private closeCb?: (self: JsonRpcWebSocket) => void;

  // reconnect back-off
  private reconnectDelay = 1_000; // start at 1 s
  private readonly maxDelay = 30_000; // cap at 30 s
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private connected = false;

  constructor(
    url: string,
    opts?: {
      // called when server sends a notification or method call
      onNotification?: (method: string, params: any) => void;

      // called when the WebSocket connection is opened
      onOpen?: (self: JsonRpcWebSocket) => void;

      // called when the WebSocket connection is closed
      onClose?: (self: JsonRpcWebSocket) => void;

      // automatically connect immediately (default true)
      autoConnect?: boolean;
    },
  ) {
    this.url = url;
    this.notifyCb = opts?.onNotification;
    this.openCb = opts?.onOpen;
    this.closeCb = opts?.onClose;
    if (opts?.autoConnect !== false) this.connect();
  }

  /* ---------------- public API ---------------- */

  // (Re)connect if not already open
  public connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('open', () => this.onOpen());
    this.ws.addEventListener('message', (ev) => this.onMessage(ev));
    this.ws.addEventListener('close', () => this.onClose());
    this.ws.addEventListener('error', () => {
      /* ignore – close will follow */
    });
  }

  // Graceful close (no auto-reconnect)
  public close(code?: number, reason?: string) {
    this.stopReconnects();
    if (this.ws) this.ws.close(code, reason);
  }

  // true ⇢ socket is OPEN right now
  public isConnected() {
    return this.connected;
  }

  // JSON-RPC request that expects a response
  public call<T = any>(method: string, params?: any): Promise<T> {
    if (!this.connected) return Promise.reject(new Error('WS not connected'));

    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', method, params, id };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(msg));
      // optional: per-request timeout
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC "${method}" timed out`));
        }
      }, 10_000);
    });
  }

  // JSON-RPC notification (no response expected)
  public notify(method: string, params?: any) {
    if (!this.connected) throw new Error('WS not connected');
    this.ws!.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  // replace / add a notification handler
  public onNotification(cb: (method: string, params: any) => void) {
    this.notifyCb = cb;
  }

  /* ---------------- internals ---------------- */

  private onOpen() {
    this.connected = true;
    this.reconnectDelay = 1_000; // reset back-off
    if (this.openCb) this.openCb(this);
  }

  private onClose() {
    this.connected = false;
    this.rejectAllPending(new Error('WebSocket closed'));
    this.scheduleReconnect();
    if (this.closeCb) this.closeCb(this);
  }

  private onMessage(ev: MessageEvent) {
    let packet: any;
    try {
      packet = JSON.parse(ev.data);
    } catch {
      return console.warn('Non-JSON message ignored:', ev.data);
    }

    // response to our request
    if ('id' in packet) {
      const pending = this.pending.get(packet.id);
      if (!pending) return; // ignore unknown id

      this.pending.delete(packet.id);
      if ('result' in packet) pending.resolve(packet.result);
      else pending.reject(new Error(packet.error?.message || 'RPC error'));
      return;
    }

    // server-side notification
    if (packet.method && this.notifyCb) {
      this.notifyCb(packet.method, packet.params);
    }
  }

  private rejectAllPending(err: Error) {
    this.pending.forEach(({ reject }) => reject(err));
    this.pending.clear();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return; // already waiting

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      // exponential back-off with cap
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxDelay);
    }, this.reconnectDelay);
  }

  private stopReconnects() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
