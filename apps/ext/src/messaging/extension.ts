import { defineExtensionMessaging } from '@webext-core/messaging';
import { ProtocolMap } from './protocol';

// For communications between background script and other parts of the extension
export const extensionMsgr = defineExtensionMessaging<ProtocolMap>();
