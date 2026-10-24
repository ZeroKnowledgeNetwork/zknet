import contextlib
import io
import json
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import server

ASSEMBLE = server.PROJECT / 'assemble.sh'
BINARIES = ['walletshield-linux-arm64', 'walletshield-linux-x64', 'walletshield-macos', 'walletshield-windows-x64']
# a full config dialing a public gateway: assembly copies whatever the caller passes
CLIENT_CONFIG = '[[PinnedGateways.Gateways]]\n  Addresses = ["tcp://203.0.113.7:30004"]\n'


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class Fixture(unittest.TestCase):
    """A WalletShield export (served/ of walletshield:dist), network files and an output directory."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.served = self.root / 'served'
        self.served.mkdir()
        for name in BINARIES:
            (self.served / name).write_text(name)
        subprocess.run(f'sha256sum {" ".join(BINARIES)} > checksums.txt', shell=True, check=True, cwd=self.served)
        self.client_config = self.root / 'client.toml'
        self.client_config.write_text(CLIENT_CONFIG)
        self.services = self.root / 'services.json'
        self.services.write_text('{"RPCEndpoints": []}\n')
        self.output = self.root / 'generated'

    def assemble(self, network_id='dev-local', *extra, check=True):
        result = subprocess.run(
            [ASSEMBLE, '--served', self.served, '--out', self.output, network_id,
             self.client_config, self.services, *extra],
            capture_output=True, text=True,
        )
        if check and result.returncode:
            self.fail(result.stderr)
        return result


class AssembleTest(Fixture):
    def test_publishes_the_client_url_layout_with_checksums(self):
        self.assemble()
        assets = self.output / 'dev-local'
        self.assertEqual(sorted(p.name for p in assets.iterdir()),
                         ['checksums.txt', 'client.toml', 'services.json', *BINARIES])
        self.assertEqual((assets / 'client.toml').read_text(), CLIENT_CONFIG)
        check = subprocess.run(['sha256sum', '--check', '--strict', 'checksums.txt'], cwd=assets,
                               capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stdout)
        self.assertEqual(len(check.stdout.splitlines()), 6)

    def test_defaults_to_the_network_services_manifest(self):
        result = subprocess.run([ASSEMBLE, '--served', self.served, '--out', self.output, 'dev-local',
                                 self.client_config], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = server.WORKSPACE / 'packages/opt/docker/services.json'
        self.assertEqual((self.output / 'dev-local' / 'services.json').read_bytes(), manifest.read_bytes())

    def test_leaves_other_networks_alone(self):
        self.assemble('dev-local')
        first = {p.name: p.read_bytes() for p in (self.output / 'dev-local').iterdir()}
        self.client_config.write_text(CLIENT_CONFIG.replace('203.0.113.7', '203.0.113.8'))
        self.assemble('devnet-test')
        self.assertEqual(sorted(p.name for p in self.output.iterdir()), ['dev-local', 'devnet-test'])
        self.assertEqual({p.name: p.read_bytes() for p in (self.output / 'dev-local').iterdir()}, first)
        self.assertIn('203.0.113.8', (self.output / 'devnet-test' / 'client.toml').read_text())

    def test_reassembling_replaces_the_network(self):
        self.assemble()
        stale = self.output / 'dev-local' / 'walletshield-freebsd-x64'
        stale.write_bytes(b'stale')
        self.assemble()
        self.assertFalse(stale.exists())
        self.assertEqual(sorted(p.name for p in self.output.iterdir()), ['dev-local'])

    def test_refuses_binaries_that_fail_the_build_checksums(self):
        (self.served / 'walletshield-macos').write_text('corrupted')
        result = self.assemble(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('do not match their build checksums', result.stderr)
        self.assertFalse((self.output / 'dev-local').exists())

    def test_refuses_a_missing_export(self):
        shutil.rmtree(self.served)
        result = self.assemble(check=False)
        self.assertIn('no WalletShield export', result.stderr)
        self.assertIn('.woodpecker/run dist', result.stderr)

    def test_refuses_a_missing_client_config(self):
        self.client_config.unlink()
        self.assertIn('no client config', self.assemble(check=False).stderr)

    def test_refuses_network_ids_that_are_not_one_plain_name(self):
        for network_id in ['../escape', 'a/b', '.hidden', '']:
            with self.subTest(network_id=network_id):
                result = self.assemble(network_id, check=False)
                self.assertIn('invalid network id', result.stderr)
        self.assertFalse(self.output.exists())


class ServeTest(Fixture):
    def setUp(self):
        super().setUp()
        quiet = mock.patch.object(server.Handler, 'log_message', lambda *args: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        self.assemble()
        self.server = server.make_server(self.output, '127.0.0.1', 0)
        self.addCleanup(self.server.server_close)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'

    def test_ready_once_the_assets_are_served(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            server.ready(self.output, self.url, timeout=2)
        self.assertIn('Ready', out.getvalue())

    def test_ready_rejects_a_server_with_other_assets(self):
        other = self.root / 'other'
        shutil.copytree(self.output, other)
        (other / 'dev-local' / 'client.toml').write_text(CLIENT_CONFIG + '# another network\n')
        with self.assertRaisesRegex(server.AssetError, 'different client.toml'):
            server.ready(other, self.url, timeout=2)

    def test_does_not_list_directories(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(f'{self.url}/dev-local/')
        self.assertEqual(error.exception.code, 404)

    def test_refuses_an_occupied_port_without_touching_its_owner(self):
        with self.assertRaisesRegex(server.AssetError, 'never stops processes'):
            server.make_server(self.output, '127.0.0.1', self.server.server_address[1])

    def test_ready_names_a_foreign_server(self):
        empty = self.root / 'empty'
        empty.mkdir()
        foreign = server.make_server(empty, '127.0.0.1', 0)
        self.addCleanup(foreign.server_close)
        threading.Thread(target=foreign.serve_forever, daemon=True).start()
        self.addCleanup(foreign.shutdown)
        with self.assertRaisesRegex(server.AssetError, 'another server'):
            server.ready(self.output, f'http://127.0.0.1:{foreign.server_address[1]}', timeout=0.5)

    def test_ready_fails_visibly_without_a_server(self):
        with self.assertRaisesRegex(server.AssetError, 'network-assets:serve'):
            server.ready(self.output, f'http://127.0.0.1:{free_port()}', timeout=0.5)


class ConsumerContractTest(unittest.TestCase):
    def test_desktop_overlay_targets_this_server(self):
        overlay = json.loads((server.WORKSPACE / 'apps/client/src-tauri/tauri.dev-local.conf.json').read_text())
        self.assertEqual(overlay['plugins']['zknet']['urlNetwork'], server.BASE_URL)

    def test_server_binds_loopback_only(self):
        self.assertEqual(server.HOST, '127.0.0.1')


if __name__ == '__main__':
    unittest.main()
