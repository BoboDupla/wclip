#!/bin/sh
# Real first-run install/compile in isolation, with lifecycle-script canaries.
# Uses the checked-in runtime and tooling locks; never installs root Bun dev deps.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMPROOT=${TMPDIR:-${XDG_CACHE_HOME:-$HOME/.cache}/wclip}
mkdir -p "$TMPROOT"
T=$(mktemp -d "$TMPROOT/wclip-bootstrap.XXXXXX")
trap 'rm -rf "$T"' EXIT
trap 'exit 1' HUP INT TERM
CHECKOUT="$T/checkout with spaces"
export ROOT CHECKOUT
node --input-type=module <<'NODE'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.ROOT, copy = process.env.CHECKOUT;
mkdirSync(copy);
for (const path of ['src', 'tooling/package.json', 'tooling/package-lock.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'wclip']) {
  cpSync(join(root, path), join(copy, path), { recursive: true });
}
for (const prefix of ['', 'tooling']) {
  const path = join(copy, prefix, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.scripts = { ...pkg.scripts };
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    pkg.scripts[hook] = `node -e "require('node:fs').writeFileSync('lifecycle-ran', '${hook}')"`;
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
}
NODE
EXPECTED=$(node -p "require(process.env.ROOT + '/package.json').version")
(cd "$CHECKOUT" && sha256sum package-lock.json tooling/package-lock.json > "$T/locks.sha256")
"$CHECKOUT/wclip" --version > "$T/version" 2> "$T/bootstrap.log" || {
  cat "$T/bootstrap.log" >&2; exit 1;
}
[ "$(cat "$T/version")" = "wclip $EXPECTED" ]
[ -s "$CHECKOUT/dist/cli.js" ]
[ -x "$CHECKOUT/tooling/node_modules/.bin/tsc" ]
[ -d "$CHECKOUT/node_modules/sanitize-html" ]
[ ! -e "$CHECKOUT/node_modules/bun" ]
[ ! -e "$CHECKOUT/node_modules/typescript" ]
[ ! -e "$CHECKOUT/lifecycle-ran" ]
[ ! -e "$CHECKOUT/tooling/lifecycle-ran" ]
[ ! -e "$CHECKOUT/.tools" ]
(cd "$CHECKOUT" && sha256sum --strict --check "$T/locks.sha256")
echo 'ok   clean first-run runtime install and pinned compiler; lifecycle hooks suppressed'
# Also exercise the compiled launcher against a local fixture without network metadata.
printf 'articles_dir: %s/articles\n' "$T" > "$T/config.yaml"
WCLIP_CONFIG="$T/config.yaml" "$CHECKOUT/wclip" \
  --html "$ROOT/test/fixtures/ploum-calendar.html" \
  https://ploum.net/2025-09-03-calendar-txt.html --stdout -g x -d y \
  > "$T/fixture.note" 2> "$T/fixture.err" || { cat "$T/fixture.err" >&2; exit 1; }
grep -q 'calendar.txt' "$T/fixture.note"
echo 'ok   bootstrapped source extracts the real HTML fixture'
# A warm invocation must work even when npm is unavailable.
mkdir "$T/no-install"
printf '#!/bin/sh\nexit 93\n' > "$T/no-install/npm"
chmod +x "$T/no-install/npm"
PATH="$T/no-install:$PATH" "$CHECKOUT/wclip" --version > "$T/warm.version" 2> "$T/warm.err"
cmp "$T/version" "$T/warm.version"
! grep -q 'First run:' "$T/warm.err"
echo 'ok   warm launcher does not reinstall'
# Fail before npm on an unsupported Node version (real minimum is 22.12.0).
printf '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "v22.11.0\\n"; exit 0; fi\nexit 1\n' > "$T/no-install/node"
chmod +x "$T/no-install/node"
if PATH="$T/no-install:$PATH" "$CHECKOUT/wclip" --version > "$T/old.out" 2> "$T/old.err"; then
  echo 'FAIL unsupported Node accepted' >&2; exit 1
fi
grep -q 'needs Node.js 22.12.0 or newer' "$T/old.err"
echo 'ok   Node 22.11 is rejected before installation'
