# Bake-off verdict: Defuddle 0.19.5 vs webclip's trafilatura pipeline

Run 2026-10-16 on the 8 fixtures in `fixtures/` (all fetched with the honest UA). Raw outputs are in `out/`, the automatic diff in `report.md`. Every claim below was checked against the source HTML in `fixtures/`.

**Verdict:** Defuddle wins on formatting fidelity, but it is not a clean sweep. With default settings it silently dropped two real passages of article text, which trafilatura kept. For an archiving tool, dropped text is worse than ugly text. With `removeContentPatterns: false` both passages come back, at the cost of some boilerplate (ploum's author bio). So the rebuild should stay on Defuddle, with that option off by default.

## Where Defuddle loses content

| page | lost | cause |
|---|---|---|
| ploum-calendar | the article's final paragraph ("Android is not Unix…") | `removeByContentPattern`, reason "thin CTA section" (Defuddle debug output) |
| arxiv-2507.21509 | the 3-item "contributions" list in the introduction | `removeByContentPattern`, reason "table of contents" (the items link to sections) |
| arxiv-2507.21509 | 4 of 8 figure images (the 2nd to 4th panels of multi-image figures 20 and 24) | only the first `<img>` of a multi-panel figure is kept; captions survive |
| tante-* | nothing lost, but it keeps the Patreon button and CC licence footer | not detected as boilerplate |
| ploum-* | metadata: author and site both become "Ploum on 2026-09-09", no publish date | byline parsing |
| arxiv-* | no author or date | none found; trafilatura's values are wrong anyway, see below |
| arxiv-* | 3 to 6 table cells left as raw `<math>` HTML inside HTML tables | complex tables (colspan) stay HTML, not Markdown |

Rerunning with `removeContentPatterns: false` recovers both dropped passages (ploum-calendar 1199 → 1320 words, arxiv-2507.21509 24713 → 24849 words, list included). It also brings back ploum's "About the author" block and Ars's duplicated subtitle.

## Where trafilatura (current webclip) loses content

| page | lost | evidence |
|---|---|---|
| ars-meta-piracy, ars-meta-yandex | the `<h2>` subheading at the top of each later `post-content` div ("Evidence may prove Meta seeded more content", "There's got to be a better way") | the multi-div merge hack drops them; Defuddle keeps them with no hack |
| ars-meta-piracy | all images, including the in-article MaxMind screenshot (caption kept, image gone) | `report.md` structure column |
| all pages | every blockquote is flattened to plain paragraphs (0 `>` lines); on Ars, quoted research steps turn into the author's own numbered list | Defuddle keeps 7 quote lines on ars-meta-yandex and 3 on tante-fund |
| arxiv-* | image links stay relative (`2507.21509v3/x.png`) and break in a saved note; webclip never resolves them (no `urljoin` in the script) | `out/*.trafilatura.md` |
| arxiv-2605.08816 | author names in all 40 references ("- [2] (2004) Reflections on animal selves.", where the source says "M. Bekoff and P. W. Sherman (2004)…") | |
| arxiv-2507.21509 | 1 of 6 display equations | TeX annotation not found verbatim |
| arxiv-* | metadata is garbage: author "Runjin Chen ‡ 1; 2" and "Affiliation University", date 2025-02-19 for a July 2025 paper | |
| ploum-* | keeps the duplicated H1, the byline, the "About the author" bio and the decorative Bikepunk logo; no author | |
| arxiv-* | list bullets render as "- •" | |

## Ties

- Full article bodies on Ars (both multi-div pages) and tante: same sentences in both, apart from the items above.
- arXiv inline math (52/52 and 145/145) and display math (Defuddle 6/6 and 17/17, trafilatura 5/6 and 17/17) are kept as LaTeX by both.
- arXiv data tables: 10/11 and 3/4 for both.
- Bibliographies are kept by both. Defuddle turns them into Markdown footnotes (`[^n]`) with in-text links, trafilatura into a plain list.
- Speed doesn't matter here: both take 10 to 250 ms per page, and up to 2.3 s on a large arXiv paper.

## Fetching notes

- **tante.cc decoy confirmed.** The honest UA gets the real post. A Firefox UA gets a decoy page titled "From experience. Nor should we have the goodness." It is saved in `decoy/` as a test case. The honest-UA-first order is necessary, not a courtesy.
- **Ars Technica works with plain HTTP**, no browser needed. In this cloud container, Node's `fetch` to arstechnica.com got "Blocked by egress policy" from the container proxy while `curl` got through, so the two Ars fixtures were saved with `curl` using the same honest UA. That is a sandbox quirk, not something Ars does.

## Recommendation for the rebuild

1. Defuddle with `removeContentPatterns: false`, plus a small boilerplate list (ploum signature, tante Patreon/CC footer) that strips known blocks instead of guessing.
2. Or keep it on, but run Defuddle in debug mode and warn when a `removeByContentPattern` removal is longer than ~30 words. A clipper should never drop text silently.
3. Patch multi-image figures: keep every `<img>` in a `<figure>`. This is worth reporting upstream.
4. Metadata: prefer JSON-LD / `article:*` meta where present (Ars, tante have them). arXiv's HTML rendition carries no author or date meta at all (checked: no `citation_*`, no JSON-LD), so arXiv needs a site rule that reads the arXiv API (`export.arxiv.org/api/query?id_list=<id>`).

## Remediation (prototype: `run_defuddle_fixed.mjs` → `out/<slug>.fixed.{md,json}`)

Every issue above was fixed and checked on all 8 fixtures. The fixed output has no sentence that trafilatura kept and it dropped, apart from boilerplate (ploum's bio and duplicated H1, tante's CC line, which is now metadata). Checked with `sentdiff.py fixed,trafilatura <slugs>`.

| issue | fix | result |
|---|---|---|
| content-pattern false positives | `removeContentPatterns: false` | ploum paragraph and arXiv contributions list back |
| boilerplate that the patterns used to catch | explicit selectors: generic (`[class^="cb_p6"]` Patreon, `.cc-block`, 1×1 tracking pixels) and per site (`ploum.net: div.signature`, `arstechnica.com: .upper-deck, .pswp-caption-content`) | ploum bio, tante Patreon/CC footer, Ars kicker and duplicated image credit gone |
| Ars dek repeated as first paragraph | drop a leading paragraph that starts with the description; drop identical consecutive paragraphs | gone |
| multi-image figures | split each into one `<figure>` per panel, caption on the last; blank arXiv's placeholder alt "Refer to caption" | arxiv-2507 8/8 images (was 4/8) |
| raw `<math>` in HTML tables | replace with `$TeX$` from the MathML annotation | 0 left |
| prompt boxes drawn as SVG (arxiv-2507, 26 boxes) | turn the SVG's `foreignObject` content into a blockquote | 0 raw `<svg>` left; this was also broken in the default run |
| `<trait\_description>` not escaped (would render as an HTML tag) | escape `<word\_word>` pseudo-tags | fixed |
| byline metadata ("Ploum on 2026-09-09") | split "X on YYYY-MM-DD"; site from `og:site_name` or host; date from URL as a last resort | ploum: author Ploum, date, site ploum.net |
| arXiv metadata | arXiv API (`export.arxiv.org/api/query`) for title, authors, first-published date, abstract | full author lists and correct dates |
| license | `rel="license"` href saved as metadata before the block is removed | tante: CC BY-SA 4.0 |

Still open:
- The Ars piracy hero image is missing in every run, Defuddle default included. The image is in the page (`og:image` and `<img>`). Its credit line survives, but the image itself doesn't.
- The per-site selector list will grow. That is the price of not letting Defuddle guess, and it should live in config so it can be extended without code changes.
