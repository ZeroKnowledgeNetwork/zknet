// The site's settings, from .env (.env.example) at build time. An empty link
// is hidden.
const env = import.meta.env;
const value = (v: string | undefined) => (v ?? "").trim();

export const config = {
  // <base>/<id>/<channel>/downloads.json; empty: only the copy baked at build
  downloadsBase: value(env.VITE_DOWNLOADS_BASE),
  channel: value(env.VITE_CHANNEL) || "beta",
  // the site's own origin: the install command is <siteUrl>/install.sh
  siteUrl: value(env.VITE_SITE_URL).replace(/\/$/, ""),
  docsUrl: value(env.VITE_DOCS_URL),
  walletDocsUrl: value(env.VITE_WALLET_DOCS_URL),
  sourceUrl: value(env.VITE_SOURCE_URL),
  releasesUrl: value(env.VITE_RELEASES_URL),
};
