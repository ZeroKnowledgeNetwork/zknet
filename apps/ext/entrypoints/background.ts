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

const extractPort = (s: string): string | null =>
  s.match(/:(\d{1,5})(?=$|[/?#])/)?.[1] ?? null;

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
      if (!rpc.isConnected() || clientStatus === null)
        throw new Error('ZKNetwork Client is not running');

      if (!clientStatus.network.isConnected)
        throw new Error('ZKNetwork is not connected');

      const wla = extractPort(clientStatus.settings.walletshield.listenAddress);
      if (wla === null) throw new Error('Invalid listen address');

      const url = `http://${config.ZKNET_CLIENT_HOST}:${wla}${
        input.toString().startsWith('/') ? '' : '/'
      }${input.toString()}`;

      const res = await fetch(url, init);
      return await packFetchResponse(res);
    } catch (err: any) {
      return await packFetchResponse(err as Error);
    }
  });

  extensionMsgr.onMessage('zknet.client.isAvailable', () => rpc.isConnected());

  extensionMsgr.onMessage(
    'zknet.client.isConnected',
    () => clientStatus?.network.isConnected ?? false
  );
});
