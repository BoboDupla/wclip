#!/bin/sh
# Smoke test compiled binaries, golden Markdown, HTML/EPUB and opt-in Chromium.
# Usage: sh test/binary-smoke.sh build/wclip-linux-x64 (arXiv metadata needs network)
set -eu
BIN=$(readlink -f "$1")
cd "$(dirname "$0")"
TMPROOT=${TMPDIR:-${XDG_CACHE_HOME:-$HOME/.cache}/wclip}
mkdir -p "$TMPROOT"
T=$(mktemp -d "$TMPROOT/wclip-binary.XXXXXX")
SRV=
NSRV=
cleanup() {
  if [ -n "$SRV" ]; then kill "$SRV" 2>/dev/null || true; wait "$SRV" 2>/dev/null || true; fi
  if [ -n "$NSRV" ]; then kill "$NSRV" 2>/dev/null || true; wait "$NSRV" 2>/dev/null || true; fi
  rm -rf "$T"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf 'articles_dir: %s/articles\n' "$T" > "$T/config.yaml"
export WCLIP_CONFIG="$T/config.yaml"
fail=0
for u in fixtures/*.url; do
  s=$(basename "$u" .url)
  # Keep the CLI out of a pipeline: a failed process must not be hidden by sed/grep.
  if "$BIN" --html "fixtures/$s.html" "$(cat "$u")" --stdout -g x -d y > "$T/$s.note" 2> "$T/$s.err"; then
    awk 'f>=2{print} /^---$/{f++}' "$T/$s.note" | sed '1{/^$/d};${/^$/d}' > "$T/$s.md"
    if diff -q "$T/$s.md" "golden/$s.md" >/dev/null; then
      echo "ok   $s"
    else
      echo "FAIL $s (golden Markdown mismatch)"; cat "$T/$s.err" >&2; fail=1
    fi
  else
    echo "FAIL $s (CLI exited nonzero)"; cat "$T/$s.err" >&2; fail=1
  fi
done
if ! "$BIN" --html fixtures/ploum-calendar.html https://ploum.net/2025-09-03-calendar-txt.html -g x -d y > "$T/files.out" 2> "$T/files.err"; then
  echo "FAIL HTML/EPUB CLI exited nonzero"; cat "$T/files.err" >&2; fail=1
fi
for f in html/how-i-fell-in-love-with-calendartxt.html epub/how-i-fell-in-love-with-calendartxt.epub; do
  if [ -s "$T/articles/$f" ]; then echo "ok   $f"; else echo "FAIL $f"; fail=1; fi
done
# The released binaries embed Bun, whose node:http is a reimplementation of Node's and
# has diverged on custom DNS lookup behaviour before. Prove on the shipped artifact that
# a non-public target is refused without --allow-private, not just in the Node test run.
mkdir "$T/net"
printf '<!doctype html><html><body><p>loopback fixture</p></body></html>\n' > "$T/net/index.html"
python3 - "$T/net" "$T/netport" > "$T/netserver.log" 2>&1 <<'PY' &
import functools, http.server, pathlib, sys
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1]))
pathlib.Path(sys.argv[2]).write_text(str(server.server_port))
server.serve_forever()
PY
NSRV=$!
n=0
while [ ! -s "$T/netport" ] && [ "$n" -lt 100 ]; do
  kill -0 "$NSRV" 2>/dev/null || break
  sleep 0.1; n=$((n + 1))
done
if [ ! -s "$T/netport" ]; then
  echo "FAIL ssrf fixture server"; cat "$T/netserver.log" >&2; fail=1
else
  NPORT=$(cat "$T/netport")
  for target in "http://127.0.0.1:$NPORT/" "http://localhost:$NPORT/" \
                "http://2130706433:$NPORT/" "http://169.254.169.254/latest/meta-data/"; do
    if "$BIN" "$target" --stdout -g x -d y > "$T/blocked.out" 2> "$T/blocked.err"; then
      echo "FAIL ssrf: binary fetched $target without --allow-private"; fail=1
    elif grep -q 'blocked non-public' "$T/blocked.err"; then
      echo "ok   ssrf blocks $target"
    else
      echo "FAIL ssrf: $target (no policy error)"; cat "$T/blocked.err" >&2; fail=1
    fi
  done
  # The same fixture must still work when the user explicitly opts in.
  if "$BIN" "http://127.0.0.1:$NPORT/" --allow-private --stdout -g x -d y > "$T/allowed.out" 2> "$T/allowed.err" \
     && grep -q 'loopback fixture' "$T/allowed.out"; then
    echo "ok   ssrf --allow-private still reaches the fixture"
  else
    echo "FAIL ssrf: --allow-private broke intentional local clipping"; cat "$T/allowed.err" >&2; fail=1
  fi
fi
kill "$NSRV" 2>/dev/null || true
wait "$NSRV" 2>/dev/null || true

# Headless browser inside the binary, against a loopback page rendered only by JS.
if [ -n "${WCLIP_CHROMIUM:-}" ] || command -v chromium >/dev/null; then
  mkdir "$T/www"
  cat > "$T/www/index.html" <<'HTML'
<!doctype html><html><head><title>JS app</title></head><body><div id="app">Loading…</div><script>
document.getElementById('app').innerHTML = '<article><h1>Rendered</h1>' + [1,2,3,4,5,6].map(i =>
  '<p>' + i + '. This paragraph only exists after JavaScript runs, so a plain fetch sees nothing useful.</p>').join('') + '</article>';
</script></body></html>
HTML
  # Bind an ephemeral port, then signal readiness; do not collide with an unrelated service.
  python3 - "$T/www" "$T/port" > "$T/server.log" 2>&1 <<'PY' &
import functools, http.server, pathlib, sys
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1]))
pathlib.Path(sys.argv[2]).write_text(str(server.server_port))
server.serve_forever()
PY
  SRV=$!
  n=0
  while [ ! -s "$T/port" ] && [ "$n" -lt 100 ]; do
    kill -0 "$SRV" 2>/dev/null || break
    sleep 0.1; n=$((n + 1))
  done
  if [ ! -s "$T/port" ]; then
    echo "FAIL headless fixture server"; cat "$T/server.log" >&2; fail=1
  elif "$BIN" "http://127.0.0.1:$(cat "$T/port")/" --allow-private --browser --stdout -g x -d y > "$T/browser.note" 2> "$T/browser.err"; then
    if grep -q 'only exists after JavaScript' "$T/browser.note"; then
      echo "ok   opt-in headless browser"
    else
      echo "FAIL headless browser output"; cat "$T/browser.err" >&2; fail=1
    fi
  else
    echo "FAIL headless browser CLI exited nonzero"; cat "$T/browser.err" >&2; fail=1
  fi
else
  echo "skip headless browser (no Chromium; set WCLIP_CHROMIUM)"
fi
exit "$fail"
