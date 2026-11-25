// Word knowledge: dictionary lookups (cached), English base forms, word colours, cards, voice.
import { api, native, T, toast, bus } from './core.js';
import { S, save, setWord, wstat, wkey, bump, uid } from './store.js';
import { newSrs } from './srs.js';

/* ------------------------------------------------------------ lookups */
const LOOK = new Map();
export async function lookup(lang, q) {
  const k = lang + ':' + q.toLowerCase();
  if (LOOK.has(k)) return LOOK.get(k);
  const r = native ? await api.invoke(lang === 'zh' ? 'dict:zh' : 'dict:en', q) : { ok: false };
  LOOK.set(k, r);
  return r;
}
// English base forms + frequency rank for many words at once ("ran" → ["run", 1437])
export const LEMMA = new Map();
export async function prepareEn(words) {
  const need = [...new Set(words)].filter((w) => !LEMMA.has(w));
  for (let i = 0; i < need.length; i += 3000) {
    const part = need.slice(i, i + 3000);
    const r = native ? await api.invoke('dict:enmany', part) : {};
    for (const w of part) LEMMA.set(w, (r && r[w]) || [w.toLowerCase(), 0]);
  }
}
export const PINYIN = new Map(); // zh word → [pinyin, thai[], hsk]
export async function prepareZh(words) {
  const need = [...new Set(words)].filter((w) => !PINYIN.has(w));
  for (let i = 0; i < need.length; i += 3000) {
    const part = need.slice(i, i + 3000);
    const r = native ? await api.invoke('dict:zhmany', part) : {};
    for (const w of part) PINYIN.set(w, (r && r[w]) || null);
  }
}
export function headOf(tok) {
  if (tok.lang === 'zh') return tok.t;
  const l = LEMMA.get(tok.t);
  return l ? l[0] : tok.t.toLowerCase();
}
/** colour class for a word token: new (to learn) / learning / known / ignored / not a dictionary word */
export function wordClass(tok) {
  if (tok.lang === 'zh') {
    if (!PINYIN.get(tok.t)) return 'w-nd';
  } else {
    const l = LEMMA.get(tok.t);
    if (l && !l[1] && /^[A-Z]/.test(tok.t)) return 'w-nd'; // names / places not in the frequency list
    if (tok.t.length < 2 && !/^[aI]$/i.test(tok.t)) return 'w-nd';
  }
  const s = wstat(tok.lang, headOf(tok));
  if (!s) {
    // the very commonest words (the, a, you / 的, 是, 我) are never highlighted unless the learner keeps them as a card
    const rank = tok.lang === 'zh' ? (PINYIN.get(tok.t) || [])[2] : (LEMMA.get(tok.t) || [])[1];
    if (rank && rank <= (tok.lang === 'zh' ? 60 : 120)) return 'w-known';
  }
  return s === 1 ? 'w-learn' : s === 2 ? 'w-known' : s === 3 ? 'w-ign' : 'w-new';
}

/* ------------------------------------------------------------ cards */
export function findCard(lang, head) { const k = wkey(lang, head); return S.cards.find((c) => wkey(c.lang, c.head) === k); }
export function addCard(o) {
  const old = findCard(o.lang, o.head);
  if (old) { Object.assign(old, { ...o, srs: old.srs, id: old.id, c: old.c }); save(); return old; }
  const c = { id: uid(), c: Date.now(), srs: newSrs(), ...o };
  S.cards.push(c);
  setWord(o.lang, o.head, 1);
  bump('n');
  bus.emit('cards');
  save();
  return c;
}
export function removeCard(id) {
  const c = S.cards.find((x) => x.id === id);
  S.cards = S.cards.filter((x) => x.id !== id);
  if (c && wstat(c.lang, c.head) === 1) setWord(c.lang, c.head, 0);
  bus.emit('cards'); save();
}

/* ------------------------------------------------------------ voice */
let audio = null;
export async function speak(text, lang, { speed } = {}) {
  if (!text || S.set.tts === false) return false;
  const sid = lang === 'zh' ? S.set.voiceZh : S.set.voiceEn;
  const r = native ? await api.invoke('tts:say', { text, sid, speed: speed || S.set.speed || 1 }) : null;
  if (r && r.ok) {
    if (audio) audio.pause();
    audio = new Audio(r.url);
    try { await audio.play(); return true; } catch { return false; }
  }
  // no offline voice → the Windows voice if there is one for the language
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
    const v = speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(lang === 'zh' ? 'zh' : 'en'));
    if (v) { u.voice = v; speechSynthesis.cancel(); speechSynthesis.speak(u); return true; }
  } catch { /* */ }
  if (r && r.reason === 'noengine') toast(T`เสียงอ่านในเครื่องใช้ไม่ได้ (ไม่พบไฟล์เสียงในโฟลเดอร์ runtime\\tts)`, { kind: 'err' });
  return false;
}
export function stopSpeak() { if (audio) audio.pause(); try { speechSynthesis.cancel(); } catch { /* */ } }
// Kokoro v1.1 voices (sherpa-onnx speaker ids)
export const VOICES = {
  en: [[0, 'Maple (US, หญิง)'], [1, 'Sol (US, หญิง)'], [2, 'Vale (UK, หญิง)']],
  zh: [[3, 'Xiaobei (หญิง)'], [4, 'Xiaoni (หญิง)'], [50, 'Yunjian (ชาย)'], [60, 'Yunxi (ชาย)']],
};

/* ------------------------------------------------------------ translation */
const TRQ = [];
let trBusy = false;
export function translate(text, src, { front = false } = {}) {
  return new Promise((res) => { (front ? TRQ.unshift : TRQ.push).call(TRQ, { text, src, res }); pump(); });
}
async function pump() {
  if (trBusy) return;
  const job = TRQ.shift();
  if (!job) return;
  trBusy = true;
  let r = native ? await api.invoke('tr:text', { text: job.text, src: job.src, tgt: 'th' }) : { ok: false };
  trBusy = false;
  job.res(r && r.ok ? r.text : null);
  pump();
}
export function clearTranslateQueue(keep) { for (let i = TRQ.length - 1; i >= 0; i--) if (!keep || !keep(TRQ[i])) { TRQ[i].res(null); TRQ.splice(i, 1); } }
export { setWord, wstat };
