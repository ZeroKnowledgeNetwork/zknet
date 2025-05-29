import { packFetchResponse } from '@/src/fetch-wire';
import { extensionMsgr } from '@/src/messaging/extension';

export default defineBackground(() => {
  extensionMsgr.onMessage('zknet.fetch', async ({ data: { input, init } }) => {
    try {
      const res = await fetch(input, init);
      return await packFetchResponse(res);
    } catch (err: any) {
      return await packFetchResponse(err as Error);
    }
  });
});
