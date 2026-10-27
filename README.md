# wclip

Clips a web article to a Markdown note with YAML frontmatter, plus optional HTML and EPUB
renditions. It replaces the Python `webclip` script and keeps its CLI flags, config keys and
note format, so existing notes and configs keep working. It was called `webclip` until the
move to this repository; see [Coming from webclip](#coming-from-webclip).

Extraction is [Defuddle](https://github.com/kepano/defuddle) 0.19.5 (the engine behind
Obsidian Web Clipper) with the fixes from the bake-off (`bakeoff/VERDICT.md`).

## Install

**From a release:** each `v*` tag gets a GitHub Release with the files below and a
`SHA256SUMS`. The repository is private, so downloading needs your GitHub login, e.g. with the
GitHub CLI:

```sh
gh release download -R BoboDupla/wclip -p wclip-linux-x64 -p SHA256SUMS   # latest release
sha256sum --ignore-missing -c SHA256SUMS && install -m 755 wclip-linux-x64 ~/.local/bin/wclip
```

Build outputs aren't committed; `npm ci` then `npm run build:bin` / `npm run build:js` make them
in `build/`.

**Single binary (no Node needed):** copy `build/wclip-linux-x64` (or `-arm64`) somewhere on
your `$PATH` as `wclip` and `chmod +x` it. It's about 95 MB because it carries the Bun runtime.
Built with `bun build --compile` (Bun 1.4.3); it needs glibc, and the x64 build needs a CPU
from roughly 2013 or later (AVX2); for older CPUs use `wclip-linux-x64-baseline`. The arm64
build is cross-compiled and hasn't been run on real arm64 hardware yet.

**Single JavaScript file (about 5.7 MB, uses your installed runtime):** `build/wclip-node.js`
runs with Node.js 20+ (`node wclip-node.js URL`), `build/wclip-bun.js` with Bun
(`bun wclip-bun.js URL`). Everything is bundled in, so there is no `npm install`.
Rebuild with `npm run build:js`.

**From source:** needs Node.js 20 or newer (tests pass on 20.20 and 22.22).

```sh
git clone https://github.com/BoboDupla/wclip.git && cd wclip
ln -s "$PWD/wclip" ~/bin/wclip    # the launcher installs and builds on first run
wclip https://ploum.net/2025-09-03-calendar-txt.html
```

On first run the launcher runs `npm ci --omit=dev` into `node_modules/` and compiles `src/` into
`dist/` with a pinned TypeScript kept in `.tools/`, like the Python version's `.venv` bootstrap.
After a `git pull` that changes `src/`, run `npm run build` (or delete `dist/`).

The headless browser fallback needs a Chromium. It uses, in order: `browser.executable` from
the config, `$WCLIP_CHROMIUM`, Playwright's own download (`npx playwright install chromium`),
then `chromium`, `chromium-browser`, `google-chrome` or `brave-browser` on `$PATH`. Without
one, wclip still works; it just can't rescue JavaScript-only pages.

## Usage

Same as before, plus these flags:

```
wclip URL [-t TITLE] [-a AUTHORS] [-p DATE] [-d DESC] [-g TAGS] [-r] [-f] [--stdout]
wclip -i [URL]                   interactive: confirm/edit fields
wclip --init-config              write a default config file
  --browser                      fetch with the headless browser right away
  --no-browser                   never use the headless browser
  --html FILE                    extract from a page you saved yourself; URL is still the source
  -v, --verbose                  sizes, HTTP status, timings, written files
  -q, --quiet                    no progress lines; warnings, errors, saved path only
  --no-progress                  plain lines instead of a live status line
```

`--bootstrap` is gone (npm handles dependencies).

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

1. Plain HTTP with an honest user agent (`wclip/0.3.0 (personal article clipper)`).
2. Only if that fails, returns under 2 KB, or yields no text: once more with a Firefox user
   agent, and that result is used only if it is bigger. tante.cc serves a small fake page to
   browser user agents (saved in `test/fixtures/tante-friction.browser-ua.html`), so the order matters.
3. Only if the result is still empty or under `browser.min_words` (50): headless Chromium,
   with its own `HeadlessChrome` user agent. Its result is used only if it has more words.

Defuddle's third-party API fallback is off (`useAsync: false`), and Defuddle is given a
`fetch` that refuses every request, so page content never leaves your machine through it.
The only other outbound calls are the arXiv API (metadata for arxiv.org pages), OpenRouter
(tags and summary, as before) and image downloads for the EPUB.

## Config

`~/.config/wclip/config.yaml` (or `$WCLIP_CONFIG`). All the old keys mean the same thing.
New, optional keys (defaults apply when they're missing):

```yaml
progress: true        # live status line on a terminal (false = plain lines)
browser:
  mode: auto          # auto | never
  executable: ""      # path to chromium/chrome
  min_words: 50       # fewer extracted words than this counts as a stub
  timeout: 45
boilerplate:          # CSS selectors removed before extraction, per host; "*" = all sites
  "ploum.net": ["div.signature"]
```

A host listed under `boilerplate` replaces that host's built-in list; other hosts keep theirs.
`properties` also accepts `site` and `license` now (off by default).

## Coming from webclip

- If `~/.config/wclip/config.yaml` doesn't exist, `~/.config/webclip/config.yaml` is read
  instead, so nothing needs moving. Move it whenever you like
  (`mv ~/.config/webclip ~/.config/wclip`); once the new file exists the old one is ignored.
- `$WEBCLIP_CONFIG` and `$WEBCLIP_CHROMIUM` still work; `$WCLIP_CONFIG` and `$WCLIP_CHROMIUM`
  win when both are set.
- The honest user agent is now `wclip/<version>`, and binaries and bundles are named `wclip-*`.
- An installed `webclip` command (e.g. `~/.local/bin/webclip`) keeps working; it's only a file
  name. Rename it, or symlink `wclip` to it, when you switch to a build from this repo.

## What changed compared to the Python version

- Extraction: Defuddle with content-pattern guessing off (it silently deleted paragraphs) and
  explicit boilerplate selectors instead. Keeps blockquotes, Ars subheadings and images that
  trafilatura dropped; arXiv metadata comes from the arXiv API. Details: `bakeoff/VERDICT.md`.
- Lead images: when a page shows its `og:image` at 400px or wider and Defuddle dropped it, it is
  put back on top (fixes the missing Ars hero image; also adds tante's featured images).
- EPUB: images are downloaded into the book. EPUB 3 does not allow remote images, so the old
  EPUBs failed epubcheck and showed no pictures on most readers. All 8 test EPUBs pass
  epubcheck 5.2.1 with 0 errors and 0 warnings.
- Page charset is honoured (e.g. windows-1250), instead of assuming UTF-8.
- Headless browser as a last resort, instead of "use Hermes" errors.

## Releasing

Bump the version in `package.json` and `src/fetch.ts`, merge, then push a tag:
`git tag v0.3.0 && git push origin v0.3.0`. The `Release` workflow checks that the tag matches
both versions, runs the tests, builds the binaries and bundles, smoke-tests the x64 ones and
publishes the release. A tag with a hyphen (`v0.3.0-rc1`) becomes a pre-release. The same
workflow runs on pull requests, without publishing.

## Tests

`npm run build:bin` rebuilds the binaries; `npm run test:bin` checks the x64 binary against the
same golden pages, the HTML/EPUB output and the headless browser fallback.

```sh
npm ci && npm test     # builds, then runs 45 tests offline
```

`test/fixtures` holds the 8 bake-off pages plus saved arXiv API answers. `test/golden` holds
the expected Markdown and metadata for each, and the frontmatter produced by the Python
script's own `build_note()` for the same input (the new one must match it byte for byte).
After an intended extraction change, run `node test/make-golden.mjs` and review the diff.

The fetch tests run a local HTTP server: the tante decoy, a site that refuses non-browser
clients, a windows-1250 page, and a JavaScript-only page. The real-Chromium test is skipped
when no Chromium is found.

## Layout

- `src/cli.ts` flags and the clip flow
- `src/pipeline.ts` fetch order (honest UA, browser UA, headless browser)
- `src/fetch.ts`, `src/browser.ts` HTTP and Playwright
- `src/extract.ts` Defuddle plus the bake-off fixes
- `src/note.ts` frontmatter; `src/render.ts` HTML/EPUB; `src/llm.ts` OpenRouter; `src/config.ts`
- `dist/` compiled JavaScript (rebuild with `npm run build`); `build/` the single binaries
  (both git-ignored)
- `bakeoff/` the Defuddle vs trafilatura comparison that picked the engine (`VERDICT.md`)
