#!/bin/sh
# Run ../public/install.sh against loopback fixtures and check what it does.
#
#   sh test.sh                          # under this machine's sh
#   TEST_SH='bash --posix' sh test.sh   # under another shell
#   ZKNET_TEST_BINARY=<path> sh test.sh # serve a real zknet instead of a fake
#
# Needs python3 (the fixture server). Each case runs the installer with a fresh
# HOME and only the environment the case sets; faked platforms come from uname
# and sysctl shims on PATH.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
script=$here/../public/install.sh
work=$(mktemp -d "${TMPDIR:-/tmp}/zknet-install-test.XXXXXX")
server=

cleanup() {
	[ -z "$server" ] || kill "$server" 2>/dev/null || true
	rm -rf "$work"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

# shellcheck disable=SC2086 # TEST_SH is a command line: a shell and its flags
set -- ${TEST_SH:-sh}
shell=$(command -v "$1")
shift
shell_args="$*"

mkdir -p "$work/www" "$work/shims"
python3 -I "$here/serve.py" "$work/www" "$work/port" "$work/requests" &
server=$!
i=0
while [ ! -s "$work/port" ]; do
	i=$((i + 1))
	[ $i -le 100 ] || { echo "fixture server did not start" >&2; exit 1; }
	sleep 0.1
done
port=$(cat "$work/port")
python3 -I "$here/fixtures.py" "$work/www" "$port" ${ZKNET_TEST_BINARY:+"$ZKNET_TEST_BINARY"}
base=http://127.0.0.1:$port/updates

cat >"$work/shims/uname" <<'EOF'
#!/bin/sh
case $1 in -s) echo "$FAKE_UNAME_S" ;; -m) echo "$FAKE_UNAME_M" ;; esac
EOF
cat >"$work/shims/sysctl" <<'EOF'
#!/bin/sh
echo "hw.optional.arm64: ${FAKE_ARM64:-0}"
EOF
chmod 755 "$work/shims/uname" "$work/shims/sysctl"

# A PATH holding only the tools install.sh uses, plus those named in $1.
tools_path() {
	dir=$work/path.$1
	mkdir -p "$dir"
	for t in uname sed tr grep head cut wc mktemp rm mkdir cp mv chmod cat sha256sum shasum $2; do
		p=$(command -v "$t" 2>/dev/null) || continue
		ln -sf "$p" "$dir/$t"
	done
	printf '%s\n' "$dir"
}

passed=0
failed=0
n=0
home=
status=
case_name=

# begin <name>: a new case with a fresh HOME
begin() {
	n=$((n + 1))
	case_name=$1
	home=$work/home.$n
	mkdir -p "$home"
	: >"$work/requests"
	# the case's environment: install.sh sees only these and HOME
	e_path=$PATH e_s='' e_m='' e_arm='' e_dir='' e_ver='' e_xdg=''
}

# install [args...]: run `sh install.sh [args...]` in the case's environment
# and nothing else (env -i), output in $work/out
install() {
	# shellcheck disable=SC2086 # unset e_* drop out; set ones hold no spaces
	if env -i HOME="$home" PATH="$e_path" TMPDIR="${TMPDIR:-/tmp}" ZKNET_DOWNLOADS_BASE="$base" \
		${e_s:+FAKE_UNAME_S=$e_s} ${e_m:+FAKE_UNAME_M=$e_m} ${e_arm:+FAKE_ARM64=$e_arm} \
		${e_dir:+ZKNET_INSTALL_DIR=$e_dir} ${e_ver:+ZKNET_VERSION=$e_ver} \
		${e_xdg:+XDG_BIN_HOME=$e_xdg} \
		"$shell" $shell_args "$script" "$@" >"$work/out" 2>&1 </dev/null; then
		status=0
	else
		status=$?
	fi
}

fail() {
	failed=$((failed + 1))
	printf 'FAIL  %s: %s\n' "$case_name" "$1"
	sed 's/^/      | /' "$work/out"
}

# check <description> <test...>
check() {
	what=$1
	shift
	"$@" || { fail "$what"; return 1; }
}

done_case() {
	passed=$((passed + 1))
	printf 'ok    %s\n' "$case_name"
}

out_has() { grep -qF -- "$1" "$work/out"; }
exited() { [ "$status" = "$1" ]; }
failed_() { [ "$status" != 0 ]; }
runs() { [ "$("$1" --version </dev/null)" != "" ]; }
absent() { [ ! -e "$1" ]; }
same() { [ "$(cksum <"$1")" = "$(cksum <"$2")" ]; }
untouched() { ! grep -q /files/ "$work/requests"; }
nothing_fetched() { [ ! -s "$work/requests" ]; }

bin=.local/bin/zknet
shims=$work/shims:$PATH

# A real binary that cannot start here (a glibc build on musl, say): the one
# thing to check is that the installer refuses it and says why.
if [ -n "${ZKNET_TEST_BINARY:-}" ] && ! "$ZKNET_TEST_BINARY" --version >/dev/null 2>&1 </dev/null; then
	begin "the real zknet cannot start here: refuses, names the C library"
	install
	check "nonzero" failed_ && check "says why" out_has "needs glibc" &&
		check "nothing installed" absent "$home/$bin" && done_case
	echo
	echo "$passed passed, $failed failed (shell: $shell${shell_args:+ $shell_args}; real binary does not run here)"
	[ "$failed" = 0 ]
	exit
fi

begin "--help prints usage and fetches nothing"
install --help
check "exit 0" exited 0 && check "usage" out_has "Usage: install.sh" &&
	check "no request" nothing_fetched && done_case

begin "happy path: installs, verifies, runs, hints PATH"
install
check "exit 0" exited 0 && check "installed" runs "$home/$bin" &&
	check "verified" out_has "verified SHA-256" &&
	check "PATH hint" out_has "is not on your PATH" && done_case

begin "happy path, one-line downloads.json"
install --channel compact
check "exit 0" exited 0 && check "installed" runs "$home/$bin" && done_case

begin "dir already on PATH: says what to run next"
e_path="$home/.local/bin:$PATH"
install
check "exit 0" exited 0 && check "next step" out_has "Next: run  zknet --help" && done_case

begin "curl | sh -s -- <args>: options through the pipe"
# shellcheck disable=SC2016 # the inner sh expands $1, $2 and $HOME
if env -i HOME="$home" PATH="$PATH" ZKNET_DOWNLOADS_BASE="$base" \
	sh -c 'cat "$1" | "$2" -s -- --dir "$HOME/piped"' _ "$script" "$shell" >"$work/out" 2>&1; then
	status=0
else
	status=$?
fi
check "exit 0" exited 0 && check "installed" runs "$home/piped/zknet" && done_case

begin "--dir and ZKNET_INSTALL_DIR choose the directory"
install --dir "$home/a"
s1=$status
e_dir=$home/b
install
check "--dir" [ "$s1" = 0 ] && check "--dir installed" runs "$home/a/zknet" &&
	check "env" exited 0 && check "env installed" runs "$home/b/zknet" && done_case

begin "XDG_BIN_HOME is the default directory when set"
e_xdg=$home/xdg
install
check "exit 0" exited 0 && check "installed" runs "$home/xdg/zknet" && done_case

begin "reinstall replaces the binary in place"
install
cp "$home/$bin" "$work/first" 2>/dev/null || :
printf 'stale\n' >"$home/$bin"
install
check "exit 0" exited 0 && check "replaced" same "$home/$bin" "$work/first" &&
	check "no temp left" [ -z "$(find "$home/.local/bin" -name '.zknet.new.*')" ] && done_case

begin "checksum mismatch: refuses, installs nothing"
install --channel badsum
check "nonzero" failed_ && check "says why" out_has "SHA-256 mismatch" &&
	check "nothing installed" absent "$home/$bin" && done_case

begin "checksum mismatch keeps the existing install"
install
cp "$home/$bin" "$work/before" 2>/dev/null || :
install --channel badsum
check "nonzero" failed_ && check "kept" same "$home/$bin" "$work/before" && done_case

begin "size mismatch: refuses"
install --channel badsize
check "nonzero" failed_ && check "says why" out_has "size mismatch" &&
	check "nothing installed" absent "$home/$bin" && done_case

begin "no SHA-256 in downloads.json: refuses before downloading"
install --channel nosum
check "nonzero" failed_ && check "says why" out_has "has no SHA-256" &&
	check "binary not fetched" untouched && done_case

begin "asset URL not HTTPS: refuses"
install --channel plainhttp
check "nonzero" failed_ && check "says why" out_has "refusing a URL that is not HTTPS" && done_case

begin "downloads.json for another component: refuses"
install --channel wrongid
check "nonzero" failed_ && check "says why" out_has "not a schema 1 downloads.json for client-cli" && done_case

begin "missing channel: refuses"
install --channel nosuch
check "nonzero" failed_ && check "says why" out_has "download failed" && done_case

begin "--version matching the channel: installs"
install --version 9.9.9-test
check "exit 0" exited 0 && check "installed" runs "$home/$bin" && done_case

begin "--version not the channel's current: refuses"
e_ver=1.0.0
install
check "nonzero" failed_ && check "says why" out_has "current release is 9.9.9-test, not 1.0.0" &&
	check "binary not fetched" untouched && done_case

begin "downloaded binary cannot start: refuses, installs nothing"
e_s=Linux e_m=x86_64 e_path=$shims
install --channel norun
check "nonzero" failed_ && check "says why" out_has "needs glibc 2.31 or newer" &&
	check "names the libc" out_has "this system has" &&
	check "nothing installed" absent "$home/$bin" && done_case

begin "unknown option: refuses"
install --frobnicate
check "nonzero" failed_ && check "says why" out_has "unknown option: --frobnicate" && done_case

begin "--uninstall removes the binary"
install
: >"$work/requests"
install --uninstall
check "exit 0" exited 0 && check "removed" absent "$home/$bin" && check "said" out_has "removed" &&
	check "no request" nothing_fetched && done_case

begin "unsupported OS (FreeBSD): refuses before any download"
e_s=FreeBSD e_m=amd64 e_path=$shims
install
check "nonzero" failed_ && check "says why" out_has "unsupported operating system: FreeBSD" &&
	check "no request" nothing_fetched && done_case

begin "unsupported arch (Linux riscv64): refuses"
e_s=Linux e_m=riscv64 e_path=$shims
install
check "nonzero" failed_ && check "says why" out_has "unsupported architecture: riscv64" && done_case

begin "Windows shell (MINGW64): points to the site"
e_s=MINGW64_NT-10.0 e_m=x86_64 e_path=$shims
install
check "nonzero" failed_ && check "says why" out_has "on Windows, download zknet from" && done_case

begin "Linux aarch64 picks linux-arm64"
e_s=Linux e_m=aarch64 e_path=$shims
install
check "exit 0" exited 0 && check "asset" out_has "(zknet_9.9.9-test_linux-arm64)" && done_case

begin "release without this platform: refuses"
e_s=Linux e_m=x86_64 e_path=$shims
install --channel nolinux
check "nonzero" failed_ && check "says why" out_has "has no build for linux x86_64" && done_case

begin "macOS arm64 takes the universal build"
e_s=Darwin e_m=arm64 e_path=$shims
install
check "exit 0" exited 0 && check "asset" out_has "(zknet_9.9.9-test_macos-universal)" && done_case

begin "macOS: a per-arch build wins over universal"
e_s=Darwin e_m=x86_64 e_path=$shims
install --channel permac
check "exit 0" exited 0 && check "asset" out_has "(zknet_9.9.9-test_macos-x86_64)" && done_case

begin "macOS under Rosetta 2 gets the arm64 build"
e_s=Darwin e_m=x86_64 e_arm=1 e_path=$shims
install --channel permac
check "exit 0" exited 0 && check "asset" out_has "(zknet_9.9.9-test_macos-arm64)" && done_case

if command -v wget >/dev/null 2>&1; then
	begin "wget only (no curl): installs"
	e_path=$(tools_path wget wget)
	install
	check "exit 0" exited 0 && check "installed" runs "$home/$bin" && done_case
else
	echo "skip  wget only (no curl): wget is not installed"
fi

begin "neither curl nor wget: says so"
e_path=$(tools_path none "")
install
check "nonzero" failed_ && check "says why" out_has "neither curl nor wget is installed" && done_case

# A cut-off download must run nothing: every cut point fetches nothing and
# installs nothing.
size=$(wc -c <"$script" | tr -d ' ')
last=$(tail -n 1 "$script" | wc -c | tr -d ' ')
for cut in $((size / 4)) $((size / 2)) $((size * 3 / 4)) $((size - last)) $((size - 2)); do
	begin "script cut off at byte $cut of $size: runs nothing"
	dd if="$script" bs="$cut" count=1 2>/dev/null >"$work/cut.sh"
	# shellcheck disable=SC2086
	env -i HOME="$home" PATH="$PATH" ZKNET_DOWNLOADS_BASE="$base" "$shell" $shell_args "$work/cut.sh" \
		>"$work/out" 2>&1 </dev/null || true
	check "no request" nothing_fetched && check "nothing installed" absent "$home/$bin" && done_case
done

echo
echo "$passed passed, $failed failed (shell: $shell${shell_args:+ $shell_args})"
[ "$failed" = 0 ]
