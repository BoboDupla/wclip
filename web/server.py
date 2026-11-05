#!/usr/bin/env python3
"""HTTP front end for wclip: paste a URL, get the article plus md/epub downloads.

Clips land in the real articles dir (the same folder the terminal writes to, so
Syncthing and dufs pick them up), using a dedicated config that keeps the web
service's own LLM/cookie/browser policy. wclip runs as a subprocess, so the CLI
stays the single source of truth. One clip at a time: the launcher rebuilds on
source changes and concurrent runs race on node_modules.
"""
import base64
import contextvars
import getpass
import hashlib
import hmac
import html
import json
import os
import queue
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse, urlsplit

WCLIP = os.path.expanduser(os.environ.get("WCLIP_BIN", "~/.local/bin/wclip"))
CONFIG = os.path.expanduser("~/.config/wclip-web/config.yaml")
AUTH_PATH = os.path.expanduser("~/.config/wclip-web/auth.yaml")
PORT = int(os.environ.get("WCLIP_PORT", "8791"))
ARTICLES = os.path.expanduser(os.environ.get("WCLIP_WEB_ARTICLES", "~/apps/dufs/data/articles"))
RENDER_HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "render-note.mjs")

SESSION_COOKIE = "wcs"
THEME_COOKIE = "wct"
SESSION_DAYS = 180
MIN_PASSWORD = 12
LOGIN_MAX_FAILS = 5
LOGIN_WINDOW = 900          # 15 minutes
LOGIN_FAILS = {}
# One user, one password: a per-IP limit alone is worth nothing to somebody with a
# pile of addresses, or to a local process that picks its own X-Forwarded-For. Every
# failure therefore also counts globally and buys an escalating cooldown. In memory,
# so a restart clears it, and a successful login clears it too.
GLOBAL_FAILS = []
GLOBAL_WINDOW = 24 * 3600
GLOBAL_LOCK_UNTIL = 0.0
GLOBAL_STEPS = ((30, 4 * 3600), (20, 3600), (10, 900))

JOB_TTL = 2 * 3600          # in-memory job entries expire after 2 hours
MAX_QUEUE = 4               # pending clips before we refuse new ones
MAX_PER_HOUR = 40           # total clips per hour (single user, so a runaway guard)

# Rendered articles are third-party HTML served on this origin, so the policy goes in a
# response header instead of trusting the <meta> tag a given rendition happens to carry
# (most older ones carry none). `sandbox allow-downloads` gives the document an opaque
# origin while keeping the reading view's EPUB link usable.
ARTICLE_CSP = ("default-src 'none'; script-src 'none'; img-src https: data:; "
               "style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; "
               "frame-ancestors 'none'; sandbox allow-downloads")
ARTICLE_HEADERS = {"Content-Security-Policy": ARTICLE_CSP,
                   "Referrer-Policy": "no-referrer"}
# The app's own pages need inline styles and forms; this only stops framing and leaks.
APP_HEADERS = {"Referrer-Policy": "no-referrer",
               "Content-Security-Policy": "frame-ancestors 'none'",
               "X-Frame-Options": "DENY"}

CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

SLOT = threading.Semaphore(1)
JOBS = {}
LOCK = threading.Lock()
STARTED = []

# Lazy rendition generation: queue of stems waiting for html/epub, plus state.
RENDER_Q = queue.Queue()
RENDER_STATE = {}
LIST_CACHE = {}


# --- credentials and sessions --------------------------------------------
# Kept in their own file: the wclip config is validated strictly by wclip and
# would reject unknown keys.

def parse_flat(text):
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        out[k.strip()] = v.strip()
    return out


def load_auth():
    try:
        with open(AUTH_PATH, encoding="utf-8") as f:
            return parse_flat(f.read())
    except OSError:
        return {}


def write_auth(auth):
    d = os.path.dirname(AUTH_PATH)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".auth-", suffix=".yaml")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("# wclip-web credentials. Private: mode 600.\n")
            for k in ("user", "password_hash", "secret", "session_days", "sessions_after"):
                if auth.get(k):
                    f.write("%s: %s\n" % (k, auth[k]))
        os.chmod(tmp, 0o600)
        os.replace(tmp, AUTH_PATH)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def hash_password(password, n=2 ** 14, r=8, p=1):
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=32)
    b64 = lambda x: base64.b64encode(x).decode()
    return "scrypt$%d$%d$%d$%s$%s" % (n, r, p, b64(salt), b64(dk))


def check_password(password, stored):
    try:
        _, n, r, p, salt, dk = stored.split("$")
        want = base64.b64decode(dk)
        got = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(salt),
                             n=int(n), r=int(r), p=int(p), dklen=len(want))
        return hmac.compare_digest(got, want)
    except Exception:  # noqa: BLE001
        return False


def sign(raw, secret):
    return hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()


def make_session(user, secret, days):
    now = int(time.time())
    raw = json.dumps({"u": user, "iat": now, "exp": now + days * 86400},
                     separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=") + "." + sign(raw, secret)


def read_session(value, user, secret, not_before=0):
    """The session's user, or None. `not_before` invalidates older sessions without
    touching the signing secret: every cookie carries `iat`."""
    if not value or not user or not secret:
        return None
    try:
        b, sig = value.rsplit(".", 1)
        raw = base64.urlsafe_b64decode(b + "=" * (-len(b) % 4))
        if not hmac.compare_digest(sig, sign(raw, secret)):
            return None
        data = json.loads(raw)
        if data.get("u") != user or int(data.get("exp", 0)) < time.time():
            return None
        if int(data.get("iat", 0)) < int(not_before or 0):
            return None
        return data["u"]
    except Exception:  # noqa: BLE001
        return None


# Burned on unknown usernames so the response time does not reveal them.
DUMMY_HASH = hash_password(secrets.token_hex(8))


def set_password_cli(argv):
    user = None
    for i, a in enumerate(argv):
        if a == "--set-user" and i + 1 < len(argv):
            user = argv[i + 1]
        elif a.startswith("--set-user="):
            user = a.split("=", 1)[1]
    existing = load_auth()
    if user is not None:
        user = user.strip()
        if not user or ":" in user:
            print("username must be non-empty and contain no colon", file=sys.stderr)
            return 2
    else:
        user = (existing.get("user") or input("username: ").strip())
        if not user:
            print("username required", file=sys.stderr)
            return 2
    pw = getpass.getpass("password: ")
    if len(pw) < MIN_PASSWORD:
        print("password must be at least %d characters" % MIN_PASSWORD, file=sys.stderr)
        return 2
    if pw != getpass.getpass("repeat password: "):
        print("passwords do not match", file=sys.stderr)
        return 2
    if pw.lower() == user.lower():
        print("password must not equal the username", file=sys.stderr)
        return 2
    auth = {
        "user": user,
        "password_hash": hash_password(pw),
        "secret": existing.get("secret") or base64.b64encode(secrets.token_bytes(32)).decode(),
        "session_days": str(existing.get("session_days") or SESSION_DAYS),
    }
    write_auth(auth)
    print("credentials stored for %r in %s (mode 600)" % (user, AUTH_PATH))
    print("sessions already signed with the old secret stay valid")
    return 0


def rotate_secret_cli(argv):
    auth = load_auth()
    if not auth.get("user") or not auth.get("password_hash"):
        print("no credentials configured yet, nothing to rotate; run --set-user/--set-password",
              file=sys.stderr)
        return 2
    old = auth.get("secret", "")
    auth["secret"] = base64.b64encode(secrets.token_bytes(32)).decode()
    write_auth(auth)
    print("session signing secret rotated in %s" % AUTH_PATH)
    print("every existing session cookie is now invalid%s"
          % ("" if old else " (there was no previous secret)"))
    print("takes effect on the next request, no restart needed")
    return 0


THEME = contextvars.ContextVar("theme", default="")

LOGIN_PAGE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>sign in</title>
<style>
:root{{--bg:#fff;--fg:#111;--link:#00e;--rule:#bbb}}
@media (prefers-color-scheme:dark){{:root{{--bg:#141414;--fg:#ddd;--link:#7fb3e0;--rule:#5a5a5a}}}}
body.light{{--bg:#fff;--fg:#111;--link:#00e;--rule:#bbb;color-scheme:light}}
body.dark{{--bg:#141414;--fg:#ddd;--link:#7fb3e0;--rule:#5a5a5a;color-scheme:dark}}
body{{max-width:24rem;margin:2rem auto;padding:0 1rem;line-height:1.6;
  background:var(--bg);color:var(--fg)}}
a{{color:var(--link)}}
label{{display:block;margin:0 0 .75rem}}
input{{display:block;width:100%;border:0;border-bottom:1px solid var(--rule);background:none;
      border-radius:0;font:inherit;color:inherit;padding:.15rem 0;-webkit-appearance:none}}
button.tlink{{border:0;background:none;padding:0;font:inherit;color:var(--link);
      text-decoration:underline;cursor:pointer;-webkit-appearance:none}}
h1{{font-size:1.2em;font-weight:normal;margin:0 0 1rem}}
.err{{white-space:pre-wrap;font-size:.9em}}
</style></head><body class="{cls}">
<h1>wclip</h1>
{message}
<form method="post" action="/login">
<input type="hidden" name="next" value="{next}">
<label>username<input name="user" autocomplete="username" autocapitalize="off"
       autocorrect="off" spellcheck="false" required autofocus></label>
<label>password<input name="password" type="password" autocomplete="current-password" required></label>
<button class="tlink" type="submit">&rarr; sign in</button>
</form>
</body></html>"""


def cookie_header(value, max_age, secure):
    expires = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(time.time() + max_age))
    bits = ["%s=%s" % (SESSION_COOKIE, value), "Path=/", "HttpOnly", "SameSite=Lax",
            "Max-Age=%d" % max_age, "Expires=%s" % expires]
    if secure:
        bits.append("Secure")
    return "; ".join(bits)


# The CLI now reports its result as one JSON object on stdout (--json), so the web
# layer never scrapes a human-readable line for a path. And nothing trusts it either:
# the reported path still has to be inside the articles folder.


def global_backoff(count):
    """Cooldown earned by this many failures inside the global window."""
    for threshold, seconds in GLOBAL_STEPS:
        if count >= threshold:
            return seconds
    return 0


def globally_blocked(now=None):
    return (now or time.time()) < GLOBAL_LOCK_UNTIL


def global_wait(now=None):
    return max(0, int(GLOBAL_LOCK_UNTIL - (now or time.time())))


def note_global_failure(now=None):
    """Count one failure, extend the cooldown and return it in seconds."""
    global GLOBAL_LOCK_UNTIL
    now = now or time.time()
    with LOCK:
        GLOBAL_FAILS.append(now)
        while GLOBAL_FAILS and now - GLOBAL_FAILS[0] > GLOBAL_WINDOW:
            GLOBAL_FAILS.pop(0)
        seconds = global_backoff(len(GLOBAL_FAILS))
        if seconds:
            GLOBAL_LOCK_UNTIL = max(GLOBAL_LOCK_UNTIL, now + seconds)
        return seconds


def clear_global_failures():
    global GLOBAL_LOCK_UNTIL
    with LOCK:
        GLOBAL_FAILS.clear()
        GLOBAL_LOCK_UNTIL = 0.0


def prune():
    now = time.time()
    with LOCK:
        dead = [j for j, v in JOBS.items()
                if v["state"] != "running" and now - v["t0"] > JOB_TTL]
        for j in dead:
            JOBS.pop(j, None)
        # Both failure tables are keyed by whoever is attacking; never let them grow.
        for ip in list(LOGIN_FAILS):
            hits = [t for t in LOGIN_FAILS[ip] if now - t < LOGIN_WINDOW]
            if hits:
                LOGIN_FAILS[ip] = hits
            else:
                LOGIN_FAILS.pop(ip, None)
        while GLOBAL_FAILS and now - GLOBAL_FAILS[0] > GLOBAL_WINDOW:
            GLOBAL_FAILS.pop(0)


def sweeper():
    while True:
        time.sleep(600)
        try:
            prune()
        except Exception:  # noqa: BLE001
            pass


def renditions(md_path):
    """The html/ and epub/ siblings wclip writes next to the note."""
    stem = os.path.basename(md_path)[:-3]
    d = os.path.dirname(md_path)
    return {
        "md": md_path,
        "html": os.path.join(d, "html", stem + ".html"),
        "epub": os.path.join(d, "epub", stem + ".epub"),
    }


def word_count(path):
    try:
        with open(path, encoding="utf-8") as f:
            body = f.read()
        body = body.split("---", 2)[-1] if body.startswith("---") else body
        return len(body.split())
    except OSError:
        return 0


# --- reading list ---------------------------------------------------------

def unquote_val(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def parse_fm(text):
    """Minimal frontmatter reader: flat scalars plus simple block lists."""
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    out = {}
    key = None
    for line in text[3:end].splitlines():
        if not line.strip():
            continue
        stripped = line.lstrip()
        if stripped.startswith("- ") and key:
            if isinstance(out.get(key), list):
                out[key].append(unquote_val(stripped[2:]))
            continue
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            key = k.strip()
            v = v.strip()
            out[key] = [] if not v else unquote_val(v)
    return out


def as_text(v):
    if isinstance(v, list):
        return ", ".join(x for x in v if isinstance(x, str))
    return v if isinstance(v, str) else ""


def as_bool(v):
    return str(v).strip().lower() in ("true", "yes", "1")


READ_LINE_RE = re.compile(r"^read:[ \t]*.*$", re.M)


def set_read(stem, value):
    """Rewrite only the read: line, atomically, leaving the rest byte-identical."""
    path = os.path.join(ARTICLES, stem + ".md")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if not text.startswith("---"):
        return False
    end = text.find("\n---", 3)
    if end < 0:
        return False
    head, tail = text[:end], text[end:]
    line = "read: %s" % ("true" if value else "false")
    if READ_LINE_RE.search(head):
        head = READ_LINE_RE.sub(line, head, count=1)
    else:
        head = head.rstrip("\n") + "\n" + line
    st = os.stat(path)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".wclip-tmp-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(head + tail)
        os.chmod(tmp, st.st_mode & 0o777)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return True


def list_articles():
    """All notes, parsed frontmatter cached per (mtime, size)."""
    entries = []
    try:
        scan = list(os.scandir(ARTICLES))
    except OSError:
        return entries
    for e in scan:
        if not e.name.endswith(".md") or not e.is_file():
            continue
        try:
            st = e.stat()
        except OSError:
            continue
        stamp = (st.st_mtime_ns, st.st_size)
        hit = LIST_CACHE.get(e.name)
        if hit and hit[0] == stamp:
            entries.append(hit[1])
            continue
        try:
            with open(e.path, encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        fm = parse_fm(text)
        tags = fm.get("tags")
        item = {
            "stem": e.name[:-3],
            "title": as_text(fm.get("title")) or e.name[:-3],
            "created": as_text(fm.get("created")),
            "published": as_text(fm.get("published")),
            "author": as_text(fm.get("author")),
            "time": as_text(fm.get("reading time")),
            "source": as_text(fm.get("source")),
            "tags": [t for t in tags if isinstance(t, str)] if isinstance(tags, list) else [],
            "read": as_bool(fm.get("read")),
            "mtime": st.st_mtime,
        }
        LIST_CACHE[e.name] = (stamp, item)
        entries.append(item)
    entries.sort(key=lambda i: (i["created"] or i["published"] or "", i["mtime"]), reverse=True)
    return entries


def contained_in_articles(path):
    """True only for a real path inside the articles folder.

    Rendition paths come from the CLI's stderr, so they are checked against the
    folder rather than trusted; a symlink out of it fails the same test.
    """
    root = os.path.realpath(ARTICLES)
    real = os.path.realpath(path)
    return real == root or real.startswith(root + os.sep)


def parse_cli_result(stdout):
    """The last JSON object wclip printed with --json, or None."""
    for line in reversed((stdout or "").splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def valid_clip_url(url):
    """A http(s) URL we are willing to hand to the CLI as one argv item.

    Control characters are refused: the CLI deliberately keeps newlines in
    diagnostics, and this URL ends up inside one.
    """
    return (url.lower().startswith(("http://", "https://"))
            and len(url) <= 2048
            and not CONTROL_RE.search(url))


def safe_next(nxt, default="/articles"):
    """An in-app redirect target, or the default.

    Browsers read `\\` as `/`, so `[backslash]evil.com` would be an open redirect
    even though urlparse sees a path.
    """
    if not nxt or not nxt.startswith("/") or nxt.startswith("//") or "\\" in nxt:
        return default
    parts = urlsplit(nxt)
    if parts.scheme or parts.netloc:
        return default
    return nxt


def rendition_paths(stem):
    d = ARTICLES
    return {"md": os.path.join(d, stem + ".md"),
            "html": os.path.join(d, "html", stem + ".html"),
            "epub": os.path.join(d, "epub", stem + ".epub")}


def render_worker():
    """One note at a time: wclip's renderer plus remote image downloads."""
    while True:
        stem = RENDER_Q.get()
        with LOCK:
            RENDER_STATE[stem] = "running"
        md = rendition_paths(stem)["md"]
        try:
            p = subprocess.run(
                ["node", RENDER_HELPER, md],
                capture_output=True, text=True, timeout=240,
                env=dict(os.environ, TERM="dumb",
                         PATH=os.path.expanduser("~/.local/bin") + ":/usr/local/bin:/usr/bin:/bin"),
            )
            ok = p.returncode == 0 and os.path.exists(rendition_paths(stem)["html"])
            with LOCK:
                RENDER_STATE[stem] = "done" if ok else "failed"
                if not ok:
                    RENDER_STATE.setdefault("_last_error", (p.stderr or p.stdout)[-500:])
        except Exception as e:  # noqa: BLE001
            with LOCK:
                RENDER_STATE[stem] = "failed"
                RENDER_STATE["_last_error"] = repr(e)
        finally:
            RENDER_Q.task_done()


def ensure_rendition(stem):
    """Queue a note for html/epub generation unless it is already queued or running."""
    with LOCK:
        state = RENDER_STATE.get(stem)
        if state in ("queued", "running"):
            return
        RENDER_STATE[stem] = "queued"
    RENDER_Q.put(stem)


def valid_stem(stem):
    if not stem or "/" in stem or "\\" in stem or stem in (".", ".."):
        return False
    return os.path.isfile(os.path.join(ARTICLES, stem + ".md"))


def domain_of(url):
    """Bare host from a note's source URL, minus a leading www."""
    if not url:
        return ""
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


ITEM = """<li class="item{readcls}" data-s="{search}">
<a class="mk" href="{toggle}" title="{label}">{glyph}</a><a class="t" href="/article/{qstem}/view">{title}</a>
<div class="sub">{when}{meta}</div></li>"""


def render_list(state=None, back="/articles"):
    entries = list_articles()
    unread = sum(1 for e in entries if not e["read"])
    read = len(entries) - unread
    if state == "unread":
        shown = [e for e in entries if not e["read"]]
    elif state == "read":
        shown = [e for e in entries if e["read"]]
    else:
        shown = entries
    items = []
    for e in shown:
        parts = [(e["created"] or e["published"] or "")[:10], e["time"], domain_of(e["source"])]
        when = " | ".join(html.escape(p) for p in parts if p)
        bits = ['<span class="tag">%s</span>' % html.escape(t) for t in e["tags"][:4]]
        meta = " | " + " &middot; ".join(bits) if bits else ""
        label = "mark unread" if e["read"] else "mark read"
        to = "0" if e["read"] else "1"
        toggle = html.escape("/toggle?%s" % urlencode(
            {"stem": e["stem"], "to": to, "back": back}), quote=True)
        items.append(ITEM.format(
            readcls=" read" if e["read"] else "",
            readnum="1" if e["read"] else "0",
            search=html.escape((e["title"] + " " + " ".join(e["tags"])).lower(), quote=True),
            qstem=quote(e["stem"], safe=""),
            title=html.escape(e["title"]),
            stem=html.escape(e["stem"], quote=True),
            toggle=toggle,
            glyph="&#9745;" if e["read"] else "&#9744;",
            label=label,
            when=when, meta=meta))

    def chip(key, text, count):
        href = "/articles" if not key else "/articles?" + key
        return '<a class="chip%s" href="%s">%s <b>%d</b></a>' % (
            " on" if (state or "") == (key.split("=")[0] if key else "") else "", href, text, count)

    chips = (chip("", "all", len(entries)) + chip("unread=1", "unread", unread)
             + chip("read=1", "read", read))
    body = (
        '<div class="chips">%s</div>'
        '<div class="listhead"><input id="filter" type="search" placeholder="filter by title or tag"'
        ' autocomplete="off" autocapitalize="off" autocorrect="off">'
        '<span class="count" id="count">%d articles</span></div>'
        '<ul class="list">%s</ul>'
        '<script>(function(){var f=document.getElementById("filter"),'
        'items=[].slice.call(document.querySelectorAll("li.item")),'
        'c=document.getElementById("count");'
        'f.addEventListener("input",function(){var q=f.value.toLowerCase().trim(),n=0;'
        'items.forEach(function(li){var hit=!q||li.dataset.s.indexOf(q)>-1;'
        'li.style.display=hit?"":"none";if(hit)n++;});'
        'c.textContent=n+(n===1?" article":" articles");});})();</script>'
    ) % (chips, len(shown), "".join(items))
    return PAGE.format(cls=THEME.get(), value="", body=body, refresh="")



def run_job(job_id, url):
    job = JOBS[job_id]
    with SLOT:
        env = dict(os.environ, WCLIP_CONFIG=CONFIG, TERM="dumb")
        t0 = time.time()
        try:
            # No --force: an existing note is never clobbered, it is shown instead.
            p = subprocess.run(
                # No --llm: the web config decides, so openrouter.enabled: false in
                # the config really does keep article text off the network.
                [WCLIP, url, "--quiet", "--no-progress", "--json"],
                env=env, capture_output=True, text=True, timeout=300,
            )
            job["seconds"] = round(time.time() - t0, 1)
            result = parse_cli_result(p.stdout)
            if result is None:
                job["error"] = ((p.stderr or "").strip()
                                or "wclip produced no JSON result")[-800:]
                job["state"] = "failed"
                return
            if not result.get("ok"):
                job["error"] = str(result.get("error") or (p.stderr or "").strip()
                                   or "wclip failed")[-800:]
                job["state"] = "failed"
                return
            path = str(result.get("path") or "")
            # The path is a claim from a subprocess, not a fact: check it before serving.
            if not path or not contained_in_articles(path) or not os.path.exists(path):
                job["error"] = "wclip reported an unusable path: %r" % path
                job["state"] = "failed"
                return
            job.update(paths=renditions(path), existing=bool(result.get("existing")),
                       stem=os.path.basename(path)[:-3],
                       words=word_count(path), state="done")
            job["warnings"] = "\n".join(
                "warning: %s" % w for w in (result.get("warnings") or []))
        except subprocess.TimeoutExpired:
            job["error"] = "wclip timed out after 300s"
            job["state"] = "failed"
        except Exception as e:  # noqa: BLE001
            job["error"] = repr(e)
            job["state"] = "failed"


PAGE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>wclip</title>
{refresh}
<style>
:root{{--bg:#fff;--fg:#111;--link:#00e;--dim:#555;--muted:#777;--rule:#bbb}}
@media (prefers-color-scheme:dark){{:root{{--bg:#141414;--fg:#ddd;--link:#7fb3e0;
  --dim:#a3a3a3;--muted:#8f8f8f;--rule:#5a5a5a}}}}
body.light{{--bg:#fff;--fg:#111;--link:#00e;--dim:#555;--muted:#777;--rule:#bbb;
  color-scheme:light}}
body.dark{{--bg:#141414;--fg:#ddd;--link:#7fb3e0;--dim:#a3a3a3;--muted:#8f8f8f;
  --rule:#5a5a5a;color-scheme:dark}}
body{{max-width:44rem;margin:1.5rem auto;padding:0 1rem;line-height:1.5;
  background:var(--bg);color:var(--fg)}}
a{{color:var(--link)}}
.nav{{margin:0 0 1.25rem}}
.nav a{{margin-right:.9rem}}
.theme{{margin-left:.6rem}}
.theme a{{margin-left:.3rem}}
body.dark .theme a[href$="dark"],body.light .theme a[href$="light"],
body:not(.dark):not(.light) .theme a[href$="auto"]{{font-weight:bold;text-decoration:underline}}
form{{margin:0 0 1.25rem}}
input{{border:0;border-bottom:1px solid var(--rule);background:none;border-radius:0;
  font:inherit;color:inherit;padding:.15rem 0;-webkit-appearance:none}}
input[type=url],input[type=search],input[type=text],input[type=password]{{width:100%;max-width:30rem}}
button.tlink{{border:0;background:none;padding:0;margin:0;font:inherit;color:var(--link);
      text-decoration:underline;cursor:pointer;-webkit-appearance:none}}
h1{{font-size:1.2em;font-weight:normal;margin:0 0 1rem}}
.chips{{margin:0 0 .75rem}}
.chips a{{margin-right:1.25rem;text-decoration:none}}
.chips a.on{{font-weight:bold;text-decoration:underline}}
.listhead{{margin:0 0 .75rem}}
ul.list{{list-style:none;margin:0;padding:0}}
li.item{{margin:0 0 .7rem}}
li.item .mk{{text-decoration:none;margin-right:.4rem;display:inline-block;padding:0 .2rem 0 0}}
li.item.read a.t{{color:var(--muted)}}
#filter{{width:16rem}}
.sub{{font-size:.85em;color:var(--dim);margin-left:1.35rem}}
.count{{margin-left:.5rem;color:var(--dim)}}
.tag{{margin-right:0}}
.meta{{margin:0 0 1rem}}
.err{{white-space:pre-wrap;font-family:monospace;font-size:.85em}}
.warn{{white-space:pre-wrap;font-size:.85em;color:var(--dim)}}
</style></head><body class="{cls}">
<p class="nav"><a href="/">clip</a><a href="/articles">articles</a><a href="/logout">logout</a><span class="theme">theme:<a href="/theme?to=auto">auto</a><a href="/theme?to=light">light</a><a href="/theme?to=dark">dark</a></span></p>
<form method="post" action="/clip">
<input type="url" name="url" placeholder="https://..." required autocomplete="off"
       autocapitalize="off" autocorrect="off" spellcheck="false" value="{value}">
<button class="tlink" type="submit">&rarr; clip</button>
</form>
{body}
</body></html>"""


def render(job_id=None):
    if not job_id:
        return PAGE.format(cls=THEME.get(), value="", body="", refresh="")
    job = JOBS[job_id]
    state = job["state"]
    if state == "running":
        body = ('<p class="meta">Working, %ss so far&hellip;</p>'
                % int(time.time() - job["t0"]))
        return PAGE.format(cls=THEME.get(), value=html.escape(job["url"], quote=True), body=body,
                           refresh='<meta http-equiv="refresh" content="2">')
    if state == "failed":
        body = '<p class="err">%s</p>' % html.escape(job["error"])
        return PAGE.format(cls=THEME.get(), value=html.escape(job["url"], quote=True), body=body, refresh="")
    note = ('<p>Already in the vault, showing the existing note.</p>'
            if job.get("existing") else "")
    warn = ('<p class="warn">%s</p>' % html.escape(job["warnings"])
            if job.get("warnings") else "")
    body = (
        '<p class="meta"><strong>%s</strong> &middot; %ss &middot; %s words</p>'
        '%s<p><a href="/article/%s/view">read</a> // <a href="/job/%s/md">markdown</a>'
        ' // <a href="/job/%s/epub">epub</a></p>'
        '%s'
    ) % (html.escape(job["stem"]), job.get("seconds", "?"), job.get("words", "?"),
         note, quote(job["stem"], safe=""), job_id, job_id, warn)
    return PAGE.format(cls=THEME.get(), value=html.escape(job["url"], quote=True), body=body, refresh="")


DARK_ARTICLE_CSS = """
html,body{background:#141414!important;color:#ddd!important}
a{color:#7fb3e0!important}
h1,h2,h3,h4,h5,h6{color:#eee!important}
pre,code,kbd,samp{background:#1e1e1e!important;color:#e0e0e0!important;
  border-color:#383838!important}
blockquote{border-left-color:#444!important;color:#c4c4c4!important}
hr,table,th,td{border-color:#383838!important}
figcaption,.caption{color:#999!important}
img,video{opacity:.92}
::selection{background:#2f4f6f!important}
.wbar{color:#9a9a9a!important}
.wbar a{color:#7fb3e0!important}
"""


def article_dark(theme):
    """Dark override for a rendition. theme is '', 'dark' or 'light'."""
    if theme == "light":
        return ""
    if theme == "dark":
        return "<style>" + DARK_ARTICLE_CSS + "</style>"
    flat = " ".join(line.strip() for line in DARK_ARTICLE_CSS.strip().splitlines())
    return "<style>@media (prefers-color-scheme:dark){" + flat + "}</style>"


BAR_STYLE = ('<style>.wbar{font-size:.8em;margin:0 0 2em;line-height:1.9}'
             '.wbar a{color:#00e;text-decoration:none}'
             '.wbar a:hover{text-decoration:underline}</style>')


def bar_html(stem, read):
    """Text-only nav strip injected into the rendition at serve time."""
    q = quote(stem, safe="")
    back = "/article/%s/view" % q
    mark = "&#9745; mark unread" if read else "&#9744; mark read"
    toggle = html.escape("/toggle?" + urlencode(
        {"stem": stem, "to": "0" if read else "1", "back": back}), quote=True)
    return ('%s<div class="wbar"><a href="/articles">&larr; articles</a> // '
            '<a href="%s">%s</a> // <a href="/article/%s/epub">&darr; epub</a> // '
            '<a href="/article/%s/md">&darr; markdown</a> //</div>') % (
                BAR_STYLE, toggle, mark, q, q)


class Handler(BaseHTTPRequestHandler):
    server_version = "wclip-web"
    sys_version = ""
    # A stalled client should not own a thread for the rest of the day.
    timeout = 30

    def log_message(self, fmt, *a):
        print("%s %s" % (time.strftime("%H:%M:%S"), fmt % a), flush=True)

    def read_body(self, cap):
        """The request body, or None after refusing a bad or oversized length."""
        raw = (self.headers.get("Content-Length") or "0").strip()
        try:
            length = int(raw)
        except ValueError:
            self.send(400, "bad Content-Length", "text/plain; charset=utf-8")
            return None
        if length < 0:
            self.send(400, "bad Content-Length", "text/plain; charset=utf-8")
            return None
        if length > cap:
            self.send(413, "request too large", "text/plain; charset=utf-8")
            return None
        return self.rfile.read(length)

    def send(self, code, body, ctype="text/html; charset=utf-8", extra=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        headers = dict(APP_HEADERS)
        headers.update(extra or {})
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path, ctype, disp, extra=None):
        if not contained_in_articles(path):
            print("%s refused to serve %r: outside %s"
                  % (time.strftime("%H:%M:%S"), path, ARTICLES), flush=True)
            return self.send(404, "not found", "text/plain; charset=utf-8")
        real = os.path.realpath(path)
        try:
            f = open(real, "rb")
        except OSError:
            return self.send(404, "not found", "text/plain; charset=utf-8")
        with f:
            size = os.fstat(f.fileno()).st_size
            name = os.path.basename(real)
            ascii_name = name.encode("ascii", "replace").decode("ascii").replace("?", "_")
            headers = dict(APP_HEADERS)
            headers.update(extra or {})
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", "%s; filename=\"%s\"; filename*=UTF-8''%s"
                                                   % (disp, ascii_name, quote(name)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            for k, v in headers.items():
                self.send_header(k, v)
            self.end_headers()
            # Stream it: an EPUB with images can be tens of megabytes.
            shutil.copyfileobj(f, self.wfile, 64 * 1024)

    def serve_article(self, stem, which):
        if which not in ("view", "html", "md", "epub") or not valid_stem(stem):
            return self.send(404, "not found", "text/plain; charset=utf-8")
        paths = rendition_paths(stem)
        if which == "view":
            return self.serve_view(stem, paths)
        path = paths[which]
        kinds = {"md": ("text/markdown; charset=utf-8", "attachment"),
                 "html": ("text/html; charset=utf-8", "inline"),
                 "epub": ("application/epub+zip", "attachment")}
        if os.path.exists(path):
            ctype, disp = kinds[which]
            return self.send_file(path, ctype, disp,
                                  ARTICLE_HEADERS if which == "html" else None)
        with LOCK:
            state = RENDER_STATE.get(stem)
            last_error = RENDER_STATE.get("_last_error", "")
        if state == "failed":
            body = ('<p class="err">Could not render %s\n%s</p>'
                    '<p class="meta"><a href="/articles">back to articles</a></p>'
                    % (html.escape(stem), html.escape(str(last_error))))
            return self.send(500, PAGE.format(cls=THEME.get(), value="", body=body, refresh=""))
        ensure_rendition(stem)
        body = ('<p class="meta">Preparing this article, the %s rendition is being generated'
                ' from the note now&hellip;</p>' % which)
        return self.send(200, PAGE.format(cls=THEME.get(), 
            value="", body=body, refresh='<meta http-equiv="refresh" content="2">'))

    def serve_view(self, stem, paths):
        if not os.path.exists(paths["html"]):
            with LOCK:
                state = RENDER_STATE.get(stem)
                last_error = RENDER_STATE.get("_last_error", "")
            if state == "failed":
                body = ('<p class="err">Could not render %s\n%s</p>'
                        '<p class="meta"><a href="/articles">back to articles</a></p>'
                        % (html.escape(stem), html.escape(str(last_error))))
                return self.send(500, PAGE.format(cls=THEME.get(), value="", body=body, refresh=""))
            ensure_rendition(stem)
            body = ('<p class="meta">Preparing this article, rendering the reading view'
                    ' from the note now&hellip;</p>')
            return self.send(200, PAGE.format(cls=THEME.get(), 
                value="", body=body, refresh='<meta http-equiv="refresh" content="2">'))
        entry = next((e for e in list_articles() if e["stem"] == stem), None)
        read = bool(entry and entry["read"])
        try:
            with open(paths["html"], encoding="utf-8") as f:
                doc = f.read()
        except OSError as e:
            return self.send(500, "could not read the rendition: %s" % e,
                             "text/plain; charset=utf-8")
        # The rendition is served as the page itself, with a text nav strip injected
        # on the way out. The file on disk stays a pure wclip export.
        dark = article_dark(THEME.get())
        if dark and "</head>" in doc:
            doc = doc.replace("</head>", dark + "\n</head>", 1)
        if "<body>" in doc:
            doc = doc.replace("<body>", "<body>\n" + bar_html(stem, read) + "\n", 1)
        return self.send(200, doc, "text/html; charset=utf-8", ARTICLE_HEADERS)

    def handle_theme(self, qs):
        to = (qs.get("to") or ["auto"])[0]
        if to not in ("auto", "dark", "light"):
            to = "auto"
        target = "/"
        ref = urlparse(self.headers.get("Referer") or "")
        host = (self.headers.get("Host") or "").split(":")[0]
        if ref.path.startswith("/") and not ref.path.startswith("//") \
                and (not ref.netloc or ref.netloc.split(":")[0] == host):
            target = ref.path + (("?" + ref.query) if ref.query else "")
        bits = ["%s=%s" % (THEME_COOKIE, to), "Path=/", "SameSite=Lax",
                "Max-Age=31536000"]
        if self.secure_cookie():
            bits.append("Secure")
        return self.send_redirect(target, extra={"Set-Cookie": "; ".join(bits)})

    def do_GET(self):
        THEME.set(self.theme_class())
        parsed = urlparse(self.path)
        if parsed.path == "/login":
            qs = parse_qs(parsed.query)
            nxt = safe_next((qs.get("next") or ["/articles"])[0], "/articles")
            auth = load_auth()
            msg = ("" if auth.get("user") and auth.get("password_hash") else
                   '<p class="err">No credentials are configured on the server yet.</p>')
            return self.login_page(msg, nxt)
        if parsed.path == "/logout":
            return self.send_redirect("/login", extra={
                "Set-Cookie": cookie_header("", 0, self.secure_cookie())})
        if parsed.path == "/theme":
            return self.handle_theme(parse_qs(parsed.query))
        if self.gate():
            return
        parts = [unquote(p) for p in parsed.path.split("/") if p]
        qs = parse_qs(parsed.query)
        if parsed.path == "/toggle":
            return self.toggle(qs)
        if not parts:
            return self.send(200, render())
        if parts[0] == "articles":
            state = "unread" if qs.get("unread") else ("read" if qs.get("read") else None)
            back = "/articles" + (("?" + parsed.query) if parsed.query else "")
            return self.send(200, render_list(state, back))
        if parts[0] == "article" and len(parts) >= 2:
            return self.serve_article(parts[1], parts[2] if len(parts) > 2 else "view")
        if parts[0] != "job" or len(parts) < 2 or parts[1] not in JOBS:
            return self.send(404, "not found", "text/plain; charset=utf-8")
        job = JOBS[parts[1]]
        if len(parts) == 2:
            return self.send(200, render(parts[1]))
        if job["state"] != "done":
            return self.send(409, "job not finished", "text/plain; charset=utf-8")
        kinds = {"md": ("text/markdown; charset=utf-8", "attachment"),
                 "html": ("text/html; charset=utf-8", "inline"),
                 "epub": ("application/epub+zip", "attachment")}
        which = parts[2]
        if which not in kinds:
            return self.send(404, "not found", "text/plain; charset=utf-8")
        path = job["paths"].get(which, "")
        if not path or not os.path.exists(path):
            return self.send(404, "%s was not written" % which, "text/plain; charset=utf-8")
        ctype, disp = kinds[which]
        return self.send_file(path, ctype, disp,
                              ARTICLE_HEADERS if which == "html" else None)

    def send_redirect(self, location, code=303, extra=None):
        headers = dict(APP_HEADERS)
        headers.update(extra or {})
        self.send_response(code)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()

    # --- auth ---------------------------------------------------------

    def cookie_value(self):
        return self.raw_cookie(SESSION_COOKIE)

    def raw_cookie(self, name):
        raw = self.headers.get("Cookie")
        if not raw:
            return ""
        c = SimpleCookie()
        try:
            c.load(raw)
        except Exception:  # noqa: BLE001
            return ""
        m = c.get(name)
        return m.value if m else ""

    def theme_class(self):
        """What the page needs on <body>: '', 'dark' or 'light'."""
        v = self.raw_cookie(THEME_COOKIE)
        return v if v in ("dark", "light") else ""

    def secure_cookie(self):
        if self.headers.get("X-Forwarded-Proto", "") == "https":
            return True
        host = (self.headers.get("Host") or "").split(":")[0]
        return host not in ("127.0.0.1", "localhost", "::1", "")

    def same_site(self):
        """False when the browser says another site started this request.

        Absent for non-browser clients (a Shortcut, curl), and "none" is a typed URL
        or a bookmark, so both stay allowed; only a known cross-site origin is refused.
        """
        site = (self.headers.get("Sec-Fetch-Site") or "").lower()
        return site in ("", "none", "same-origin")

    def client_ip(self):
        xff = self.headers.get("X-Forwarded-For")
        if xff:
            return xff.split(",")[0].strip()
        return self.client_address[0]

    def login_blocked(self, ip):
        now = time.time()
        with LOCK:
            hits = [t for t in LOGIN_FAILS.get(ip, []) if now - t < LOGIN_WINDOW]
            LOGIN_FAILS[ip] = hits
            return len(hits) >= LOGIN_MAX_FAILS

    def note_failure(self, ip):
        with LOCK:
            LOGIN_FAILS.setdefault(ip, []).append(time.time())
        # Outside the lock: note_global_failure takes it again.
        note_global_failure()

    def login_page(self, message="", next_url="/", code=200):
        return self.send(code, LOGIN_PAGE.format(cls=THEME.get(), 
            message=message, next=html.escape(next_url, quote=True)), "text/html; charset=utf-8")

    def gate(self, json_mode=False):
        """True when the request was answered here (unauthenticated)."""
        auth = load_auth()
        if not auth.get("user") or not auth.get("password_hash"):
            body = ('<p class="err">This instance has no credentials configured, so it refuses'
                    ' to serve anything.</p><p class="meta">On the server run:<br>'
                    '<code>python3 %s --set-user NAME --set-password</code></p>'
                    % html.escape(os.path.abspath(__file__)))
            self.send(503, PAGE.format(cls=THEME.get(), value="", body=body, refresh=""))
            return True
        cookie = self.cookie_value()
        if read_session(cookie, auth["user"], auth.get("secret", ""),
                        int(auth.get("sessions_after") or 0)):
            return False
        print("%s auth reject: %s (%d chars) ua=%r host=%s"
              % (time.strftime("%H:%M:%S"),
                 "no cookie header" if not cookie else "cookie present but rejected",
                 len(cookie), self.headers.get("User-Agent", "")[:60],
                 self.headers.get("Host", "")), flush=True)
        if json_mode:
            self.send(401, json.dumps({"error": "authentication required"}),
                      "application/json; charset=utf-8")
            return True
        nxt = self.path if self.path.startswith("/") else "/"
        self.send_redirect("/login?" + urlencode({"next": nxt}))
        return True

    def handle_login(self):
        ip = self.client_ip()
        if self.login_blocked(ip):
            return self.login_page(
                '<p class="err">Too many attempts. Wait 15 minutes and try again.</p>', "/", 429)
        if globally_blocked():
            mins = max(1, (global_wait() + 59) // 60)
            return self.login_page(
                '<p class="err">Too many failed attempts. Try again in %d minute(s), '
                'or restart the service to clear the cooldown.</p>' % mins, "/", 429)
        body = self.read_body(4096)
        if body is None:
            return
        form = parse_qs(body.decode("utf-8", "replace"))
        user = (form.get("user") or [""])[0].strip()
        password = (form.get("password") or [""])[0]
        nxt = safe_next((form.get("next") or ["/"])[0], "/articles")
        auth = load_auth()
        if not auth.get("user") or not auth.get("password_hash"):
            return self.login_page(
                '<p class="err">No credentials configured on the server yet.</p>', nxt, 503)
        user_ok = hmac.compare_digest(user.encode(), auth["user"].encode())
        # Always pay for a scrypt run, so timing does not reveal whether the user exists.
        pw_ok = check_password(password, auth["password_hash"] if user_ok else DUMMY_HASH)
        if not (user_ok and pw_ok):
            self.note_failure(ip)
            # Never log the attempted username itself: that field is where people
            # paste their password by mistake.
            print("%s login failed for user#%s from %s"
                  % (time.strftime("%H:%M:%S"),
                     hashlib.sha256(user.encode("utf-8")).hexdigest()[:10], ip), flush=True)
            return self.login_page(
                '<p class="err">Wrong username or password.</p>', nxt, 401)
        with LOCK:
            LOGIN_FAILS.pop(ip, None)
        # The owner is back; an attacker cannot get this far, so drop the cooldown.
        clear_global_failures()
        days = int(auth.get("session_days") or SESSION_DAYS)
        token = make_session(auth["user"], auth["secret"], days)
        if not nxt.startswith("/") or nxt.startswith("//"):
            nxt = "/articles"
        print("%s login ok for %r from %s" % (time.strftime("%H:%M:%S"), auth["user"], ip),
              flush=True)
        return self.send_redirect(nxt, extra={
            "Set-Cookie": cookie_header(token, days * 86400, self.secure_cookie())})

    def toggle(self, params):
        if not self.same_site():
            return self.send(403, "cross-site request rejected", "text/plain; charset=utf-8")
        host = self.headers.get("Host", "")
        for hdr in ("Origin", "Referer"):
            origin = self.headers.get(hdr)
            if origin:
                if urlparse(origin).netloc and urlparse(origin).netloc != host:
                    return self.send(403, "cross-origin request rejected", "text/plain; charset=utf-8")
                break
        stem = (params.get("stem") or params.get("toggle") or [""])[0]
        back = (params.get("back") or ["/articles"])[0]
        target = (params.get("to") or [""])[0]
        if not valid_stem(stem):
            return self.send(400, "unknown article", "text/plain; charset=utf-8")
        with LOCK:
            entry = next((e for e in list_articles() if e["stem"] == stem), None)
            current = bool(entry and entry["read"])
            value = (target == "1") if target in ("0", "1") else not current
            ok = set_read(stem, value)
            LIST_CACHE.pop(stem + ".md", None)
        if not ok:
            return self.send(422, "this note has no frontmatter, so there is nowhere to store "
                                  "the read state", "text/plain; charset=utf-8")
        if not (back.startswith("/articles") or back.startswith("/article/")):
            back = "/articles"
        print("%s read: %s -> %s" % (time.strftime("%H:%M:%S"), stem,
                                     "read" if value else "unread"), flush=True)
        return self.send_redirect(back)

    def do_POST(self):
        THEME.set(self.theme_class())
        path = urlparse(self.path).path
        if path == "/login":
            return self.handle_login()
        if self.gate(json_mode=(path == "/clip")):
            return
        if path == "/toggle":
            body = self.read_body(8192)
            if body is None:
                return
            return self.toggle(parse_qs(body.decode("utf-8", "replace")))
        if path != "/clip":
            return self.send(404, "not found", "text/plain; charset=utf-8")
        if not self.same_site():
            return self.send(403, "cross-site request rejected", "text/plain; charset=utf-8")
        body = self.read_body(8192)
        if body is None:
            return
        raw = body.decode("utf-8", "replace")
        url = ""
        if "application/json" in (self.headers.get("Content-Type") or ""):
            try:
                url = str((json.loads(raw) or {}).get("url") or "").strip()
            except (ValueError, AttributeError):
                url = ""
        else:
            url = (parse_qs(raw).get("url") or [""])[0].strip()
        if not valid_clip_url(url):
            return self.send(400, render(), "text/html; charset=utf-8")
        now = time.time()
        with LOCK:
            while STARTED and now - STARTED[0] > 3600:
                STARTED.pop(0)
            pending = sum(1 for v in JOBS.values() if v["state"] == "running")
            if pending >= MAX_QUEUE:
                return self.send(429, PAGE.format(cls=THEME.get(), value="", refresh="", body=(
                    '<p class="meta">Queue is full (%d clips pending). Try again in a minute.</p>'
                    % pending)))
            if len(STARTED) >= MAX_PER_HOUR:
                return self.send(429, PAGE.format(cls=THEME.get(), value="", refresh="", body=(
                    '<p class="meta">Hourly limit of %d clips reached.</p>' % MAX_PER_HOUR)))
            STARTED.append(now)
            job_id = uuid.uuid4().hex[:12]
            JOBS[job_id] = {"url": url, "state": "running", "t0": now}
        threading.Thread(target=run_job, args=(job_id, url), daemon=True).start()
        return self.send_redirect("/job/" + job_id)


def invalidate_sessions_cli():
    auth = load_auth()
    if not auth.get("user"):
        print("no credentials configured yet; run --set-user NAME --set-password first",
              file=sys.stderr)
        return 1
    auth["sessions_after"] = str(int(time.time()))
    write_auth(auth)
    print("every session issued before now is invalid; the password is unchanged")
    return 0


if __name__ == "__main__":
    if "--set-password" in sys.argv or any(a.startswith("--set-user") for a in sys.argv):
        sys.exit(set_password_cli(sys.argv[1:]))
    if "--rotate-secret" in sys.argv:
        sys.exit(rotate_secret_cli(sys.argv[1:]))
    if "--invalidate-sessions" in sys.argv:
        sys.exit(invalidate_sessions_cli())
    auth = load_auth()
    if auth.get("user") and not auth.get("secret"):
        # Sessions need a signing key; make one on first start after an upgrade.
        auth["secret"] = base64.b64encode(secrets.token_bytes(32)).decode()
        write_auth(auth)
        print("generated a session signing secret", flush=True)
    if not auth.get("user"):
        print("WARNING: no credentials configured; every request will get 503.\n"
              "         run: python3 %s --set-user NAME --set-password" % os.path.abspath(__file__),
              flush=True)
    threading.Thread(target=sweeper, daemon=True).start()
    threading.Thread(target=render_worker, daemon=True).start()
    print("wclip-web on 127.0.0.1:%d" % PORT, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
