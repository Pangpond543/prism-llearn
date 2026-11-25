# Builds Prism LLearn's offline dictionaries (dev tool — the user never runs this).
#   python -X utf8 tools/dict/build.py <source dir>
# Source dir (outside OneDrive, e.g. %USERPROFILE%\PrismLLearnBuild\dl\data) must hold:
#   kaikki-en.jsonl.gz   English Wiktionary extract (kaikki.org, CC BY-SA)        → IPA, English senses, Thai translations, word forms
#   volubilis-mundo.xlsx VOLUBILIS Mundo Thai dictionary (Belisan, CC BY-SA 4.0)   → Thai ↔ English, Thai ↔ Chinese
#   cedict_ts.u8         CC-CEDICT (MDBG, CC BY-SA 4.0)                            → Chinese words, pinyin, English
#   hsk.json             complete-hsk-vocabulary (drkameleon, MIT)                 → HSK 3.0 levels
# plus the Python package wordfreq (data CC BY-SA 4.0) for word frequency ranks.
# Output: app/bin/runtime/dict/en.json, zh.json (+ LICENSES.txt)
import gzip, json, os, re, sys, unicodedata
from collections import defaultdict

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'app', 'bin', 'runtime', 'dict')
os.makedirs(OUT, exist_ok=True)

import wordfreq
EN_RANK = {w: i + 1 for i, w in enumerate(wordfreq.top_n_list('en', 120000))}
ZH_RANK = {w: i + 1 for i, w in enumerate(wordfreq.top_n_list('zh', 80000))}

THAI = re.compile(r'[฀-๿]')
def clean(s): return re.sub(r'\s+', ' ', unicodedata.normalize('NFC', str(s or '')).replace('\xa0', ' ')).strip()
def split_semi(s): return [x for x in (clean(p) for p in re.split(r'\s*;\s*', clean(s))) if x]

# ---------------------------------------------------------------- Volubilis (Thai ↔ English / Chinese)
print('volubilis…', flush=True)
import openpyxl
wb = openpyxl.load_workbook(os.path.join(SRC, 'volubilis-mundo.xlsx'), read_only=True)
ws = wb.worksheets[0]
rows = ws.iter_rows(values_only=True)
next(rows); next(rows)
POS_TH = {'n.': 'n', 'v.': 'v', 'adj.': 'adj', 'adv.': 'adv', 'prep.': 'prep', 'conj.': 'conj', 'pron.': 'pron', 'interj.': 'interj'}
vol_en = defaultdict(list)   # english phrase (lower) → [(thai, type)]
vol_zh = defaultdict(list)   # chinese → [thai]
def en_keys(p):
    p = re.sub(r'\([^)]*\)|\[[^\]]*\]', '', p).strip(' .!?,').lower()
    if not p or len(p) > 40: return []
    ks = [p]
    for pre in ('to ', 'be ', 'a ', 'an ', 'the '):
        if p.startswith(pre) and len(p) > len(pre) + 1: ks.append(p[len(pre):])
    return ks
for r in rows:
    th, en, typ = clean(r[3]), r[4], clean(r[6])
    if not th or not THAI.search(th): continue
    th = th.split(';')[0].strip()
    pos = next((v for k, v in POS_TH.items() if typ.startswith(k)), '')
    if en:
        for p in split_semi(en):
            for k in en_keys(p):
                if (th, pos) not in vol_en[k]: vol_en[k].append((th, pos))
    zh = clean(r[33]) if len(r) > 33 else ''
    if zh:
        for z in re.split(r'[;；/,，、\s]+', zh):
            z = z.strip()
            if z and re.search(r'[一-鿿]', z) and th not in vol_zh[z]: vol_zh[z].append(th)
print(' en phrases', len(vol_en), 'zh', len(vol_zh))

# ---------------------------------------------------------------- Wiktionary English
print('wiktionary…', flush=True)
POS = {'noun': 'n', 'verb': 'v', 'adj': 'adj', 'adv': 'adv', 'prep': 'prep', 'conj': 'conj', 'pron': 'pron', 'intj': 'interj',
       'phrase': 'phr', 'prep_phrase': 'phr', 'det': 'det', 'num': 'num', 'particle': 'part', 'contraction': 'contr', 'proverb': 'phr'}
SKIP_TAGS = {'obsolete', 'archaic', 'rare', 'dated', 'nonstandard', 'misspelling', 'historical'}
entries = {}           # lemma → {'ipa': str, 'senses': {pos: [gloss…]}, 'th': [thai…]}
forms = {}             # inflected form → lemma
def common(w): return EN_RANK.get(w, 10**9)
def keep_word(w):
    lw = w.lower()
    if ' ' in w:
        parts = lw.split()
        return len(parts) <= 4 and all(common(p) <= 25000 for p in parts)
    return common(lw) <= 120000
with gzip.open(os.path.join(SRC, 'kaikki-en.jsonl.gz'), 'rt', encoding='utf-8') as f:
    for n, line in enumerate(f):
        if n % 200000 == 0: print(' ', n, len(entries), flush=True)
        d = json.loads(line)
        if d.get('lang_code') != 'en': continue
        w = d.get('word', '')
        if not w or len(w) > 40: continue
        lw = w.lower()
        senses = d.get('senses') or []
        # inflected forms ("ran" → "run")
        for s in senses:
            for fo in s.get('form_of') or []:
                base = (fo.get('word') or '').lower()
                if base and base != lw and lw not in forms and common(lw) <= 120000: forms[lw] = base
        th = [t.get('word') for t in (d.get('translations') or []) if t.get('lang_code') == 'th' and t.get('word')]
        for s in senses: th += [t.get('word') for t in (s.get('translations') or []) if t.get('lang_code') == 'th' and t.get('word')]
        if not keep_word(w) and not th: continue
        pos = POS.get(d.get('pos'), '')
        if not pos: continue
        e = entries.setdefault(lw, {'ipa': '', 'senses': {}, 'th': []})
        if not e['ipa']:
            ipas = [s['ipa'] for s in d.get('sounds') or [] if s.get('ipa')]
            us = [s['ipa'] for s in d.get('sounds') or [] if s.get('ipa') and any(t in (s.get('tags') or []) for t in ('US', 'General-American'))]
            e['ipa'] = (us or ipas or [''])[0]
        gl = e['senses'].setdefault(pos, [])
        for s in senses:
            tags = set(s.get('tags') or [])
            if s.get('form_of') or 'form-of' in tags or tags & SKIP_TAGS: continue
            g = (s.get('glosses') or [''])[-1]
            g = clean(g)
            if g and len(gl) < 4 and g not in gl: gl.append(g[:140])
        for t in th:
            t = clean(t)
            if t and THAI.search(t) and t not in e['th']: e['th'].append(t)
# drop entries that are only form-of pages (no senses) and forms that point nowhere
entries = {k: v for k, v in entries.items() if any(v['senses'].values()) or v['th']}
# keep a form even when the form has its own page ("ran" = yarn): the app shows the lemma when the form's own entry has no Thai
forms = {k: v for k, v in forms.items() if v in entries}
print(' entries', len(entries), 'forms', len(forms))

# merge Volubilis Thai into entries (and add words only Volubilis knows, if common)
for k, ths in vol_en.items():
    if k in entries or (' ' not in k and common(k) <= 60000) or (' ' in k and keep_word(k)):
        e = entries.setdefault(k, {'ipa': '', 'senses': {}, 'th': []})
        e.setdefault('vth', [])
        for th, pos in ths:
            if len(e['vth']) < 10 and [th, pos] not in e['vth']: e['vth'].append([th, pos])

# compact: [ipa, [[pos, [gloss…]]…], [thai from wiktionary…], [[thai, pos] from volubilis…], rank]
en_out = {}
for k, e in entries.items():
    en_out[k] = [e['ipa'], [[p, g] for p, g in e['senses'].items() if g], e['th'][:8], e.get('vth', []), EN_RANK.get(k, 0)]
with open(os.path.join(OUT, 'en.json'), 'w', encoding='utf-8') as f:
    json.dump({'w': en_out, 'f': forms, 'top': wordfreq.top_n_list('en', 30000)}, f, ensure_ascii=False, separators=(',', ':'))
print('en.json', os.path.getsize(os.path.join(OUT, 'en.json')) // 1024, 'KB')

# ---------------------------------------------------------------- Chinese: CC-CEDICT + HSK + Volubilis Thai
print('cedict…', flush=True)
TONE = {'a': 'āáǎà', 'e': 'ēéěè', 'i': 'īíǐì', 'o': 'ōóǒò', 'u': 'ūúǔù', 'ü': 'ǖǘǚǜ'}
def syl(s):
    m = re.match(r'^([a-zü:]+)([1-5])$', s.lower().replace('u:', 'ü').replace('v', 'ü'))
    if not m: return s.replace('u:', 'ü')
    b, t = m.group(1), int(m.group(2))
    if t == 5: return b
    for v in ('a', 'e'):
        if v in b: return b.replace(v, TONE[v][t - 1], 1)
    if 'ou' in b: return b.replace('o', TONE['o'][t - 1], 1)
    for i in range(len(b) - 1, -1, -1):
        if b[i] in TONE: return b[:i] + TONE[b[i]][t - 1] + b[i + 1:]
    return b
def pinyin(p):
    out = []
    for s in p.split():
        mark = syl(s)
        out.append(mark[0].upper() + mark[1:] if s[:1].isupper() else mark)
    return ' '.join(out)
zh = {}     # simplified → [[pinyin, [english…]]…]
trad = {}
with open(os.path.join(SRC, 'cedict_ts.u8'), encoding='utf-8') as f:
    for line in f:
        if line.startswith('#'): continue
        m = re.match(r'^(\S+) (\S+) \[([^\]]*)\] /(.*)/\s*$', line)
        if not m: continue
        t, s, py, defs = m.groups()
        defs = [d for d in defs.split('/') if d and not d.startswith('CL:') and not d.startswith('variant of') and not d.startswith('old variant')]
        if not defs: continue
        ent = zh.setdefault(s, [])
        p = pinyin(py)
        for row in ent:
            if row[0].lower() == p.lower(): row[1] += [d for d in defs if d not in row[1]][: max(0, 8 - len(row[1]))]; break
        else: ent.append([p, defs[:8]])
        if t != s: trad[t] = s
hsk = {}
for it in json.load(open(os.path.join(SRC, 'hsk.json'), encoding='utf-8')):
    lv = [l for l in it.get('l', []) if l.startswith('n')]
    if lv: hsk[it['s']] = int(lv[0][1:])
zh_out = {}
for s, ent in zh.items():
    zh_out[s] = [ent[:4], vol_zh.get(s, [])[:8], hsk.get(s, 0), ZH_RANK.get(s, 0)]
with open(os.path.join(OUT, 'zh.json'), 'w', encoding='utf-8') as f:
    json.dump({'w': zh_out, 't': trad, 'top': wordfreq.top_n_list('zh', 20000)}, f, ensure_ascii=False, separators=(',', ':'))
print('zh.json', os.path.getsize(os.path.join(OUT, 'zh.json')) // 1024, 'KB', len(zh_out))

with open(os.path.join(OUT, 'LICENSES.txt'), 'w', encoding='utf-8') as f:
    f.write('''Prism LLearn offline dictionaries are built from:
- Wiktionary (English), extracted by kaikki.org / wiktextract — CC BY-SA 4.0, https://kaikki.org
- VOLUBILIS Mundo Thai dictionary by Belisan — CC BY-SA 4.0, https://belisan-volubilis.blogspot.com
- CC-CEDICT by MDBG — CC BY-SA 4.0, https://www.mdbg.net/chinese/dictionary?page=cedict
- complete-hsk-vocabulary by drkameleon — MIT, https://github.com/drkameleon/complete-hsk-vocabulary
- wordfreq by Robyn Speer — data CC BY-SA 4.0, https://github.com/rspeer/wordfreq
The combined dictionary files en.json / zh.json are shared under CC BY-SA 4.0.
''')
print('done')
