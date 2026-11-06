# install.sh

`../public/install.sh` installs the ZKNet command-line client, `zknet`, on Linux and macOS:

```sh
curl -fsSL https://get.zknet.io/install.sh | sh
curl -fsSL https://get.zknet.io/install.sh | sh -s -- --help
```

It reads `https://dist.zknet.io/updates/client-cli/<channel>/downloads.json`, picks the `binary` asset for the machine (the exact arch first, then `universal`), downloads it, checks its size and SHA-256 against that file, and checks that it starts (`zknet --version`). Only then does it rename it into `~/.local/bin` (or `$XDG_BIN_HOME`, `--dir`, `ZKNET_INSTALL_DIR`). It is POSIX `sh`. It never uses `sudo`, never prompts, and never edits shell profiles: when the directory is not on `PATH`, it prints the line to add.

Each line of the script is inside a function, and only the last line calls `main`. If the download stops part way, the script runs nothing.

## What the checksum does and does not prove

The SHA-256 comes from `downloads.json`, which is served by the same host chain as the binary. The checksum catches a corrupted or truncated download, and a binary that was swapped on its own. It does not catch an attacker who controls the host or the path to it, because that attacker can change both files. TLS and the HTTPS-only rule (no redirect down to HTTP, except the loopback tests) are what protect that path. To do better than that, the binary has to be checked against a key the host does not hold: a signature checked against a public key pinned in the script.

## Tests

```sh
sh test.sh                          # this machine's sh, against loopback fixtures
TEST_SH='bash --posix' sh test.sh   # another shell
sh matrix.sh                        # Alpine (BusyBox), Debian, Ubuntu, Fedora in Docker
ZKNET_TEST_BINARY=<zknet> sh matrix.sh   # serve a real zknet build instead of a fake
shellcheck -s sh ../public/install.sh test.sh matrix.sh
```

`test.sh` needs `python3`. `serve.py` serves the fixtures on 127.0.0.1, and `fixtures.py` writes a fake `zknet` and the `downloads.json` variants. The installer gets a fresh `HOME` and only the environment the case sets (`env -i`). Platforms are faked with `uname` and `sysctl` shims. The cases cover:

- the happy path, with `downloads.json` both pretty-printed and on one line, curl and wget, and `curl | sh -s --`;
- refusals: checksum mismatch (an existing install is kept), size mismatch, a missing SHA-256, a non-HTTPS URL, a binary that cannot start, an unsupported OS or arch, and a version pin that does not match the channel;
- macOS: Rosetta 2, and per-arch versus universal builds;
- uninstall;
- a script cut off at several points, which fetches nothing.

`matrix.sh` installs `python3` and the downloader under test in each image, so it needs network access to the distribution mirrors.
