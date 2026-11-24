// What the site's pages share: the header, the footer, links and code blocks.
import type { ReactNode } from "react";

// A link whose URL is empty is not shown
export const Link = ({
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

export const Code = ({ children }: { children: string }) => (
  <pre className="bg-base-300 rounded-box p-4 overflow-x-auto text-sm leading-relaxed">
    <code>{children}</code>
  </pre>
);

// The header's links, [label, href]; an empty href is hidden
export function Header({ nav }: { nav: [string, string][] }) {
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
        {nav.map(([label, href]) => (
          <Link key={label} className="btn btn-ghost btn-sm" href={href}>
            {label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export const Footer = () => (
  <footer className="border-t border-base-300">
    <div className="max-w-6xl mx-auto px-4 py-8 text-sm opacity-70 flex flex-col sm:flex-row gap-2 justify-between">
      <p>This page sets no cookies and runs no analytics.</p>
      <p>AGPL-3.0</p>
    </div>
  </footer>
);
