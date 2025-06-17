import { PackedFetchResponse } from '../fetch-wire';

// https://webext-core.aklinker1.io/messaging/protocol-maps
export interface ProtocolMap {
  'zknet.fetch'(data: {
    input: RequestInfo | URL;
    init?: RequestInit;
  }): Promise<PackedFetchResponse>;

  // is the ZKNetwork Client Application running locally
  'zknet.client.isAvailable'(): boolean;

  // is the ZKNetwork Client Application connected to a network
  'zknet.client.isConnected'(): boolean;
}
