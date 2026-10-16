import re, sys
def strip(md):
    md = re.sub(r'!\[[^\]]*\]\([^)]*\)', ' ', md); md = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', md)
    md = re.sub(r'\[\^\d+\]', ' ', md); return md
norm = lambda s: re.sub(r'[^0-9a-z]+', ' ', s.lower()).strip()
def sents(md):
    return [s for s in (norm(x) for x in re.split(r'(?<=[.!?:])\s+|\n+', strip(md))) if len(s.split()) >= 7]
for slug in [a for a in sys.argv[1:] if ',' not in a]:
    A, B = (sys.argv[1].split(',') if ',' in sys.argv[1] else ('defuddle','trafilatura'))
    D, T = (open(f'out/{slug}.{e}.md').read() for e in (A, B))
    sd, st = sents(D), sents(T); jd, jt = ' '.join(norm(strip(D)).split()), ' '.join(norm(strip(T)).split())
    print(f'== {slug}  sentences D {len(sd)} T {len(st)}')
    for who, mine, other in (('ONLY D', sd, jt), ('ONLY T', st, jd)):
        for s in mine:
            if s not in other: print(f'  {who}: {s[:150]}')
