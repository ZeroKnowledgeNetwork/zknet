import { unpackFetchResponse } from '@/src/fetch-wire';
import { eventMsgr } from '@/src/messaging/event';

declare global {
  interface Window {
    zknet: {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
  }
}

export default defineUnlistedScript(async () => {
  window.zknet = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const p = await eventMsgr.sendMessage('zknet.fetch', { input, init });
      return unpackFetchResponse(p);
    },
  };
});
