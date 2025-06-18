import { PackedFetchResponse } from '../fetch-wire';
import { ClientState } from '../types';

// https://webext-core.aklinker1.io/messaging/protocol-maps
export interface ProtocolMap {
  'zknet.fetch'(data: {
    input: RequestInfo | URL;
    init?: RequestInit;
  }): Promise<PackedFetchResponse>;

  // get the ZKNetwork Client Application status
  'zknet.client.getState'(): ClientState;

  // report the ZKNetwork Client Application status
  'zknet.client.state'(state: ClientState): void;
}
