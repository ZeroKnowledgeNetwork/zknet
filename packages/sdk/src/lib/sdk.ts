import { ZKNetClientState, ZKNetLink } from './types.js';

export function sdk(): string {
  return 'sdk';
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
  // singleton instance of the SDK
  private static _ready: Promise<ZKNetSDK> | null = null;

  private constructor(private link: ZKNetLink, private opts: ZKNetSDKOptions) {}

  // Initializes the SDK, waiting for the ZKNet extension to be ready.
  static async init(opts: ZKNetSDKOptions = {}): Promise<ZKNetSDK> {
    // init or reuse the existing singleton instance
    return (this._ready ??= detectExtension(opts.detectExtensionTimeout).then(
      (link) => new ZKNetSDK(link, opts)
    ));
  }

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    console.log('ZKNetSDK Options:', this.opts); // TODO: remove this after use opts
    return this.link.fetch(input, init);
  }

  client = {
    getState: async (): Promise<ZKNetClientState> =>
      await this.link.client.getState(),
  };
}
