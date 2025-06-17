// the object the ZKNet extension injects into the page
export interface ZKNetLink {
  client: {
    isAvailable(): Promise<boolean>;
    isConnected(): Promise<boolean>;
  };
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
