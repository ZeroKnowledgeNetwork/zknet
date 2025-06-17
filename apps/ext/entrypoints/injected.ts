import { unpackFetchResponse } from '@/src/fetch-wire';
import { eventMsgr } from '@/src/messaging/event';
import type { ZKNetLink } from '@zknet/sdk';

declare global {
  interface Window {
    zknet?: ZKNetLink;
  }
}

export default defineUnlistedScript(async () => {
  window.zknet = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const p = await eventMsgr.sendMessage('zknet.fetch', { input, init });
      return unpackFetchResponse(p);
    },
    client: {
      isAvailable: () =>
        eventMsgr.sendMessage('zknet.client.isAvailable', undefined),

      isConnected: () =>
        eventMsgr.sendMessage('zknet.client.isConnected', undefined),
    },
  };

  window.dispatchEvent(new Event('zknet#initialized'));
});
