// The learner's data: words (status), cards, lessons list, activity per day (the heatmap), settings.
// Saved by Rust to %APPDATA%\com.prism.llearn\state.json (temp file + .bak); one lesson's subtitles / translations live in
// src\<id>.json. In a plain browser (dev preview) everything falls back to localStorage.
import { api, native, bus, toast, T } from './core.js';

const KEY = 'prism.llearn.v1';
const fresh = () => ({
  v: 1,
  words: {},        // "en:run" → { s: 1 learning | 2 known | 3 ignore, t: ms }
  cards: [],        // see newCard()
  sources: [],      // lessons: { id, kind: yt|web|file|text, title, url, lang, thumb, dur, added, last, pos, video, track }
  act: {},          // "YYYY-MM-DD" → { m: seconds, r: reviews, n: new cards, l: lookups, d: dictation lines, k: words marked known }
  goal: { min: 15 },
  set: { voiceEn: 0, voiceZh: 3, speed: 1, showTh: true, pinyin: true, autoPause: false, subFont: 21, tts: true, newPerDay: 30, aiAuto: true, aiMode: 'best', liveSave: true },
  asrQ: [],         // AI subtitle jobs not finished yet (resumed after a restart): { key, kind, src, lang, mode, title }
  placed: {},       // { en: true } after the placement test (or skipped)
  ui: { view: 'home', wordsLang: 'all', wordsFilter: 'all' },
});
export let S = fresh();

export async function loadState() {
  let raw = '';
  if (native) raw = await api.invoke('db:load');
  else { try { raw = localStorage.getItem(KEY) || ''; } catch { /* */ } }
  if (raw) {
    try {
      const d = JSON.parse(raw);
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('not an object');
      const f = fresh();
      S = { ...f, ...d, set: { ...f.set, ...(d.set || {}) }, goal: { ...f.goal, ...(d.goal || {}) }, ui: { ...f.ui, ...(d.ui || {}) } };
    } catch { toast(T`อ่านข้อมูลที่บันทึกไว้ไม่ได้ — เริ่มใหม่ (ไฟล์เดิมเก็บไว้เป็น state.broken.json)`, { kind: 'err' }); }
  }
  return S;
}
let saveT = 0, saving = false, again = false;
export function save() { clearTimeout(saveT); saveT = setTimeout(saveNow, 600); }
export async function saveNow() {
  clearTimeout(saveT);
  if (saving) { again = true; return; }
  saving = true;
  const text = JSON.stringify(S);
  let ok = true;
  if (native) ok = await api.invoke('db:save', text);
  else { try { localStorage.setItem(KEY, text); } catch { ok = false; } }
  saving = false;
  // once per problem, not every autosave (a full disk would show it every 5 s)
  if (!ok && !saveNow.warned) { saveNow.warned = true; toast(T`บันทึกข้อมูลไม่สำเร็จ — ดิสก์อาจเต็ม`, { kind: 'err' }); }
  if (ok) saveNow.warned = false;
  if (again) { again = false; saveNow(); }
}
addEventListener('beforeunload', () => { if (!native) try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* */ } });

/* -------------------------------------------------------------------- lessons */
const memSrc = new Map();
export async function loadSrc(id) {
  if (memSrc.has(id)) return memSrc.get(id);
  let raw = native ? await api.invoke('src:load', id) : (() => { try { return localStorage.getItem('prism.llearn.src.' + id); } catch { return null; } })();
  let d = null; try { d = raw ? JSON.parse(raw) : null; } catch { /* */ }
  if (d) memSrc.set(id, d);
  return d;
}
const srcT = new Map();
export function saveSrc(id, data, now = false) {
  memSrc.set(id, data);
  clearTimeout(srcT.get(id));
  const go = () => { const text = JSON.stringify(data); if (native) api.invoke('src:save', { id, data: text }); else try { localStorage.setItem('prism.llearn.src.' + id, text); } catch { /* */ } };
  if (now) go(); else srcT.set(id, setTimeout(go, 1500));
}
export async function deleteSrc(id) {
  const s = S.sources.find((x) => x.id === id);
  S.sources = S.sources.filter((x) => x.id !== id);
  memSrc.delete(id);
  if (native) { await api.invoke('asr:cancel', id); api.invoke('asr:drop', id); S.asrQ = (S.asrQ || []).filter((x) => x.key !== id); }
  if (native) await api.invoke('src:del', { id, video: s && s.video || null }); else try { localStorage.removeItem('prism.llearn.src.' + id); } catch { /* */ }
  save();
}

/* -------------------------------------------------------------------- words */
export const wkey = (lang, head) => `${lang}:${String(head).toLowerCase()}`;
export const wstat = (lang, head) => (S.words[wkey(lang, head)] || {}).s || 0;
export function setWord(lang, head, s) {
  const k = wkey(lang, head);
  const was = (S.words[k] || {}).s || 0;
  if (s === 0) delete S.words[k]; else S.words[k] = { s, t: Date.now() };
  if (s === 2 && was !== 2) bump('k');
  save();
  bus.emit('words', { lang, head, s });
}

/* -------------------------------------------------------------------- activity (heatmap) */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function bump(field, n = 1) {
  const k = dayKey();
  const a = S.act[k] || (S.act[k] = {});
  a[field] = (a[field] || 0) + n;
  save();
  bus.emit('act', k);
}
// a day counts when the learner did something real; the level grows with time + reviews + new words
export function dayScore(a) { if (!a) return 0; return (a.m || 0) / 60 + (a.r || 0) * 0.35 + (a.n || 0) * 0.8 + (a.d || 0) * 0.5 + (a.l || 0) * 0.15; }
export function streak() {
  let cur = 0, best = 0, run = 0;
  const d = new Date(); d.setHours(12);
  const today = dayKey(d);
  // current: today (if active) or from yesterday backwards
  const t = new Date(d);
  if (!(dayScore(S.act[today]) >= 1)) t.setDate(t.getDate() - 1);
  while (dayScore(S.act[dayKey(t)]) >= 1) { cur++; t.setDate(t.getDate() - 1); }
  const keys = Object.keys(S.act).filter((k) => dayScore(S.act[k]) >= 1).sort();
  let prev = null;
  for (const k of keys) {
    const dt = new Date(k + 'T12:00:00');
    run = prev && Math.round((dt - prev) / 864e5) === 1 ? run + 1 : 1;
    best = Math.max(best, run); prev = dt;
  }
  return { cur, best: Math.max(best, cur), days: keys.length };
}

/* active time: counted while a video plays or the learner works on a page (input in the last 60 s) */
let lastInput = 0, playing = false, view = 'home';
export function noteInput() { lastInput = Date.now(); }
export function setPlaying(on) { playing = on; }
export function setView(v) { view = v; }
setInterval(() => {
  if (document.hidden) return;
  const learning = view === 'learn' || view === 'review';
  if (playing || (learning && Date.now() - lastInput < 60000)) bump('m', 5);
}, 5000);
for (const ev of ['pointerdown', 'keydown', 'wheel']) addEventListener(ev, noteInput, { passive: true, capture: true });

export const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
