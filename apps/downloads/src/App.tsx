import { useEffect, useState, type ReactNode } from "react";
import { config } from "./config.ts";
import { detectPlatform, OS_LABEL, type OS, type Platform } from "./detect.ts";
import { assetsFor, mb, type Asset, type Downloads, type Releases } from "./manifest.ts";
import { loadReleases } from "./releases.ts";

const DESKTOP_OS: OS[] = ["windows", "macos", "linux"];

// A link whose URL is empty is not shown
const Link = ({
  href,
  className = "link",
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) =>
  href ? (
    <a className={className} href={href}>
      {children}
    </a>
  ) : null;

const Code = ({ children }: { children: string }) => (
  <pre className="bg-base-300 rounded-box p-4 overflow-x-auto text-sm leading-relaxed">
    <code>{children}</code>
  </pre>
);

const KIND_LABEL: Record<Asset["kind"], string> = {
  dmg: "Disk image (.dmg)",
  exe: "Installer (.exe)",
  AppImage: "AppImage",
  deb: ".deb (Debian, Ubuntu)",
  rpm: ".rpm (Fedora, openSUSE)",
  binary: "Binary",
  archive: "Archive",
};

const howToInstall = (a: Asset) =>
  ({
    dmg: "Open the disk image and drag ZKNetwork to Applications.",
    exe: "Run the installer.",
    AppImage: `chmod +x ${a.name} && ./${a.name}`,
    deb: `sudo apt install ./${a.name}`,
    rpm: `sudo dnf install ./${a.name}`,
  })[a.kind as string] ?? "";

function Header() {
  return (
    <header className="navbar max-w-6xl mx-auto px-4 py-6 gap-4">
      <a href="/" className="flex items-center gap-4 flex-1" aria-label="ZKNetwork">
        <img src="/brand/logo.svg" alt="" className="h-10 w-10" />
        <img
          src="/brand/ZKNetwork-letters-full.svg"
          alt="ZKNetwork"
          className="h-4 sm:h-5 w-auto"
        />
      </a>
      <nav className="hidden sm:flex gap-1 text-sm">
        <Link className="btn btn-ghost btn-sm" href={config.docsUrl}>
          Docs
        </Link>
        <Link className="btn btn-ghost btn-sm" href={config.sourceUrl}>
          Source
        </Link>
        <Link className="btn btn-ghost btn-sm" href={config.releasesUrl}>
          All releases
        </Link>
      </nav>
    </header>
  );
}

type Loaded = { releases: Releases | null; platform: Platform | null };

function DesktopDownload({ releases, platform, onPick }: Loaded & { onPick: (os: OS) => void }) {
  const client = releases?.client;
  const assets = platform ? assetsFor(client, platform) : [];
  const [primary, ...others] = assets;
  const detected = platform
    ? `${OS_LABEL[platform.os]}${platform.arch !== "unknown" ? ` · ${platform.arch}` : ""}`
    : "…";
  return (
    <div className="card bg-base-200 border border-base-300">
      <div className="card-body gap-4">
        <div className="flex items-center justify-between gap-2 text-sm opacity-80">
          <span>
            Detected: <strong>{detected}</strong>
          </span>
          <div className="join" role="group" aria-label="Choose a platform">
            {DESKTOP_OS.map((os) => (
              <button
                key={os}
                type="button"
                className={`btn btn-xs join-item ${platform?.os === os ? "btn-secondary" : "btn-ghost"}`}
                aria-pressed={platform?.os === os}
                onClick={() => onPick(os)}
              >
                {OS_LABEL[os]}
              </button>
            ))}
          </div>
        </div>

        {!releases || !platform ? (
          <div className="skeleton h-14 w-full" />
        ) : !client ? (
          <div role="alert" className="alert alert-soft border-base-300">
            <p className="text-sm">
              The release list is unavailable right now.{" "}
              <Link href={config.releasesUrl}>Pick your download from all releases.</Link>
            </p>
          </div>
        ) : primary ? (
          <>
            <a
              className="btn btn-primary btn-lg h-auto py-3 flex-col items-start"
              href={primary.url}
            >
              <span className="font-display text-base">Download for {OS_LABEL[platform.os]}</span>
              <span className="text-xs font-normal opacity-80">
                {KIND_LABEL[primary.kind]} · {mb(primary.size)}
              </span>
            </a>
            <code className="text-xs opacity-80 break-all">{howToInstall(primary)}</code>
            {others.length > 0 && (
              <div className="flex flex-wrap gap-2 text-sm">
                Also:
                {others.map((a) => (
                  <a key={a.name} className="link link-primary" href={a.url}>
                    {KIND_LABEL[a.kind]} · {mb(a.size)}
                  </a>
                ))}
              </div>
            )}
          </>
        ) : (
          <div role="status" className="alert alert-soft border-base-300">
            <div>
              <p className="font-display text-sm">
                The desktop client is not available on {OS_LABEL[platform.os]}.
              </p>
              <p className="text-sm opacity-80 mt-1">
                It runs on Windows, macOS and x86_64 Linux. Pick one above or try the{" "}
                <a className="link" href="#cli">
                  command-line client
                </a>
                .{" "}
                {config.sourceUrl && (
                  <>
                    You can also <Link href={config.sourceUrl}>build it from source</Link>.
                  </>
                )}
              </p>
            </div>
          </div>
        )}

        {client && (
          <p className="text-xs opacity-70">
            ZKNetwork {client.version} · {client.date}
            {client.notes && (
              <>
                {" · "}
                <a className="link" href={client.notes}>
                  release notes
                </a>
              </>
            )}
            {" · "}
            <a className="link" href="#verify">
              verify
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

function cliSnippet(os: OS, a: Asset, cli: Downloads) {
  if (os === "windows")
    return `# PowerShell
Invoke-WebRequest -OutFile zknet.exe ${a.url}
(Get-FileHash zknet.exe -Algorithm SHA256).Hash   # must be ${a.sha256 ?? "the one in checksums.txt"}
.\\zknet.exe list`;
  const check = os === "macos" ? "shasum -a 256 -c" : "sha256sum --check";
  const verify = a.sha256
    ? `echo "${a.sha256}  ${a.name}" | ${check}`
    : cli.checksums
      ? `curl -fL ${cli.checksums} | grep ${a.name} | ${check}`
      : "";
  return [
    `curl -fLO ${a.url}`,
    ...(verify ? [verify] : []),
    `install -m 0755 ${a.name} ~/.local/bin/zknet`,
    "",
    "zknet list                 # the mix networks you can join",
    "zknet connect <network-id> # download its assets and connect",
  ].join("\n");
}

function Cli({ releases, platform }: Loaded) {
  const cli = releases?.["client-cli"];
  const os = platform && DESKTOP_OS.includes(platform.os) ? platform.os : "linux";
  // a phone or tablet gets the server default: Linux x86_64
  const arch = platform?.os === "linux" && platform.arch === "arm64" ? "arm64" : "x86_64";
  const [asset] = assetsFor(cli, { os, arch });
  if (releases && !cli && !config.siteUrl) return null;
  return (
    <section id="cli" className="max-w-6xl mx-auto px-4 py-12 grid lg:grid-cols-[1fr_1.4fr] gap-8">
      <div className="space-y-3">
        <h2 className="text-2xl">Command line</h2>
        <p className="opacity-80">
          <code>zknet</code> is the client for servers and terminals: it lists the mix networks and
          connects to one. It is a single binary with no runtime dependencies.
        </p>
        {cli && (
          <p className="text-sm opacity-70">
            zknet {cli.version} · {cli.date} ·{" "}
            {cli.assets.map((a) => `${a.os}-${a.arch}`).join(", ")}
          </p>
        )}
      </div>
      <div className="space-y-4 min-w-0">
        {config.siteUrl && os !== "windows" && (
          <div>
            <p className="text-sm mb-2">Install with the script:</p>
            <Code>{`curl -fsSL ${config.siteUrl}/install.sh | sh`}</Code>
          </div>
        )}
        {cli && asset && (
          <div>
            <p className="text-sm mb-2">
              {config.siteUrl && os !== "windows" ? "Or by hand" : "By hand"}, {OS_LABEL[os]}{" "}
              {asset.arch}:
            </p>
            <Code>{cliSnippet(os, asset, cli)}</Code>
          </div>
        )}
        {!releases && <div className="skeleton h-32" />}
      </div>
    </section>
  );
}

const STEPS: [string, ReactNode][] = [
  ["Install", "Download the client for your platform above and install it."],
  [
    "Connect",
    <>
      Pick a mix network in the client and connect, or run{" "}
      <code>zknet connect &lt;network-id&gt;</code>.
    </>,
  ],
  [
    "Point your wallet at it",
    <>
      WalletShield gives your wallet a local RPC endpoint.{" "}
      <Link className="link link-primary" href={config.walletDocsUrl}>
        How to set up your wallet
      </Link>
    </>,
  ],
];

const More = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="card bg-base-200 border border-base-300">
    <div className="card-body">
      <h3 className="card-title text-sm">{title}</h3>
      {children}
    </div>
  </div>
);

export default function App() {
  const [releases, setReleases] = useState<Releases | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);

  useEffect(() => {
    void detectPlatform().then(setPlatform);
    void loadReleases().then(setReleases);
  }, []);

  const pick = (os: OS) => setPlatform({ os, arch: "x86_64" });
  const checksums = releases?.client?.checksums ?? releases?.["client-cli"]?.checksums;

  return (
    <div className="min-h-screen bg-base-100 text-base-content font-sans">
      <Header />

      <main>
        <section className="max-w-6xl mx-auto px-4 pt-6 pb-12 grid lg:grid-cols-[1.2fr_1fr] gap-10 items-start">
          <div className="space-y-5 min-w-0">
            <h1 className="text-3xl sm:text-4xl leading-tight">
              Get <span className="text-primary">ZKNetwork</span>
            </h1>
            <p className="text-lg">
              ZKNetwork is privacy-first infrastructure for sovereign coordination. Post-quantum
              mixnets, zero-knowledge cryptography, and tamper-resistant edge hardware, forged into
              one modular substrate, private from the core to the edge.
            </p>
            <p className="opacity-80">
              WalletShield is the first app on ZKNet: a local RPC endpoint for wallets that carries
              their blockchain RPC requests, for Ethereum and other chains, through the{" "}
              <a className="link" href="https://katzenpost.network">
                Katzenpost
              </a>{" "}
              mixnet to an exit that forwards them to an RPC provider, so the provider sees the
              request but not who sent it. The desktop and command-line clients run it for you.
            </p>
            <div role="note" className="alert alert-outline border-secondary text-sm">
              <span className="badge badge-secondary font-display">BETA</span>
              <span>
                <strong>ZKNet is beta software.</strong> Expect breaking changes between releases.
              </span>
            </div>
          </div>
          <DesktopDownload releases={releases} platform={platform} onPick={pick} />
        </section>

        <section className="bg-base-200 border-y border-base-300">
          <div className="max-w-6xl mx-auto px-4 py-12">
            <h2 className="text-2xl mb-6">Get started</h2>
            <ol className="grid md:grid-cols-3 gap-6">
              {STEPS.map(([title, body], i) => (
                <li key={title} className="flex gap-4">
                  <span className="font-display text-primary text-2xl">{i + 1}</span>
                  <div>
                    <h3 className="text-sm mb-1">{title}</h3>
                    <p className="opacity-80 text-sm">{body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <Cli releases={releases} platform={platform} />

        <section id="verify" className="max-w-6xl mx-auto px-4 pb-12 grid md:grid-cols-3 gap-6">
          <More title="Verify a download">
            <p className="text-sm opacity-80">
              Every release publishes <code>checksums.txt</code> with the SHA-256 of each file.
              Compare it with your download.
            </p>
            <Link className="link link-primary text-sm" href={checksums ?? ""}>
              checksums.txt
            </Link>
          </More>
          {config.sourceUrl && (
            <More title="Build from source">
              <p className="text-sm opacity-80">
                ZKNet is open source. The repository's README covers building every client.
              </p>
              <Link className="link link-primary text-sm" href={config.sourceUrl}>
                Source
              </Link>
            </More>
          )}
          {config.docsUrl && (
            <More title="Documentation">
              <p className="text-sm opacity-80">
                Installing, connecting and configuring your wallet, step by step.
              </p>
              <Link className="link link-primary text-sm" href={config.docsUrl}>
                Docs
              </Link>
            </More>
          )}
        </section>
      </main>

      <footer className="border-t border-base-300">
        <div className="max-w-6xl mx-auto px-4 py-8 text-sm opacity-70 flex flex-col sm:flex-row gap-2 justify-between">
          <p>This page sets no cookies and runs no analytics.</p>
          <p>AGPL-3.0</p>
        </div>
      </footer>
    </div>
  );
}
