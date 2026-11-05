#!/bin/sh
# Install / update the wclip web front end: systemd unit + Caddy site block.
# Run as root: sudo /home/deploy/apps/wclip-web/install.sh
#
# The Caddy block carries no basic_auth any more: the app serves its own login
# form with a session cookie. Replacing the block in place keeps this idempotent.
set -eu

APP=/home/deploy/apps/wclip-web
CADDYFILE=/etc/caddy/Caddyfile

if [ "$(id -u)" -ne 0 ]; then
    echo "run me with sudo" >&2
    exit 1
fi

install -m 0644 "$APP/wclip-web.service" /etc/systemd/system/wclip-web.service

cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"
/usr/bin/python3 - "$CADDYFILE" "$APP/caddy-clip.snippet" <<'PY'
import re, sys
caddy, snippet = sys.argv[1], sys.argv[2]
text = open(caddy, encoding="utf-8").read()
want = open(snippet, encoding="utf-8").read().rstrip("\n")
pattern = re.compile(r"(?ms)^# ── wclip web[^\n]*\n^clip\.shtfn\.xyz \{.*?^\}\n?")
text = pattern.sub("", text)
text = re.sub(r"(?ms)^clip\.shtfn\.xyz \{.*?^\}\n?", "", text)
open(caddy, "w", encoding="utf-8").write(text.rstrip("\n") + "\n\n" + want + "\n")
print("caddy: clip.shtfn.xyz block replaced (previous file backed up)")
PY

if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    echo "caddy validate FAILED, restoring the previous Caddyfile" >&2
    cp "$(ls -t "$CADDYFILE".bak.* | head -1)" "$CADDYFILE"
    exit 1
fi

systemctl daemon-reload
# enable --now would leave an already-running service on the old unit file, which
# silently skips new hardening settings; always restart so a redeploy takes effect.
systemctl enable wclip-web.service
systemctl restart wclip-web.service
systemctl reload caddy

sleep 2
systemctl is-active wclip-web.service
curl -s -o /dev/null -w 'local login page: HTTP %{http_code}\n' http://127.0.0.1:8791/login
echo "done"
