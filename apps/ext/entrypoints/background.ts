import config from '@/src/config';
import { packFetchResponse } from '@/src/fetch-wire';
import { extensionMsgr } from '@/src/messaging/extension';
import { RemoteClientStatus } from '@/src/types';
import { JsonRpcWebSocket } from '@/src/ws-rpc-client';

const extractPort = (s: string): string | null =>
  s.match(/:(\d{1,5})(?=$|[/?#])/)?.[1] ?? null;

export default defineBackground(() => {
  let clientStatus: RemoteClientStatus | null = null;

  const getClientState = () => ({
    isAvailable: (clientStatus && rpc.isConnected()) ?? false,
    isConnected: clientStatus?.network.isConnected ?? false,
  });

  const setClientStatus = (status: RemoteClientStatus | null) => {
    clientStatus = status;
    extensionMsgr
      .sendMessage('zknet.client.state', getClientState())
      .catch(() => {
        // ignore errors, including if no message listeners yet
      });
  };

  const url = `http://${config.ZKNET_CLIENT_HOST}:${config.ZKNET_CLIENT_PORT}`;
  const rpc = new JsonRpcWebSocket(url, {
    onNotification: (method, params) => {
      switch (method) {
        case 'status':
          setClientStatus(params);
          break;

        default:
          break;
      }
    },

    onOpen: async (ws) => {
      try {
        const status = await ws.call('getStatus');
        setClientStatus(status);
      } catch (err) {
        // ignore errors
      }
    },

    onClose: () => {
      setClientStatus(null);
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

  extensionMsgr.onMessage('zknet.client.getState', () => getClientState());
});
