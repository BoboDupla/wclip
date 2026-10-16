import sys, re
from lxml import html
norm = lambda s: re.sub(r'[^0-9a-z]+', '', s.lower())
for slug in sys.argv[1:]:
    doc = html.parse(f'fixtures/{slug}.html').getroot()
    outs = {e: open(f'out/{slug}.{e}.md').read() for e in ('defuddle','trafilatura')}
    nouts = {e: norm(v) for e, v in outs.items()}
    print('==', slug)
    # data tables: take 3 longest-ish cell texts of each ltx_tabular
    tabs = doc.xpath('//table[contains(@class,"ltx_tabular")]')
    hit = {e: 0 for e in outs}
    for t in tabs:
        cells = sorted({norm(c.text_content()) for c in t.xpath('.//td|.//th') if len(norm(c.text_content())) > 6 and not c.xpath('.//math')}, key=len, reverse=True)[:3]
        for e in outs:
            if cells and all(c in nouts[e] for c in cells): hit[e] += 1
    print(f'  data tables {len(tabs)}:', hit)
    imgs = [i.get('src') for i in doc.xpath('//figure//img')]
    print(f'  figure images {len(imgs)}:', {e: sum(1 for s in imgs if s and s.split("/")[-1] in outs[e]) for e in outs})
    eqs = [a.text for a in doc.xpath('//table[contains(@class,"ltx_equation")]//annotation[@encoding="application/x-tex"]') if a.text]
    tex = lambda s: re.sub(r'\s+', '', s)
    print(f'  display equations {len(eqs)} (TeX found verbatim):', {e: sum(1 for q in eqs if tex(q) in tex(outs[e])) for e in outs})
    inl = [a.text for a in doc.xpath('//p//math[@display="inline"]//annotation[@encoding="application/x-tex"]') if a.text]
    print(f'  inline math in paragraphs {len(inl)}:', {e: sum(1 for q in inl if tex(q) in tex(outs[e])) for e in outs})
    abs_ = doc.xpath('//div[contains(@class,"ltx_abstract")]//p')
    print('  abstract:', {e: all(norm(p.text_content())[:80] in nouts[e] for p in abs_) for e in outs})
