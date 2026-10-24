"""served.sh: the dist export in the clients' download layout, and its contract."""

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parents[1]
SERVED_SH = HERE / 'served.sh'

BUILDS = {  # a goreleaser dist: build directory -> binary
    'linux-amd64_linux_amd64_v1': 'walletshield',
    'linux-arm64_linux_arm64_v8.0': 'walletshield',
    'darwin-amd64_darwin_amd64_v1': 'walletshield',
    'darwin-arm64_darwin_arm64_v8.0': 'walletshield',
    'darwin-universal_darwin_all': 'walletshield',
    'windows-amd64_windows_amd64_v1': 'walletshield.exe',
}


def platforms() -> dict[str, str]:
    """served.sh's map: goreleaser build id -> client platform name."""
    block = re.search(r'^platforms=\((.*?)^\)', SERVED_SH.read_text(), re.M | re.S).group(1)
    return dict(line.split('=') for line in block.split())


class ServedTest(unittest.TestCase):
    def setUp(self):
        self.dist = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dist)
        for build, binary in BUILDS.items():
            (self.dist / build).mkdir()
            (self.dist / build / binary).write_text(build)

    def served(self):
        return subprocess.run([SERVED_SH, self.dist], capture_output=True, text=True)

    def test_exports_every_client_platform_with_checksums(self):
        self.assertEqual(self.served().returncode, 0)
        served = self.dist / 'served'
        self.assertEqual(sorted(p.name for p in served.iterdir()), [
            'checksums.txt', 'walletshield-linux-arm64', 'walletshield-linux-x64',
            'walletshield-macos-arm64', 'walletshield-macos-x64', 'walletshield-windows-x64',
        ])
        # per-arch, not the universal binary: Cloudflare Pages caps a file at 25 MiB
        self.assertEqual((served / 'walletshield-macos-arm64').read_text(), 'darwin-arm64_darwin_arm64_v8.0')
        self.assertEqual((served / 'walletshield-macos-x64').read_text(), 'darwin-amd64_darwin_amd64_v1')
        self.assertEqual((served / 'walletshield-windows-x64').read_text(), 'windows-amd64_windows_amd64_v1')
        check = subprocess.run(['sha256sum', '-c', 'checksums.txt'], cwd=served, capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stdout)
        self.assertEqual(len(check.stdout.splitlines()), 5)

    def test_replaces_a_previous_export(self):
        self.served()
        (self.dist / 'served' / 'walletshield-freebsd-x64').write_text('stale')
        self.served()
        self.assertFalse((self.dist / 'served' / 'walletshield-freebsd-x64').exists())

    def test_fails_without_a_build_for_a_platform(self):
        shutil.rmtree(self.dist / 'windows-amd64_windows_amd64_v1')
        result = self.served()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('one WalletShield build for windows-amd64', result.stderr)


class ContractTest(unittest.TestCase):
    def test_platform_names_match_the_clients(self):
        # both clients take their platform from zknet_core::network::Platform
        rust = (WORKSPACE / 'libs/rs-core/src/network.rs').read_text()
        mapping = rust.split('pub fn from_os_arch', 1)[1].split('_ => return', 1)[0]
        names = set(platforms().values())
        self.assertEqual(set(re.findall(r'=> "([a-z0-9-]+)",', mapping)), names)

    def test_platforms_are_goreleaser_build_ids(self):
        config = (HERE / '.goreleaser.yaml').read_text()
        builds = set(re.findall(r'^\s+(?:- )?(?:&\w+\s+)?id: ([\w-]+)$', config, re.M))
        self.assertLessEqual(set(platforms()), builds)

    def test_the_universal_binary_keeps_its_per_arch_builds(self):
        config = (HERE / '.goreleaser.yaml').read_text()
        universal = config.split('universal_binaries:', 1)[1].split('\n\n', 1)[0]
        self.assertIn('replace: false', universal)


if __name__ == '__main__':
    unittest.main()
