# Security

wclip is an interactive, single-user article clipper. The user and the configuration are
trusted; article HTML, metadata, redirects, image hosts and saved page contents are not.
It is not a hardened URL-fetching service or a multi-tenant bot backend.

## Defaults and consent

- Private and special-purpose network destinations are denied by default. `--allow-private`
  or `allow_private: true` explicitly permits intentional local/intranet requests, including
  page images. Apart from IP ranges, obvious intranet names (`localhost`, `*.local`,
  `*.internal`, `*.lan`, `*.home.arpa`, `*.corp`, `*.intranet`, `*.localdomain`) and
  single-label hostnames are refused by name, because split-horizon DNS can answer them with a
  publicly routable address. Do not enable `--allow-private` for untrusted public pages on a
  sensitive network.
- Browser JavaScript execution is off by default. `--browser` enables it for a run;
  `browser.mode: auto` explicitly enables automatic fallback. Chromium must start with its
  sandbox enabled. wclip does not fall back to an unsandboxed browser.
- OpenRouter is off by default. Having an API key does not constitute consent.
  `--llm` authorises sending the title and up to 15,000 characters of article text for that
  run. `openrouter.enabled: true` opts into this for ordinary public URLs. Saved HTML and
  any run with private-network access still need `--llm` each time. `--no-llm` always wins.
  Instructions and article text travel as separate system/user messages and the article is
  delimited as data, which reduces (but does not eliminate) prompt injection. The configured
  model/provider's data terms apply; `openrouter.data_collection: deny` asks OpenRouter to
  refuse providers that may retain or train on prompts, at the cost of possible price changes
  or "no provider" failures. wclip cannot guarantee provider retention or confidentiality
  policies. No fallback summary is fabricated if the call fails.
- Defuddle has no outbound network access. arXiv pages trigger an arXiv metadata request, but
  not during `--html` runs, which read a local snapshot and generate no traffic.
  EPUB images are fetched while exporting. HTML images remain remote and are fetched by
  your viewer when opened; no-referrer prevents sending the source URL but does not hide
  your IP address or viewing time.

## Saved output

Article Markdown is cleaned with Markdown-aware handling so raw active HTML and dangerous
link/image destinations do not pass into notes. Rendered HTML and EPUB share an allow-list
sanitiser, including the MathML needed for equations. HTML has a restrictive CSP as defence
in depth, and its `img-src` allows HTTPS only. Code snippets remain text, not executable
markup, and fence languages that note applications execute (Obsidian Dataview/Templater,
inline `$=` queries) are relabelled so a clipped page cannot run code in the viewer that opens
it. Metadata (title, byline, description, site, license) and body text are stripped of C0/C1
controls and bidi embedding characters; right-to-left marks are kept. A `rel=license` link is
resolved against the page and dropped unless it is a plain HTTP(S) URL.

Existing clips are **not retroactively repaired**. Re-clip old articles with the updated
version if you intend to open their HTML/EPUB exports. Arbitrary edits made afterwards and
vulnerabilities in third-party note viewers are outside wclip's guarantees.

## Networking and resource boundaries

The Node HTTP client checks the resolved address actually handed to the connection, repeats
validation on redirects, refuses URL credentials and HTTPS-to-HTTP downgrades, and limits wire
and decompressed bodies. Pages/local HTML are capped at 20 MiB, each image at 15 MiB, and
EPUBs at 128 unique image requests and 60 MiB of retained image payload. Scheduling stops when
the image budget fills; already in-flight requests can still finish (at most four downloads).
Config files and arXiv metadata responses are capped at 1 MiB; OpenRouter responses at 2 MiB.
Limits reduce denial-of-service exposure; they are not
proof that every possible hostile document will parse in constant time or memory. The limits
cover Node downloads and extractor input; explicitly enabled Chromium can still consume CPU
and memory while running page scripts and buffering browser resources, although media,
webfont and manifest responses are refused before they are buffered. Use OS-level resource
limits if you need a hard budget for hostile JavaScript.

Chromium is a distinct network client. Request interception and destination checks are
additional safeguards, not a complete network sandbox: browser DNS resolution/rebinding and
browser-internal network paths cannot be treated as equivalent to the Node connection guard.
Non-proxied WebRTC UDP is disabled at launch, but that flag set is still not egress isolation.
For genuinely hostile JavaScript on a sensitive network, use an OS/container/VM with enforced
egress restrictions, or leave the browser disabled. Do not expose wclip as a public service
and assume its CLI flags provide service-grade SSRF containment.

## Files, configuration and terminals

- Config fields and ranges are validated, dangerous prototype keys are rejected, and custom
  YAML keys are escaped. Config contents must still be trusted.
- New config files use mode 0600 and newly created config directories use mode 0700. Setup
  does not request API keys on an echoing prompt. Prefer `OPENROUTER_API_KEY` in the environment;
  do not put secrets in command-line arguments.
- Notes use exclusive atomic creation unless overwrite was explicitly authorised. Replacement
  writes are atomic and destination-file symlinks are refused. Output directories and their
  parent path components remain user-controlled/trusted; this is not a filesystem jail.
- Filenames are bounded by UTF-8 bytes. Diagnostics, metadata and extracted Markdown remove
  terminal control characters and bidi embedding characters, while the status renderer adds
  only its own terminal controls.

## Builds and dependencies

Release builds are tested before a separate, narrowly privileged job publishes artifacts.
Action references and bootstrap compiler dependencies are locked; source-launcher installs
have lifecycle scripts disabled. Dependency scanning does not establish that dependencies are
free of malicious code or undisclosed vulnerabilities.

`SHA256SUMS` detects corruption and verifies consistency with the accompanying release, not
independent authenticity if the repository/release account itself is compromised. Build
attestations, when available, add a verifiable workflow identity, not a guarantee that source
code is safe. The bundled executables contain Bun; changing the Node version used in CI does
not by itself update the embedded runtime.

The committed TLS key is an intentionally public, self-signed localhost test fixture. It is
not used for deployment, signing, or authentication. Do not ignore unrelated secret-scanner
findings because this one fixture is expected.

## Reporting

Do not paste API keys, confidential clips, or exploit payloads containing real internal data
into a public issue. Use GitHub private vulnerability reporting if enabled; otherwise arrange
a private reporting channel with the maintainer before sharing sensitive details.
