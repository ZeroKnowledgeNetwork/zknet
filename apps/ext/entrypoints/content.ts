import { eventMsgr } from '@/src/messaging/event';
import { extensionMsgr } from '@/src/messaging/extension';

export default defineContentScript({
  matches: ['*://*/*'],
  async main() {
    await injectScript('/injected.js' as any, { keepInDom: true });

    // relay messages from the injected script to the extension
    eventMsgr.onMessage('zknet.fetch', async ({ data, type }) => {
      return await extensionMsgr.sendMessage(type, data);
    });
  },
});
