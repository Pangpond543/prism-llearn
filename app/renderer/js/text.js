// Text work on the page: splitting lines into words (English by letters, Chinese by the dictionary's word list),
// reading subtitle files (YouTube json3, SRT, VTT, ASS) and turning a web page into sentences.
import { api, native } from './core.js';

export const HAN = /[㐀-鿿豈-﫿]/;
const HAN_G = /[㐀-鿿豈-﫿]/g;
export function guessLang(text) {
  const han = (String(text).match(HAN_G) || []).length;
  const lat = (String(text).match(/[A-Za-z]/g) || []).length;
  return han * 2 >= lat && han > 0 ? 'zh' : 'en';
}

/* ------------------------------------------------------------ Chinese words */
let ZH = null, ZHMAX = 1, zhLoading = null;
export function zhReady() {
  if (ZH) return Promise.resolve(true);
  if (!zhLoading) zhLoading = (async () => {
    const s = native ? await api.invoke('dict:zhwords') : '';
    ZH = new Set(String(s || '').split('\n').filter(Boolean));
    for (const w of ZH) if (w.length > ZHMAX) ZHMAX = Math.min(8, w.length);
    return true;
  })();
  return zhLoading;
}
function segHan(run) {
  // forward maximum matching with the dictionary words (good enough for learners; names fall back to single characters)
  const out = [];
  let i = 0;
  while (i < run.length) {
    let n = Math.min(ZHMAX, run.length - i);
    for (; n > 1; n--) if (ZH && ZH.has(run.substr(i, n))) break;
    out.push(run.substr(i, n)); i += n;
  }
  return out;
}

/** "We're no strangers…" → [{t:"We're", w:true, lang:"en"}, {t:" "}, …]. Chinese runs are split into words. */
export function tokenize(text) {
  const out = [];
  const re = /([A-Za-z][A-Za-z'’\-]*[A-Za-z]|[A-Za-z])|([㐀-鿿豈-﫿]+)|([^A-Za-z㐀-鿿豈-﫿]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) out.push({ t: m[1], w: true, lang: 'en' });
    else if (m[2]) for (const p of segHan(m[2])) out.push({ t: p, w: true, lang: 'zh' });
    else out.push({ t: m[3] });
  }
  return out;
}

/* ------------------------------------------------------------ subtitles */
const clean = (s) => String(s).replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const noise = (t) => !t || /^\[[^\]]*\]$|^\([^)]*\)$|^♪+$/.test(t);

/** YouTube json3 → cues [{s, e, t, w?:[[ms, word]…]}] (auto captions are rebuilt from word timings into lines) */
export function fromJson3(text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  const ev = (j.events || []).filter((e) => e.segs && e.segs.some((s) => (s.utf8 || '').trim()));
  const auto = ev.some((e) => e.segs.some((s) => s.tOffsetMs !== undefined));
  if (!auto) {
    const cues = ev.map((e) => ({ s: e.tStartMs, e: e.tStartMs + (e.dDurationMs || 2000), t: clean(e.segs.map((s) => s.utf8 || '').join('')) })).filter((c) => !noise(c.t));
    return fixEnds(cues);
  }
  // auto captions: a stream of timed words → lines broken at pauses / sentence ends / ~11 words
  const words = [];
  for (const e of ev) for (const s of e.segs) {
    const w = (s.utf8 || '').replace(/\n/g, ' ');
    if (!w.trim()) continue;
    words.push({ ms: e.tStartMs + (s.tOffsetMs || 0), w, end: e.tStartMs + (e.dDurationMs || 0) });
  }
  const cues = [];
  let cur = null;
  const zh = words.length && HAN.test(words.slice(0, 20).map((x) => x.w).join(''));
  for (let i = 0; i < words.length; i++) {
    const x = words[i], nx = words[i + 1];
    if (!cur) cur = { s: x.ms, e: x.ms, t: '', w: [] };
    cur.t += x.w; cur.w.push([x.ms, x.w.trim()]);
    const gap = nx ? nx.ms - x.ms : 9e9;
    const len = zh ? cur.t.replace(/\s/g, '').length : cur.w.length;
    if (!nx || gap > 1300 || /[.!?。！？]$/.test(x.w.trim()) || len >= (zh ? 22 : 11)) {
      cur.e = nx ? Math.min(nx.ms, x.ms + Math.max(500, Math.min(gap, 1500))) : x.ms + 1500;
      cur.t = clean(cur.t);
      if (!noise(cur.t)) cues.push(cur);
      cur = null;
    }
  }
  return cues;
}
function fixEnds(cues) {
  cues.sort((a, b) => a.s - b.s);
  for (let i = 0; i < cues.length - 1; i++) if (cues[i].e > cues[i + 1].s) cues[i].e = Math.max(cues[i].s + 300, cues[i + 1].s);
  // the same line repeated back to back (some uploads) → one cue
  return cues.filter((c, i) => !(i && cues[i - 1].t === c.t && c.s - cues[i - 1].e < 200 && (cues[i - 1].e = c.e)));
}
const tms = (s) => { const m = String(s).trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/); if (!m) return null; return ((+(m[1] || 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 + Math.round(+('0.' + m[4]) * 1000); };
/** SRT / VTT / ASS text → cues */
export function fromSubText(text, ext = '') {
  text = String(text).replace(/\r/g, '');
  if (/^\[Script Info\]/m.test(text) || ext === 'ass' || ext === 'ssa') {
    const cues = [];
    let fmt = null;
    for (const line of text.split('\n')) {
      if (/^Format:/.test(line) && !fmt) { const f = line.slice(7).split(',').map((x) => x.trim().toLowerCase()); if (f.includes('text')) fmt = f; }
      else if (/^Dialogue:/.test(line)) {
        const f = fmt || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
        const parts = line.slice(9).split(',');
        const v = parts.slice(0, f.length - 1).concat(parts.slice(f.length - 1).join(','));
        const o = Object.fromEntries(f.map((k, i) => [k, (v[i] || '').trim()]));
        const t = clean(o.text);
        if (!noise(t)) cues.push({ s: tms(o.start + '0'), e: tms(o.end + '0'), t });
      }
    }
    return fixEnds(cues.filter((c) => c.s !== null));
  }
  const cues = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const t = clean(lines.slice(i + 1).join(' '));
    const s = tms(a), e = tms(b);
    if (s !== null && e !== null && !noise(t)) cues.push({ s, e, t });
  }
  return fixEnds(cues);
}
/** bytes (base64) of a subtitle / web page → text; tries UTF-8 (+BOM / UTF-16), then GBK / Big5 for Chinese files */
export function decode(b64, hint = '') {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  if (hint) { try { return new TextDecoder(hint).decode(u8); } catch { /* unknown label */ } }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { /* not utf-8 */ }
  for (const enc of ['gb18030', 'big5', 'windows-874']) { try { return new TextDecoder(enc, { fatal: true }).decode(u8); } catch { /* next */ } }
  return new TextDecoder('utf-8').decode(u8);
}

/* ------------------------------------------------------------ web pages / pasted text */
export function sentences(p) {
  const t = p.replace(/\[(?:\d+|[a-z]|citation needed|note \d+)\]/gi, '').replace(/\s+/g, ' ').trim(); // wiki-style references [1] [a]
  if (!t) return [];
  if (HAN.test(t) && guessLang(t) === 'zh') return t.split(/(?<=[。！？；!?])/).map((x) => x.trim()).filter(Boolean);
  return t.split(/(?<=[.!?…]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/).map((x) => x.trim()).filter(Boolean);
}
/** html → {title, paras:[{h?:bool, s:[sentence…]}]} using Mozilla Readability (vendor/Readability.js) */
export function article(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  try { const b = doc.createElement('base'); b.href = url; doc.head.prepend(b); } catch { /* */ }
  let title = (doc.querySelector('title') || {}).textContent || '';
  let root = null;
  try { const r = new window.Readability(doc.cloneNode(true), { charThreshold: 300 }).parse(); if (r && r.content) { title = r.title || title; root = new DOMParser().parseFromString(r.content, 'text/html').body; } } catch { /* fall back to the whole body */ }
  if (!root) root = doc.body;
  const paras = [];
  const walk = (el) => {
    for (const c of el.children) {
      const tag = c.tagName;
      if (/^(SCRIPT|STYLE|NAV|FOOTER|ASIDE|FIGURE|NOSCRIPT|FORM|BUTTON|TABLE)$/.test(tag)) continue;
      if (/^(P|H1|H2|H3|H4|H5|H6|LI|BLOCKQUOTE|DD|DT|FIGCAPTION|PRE)$/.test(tag)) {
        const s = sentences(c.textContent || '');
        if (s.length) paras.push({ h: /^H\d$/.test(tag), s });
      } else if (c.children.length) walk(c);
      else { const s = sentences(c.textContent || ''); if (s.length && s.join(' ').length > 40) paras.push({ s }); }
    }
  };
  walk(root);
  return { title: title.trim(), paras };
}
export function fromPlain(text) {
  return String(text).replace(/\r/g, '').split(/\n\s*\n|\n(?=\S)/).map((p) => ({ s: sentences(p) })).filter((p) => p.s.length);
}

export const fmtTime = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
