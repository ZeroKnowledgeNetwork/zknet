import { defineCustomEventMessaging } from '@webext-core/messaging/page';
import { ProtocolMap } from './protocol';

// For communications between content script and website's injected script
export const eventMsgr = defineCustomEventMessaging<ProtocolMap>({
  namespace: 'zknet',
});
