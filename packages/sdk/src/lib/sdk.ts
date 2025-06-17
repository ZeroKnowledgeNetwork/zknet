export function sdk(): string {
  return 'sdk';
}

// the object the ZKNet extension injects into the page
export interface ZKNetLink {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

  client: {
    isAvailable(): Promise<boolean>;
    isConnected(): Promise<boolean>;
  };
}

declare global {
  interface Window {
    zknet?: ZKNetLink;
  }
}

export interface ZKNetSDKOptions {
  detectExtensionTimeout?: number;
}

// Wait for the ZKNet extension to be ready, or timeout after a specified period.
function detectExtension(timeoutMs = 2_000): Promise<ZKNetLink> {
  function isReady() {
    return !!window.zknet && typeof window.zknet.fetch === 'function';
  }

  if (isReady()) {
    console.log('ZKNet extension detected (flag)');
    return Promise.resolve(window.zknet!);
  }

  return new Promise((resolve, reject) => {
    // fired when the injected script finishes
    window.addEventListener('zknet#initialized', onReady, { once: true });

    const timer = setTimeout(() => {
      window.removeEventListener('zknet#initialized', onReady);
      reject(new Error('ZKNetwork extension not found'));
    }, timeoutMs);

    function onReady() {
      console.log('ZKNet extension detected (event)');
      if (isReady()) {
        clearTimeout(timer);
        resolve(window.zknet!);
      }
    }
  });
}

export class ZKNetSDK {
  private constructor(private link: ZKNetLink, private opts: ZKNetSDKOptions) {}

  static async init(options: ZKNetSDKOptions = {}): Promise<ZKNetSDK> {
    const link = await detectExtension(options.detectExtensionTimeout);
    return new ZKNetSDK(link, options);
  }

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    console.log('ZKNetSDK Options:', this.opts); // TODO: remove this after use opts
    return this.link.fetch(input, init);
  }

  client = {
    isAvailable: async (): Promise<boolean> =>
      await this.link.client.isAvailable(),

    isConnected: async (): Promise<boolean> =>
      await this.link.client.isConnected(),
  };
}
