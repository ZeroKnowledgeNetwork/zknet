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
INDEX = server.PROJECT / 'index.sh'
FIXTURE = server.PROJECT / 'fixtures' / 'networks.json'
# the network.json lines behind FIXTURE, which the clients' tests parse
FIXTURE_NETWORKS = {
    'dev-local': {'id': 'dev-local', 'kind': 'local', 'name': 'Local · 2026-10-23', 'created': '2026-10-23T08:00:00Z'},
    'devnet-78c3de28': {'id': 'devnet-78c3de28', 'kind': 'devnet', 'name': 'Devnet · 2026-10-23',
                        'created': '2026-10-23T12:00:00Z'},
}
BINARIES = ['walletshield-linux-arm64', 'walletshield-linux-x64', 'walletshield-macos-arm64', 'walletshield-macos-x64',
            'walletshield-windows-x64']
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

    def assemble(self, network_id='dev-local', *extra, options=(), check=True):
        return self.run_script(ASSEMBLE, '--served', self.served, '--out', self.output, *options,
                               network_id, self.client_config, self.services, *extra, check=check)

    def run_script(self, *args, check=True):
        result = subprocess.run(args, capture_output=True, text=True)
        if check and result.returncode:
            self.fail(result.stderr)
        return result

    def networks(self):
        return sorted(p.name for p in self.output.iterdir() if p.is_dir())

    def index(self):
        return json.loads((self.output / 'networks.json').read_text())


class AssembleTest(Fixture):
    def test_publishes_the_client_url_layout_with_checksums(self):
        self.assemble()
        assets = self.output / 'dev-local'
        self.assertEqual(sorted(p.name for p in assets.iterdir()),
                         ['checksums.txt', 'client.toml', 'network.json', 'services.json', *BINARIES])
        self.assertEqual((assets / 'client.toml').read_text(), CLIENT_CONFIG)
        check = subprocess.run(['sha256sum', '--check', '--strict', 'checksums.txt'], cwd=assets,
                               capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stdout)
        self.assertEqual(len(check.stdout.splitlines()), len(BINARIES) + 2)

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
        self.assertEqual(self.networks(), ['dev-local', 'devnet-test'])
        self.assertEqual({p.name: p.read_bytes() for p in (self.output / 'dev-local').iterdir()}, first)
        self.assertIn('203.0.113.8', (self.output / 'devnet-test' / 'client.toml').read_text())

    def test_reassembling_replaces_the_network(self):
        self.assemble()
        stale = self.output / 'dev-local' / 'walletshield-freebsd-x64'
        stale.write_bytes(b'stale')
        self.assemble()
        self.assertFalse(stale.exists())
        self.assertEqual(self.networks(), ['dev-local'])

    def test_refuses_binaries_that_fail_the_build_checksums(self):
        (self.served / 'walletshield-macos-arm64').write_text('corrupted')
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
        for network_id in ['../escape', 'a/b', '.hidden', '', 'Dev', 'list', 'connect', 'help', 'a' * 65]:
            with self.subTest(network_id=network_id):
                result = self.assemble(network_id, check=False)
                self.assertIn('invalid network id', result.stderr)
        self.assertFalse(self.output.exists())


class IndexTest(Fixture):
    def test_lists_every_assembled_network_newest_first(self):
        self.assemble('dev-local')
        self.assemble('devnet-a', options=['--name', 'Devnet "A" \\ one'])
        index = self.index()
        self.assertEqual(index['schema'], 1)
        self.assertEqual([n['id'] for n in index['networks']], ['devnet-a', 'dev-local'])
        self.assertEqual([n['kind'] for n in index['networks']], ['devnet', 'local'])
        self.assertEqual(index['networks'][0]['name'], 'Devnet "A" \\ one')
        local = index['networks'][1]
        # the default name: the kind and the date of `created`, no time
        self.assertEqual(local['name'], f"Local · {local['created'][:10]}")
        self.assertRegex(index['networks'][0]['created'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')

    def test_the_default_name_is_the_kind_and_the_day(self):
        self.assemble('devnet-78c3de87')
        (entry,) = self.index()['networks']
        self.assertRegex(entry['name'], r'^Devnet · \d{4}-\d\d-\d\d$')
        self.assertEqual(entry['name'], f"Devnet · {entry['created'][:10]}")

    def test_publishes_pages_headers_and_a_real_404(self):
        self.assemble()
        headers = (self.output / '_headers').read_text()
        self.assertIn('/networks.json\n  Cache-Control: public, max-age=0, must-revalidate', headers)
        self.assertTrue((self.output / '404.html').is_file())

    def test_remove_drops_the_network_and_its_entry(self):
        self.assemble('dev-local')
        self.assemble('devnet-a')
        self.run_script(ASSEMBLE, '--out', self.output, '--remove', 'devnet-a')
        self.assertEqual(self.networks(), ['dev-local'])
        self.assertEqual([n['id'] for n in self.index()['networks']], ['dev-local'])
        result = self.run_script(ASSEMBLE, '--out', self.output, '--remove', 'devnet-a', check=False)
        self.assertIn('no network devnet-a', result.stderr)

    def test_an_empty_directory_has_an_empty_index(self):
        self.output.mkdir()
        self.run_script(INDEX, '--out', self.output)
        self.assertEqual(self.index(), {'schema': 1, 'networks': []})

    def test_skips_staging_directories(self):
        self.assemble()
        staging = self.output / '.assemble-devnet-x.abc'
        staging.mkdir()
        (staging / 'network.json').write_text(json.dumps(FIXTURE_NETWORKS['devnet-78c3de28']) + '\n')
        self.run_script(INDEX, '--out', self.output)
        self.assertEqual([n['id'] for n in self.index()['networks']], ['dev-local'])

    def test_refuses_an_unknown_kind_or_name(self):
        result = self.assemble('lab-1', check=False)
        self.assertIn('pass --kind', result.stderr)
        result = self.assemble('devnet-1', options=['--kind', 'lab'], check=False)
        self.assertIn("unknown network kind 'lab'", result.stderr)
        result = self.assemble('devnet-1', options=['--name', 'a\nb'], check=False)
        self.assertIn('invalid network name', result.stderr)
        self.assertFalse((self.output / 'devnet-1').exists())

    def test_the_client_fixture_is_what_index_writes(self):
        self.output.mkdir()
        for network_id, entry in FIXTURE_NETWORKS.items():
            (self.output / network_id).mkdir()
            (self.output / network_id / 'network.json').write_text(json.dumps(entry, ensure_ascii=False) + '\n')
        self.run_script(INDEX, '--out', self.output)
        self.assertEqual((self.output / 'networks.json').read_text(), FIXTURE.read_text())


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

    def test_serves_the_index(self):
        with urllib.request.urlopen(f'{self.url}/networks.json') as response:
            self.assertEqual([n['id'] for n in json.load(response)['networks']], ['dev-local'])

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
