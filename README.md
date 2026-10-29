# wclip

Clips a web article to a Markdown note with YAML frontmatter, plus optional HTML and EPUB
renditions.

Extraction is [Defuddle](https://github.com/kepano/defuddle) 0.19.5 (the engine behind
Obsidian Web Clipper), with its content-pattern guessing turned off and explicit boilerplate
selectors instead, because the guessing silently dropped real paragraphs.

## How this was written

Most of the code, tests and documentation here were drafted by AI coding agents (Claude Code,
and Hermes running other models) at the author's direction, then reviewed and committed. What
to build, which bugs were worth chasing and what counted as good enough are the author's calls;
much of the typing and of the diagnosis is not. Judge the tool by its code and its test suite
rather than by who wrote it.

## Install

**One-line install:** fetches the release binary for your architecture, verifies it
against `SHA256SUMS`, smoke-runs it, and drops it in `~/.local/bin`:

```sh
curl -fsSL https://github.com/BoboDupla/wclip/releases/latest/download/install.sh | sh
```

Pin a version or change the destination, and note the `-s --`, which is needed to pass
arguments through a pipe:

```sh
curl -fsSL https://github.com/BoboDupla/wclip/releases/latest/download/install.sh \
  | sh -s -- --version v0.5.1 --bin-dir ~/bin
```

If you would rather read it first, `install.sh` is a release asset and is listed in
`SHA256SUMS`; `curl -fsSLO .../install.sh && sh install.sh` works too. It refuses musl
systems (Alpine) instead of downloading a glibc binary that cannot run.

**From a release:** each `v*` tag gets a GitHub Release with the files below and a
`SHA256SUMS`. Download them from the releases page, or with the GitHub CLI:

```sh
gh release download -R BoboDupla/wclip -p wclip-linux-x64 -p SHA256SUMS   # latest release
sha256sum --ignore-missing -c SHA256SUMS && mkdir -p ~/.local/bin && install -m 755 wclip-linux-x64 ~/.local/bin/wclip
```

Build outputs aren't committed; `npm ci` then `npm run build:bin` / `npm run build:js` make them
in `build/`.

**Single binary (no Node needed):** copy `build/wclip-linux-x64` (or `-arm64`) somewhere on
your `$PATH` as `wclip` and `chmod +x` it. It's about 95 MB because it carries the Bun runtime.
Built with `bun build --compile` (Bun 1.4.3); it needs glibc, and the x64 build needs a CPU
from roughly 2013 or later (AVX2); for older CPUs use `wclip-linux-x64-baseline`. The arm64
build is cross-compiled from x64 and is not covered by the CI smoke test; it has been run by
hand on a real aarch64 host (version, a clip, HTML and EPUB exports).

**Single JavaScript file (about 5.7 MB, uses your installed runtime):** `build/wclip-node.js`
runs with Node.js 22.12+ (`node wclip-node.js URL`), `build/wclip-bun.js` with Bun
(`bun wclip-bun.js URL`). Everything is bundled in, so there is no `npm install`.
Rebuild with `npm run build:js`.

**From source:** needs Node.js 22.12 or newer. CI builds and tests on Node 24.

```sh
git clone https://github.com/BoboDupla/wclip.git && cd wclip
mkdir -p ~/.local/bin             # same place the release install goes
ln -s "$PWD/wclip" ~/.local/bin/wclip   # the launcher installs and builds on first run
wclip https://ploum.net/2025-09-03-calendar-txt.html
```

To update a source install, just `git pull`: the launcher compares a fingerprint of `src/` and
the lockfiles against `dist/.build-stamp` and reinstalls/rebuilds when they changed. Developer
installs can use `npm ci && npm run build`.

On first run the launcher installs locked runtime dependencies into `node_modules/` and locked
compiler tools into `tooling/node_modules/`, with lifecycle scripts disabled. It compiles `src/`
into `dist/` without a global TypeScript install.

The headless browser fallback needs a Chromium. It uses, in order: `browser.executable` from
the config, `$WCLIP_CHROMIUM`, Playwright's own download (`npx playwright install chromium`),
then `chromium`, `chromium-browser`, `google-chrome` or `brave-browser` on `$PATH`. Without
one, wclip still works; it just can't rescue JavaScript-only pages.

## Usage

Flags:

```
wclip URL [-t TITLE] [-a AUTHORS] [-p DATE] [-d DESC] [-g TAGS] [-r] [-f] [--stdout]
wclip -i [URL]                   interactive: confirm/edit fields
wclip --init-config              write a default config file
  --browser                      fetch with the headless browser right away
  --no-browser                   never use the headless browser
  --html FILE                    extract from saved HTML (20 MiB limit); URL is the source
  --cookies FILE                  send subscriber cookies (Netscape cookies.txt) to that host
  --llm                          explicitly send article text to OpenRouter for this run
  --no-llm                       never send article text to OpenRouter
  --allow-private                allow local/intranet page and image requests
  -v, --verbose                  sizes, HTTP status, timings, written files
  -q, --quiet                    no progress lines; warnings, errors, saved path only
  --no-progress                  plain lines instead of a live status line
```


## Output

Progress goes to stderr, so `--stdout` still emits the note and nothing else. When stderr is a
terminal, one line is redrawn in place with a spinner and the elapsed time:

```
| fetching en.wikipedia.org                                                    0.4 s
ok 1.9 MB from honest UA, 27323 words (HTTP 200, 173 ms) in 4.4 s
| tags + summary via glm-5.3-flash                                             2.1 s
ok everest, mountaineering, himalayas in 3.4 s
| embedding images                                        [########--------] 21/41
ok 41 image(s) in 0.5 s
```

A bar appears only where the total is known: the EPUB image downloads. Phases without a known
length (fetch, extraction, tags) get a label, a spinner and a clock instead of a fake bar. Piped
stderr (cron, `2>log`) gets plain `label ...` / `ok ...` lines and no escape codes. `TERM=dumb`
and `--no-progress` do the same on a terminal; `progress: false` in the config or
`$WCLIP_PROGRESS=0` turns the live line off everywhere.

## How a page is fetched

1. Plain HTTP with an honest user agent (`wclip/<version> (personal article clipper)`).
2. Only if that fails, returns under 2 KB, or yields no text: once more with a Firefox user
   agent, and that result is used only if it is bigger. tante.cc serves a small fake page to
   browser user agents (saved in `test/fixtures/tante-friction.browser-ua.html`), so the order matters.
3. Browser execution is off by default. `--browser` explicitly uses sandboxed Chromium;
   `browser.mode: auto` opts into a fallback when the result is empty or under
   `browser.min_words` (50). The fallback is used only if it has more words.

Defuddle itself has no network access. Other network activity is explicit: fetching the source
page, an arXiv metadata lookup for arXiv URLs, EPUB image downloads, and OpenRouter **only when
enabled**. HTML renditions load remote images when viewed, with no referrer. Image hosts can
still observe your IP and viewing time.

**OpenRouter is disabled by default, even when an API key is present.** `--llm` sends the title
and up to 15,000 characters of article text through OpenRouter to the configured model.
`openrouter.enabled: true` opts into this for ordinary public URLs. Saved HTML and runs with
private-network access still require `--llm` each time. `--no-llm` overrides the config.
Do not enable it for confidential material without permission to send that material to the
provider. Overridden or unused tags/description never trigger a call. Instructions and article
text are sent as separate system/user messages with the article delimited as data, and
`openrouter.data_collection: deny` asks OpenRouter to skip providers that may retain or train
on prompts (it can raise the price or fail if the model has no such provider).

Local/intranet destinations and HTTPS-to-HTTP redirects are blocked by default. Use
`--allow-private` only for intentional local/intranet clipping. Chromium runs with its sandbox
enabled and fails if that is unavailable; it is not a network-isolation boundary. See
[SECURITY.md](SECURITY.md) for the threat model, limits and remaining browser-network caveats.

## Paywalled pages

A paywall is not a bug in the fetcher, and a 200 is not proof of a whole article. Two things
make that visible instead of silently producing a two-paragraph note:

- A non-2xx answer names the wall: `warning: honest UA: HTTP 401 from <url> (login or
  subscription required)`, and the final error repeats it with what to do next.
- Extraction that ends in a rights notice or a subscribe box, under 400 words, is reported as
  `warning: incomplete article: the body ends with a copyright notice after 187 words`.
  Long articles and short posts without those markers are left alone. This applies to `--html`
  as well: a saved page can be a teaser.

If you have a subscription, export cookies for that site as a Netscape `cookies.txt` (curl, most
browser extensions, or `--cookies-from-browser` in yt-dlp produce that format) and point at it:

```sh
wclip https://www.example.com/paid-story --cookies ~/.config/wclip/cookies.txt
```

What the cookie jar will and will not do:

- A cookie is only sent to the host it belongs to; the subdomain flag in the file is honoured,
  and a bare `name=value` line applies to any host (use that deliberately).
- A redirect to a different host drops the cookies: each hop's header is rebuilt from the jar.
- `Secure` cookies are not sent over HTTP, expired ones are dropped, and path prefixes apply.
- The headless browser loads them into a fresh context, so Chromium's own rules apply there.
- Image downloads never carry them, and `--html` ignores them (a saved file needs no network).
- Values are never logged. Diagnostics report a host name at most, e.g.
  `no cookie in the file matches www.example.com; fetching unauthenticated`.

No cookies are sent unless you ask: `cookies_file` is empty by default.

## Config

`~/.config/wclip/config.yaml` (or `$WCLIP_CONFIG`).
Selected keys (defaults apply when they're missing):

```yaml
articles_dir: ~/articles   # notes and their html/ and epub/ land here (default)
reading_wpm: 200
progress: true        # live status line on a terminal (false = plain lines)
allow_private: false
cookies_file: ""      # Netscape cookies.txt for subscriber sites; empty = send none
openrouter:
  enabled: false
  api_key: ""         # prefer OPENROUTER_API_KEY in the environment
  model: "z-ai/glm-5.3-flash"
  timeout: 60
  data_collection: allow  # deny = skip OpenRouter providers that may retain/train on prompts
browser:
  mode: never         # never | auto; --browser explicitly runs Chromium
  executable: ""      # path to chromium/chrome
  min_words: 50       # fewer extracted words than this counts as a stub
  timeout: 45
boilerplate:          # CSS selectors removed before extraction, per host; "*" = all sites
  "ploum.net": ["div.signature"]
```

A host listed under `boilerplate` replaces that host's built-in list; other hosts keep theirs.
`properties` also accepts `site` and `license` (off by default).

## What it does with awkward pages

- Extraction keeps blockquotes, subheadings and images that Defuddle's defaults drop;
  arXiv metadata comes from the arXiv API rather than the page.
- Lead images: when a page shows its `og:image` at 400px or wider and Defuddle dropped it, it is
  put back on top.
- EPUB: images are downloaded into the book, because EPUB 3 does not allow remote images
  (epubcheck RSC-006). All 8 test EPUBs pass epubcheck 5.2.1 with 0 errors and 0 warnings.
- Page charset is honoured (e.g. windows-1250) instead of assuming UTF-8.
- Notes are Markdown, not code: fence languages that note apps execute (`dataview`,
  `dataviewjs`, `templater`) are relabelled `text`, and inline code starting with `$=` gets a
  zero-width space so a clipped page cannot run a query in Obsidian. Ordinary code is untouched.
- Explicitly enabled, sandboxed headless browser for pages that only render with JavaScript.
  Browser media/font/manifest requests are refused (they are buffered in-process) and Chromium's
  non-proxied WebRTC UDP paths are disabled.

## Tests

`npm run build:bin` rebuilds the binaries; `npm run test:bin` checks the x64 binary against the
same golden pages, the HTML/EPUB output, the headless browser fallback and the SSRF policy. The
binary is Bun-compiled, so those checks are what prove the security policy on the runtime that
actually ships; the Node suite alone does not.

```sh
npm ci && npm test     # builds, then runs the test suite offline
```

`test/fixtures` holds eight captured article pages plus saved arXiv API answers. `test/golden`
holds the expected Markdown and metadata for each, and the exact frontmatter a note must come
out with. After an intended extraction change, run `node test/make-golden.mjs` and review the
diff.

The fetch tests run a local HTTP server: the tante decoy, a site that refuses non-browser
clients, a windows-1250 page, and a JavaScript-only page. The real-Chromium test is skipped
when no Chromium is found.

## Layout

- `src/cli.ts` flags and the clip flow
- `src/pipeline.ts` fetch order (honest UA, browser UA, headless browser)
- `src/fetch.ts`, `src/network-policy.ts`, `src/browser.ts` bounded/guarded HTTP and Playwright
- `src/sanitize.ts`, `src/files.ts` safe output and atomic file writes
- `src/extract.ts` Defuddle plus one named fix per known extraction failure
- `src/note.ts` frontmatter; `src/render.ts` HTML/EPUB; `src/llm.ts` OpenRouter; `src/config.ts`
- `dist/` compiled JavaScript (rebuild with `npm run build`); `build/` the single binaries
  (both git-ignored)
