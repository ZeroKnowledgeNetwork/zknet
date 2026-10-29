#!/usr/bin/env python3
"""Serve assembled network assets to development clients on loopback.

Clients download `<base>/<network id>/{client.toml,services.json,walletshield-<platform>}`.
assemble.sh writes the published root to generated/, its networks in
generated/networks/; this serves that networks directory as the base, on a
loopback-only HTTP server. Python standard library only.

    server.py serve   serve generated/networks/ in the foreground (an Nx continuous task)
    server.py ready   wait until the server answers with the dev-local assets
    server.py url     print the asset base URL for client flags
"""

import argparse
import functools
import hashlib
import http.server
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# The one definition of the local asset endpoint. The desktop's dev-local Tauri
# overlay must repeat it literally as its urlNetwork; tests check they agree.
HOST = '127.0.0.1'
PORT = 8765
NETWORK_ID = 'dev-local'
BASE_URL = f'http://{HOST}:{PORT}'

PROJECT = Path(__file__).resolve().parent
WORKSPACE = PROJECT.parents[1]
OUTPUT = PROJECT / 'generated'
NETWORKS = 'networks'  # the clients' source under a published root, as on Pages
STAGE_HINT = 'run `pnpm nx run network-assets:stage`'


class AssetError(Exception):
    pass


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Handler(http.server.SimpleHTTPRequestHandler):
    def list_directory(self, path):
        self.send_error(404)  # serve files only, never an index


def make_server(output: Path, host: str, port: int) -> http.server.ThreadingHTTPServer:
    handler = functools.partial(Handler, directory=str(output / NETWORKS))
    try:
        return http.server.ThreadingHTTPServer((host, port), handler)
    except OSError as error:
        raise AssetError(
            f'Cannot bind {host}:{port} ({error}). If another process owns it, stop that '
            'process yourself; this server never stops processes it did not start.'
        ) from None


def serve(output: Path = OUTPUT, host: str = HOST, port: int = PORT) -> None:
    if not (output / NETWORKS / NETWORK_ID).is_dir():
        raise AssetError(f'Nothing assembled at {output / NETWORKS / NETWORK_ID}: {STAGE_HINT}')
    server = make_server(output, host, port)
    print(f'Serving {output / NETWORKS} at http://{host}:{port}/ (Ctrl-C stops)', flush=True)
    with server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


def ready(output: Path = OUTPUT, base_url: str = BASE_URL, timeout: float = 15) -> None:
    """Wait until every dev-local asset is served byte-identically."""
    assets = output / NETWORKS / NETWORK_ID
    if not assets.is_dir():
        raise AssetError(f'Nothing assembled at {assets}: {STAGE_HINT}')
    expected = {p.name: sha256(p) for p in assets.iterdir()}
    deadline = time.monotonic() + timeout
    while True:
        try:
            for name, digest in expected.items():
                with urllib.request.urlopen(f'{base_url}/{NETWORK_ID}/{name}', timeout=5) as response:
                    if hashlib.sha256(response.read()).hexdigest() != digest:
                        raise AssetError(f'{base_url} serves a different {name} than {assets}')
            print(f'Ready: {base_url}/{NETWORK_ID}/')
            return
        except (urllib.error.URLError, ConnectionError) as error:
            if time.monotonic() > deadline:
                if isinstance(error, urllib.error.HTTPError):
                    raise AssetError(
                        f'{base_url} answers without the assembled assets ({error}): '
                        'another server holds the port'
                    ) from None
                raise AssetError(
                    f'No local asset server at {base_url} after {timeout:.0f}s ({error}): '
                    'run `pnpm nx run network-assets:serve`'
                ) from None
            time.sleep(0.25)


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('command', choices=['serve', 'ready', 'url'])
    command = parser.parse_args(argv).command
    try:
        if command == 'serve':
            serve()
        elif command == 'ready':
            ready()
        else:
            print(BASE_URL)
    except AssetError as error:
        sys.exit(f'network-assets {command}: {error}')


if __name__ == '__main__':
    main()
