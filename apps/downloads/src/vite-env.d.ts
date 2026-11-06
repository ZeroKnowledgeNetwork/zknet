/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DOWNLOADS_BASE?: string;
  readonly VITE_CHANNEL?: string;
  readonly VITE_SITE_URL?: string;
  readonly VITE_DOCS_URL?: string;
  readonly VITE_WALLET_DOCS_URL?: string;
  readonly VITE_SOURCE_URL?: string;
  readonly VITE_RELEASES_URL?: string;
}
