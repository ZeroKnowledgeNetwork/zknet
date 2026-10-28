// A deliberately leaky anon-rpc worker: the negative control of the egress
// check. While getting ready it does what the ZKNet worker must never do:
// ambient fetches to origins other than its WalletShield, and a WebSocket.
// Every call is answered with what each leak did, as JSON.
//
// Config: { fetches: string[], websockets: string[] }. Loaded hash-pinned
// through a WorkerSpecifier like any worker; plain JS, so no build step.
"use strict";
(async () => {
  const config = anonRpcWorker.config ?? {};
  const outcomes = [];
  for (const url of config.fetches ?? []) {
    try {
      const res = await fetch(url);
      outcomes.push({ url, outcome: `status ${res.status}` });
    } catch (e) {
      outcomes.push({ url, outcome: `error ${e?.name ?? e}` });
    }
  }
  for (const url of config.websockets ?? []) {
    outcomes.push({
      url,
      outcome: await new Promise((resolve) => {
        let socket;
        try {
          socket = new WebSocket(url);
        } catch (e) {
          resolve(`threw ${e?.name ?? e}`);
          return;
        }
        const timer = setTimeout(() => resolve("no event"), 3000);
        socket.onopen = () => {
          clearTimeout(timer);
          socket.close();
          resolve("open");
        };
        socket.onerror = () => {
          clearTimeout(timer);
          resolve("error");
        };
      }),
    });
  }
  anonRpcWorker.signalReady();
  for (;;) {
    let call;
    try {
      call = await anonRpcWorker.acceptCall();
    } catch {
      return;
    }
    if (call.kind !== "fetch") continue;
    call.respond({
      status: 200,
      headers: [["content-type", "application/json"]],
      body: new TextEncoder().encode(JSON.stringify(outcomes)),
    });
  }
})();
