"""Extract every fixtures/*.html with the CURRENT webclip pipeline (its own
_extract_html, incl. Ars multi-div merge, MathML->LaTeX, tidy/boilerplate)
-> out/<slug>.trafilatura.md (+ .json metadata).

Run with the venv that has webclip's deps:  .venv/bin/python run_trafilatura.py
(set $WEBCLIP to point at the old script if it is not ../../webclip)
"""
import importlib.machinery, importlib.util, json, os, sys, time
from pathlib import Path

WEBCLIP = Path(os.environ.get("WEBCLIP") or Path(__file__).resolve().parent.parent.parent / "webclip")
loader = importlib.machinery.SourceFileLoader("webclip", str(WEBCLIP))
spec = importlib.util.spec_from_loader("webclip", loader)
wc = importlib.util.module_from_spec(spec)
loader.exec_module(wc)
cfg = wc.deep_merge(wc.DEFAULTS, {})

for f in sorted(Path("fixtures").glob("*.html")):
    slug = f.stem
    t0 = time.perf_counter()
    try:
        content, meta = wc._extract_html(f.read_text("utf-8", "replace"), cfg)
    except Exception as e:  # keep going; report per fixture
        print(f"trafilatura {slug}: ERROR {e}")
        continue
    ms = round((time.perf_counter() - t0) * 1000)
    Path(f"out/{slug}.trafilatura.md").write_text(content or "")
    m = {k: wc.meta_get(meta, k) for k in ("title", "author", "date", "description", "sitename")}
    m.update(wordCount=wc.word_count(content or ""), ms=ms)
    Path(f"out/{slug}.trafilatura.json").write_text(json.dumps(m, indent=2, ensure_ascii=False))
    print(f"trafilatura {slug}: {m['wordCount']} words, {ms} ms")
