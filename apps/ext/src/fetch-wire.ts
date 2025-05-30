/*
 * (de)serialise fetch results for transmission between injected <=> content <=> background scripts
 */

export type FetchRequest = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

export type FetchSuccess = {
  tag: 'success';
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyType: 'json' | 'text' | 'arrayBuffer';
  body: unknown; // json | string | Uint8Array
};

export type FetchFailure = {
  tag: 'failure';
  name: string;
  message: string;
};

export type PackedFetchResponse = FetchSuccess | FetchFailure;

export async function packFetchResponse(
  resOrErr: Response | Error
): Promise<PackedFetchResponse> {
  if (resOrErr instanceof Error) {
    return { tag: 'failure', name: resOrErr.name, message: resOrErr.message };
  }

  const res = resOrErr.clone(); // keep original stream
  const ct = res.headers.get('content-type') ?? '';

  const body = ct.includes('application/json')
    ? await res.json()
    : ct.startsWith('text/')
    ? await res.text()
    : /* binary  */ new Uint8Array(await res.arrayBuffer());

  const hdrs: Record<string, string> = {};
  res.headers.forEach((v, k) => (hdrs[k] = v));

  return {
    tag: 'success',
    status: res.status,
    statusText: res.statusText,
    headers: hdrs,
    bodyType: ct.includes('application/json')
      ? 'json'
      : ct.startsWith('text/')
      ? 'text'
      : 'arrayBuffer',
    body,
  };
}

export function unpackFetchResponse(p: PackedFetchResponse): Response {
  if (p.tag === 'failure') {
    const Ctor = (globalThis as any)[p.name] as
      | (new (msg: string) => Error)
      | undefined;
    throw Ctor ? new Ctor(p.message) : new Error(p.message);
  }

  const headers = new Headers(p.headers);
  if (!headers.has('content-type')) {
    if (p.bodyType === 'json') headers.set('content-type', 'application/json');
    else if (p.bodyType === 'text') headers.set('content-type', 'text/plain');
  }

  const bodyInit: BodyInit | null =
    p.bodyType === 'json'
      ? JSON.stringify(p.body)
      : p.bodyType === 'text'
      ? (p.body as string)
      : (p.body as Uint8Array);

  return new Response(bodyInit, {
    status: p.status,
    statusText: p.statusText,
    headers,
  });
}
