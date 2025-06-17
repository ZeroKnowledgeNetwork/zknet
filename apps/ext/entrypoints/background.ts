import config from '@/src/config';
import { packFetchResponse } from '@/src/fetch-wire';
import { extensionMsgr } from '@/src/messaging/extension';
import { JsonRpcWebSocket } from '@/src/ws-rpc-client';

type ZKNetClientStatus = {
  app: {
    version: string;
  };
  network: {
    isConnected: boolean;
  };
  settings: {
    walletshield: {
      listenAddress: string;
    };
  };
};
export default defineBackground(() => {
  let clientStatus: ZKNetClientStatus | null = null;

  const url = `http://${config.ZKNET_CLIENT_HOST}:${config.ZKNET_CLIENT_PORT}`;
  const rpc = new JsonRpcWebSocket(url, {
    onNotification: (method, params) => {
      switch (method) {
        case 'status':
          clientStatus = params;
          break;

        default:
          break;
      }
    },

    onOpen: async (ws) => {
      try {
        clientStatus = await ws.call('getStatus');
      } catch (err) {
        // ignore errors here
      }
    },

    onClose: () => {
      clientStatus = null;
    },
  });

  extensionMsgr.onMessage('zknet.fetch', async ({ data: { input, init } }) => {
    try {
      const res = await fetch(input, init);
      return await packFetchResponse(res);
    } catch (err: any) {
      return await packFetchResponse(err as Error);
    }
  });
});
