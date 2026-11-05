# wclip-web

A small web front end for the `wclip` article clipper. Paste a URL, get the
article rendered as a page, plus Markdown and EPUB downloads. It also keeps a
reading list over the notes already in the articles folder, with read and unread
state stored in the note frontmatter.

It is a single-user tool. There is no registration, no multi-tenancy, and no
database.

## How it works

```
browser  ->  reverse proxy (TLS)  ->  server.py  ->  wclip CLI  ->  note.md
                                                              ->  html/name.html
                                                              ->  epub/name.epub
```

The server is one Python file using only the standard library. It runs `wclip`
as a subprocess with a dedicated config, then reads back what the CLI wrote. The
CLI stays the single source of truth for fetching, extraction, note building and
HTML/EPUB rendering, so the web layer cannot drift from the tool's behaviour.

Only one clip or rendition runs at a time. That is deliberate: `wclip`'s launcher
may rebuild its compiled output on start, and two concurrent runs race on
`node_modules`.

## Requirements

- Python 3.10 or newer. Nothing outside the standard library is needed.
- `wclip` installed and working from the command line.
- A reverse proxy for TLS. The server binds `127.0.0.1` and speaks plain HTTP by
  design. Never expose it directly.

## Files

| Path | Purpose |
| --- | --- |
| `server.py` | the whole application |
| `test_server.py` | stdlib tests, run with `python3 web/test_server.py` |
| `render-note.mjs` | generates missing HTML/EPUB using wclip's own renderer |
| `wclip-web.service` | systemd unit template |
| `install.sh` | installs the unit and rewrites the proxy configuration |

Runtime state:

- `~/.config/wclip-web/config.yaml` is a **wclip** config used for every clip.
- `~/.config/wclip-web/auth.yaml` holds credentials and the session secret, mode
  600.
- `~/.config/wclip-web/env` holds environment secrets for the unit, mode 600.

Credentials live in their own file on purpose, and not because `wclip` would
reject them: it checks the keys it knows and passes unknown ones through silently.
That is precisely why a password does not belong in a config the CLI is handed on
every clip. (The same silence means a mistyped key in that file does nothing at
all; only the keys listed above are read.)

## Configuration

The wclip config is a normal wclip config. The keys that matter here:

```yaml
articles_dir: ~/articles   # where notes and their renditions are written
make_html: true            # write html/<name>.html next to the note
make_epub: true            # write epub/<name>.epub next to the note
include_images: true
allow_private: false       # keep false for anything reachable over a network
cookies_file: ''           # never send subscriber cookies from a web request
browser:
  mode: never              # no headless browser from the server
openrouter:
  enabled: true            # tags and summaries, requires OPENROUTER_API_KEY
```

The server does not pass `--llm`: `openrouter.enabled` in the config decides, so
`false` really does keep the article text off the network. With `true` and no key,
tags and the description come back empty rather than invented.

## Response headers and request limits

Renditions are third-party HTML, so the server does not rely on whatever `<meta>`
tag a given file happens to contain. Every `/article/*/view`, `/article/*/html`
and `/job/*/html` response carries:

```
Content-Security-Policy: default-src 'none'; script-src 'none'; img-src https: data:;
  style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'; sandbox allow-downloads
Referrer-Policy: no-referrer
```

`sandbox` gives the document an opaque origin; `allow-downloads` is what keeps the
reading view's EPUB and Markdown links working. The app's own pages get
`frame-ancestors 'none'`, `X-Frame-Options: DENY` and `no-referrer` instead, because
they need inline styles and forms.

The request side is deliberately narrow: `Content-Length` must parse and fit the
endpoint's cap (4 KiB for login, 8 KiB for clip and toggle), the handler socket times
out after 30 s, a clip URL containing control characters is refused before it reaches
the CLI, and only paths under `articles_dir` (after `realpath`) can be served.

## Tests

```
python3 web/test_server.py
```

Stdlib `unittest`. It imports the app with `HOME` and `WCLIP_WEB_ARTICLES` pointed at
a temporary tree, starts a real server on an ephemeral port and checks the headers,
the login redirect, control-character and length rejection, path containment and the
404s. No network, no credentials, nothing touched outside the temp directory.

## First run

```
# 1. create the account (prompts twice, nothing echoed)
python3 server.py --set-user alice --set-password

# 2. install the unit and proxy config, then reload
sudo ./install.sh

# 3. open the site and sign in once
```

The password must be at least 12 characters and must not match the username. The
hash is read at login time, so changing the password does not need a restart.

Useful flags:

- `--set-user NAME --set-password` creates or replaces the account. An existing
  session secret is kept, so other devices stay signed in.
- `--rotate-secret` generates a new signing secret and invalidates every session
  cookie. No restart needed.
- `--invalidate-sessions` stamps `sessions_after` in `auth.yaml`: every cookie
  issued before now stops working while the password and the secret stay as they
  are. Sessions carry `iat` for exactly this, and a cookie without one counts as
  old when the stamp exists.

If no credentials are configured, every route answers `503` with instructions
instead of serving openly. This is intentional: removing basic auth from the
proxy must not leave an open endpoint behind.

## Authentication

- Passwords are hashed with `scrypt` (n=16384, r=8, p=1, 16-byte salt) and
  compared with `hmac.compare_digest`. Format: `scrypt$n$r$p$salt$hash`.
- Unknown usernames still cost a full scrypt run, so response time does not
  reveal whether the account exists.
- Sessions are stateless: `base64url(json{u,exp})` plus an HMAC-SHA256 over it
  keyed by the stored secret, in the cookie `wcs`.
- Cookie flags: `HttpOnly`, `SameSite=Lax`, `Max-Age` of 180 days, and `Secure`
  when the request arrives over HTTPS (`X-Forwarded-Proto`) or the Host is not
  loopback.
- Login failures are throttled per client IP: 5 attempts per 15 minutes, then
  `429`. The IP is taken from the first `X-Forwarded-For` hop, since every
  request otherwise appears to come from the proxy, and the proxy is expected to
  set that header itself (Caddy does).
- There is also a global counter: 10 failures inside 24 hours buy a 15 minute
  cooldown, 20 an hour, 30 four hours. A successful login clears it and a
  restart clears it, because it is deliberately in memory. This is what stops
  somebody who can pick their own source address; it is also a self-lockout
  risk, which is why the escalation starts at ten rather than five.
- State-changing requests (`POST /clip`, `GET|POST /toggle`) are refused with
  `403` when the browser reports `Sec-Fetch-Site: cross-site` or `same-site`.
  A request without that header (curl, a Shortcut) is still allowed.
- `POST /clip` with a JSON body, or any request asking for JSON, returns `401`
  with a JSON error instead of an HTML redirect, so scripts and shortcuts can
  handle it.

To log out, use the `logout` link in the nav or clear the cookie.

## Endpoints

- `GET /` clip form
- `POST /clip` accepts a URL as form field `url` or JSON `{"url": "..."}`,
  redirects to the job page
- `GET /job/<id>` progress and result, with downloads
- `GET /job/<id>/md|html|epub` the renditions of that clip
- `GET /articles` reading list, `?unread=1` or `?read=1` to filter
- `GET /article/<stem>/view` the article itself, with a text nav strip
- `GET /article/<stem>/md|html|epub` the raw renditions
- `GET /toggle?stem=...&to=0|1&back=...` set read state
- `GET /theme?to=auto|light|dark` set the theme, redirect back
- `GET|POST /login`, `GET /logout`

Stems are note filenames without `.md`. They may contain spaces, apostrophes and
parentheses, so every link is percent-encoded and every incoming stem is checked
against the existing notes.

## Theme

Three states, picked from the nav with plain text links, stored in a `wct`
cookie for a year:

- `auto`, the default when no cookie is set, follows `prefers-color-scheme`
- `light` and `dark` pin it by putting a class on `<body>`, which is what lets a
  manual choice beat the system setting

The palette is a handful of CSS variables, so both themes come from the same
rules and there is no second stylesheet to keep in sync.

Article renditions are third-party HTML exported by wclip, so they are not
repainted on disk. The server injects a small dark override into the rendition
on the way out: scoped to `prefers-color-scheme` when the theme is `auto`,
unconditional when it is `dark`, and omitted entirely in `light`. The note, the
HTML and the EPUB in the articles folder are never touched, and the injected
CSS overrides only what it must, since an export can carry its own colors.

## Reading list and read state

The list parses note frontmatter (title, author, created, reading time, tags,
`source`, `read`) and caches it per file mtime, so a warm list of roughly a
thousand notes renders in tens of milliseconds.

The sub-line under each title is
`2026-11-01 | 24 min | daringfireball.net | watermarking · anthropic`: pipes
separate date, reading time, source host and the tag block, and the middle dot
separates tags within it (at most four). The host comes from the note's
`source:` URL with any leading `www.` dropped; a missing reading time or source
drops that pipe slot, and a note without tags ends at the host.

Read state lives in the note's own `read:` field, which is also what
`wclip --read` writes. Toggling rewrites only that line: a temp file with the
note's original permissions replaces the note atomically, so a crash mid-write
cannot truncate an article. Every other byte, including quoting and key order,
is left alone.

Notes clipped before HTML/EPUB export existed have no renditions. Opening one
queues it for generation through `render-note.mjs`, which imports wclip's
compiled renderer, so there is exactly one markdown pipeline. The page shows a
short "preparing" notice and reloads itself when the file exists.

## Security model

- The server trusts nothing about a URL and relies on `wclip`'s own guards: DNS
  preflight against private address space, redirect validation and response size
  limits. Keep `allow_private: false`.
- No subscriber cookies and no headless browser are configured for web requests,
  which removes two whole classes of surprise.
- Path traversal is not possible: renditions are addressed by a stem that must
  match an existing note, and no client-supplied path is ever joined into a file
  path.
- CSRF: cookies are `SameSite=Lax`, so cross-site POSTs carry no session. The
  read toggle additionally rejects a mismatched `Origin` or `Referer`. It is a
  GET with an explicit target so repeats and prefetches are idempotent.
- Downloads are sent with `Content-Disposition: attachment` and every response
  carries `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.
- Rendered article HTML is served as-is; it carries its own restrictive CSP
  (`default-src 'none'`, no scripts, no forms).

Residual risks worth stating plainly: this is a single-user tool with no audit
trail, no per-user isolation and no protection against a compromised host. If it
ever serves more than one person, the whole model has to change.

## Operations

- Restart without root: `kill` the server PID and the unit's `Restart=always`
  brings it back on the current code.
- A clip queue of 4 and an hourly cap of 40 keep a runaway client from pinning
  the machine.
- Job entries expire from memory after 2 hours. Files on disk are never deleted
  by the service; they are your notes.
- Rotating the session secret logs out every device. Rotating the password keeps
  sessions alive.

## Limitations

- Notes with no frontmatter cannot carry read state and return `422`.
- Some old notes render without images when their Markdown carries unexpanded
  srcset placeholders such as `{width}` in the image URL. The clipper warns and
  omits them.
- No search, no pagination, client-side filtering only.
- No multi-user support, no registration, no password reset beyond rerunning the
  command.
- EPUB renditions with many images can be large, tens of megabytes, which matters
  on a slow phone connection.

## Roadmap

The plan is to fold this into `wclip` as a `serve` subcommand, calling the
pipeline in process instead of shelling out. That would remove the subprocess
boundary, the separate config and the helper script, and would ship with the
release binaries. The server would stay loopback-only there as well, with a
reverse proxy expected to terminate TLS and handle exposure.

The subprocess today is at least a narrow contract: `wclip` runs with `--json`
and prints one object (`ok`, `path`, `existing`, `warnings`), so nothing here
parses human-readable output. A reported path is still checked against the
articles folder before it is served.

## Disclosure

This tool was written with substantial AI assistance. It has tests for the paths
covered above, but it has not had an independent security audit. Treat it as
personal infrastructure, not a product.

## Where things sit on the author's host

The files here are the ones actually deployed, so a few paths are specific to that
host. Change them before using this elsewhere:

- `wclip-web.service`: `User`/`Group`, `WorkingDirectory`, `EnvironmentFile`
  (`~/.config/wclip-web/env` holds `OPENROUTER_API_KEY` when the LLM step is on) and
  `ExecStart` point at `/home/deploy/apps/wclip-web`.
- The same unit hardens the cgroup: `ProtectSystem=strict`, `ProtectHome=read-only`
  with `ReadWritePaths` for the articles folder, `~/.config/wclip-web` and the wclip
  checkout, no capabilities, `MemoryMax=2G`, `TasksMax=256`, and an address filter
  that denies loopback, link-local, multicast and every private range. Both
  `IPAddressAllow` entries matter: `127.0.0.1` is the reverse proxy connecting in,
  `127.0.0.53` is the local DNS resolver. Without the first the site goes dark,
  without the second every clip fails to resolve hostnames. `SystemCallFilter` is
  deliberately absent: it is the setting most likely to break Node in ways that are
  hard to attribute, and it can be added once the filtered run is known to work.
- The unit also points `npm_config_cache` at `~/.local/share/wclip-npm-cache`,
  because the default `~/.npm` is not writable under `ProtectHome=read-only` and the
  launcher runs `npm ci` when the wclip sources change. After pulling a new wclip,
  run `wclip --version` once in your shell so the rebuild happens outside the
  sandbox; otherwise the first web clip does it and pays the download.
- `install.sh`: `APP=/home/deploy/apps/wclip-web` and the Caddy site name
  `clip.shtfn.xyz` in `caddy-clip.snippet`. The script checks that Caddy still
  validates and restores its backup if it does not.
- `server.py`: reads `~/.config/wclip-web/config.yaml` (see `config.example.yaml`),
  `~/.config/wclip-web/auth.yaml` (accounts and cookie secret, written by the
  `--set-user` / `--set-password` / `--rotate-secret` flags) and clips into
  `$WCLIP_WEB_ARTICLES`, default `~/apps/dufs/data/articles`.
- `render-note.mjs`: imports the compiled renderer from `$WCLIP_DIST`, default
  `~/.local/share/wclip/dist`, i.e. from a source install of the CLI.

Nothing in this directory reads a secret at startup beyond `auth.yaml`; there is no
`.env` in the repository.
