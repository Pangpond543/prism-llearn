// Language layer. Thai is the source text; English lives in lang-en.js keyed by the Thai string
// (interpolations become "{}"). Proper names stay in English in both languages.
import { EN } from './lang-en.js';

export let lang = 'th';
try { lang = localStorage.getItem('prism.lang') === 'en' ? 'en' : 'th'; } catch { /* storage unavailable */ }
const forced = new URLSearchParams(location.search).get("lang"); // test hook: PRISM_LANG
if (forced === "en" || forced === "th") lang = forced;
document.documentElement.lang = lang;

// exact-match translation of a finished string (used for text coming from the main process / static HTML)
// Prism Code also matches finished strings against templates ("ไม่รู้จักชื่อ {}" ← "ไม่รู้จักชื่อ totl"), so text built
// before translation (error explanations, generated problems) still comes out in English.
let PAT = null;
function byPattern(s) {
  if (!PAT) {
    PAT = [];
    for (const k of Object.keys(EN)) {
      if (!k.includes('{}')) continue;
      const re = new RegExp('^' + k.split('{}').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([\\s\\S]*?)') + '$');
      PAT.push([re, EN[k]]);
    }
  }
  for (const [re, en] of PAT) {
    const m = re.exec(s);
    if (m) { let i = 1; return en.replace(/\{(\d*)\}/g, (_x, d) => m[d === '' ? i++ : +d + 1]); }
  }
  return s;
}
export const tr = (s) => (lang !== 'en' || typeof s !== 'string' ? s : EN[s] !== undefined ? EN[s] : byPattern(s));

// tagged template:  T`ย้าย “${name}” แล้ว`   → looks up "ย้าย “{}” แล้ว"
export function T(strings, ...vals) {
  if (typeof strings === 'string') return tr(strings);
  if (lang === 'en') {
    const tpl = EN[strings.join('{}')];
    if (tpl !== undefined) { let i = 0; return tpl.replace(/\{(\d*)\}/g, (_m, d) => String(vals[d === '' ? i++ : +d])); }
  }
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += vals[i] + strings[i + 1];
  return out;
}

// static markup in index.html: translate text nodes and title attributes in place
export function translateDom(root) {
  if (lang !== 'en') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const raw = n.nodeValue, key = raw.trim();
    if (key && EN[key] !== undefined) n.nodeValue = raw.replace(key, () => EN[key]);
  }
  root.querySelectorAll('[title]').forEach((el) => { el.title = tr(el.title); });
}
