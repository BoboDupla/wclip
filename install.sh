#!/bin/sh
# Install the wclip release binary for this machine.
#
#   curl -fsSL https://github.com/BoboDupla/wclip/releases/latest/download/install.sh | sh
#   sh install.sh --version v0.5.1 --bin-dir ~/bin
#
# POSIX sh on purpose: this is piped into dash, ash and bash alike.
set -eu

repo=${WCLIP_REPO:-BoboDupla/wclip}
version=${WCLIP_VERSION:-latest}
bin_dir=${WCLIP_BIN_DIR:-$HOME/.local/bin}
uninstall=0

usage() {
	cat <<'EOF'
Usage: install.sh [options]

  --version VERSION   release tag to install, e.g. v0.5.1 (default: latest)
  --bin-dir DIR       where to put the wclip binary (default: ~/.local/bin)
  --uninstall         remove $bin-dir/wclip and exit
  -h, --help          this text

Environment: WCLIP_VERSION, WCLIP_BIN_DIR, WCLIP_REPO (forks/testing).
EOF
}

while [ $# -gt 0 ]; do
	case $1 in
	--version) version=${2:?--version needs a value}; shift 2 ;;
	--version=*) version=${1#*=}; shift ;;
	--bin-dir) bin_dir=${2:?--bin-dir needs a value}; shift 2 ;;
	--bin-dir=*) bin_dir=${1#*=}; shift ;;
	--uninstall) uninstall=1; shift ;;
	-h | --help) usage; exit 0 ;;
	--) shift; break ;;
	*) echo "install.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
	esac
done

if [ "$uninstall" = 1 ]; then
	if [ -e "$bin_dir/wclip" ]; then
		rm -f "$bin_dir/wclip"
		echo "removed $bin_dir/wclip"
	else
		echo "nothing to remove at $bin_dir/wclip"
	fi
	exit 0
fi

# --- platform detection -----------------------------------------------------
os=$(uname -s)
case $os in
Linux) ;;
*)
	echo "install.sh: unsupported OS: $os (wclip releases are Linux-only; use 'npm run build:js' or the source launcher)" >&2
	exit 1
	;;
esac

arch=$(uname -m)
case $arch in
x86_64 | amd64) asset=wclip-linux-x64 ;;
aarch64 | arm64) asset=wclip-linux-arm64 ;;
*)
	echo "install.sh: unsupported architecture: $arch (no prebuilt binary)" >&2
	exit 1
	;;
esac

# The prebuilt binaries link against glibc; musl systems need a musl build.
if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ] ||
	{ ldd --version 2>&1 | head -n 1 | grep -qi musl; }; then
	echo "install.sh: this looks like a musl system (Alpine?), and the releases are glibc-only so far." >&2
	echo "install.sh: use the source launcher instead: git clone https://github.com/$repo && ln -s \"\$PWD/wclip\" ~/.local/bin/wclip" >&2
	exit 1
fi

# --- download ---------------------------------------------------------------
if [ "$version" = latest ]; then
	base=https://github.com/$repo/releases/latest/download
else
	case $version in v*) ;; *) version=v$version ;; esac
	base=https://github.com/$repo/releases/download/$version
fi

fetch() { # fetch URL DEST
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 2 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$2" "$1"
	else
		echo "install.sh: need curl or wget on PATH" >&2
		exit 1
	fi
}

tmp=$(mktemp -d "${TMPDIR:-/tmp}/wclip-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

echo "downloading $asset (${version})"
if ! fetch "$base/$asset" "$tmp/$asset" || ! fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"; then
	echo "install.sh: download failed; does release '$version' exist at https://github.com/$repo/releases ?" >&2
	exit 1
fi

# --- verify and install -----------------------------------------------------
(
	cd "$tmp"
	sha256sum --ignore-missing -c SHA256SUMS
) || {
	echo "install.sh: checksum verification failed, not installing" >&2
	exit 1
}

chmod 755 "$tmp/$asset"
"$tmp/$asset" --version >/dev/null 2>&1 || {
	echo "install.sh: the downloaded binary does not run on this machine; not installing" >&2
	exit 1
}

mkdir -p "$bin_dir"
if command -v install >/dev/null 2>&1; then
	install -m 755 "$tmp/$asset" "$bin_dir/wclip"
else
	cp "$tmp/$asset" "$bin_dir/wclip"
	chmod 755 "$bin_dir/wclip"
fi

echo "installed $("$bin_dir/wclip" --version) to $bin_dir/wclip"

case ":${PATH:-}:" in
*":$bin_dir:"*) ;;
*) echo "note: $bin_dir is not on your PATH; add it, e.g. export PATH=\"$bin_dir:\$PATH\"" ;;
esac
