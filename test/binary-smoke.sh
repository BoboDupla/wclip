#!/bin/sh
# Smoke test for the compiled binary: every fixture must give its golden Markdown, and the
# HTML/EPUB/headless-browser paths must work from inside the binary.
# Usage: sh test/binary-smoke.sh build/wclip-linux-x64   (arXiv metadata needs network)
set -eu
BIN=$(readlink -f "$1"); cd "$(dirname "$0")"
T=$(mktemp -d); trap 'rm -rf "$T"; kill $SRV 2>/dev/null || true' EXIT
printf 'articles_dir: %s/articles\n' "$T" > "$T/config.yaml"
export WCLIP_CONFIG="$T/config.yaml"
fail=0
for u in fixtures/*.url; do
  s=$(basename "$u" .url)
  "$BIN" --html "fixtures/$s.html" "$(cat "$u")" --stdout -g x -d y 2>/dev/null \
    | awk 'f>=2{print} /^---$/{f++}' | sed '1{/^$/d};${/^$/d}' > "$T/$s.md"
  if diff -q "$T/$s.md" "golden/$s.md" >/dev/null; then echo "ok   $s"; else echo "FAIL $s"; fail=1; fi
done
"$BIN" --html fixtures/ploum-calendar.html https://ploum.net/2025-09-03-calendar-txt.html -g x -d y 2>/dev/null
for f in html/how-i-fell-in-love-with-calendartxt.html epub/how-i-fell-in-love-with-calendartxt.epub; do
  if [ -s "$T/articles/$f" ]; then echo "ok   $f"; else echo "FAIL $f"; fail=1; fi
done
# Headless browser from inside the binary, against a page that only renders with JavaScript.
mkdir "$T/www"
cat > "$T/www/index.html" <<'HTML'
<!doctype html><html><head><title>JS app</title></head><body><div id="app">Loading…</div><script>
document.getElementById('app').innerHTML = '<article><h1>Rendered</h1>' + [1,2,3,4,5,6].map(i =>
  '<p>' + i + '. This paragraph only exists after JavaScript runs, so a plain fetch sees nothing useful.</p>').join('') + '</article>';
</script></body></html>
HTML
python3 -m http.server -d "$T/www" -b 127.0.0.1 8765 >/dev/null 2>&1 & SRV=$!
sleep 1
if [ -n "${WCLIP_CHROMIUM:-${WEBCLIP_CHROMIUM:-}}" ] || command -v chromium >/dev/null; then
  if "$BIN" http://127.0.0.1:8765/ --stdout -g x -d y 2>/dev/null | grep -q 'only exists after JavaScript'; then
    echo "ok   headless browser fallback"; else echo "FAIL headless browser fallback"; fail=1; fi
else
  echo "skip headless browser fallback (no Chromium; set WCLIP_CHROMIUM)"
fi
exit $fail
