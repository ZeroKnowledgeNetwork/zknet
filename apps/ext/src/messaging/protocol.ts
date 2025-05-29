import { PackedFetchResponse } from '../fetch-wire';

// https://webext-core.aklinker1.io/messaging/protocol-maps
export interface ProtocolMap {
  'zknet.fetch'(data: {
    input: RequestInfo | URL;
    init?: RequestInit;
  }): Promise<PackedFetchResponse>;
}
