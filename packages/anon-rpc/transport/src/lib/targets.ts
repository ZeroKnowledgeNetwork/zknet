// Where a local peer may live. Edit the arrays; the code below only reads them.
//
// A peer is loopback or on the local network; anything else (a public
// address, a host name whose address the worker cannot see) is refused. The
// IP ranges follow the browsers' Local Network Access address spaces.

/** Peer classes. A remote peer has no class: it is refused. */
export type TargetClass = 'loopback' | 'lan';

/** CIDR ranges per class. IPv6 is written without brackets. */
export const TARGET_CIDRS: Readonly<Record<TargetClass, readonly string[]>> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  lan: [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16', // IPv4 link-local
    'fc00::/7', // IPv6 unique local
    'fe80::/10', // IPv6 link-local
  ],
};

/**
 * Host names per class: an exact name, or a suffix starting with `.`.
 * Matched case-insensitively.
 */
export const TARGET_HOSTNAMES: Readonly<Record<TargetClass, readonly string[]>> = {
  loopback: ['localhost'],
  lan: ['.local'], // mDNS, e.g. a ZKNet device on the LAN
};

/** URL schemes a peer may use, per transport. */
export const TARGET_SCHEMES = {
  walletshield: ['http:', 'https:'],
  kpclientd: ['ws:', 'wss:'],
} as const;

/** The class of `url`'s host, or `undefined` when it is not a local peer. */
export function classifyTarget(url: URL): TargetClass | undefined {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ip = parseIp(host);
  for (const cls of ['loopback', 'lan'] as const) {
    if (ip) {
      if (TARGET_CIDRS[cls].some((cidr) => inCidr(ip, cidr))) return cls;
    } else if (
      TARGET_HOSTNAMES[cls].some((name) =>
        name.startsWith('.') ? host.endsWith(name) : host === name,
      )
    ) {
      return cls;
    }
  }
  return undefined;
}

type Ip = { v: 4 | 6; bytes: Uint8Array };

function inCidr(ip: Ip, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const net = parseIp(base);
  if (!net || net.v !== ip.v) return false;
  const bits = Number(bitsText);
  for (let i = 0; i < bits; i++) {
    const mask = 0x80 >> (i % 8);
    if ((ip.bytes[i >> 3] & mask) !== (net.bytes[i >> 3] & mask)) return false;
  }
  return true;
}

/** Parse a dotted IPv4 or a (WHATWG-normalized) IPv6 literal; `undefined` for a name. */
function parseIp(text: string): Ip | undefined {
  const v4 = parseIpv4(text);
  if (v4) return { v: 4, bytes: v4 };
  if (!text.includes(':')) return undefined;
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const words = (part: string): number[] | undefined => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      // An embedded IPv4 tail (`::ffff:1.2.3.4`); WHATWG URL rewrites it to hex, but be lenient.
      const tail = parseIpv4(group);
      if (tail) out.push((tail[0] << 8) | tail[1], (tail[2] << 8) | tail[3]);
      else if (/^[0-9a-f]{1,4}$/.test(group)) out.push(parseInt(group, 16));
      else return undefined;
    }
    return out;
  };
  const head = words(halves[0]);
  const tail = halves.length === 2 ? words(halves[1]) : [];
  if (!head || !tail) return undefined;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const all = [...head, ...Array.from({ length: fill }, () => 0), ...tail];
  const bytes = new Uint8Array(16);
  all.forEach((w, i) => {
    bytes[2 * i] = w >> 8;
    bytes[2 * i + 1] = w & 0xff;
  });
  // An IPv4-mapped address classifies as the IPv4 address it carries.
  if (all.slice(0, 5).every((w) => w === 0) && all[5] === 0xffff)
    return { v: 4, bytes: bytes.slice(12) };
  return { v: 6, bytes };
}

function parseIpv4(text: string): Uint8Array | undefined {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255))
    return undefined;
  return Uint8Array.from(parts.map(Number));
}
