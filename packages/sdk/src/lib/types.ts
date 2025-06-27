export type ZKNetClientState = {
  // is the ZKNetwork Client Application running locally
  isAvailable: boolean;

  // is the ZKNetwork Client Application connected to a network
  isConnected: boolean;
};

// the object the ZKNet extension injects into the page
export interface ZKNetLink {
  client: {
    getState(): Promise<ZKNetClientState>;
  };
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
