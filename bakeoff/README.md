# Bake-off: Defuddle vs current webclip

Same saved HTML goes through both extractors, so fetch quirks don't skew the result.

1. Put `slug URL` lines in `urls.txt` (or drop manually saved pages in `fixtures/` as `<slug>.html`, with the URL in `<slug>.url`).
2. `npm install && npm run fetch` saves `fixtures/<slug>.html` (honest UA first, browser UA on failure).
3. `npm run defuddle` writes `out/<slug>.defuddle.{md,json}` (useAsync off: no third-party APIs).
4. `python3 -m venv .venv && .venv/bin/pip install trafilatura==2.2.0 pyyaml markdown latex2mathml==3.81.1`,
   then `.venv/bin/python run_trafilatura.py` writes `out/<slug>.trafilatura.{md,json}` using the old script's own `_extract_html`.
5. `npm run compare` writes `report.md`.
6. `node run_defuddle_fixed.mjs [slugs]` runs Defuddle plus the remediations (see VERDICT.md) -> `out/<slug>.fixed.{md,json}`; needs network for the arXiv API.

Results (2026-10-16): see `VERDICT.md`. Extra checks: `.venv/bin/python -I check_arxiv.py <arxiv slugs>` (tables/figures/math/bib coverage vs source) and `.venv/bin/python -I sentdiff.py <slugs>` (sentences only one extractor kept). `decoy/` holds tante.cc's fake page served to browser UAs.
Note: in the cloud container Node fetch to arstechnica.com is blocked by the egress proxy while curl works; the Ars fixtures were saved with curl and the honest UA.
