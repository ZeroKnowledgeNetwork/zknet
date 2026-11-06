"""Write the install.sh test fixtures: a fake zknet and the downloads.json
variants that serve it.

    python3 -I fixtures.py <root> <port> [<binary>]

<root>/updates/client-cli/<channel>/downloads.json is one variant per
"channel"; the tests pick a variant by passing --channel. <binary> replaces
the fake zknet with a real one (it must run here with --version).
"""

import copy
import hashlib
import json
import os
import shutil
import sys

root, port = sys.argv[1:3]
binary = sys.argv[3] if len(sys.argv) > 3 else None

files = os.path.join(root, "files")
os.makedirs(files, exist_ok=True)
zknet = os.path.join(files, "zknet")
if binary:
    shutil.copyfile(binary, zknet)
else:
    with open(zknet, "w") as f:
        f.write('#!/bin/sh\necho "zknet 9.9.9-test"\n')
os.chmod(zknet, 0o755)
data = open(zknet, "rb").read()
sha256 = hashlib.sha256(data).hexdigest()

# A zknet that cannot start: its loader is missing, as for a glibc build on
# musl
norun = os.path.join(files, "zknet-norun")
with open(norun, "w") as f:
    f.write("#!/nonexistent/ld-linux\n")
norun_data = open(norun, "rb").read()


def asset(os_, arch, name=None):
    name = name or f"zknet_9.9.9-test_{os_}-{arch}"
    return {
        "os": os_,
        "arch": arch,
        "kind": "binary",
        "name": name,
        "url": f"http://127.0.0.1:{port}/files/zknet",
        "size": len(data),
        "sha256": sha256,
    }


good = {
    "schema": 1,
    "id": "client-cli",
    "channel": "beta",
    "version": "9.9.9-test",
    "date": "2026-11-05",
    "notes": None,
    "checksums": None,
    "assets": [
        asset("linux", "x86_64"),
        asset("linux", "arm64"),
        asset("macos", "universal"),
        asset("windows", "x86_64", "zknet_9.9.9-test_windows-x86_64.exe"),
    ],
}


def variant(change):
    d = copy.deepcopy(good)
    change(d)
    return d


def each_asset(**fields):
    def change(d):
        for a in d["assets"]:
            a.update(fields)

    return change


def per_arch_macos(d):
    d["assets"] = [
        asset("macos", "x86_64"),
        asset("macos", "arm64"),
        asset("macos", "universal"),
    ]


def cannot_start(d):
    for a in d["assets"]:
        a.update(
            url=a["url"].replace("/files/zknet", "/files/zknet-norun"),
            size=len(norun_data),
            sha256=hashlib.sha256(norun_data).hexdigest(),
        )


variants = {
    "beta": (good, 2),  # pretty-printed, as snapshot.mjs writes it
    "compact": (good, None),  # one line
    "badsum": (variant(each_asset(sha256="0" * 64)), 2),
    "nosum": (variant(each_asset(sha256=None)), 2),
    "badsize": (variant(each_asset(size=len(data) + 1)), 2),
    "plainhttp": (variant(each_asset(url="http://example.org/zknet")), 2),
    "wrongid": (variant(lambda d: d.update(id="client")), 2),
    "permac": (variant(per_arch_macos), 2),
    "norun": (variant(cannot_start), 2),
    "nolinux": (variant(lambda d: d.update(assets=[asset("macos", "universal")])), 2),
}
for channel, (doc, indent) in variants.items():
    out = os.path.join(root, "updates", "client-cli", channel)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "downloads.json"), "w") as f:
        json.dump(doc, f, indent=indent)
