// The lesson page: a YouTube video / video file / web page with its lines. Every word is clickable and coloured by
// what the learner knows; Thai under each line (translated offline in the background); repeat / auto-pause / speed;
// "listen and type" (dictation); keep the video for offline.
import { api, native, T, esc, $, toast, bus, confirmBox, promptBox } from './core.js';
import { icon } from './icons.js';
import { S, save, loadSrc, saveSrc, setPlaying, bump, setWord, wstat, uid } from './store.js';
import { tokenize, fromJson3, fromSubText, decode, article, fromPlain, guessLang, zhReady, fmtTime, HAN } from './text.js';
import { prepareEn, prepareZh, wordClass, headOf, PINYIN, translate, clearTranslateQueue, speak, stopSpeak } from './words.js';
import { openWord, closeWord, wordOpen } from './popup.js';
import { YTPlayer, VideoPlayer } from './players.js';
import { JOBS, startAi, cancelAi, redoRange, canAi, phaseText, exportSubs, aiDialog, setOpenKey, openLive, AST } from './asr.js';
import { ctxMenu } from './core.js';

let R = null; // { src, d, player, idx, loop, kind }
let raf = 0;
const hashStr = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
export const current = () => R;

/* ------------------------------------------------------------ opening lessons */
export function isYouTube(u) { return /(^|\.|\/\/)(youtube\.com|youtu\.be)\//i.test(u) || /^[\w-]{11}$/.test(u.trim()); }
function busy(msg) { $('lr-busy').innerHTML = msg ? `<div class="lr-busy-card glass"><div class="progress indet"><i></i></div><span>${esc(msg)}</span><button class="pill-btn small" id="lr-busy-x">${T`ยกเลิก`}</button></div>` : ''; $('lr-busy').classList.toggle('hidden', !msg); if (msg) $('lr-busy-x').onclick = () => { cancelLoad = true; busy(''); }; }
let cancelLoad = false;

/** a link typed / pasted anywhere: YouTube → video lesson, anything else → web page */
export async function openLink(url) {
  url = String(url || '').trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url) && !isYouTube(url) && !/^[\w-]+(\.[\w-]+)+(\/|$)/.test(url)) {
    // not a link: treat as text to read
    return openText(url);
  }
  if (isYouTube(url)) return openYouTube(url);
  return isVideoSite(url) ? openSite(url) : openWeb(url);
}
// sites whose links are videos (anything else is read as an article first, and tried as a video if it has no text)
const VSITES = /(^|\.)(bilibili\.com|b23\.tv|tiktok\.com|douyin\.com|fb\.watch|vimeo\.com|dailymotion\.com|dai\.ly|twitch\.tv|youku\.com|iqiyi\.com|ixigua\.com|kuaishou\.com|nicovideo\.jp|soundcloud\.com|rumble\.com|odysee\.com|streamable\.com|bitchute\.com|xiaohongshu\.com|xhslink\.com)$/i;
export function isVideoSite(u) {
  let h = '', path = '';
  try { const x = new URL(/^https?:/i.test(u) ? u : 'https://' + u); h = x.hostname; path = x.pathname; } catch { return false; }
  if (VSITES.test(h)) return true;
  if (/(^|\.)facebook\.com$/i.test(h) && /\/(watch|reel|videos?)\b/i.test(path)) return true;
  if (/(^|\.)instagram\.com$/i.test(h) && /\/(reel|reels|tv)\//i.test(path)) return true;
  if (/(^|\.)(x|twitter)\.com$/i.test(h) && /\/status\//i.test(path)) return true;
  if (/(^|\.)ted\.com$/i.test(h) && /\/talks\//i.test(path)) return true;
  if (/(^|\.)v\.qq\.com$/i.test(h) || (/(^|\.)weibo\.com$/i.test(h) && /\/tv\//.test(path))) return true;
  if (/(^|\.)podcasts\.apple\.com$/i.test(h) || (/(^|\.)archive\.org$/i.test(h) && /\/details\//.test(path))) return true;
  return /\.(mp4|m4v|webm|mov|mkv|m3u8|mp3|m4a|aac|ogg|wav)$/i.test(path);
}
function whySite(r) {
  return { novideo: T`ไม่พบวิดีโอในลิงก์นี้`, signin: T`เว็บนี้ต้องล็อกอินจึงดูวิดีโอได้`, network: T`เชื่อมต่ออินเทอร์เน็ตไม่ได้`, badurl: T`ลิงก์ไม่ถูกต้อง`, noruntime: T`ไม่พบไฟล์ yt-dlp ในโฟลเดอร์ runtime — ติดตั้งแอปใหม่ (ซ่อมใน Prism Hub)` }[r] || T`เปิดวิดีโอจากเว็บนี้ไม่ได้`;
}
/** a video on another site: details + its subtitles (if any) with yt-dlp; the video is kept as a file to play,
 *  and when there are no English / Chinese subtitles AI makes them */
async function openSite(url, { quietFail = false } = {}) {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  cancelLoad = false;
  busy(T`กำลังอ่านข้อมูลวิดีโอ…`);
  const info = await api.invoke('site:info', { url });
  if (cancelLoad) return true;
  if (!info || !info.ok) { busy(''); if (!quietFail) toast(whySite(info && info.reason), { kind: 'err' }); return false; }
  const id = 's-' + String(info.id).replace(/[^\w-]/g, '').slice(0, 70);
  if (S.sources.some((s) => s.id === id) && (await loadSrc(id))) { busy(''); await openSource(id); return true; }
  let cues = null, tr = null;
  const want = String(info.lang || '').startsWith('zh') ? 'zh' : String(info.lang || '').startsWith('en') ? 'en' : null;
  const subs = [...(info.subs || [])].sort((a, b) => ((b.lang === want) * 4 + !b.auto * 2) - ((a.lang === want) * 4 + !a.auto * 2));
  for (const t of subs) {
    busy(T`กำลังดึงซับ ${t.name || t.code}…`);
    const r = await api.invoke('site:sub', { url: t.url });
    if (cancelLoad) return true;
    if (r && r.ok) { cues = t.ext === 'json3' ? fromJson3(r.text) : fromSubText(r.text, t.ext); if (cues.length) { tr = t; break; } }
  }
  busy('');
  const lang = tr ? tr.lang : want || 'en';
  const src = { id, kind: 'site', site: info.site, title: info.title || url, url: info.url || url, channel: info.channel || info.site, lang, thumb: String(info.thumb || '').replace(/^http:\/\//i, 'https://'), dur: (info.duration || 0) * 1000,
    added: Date.now(), last: Date.now(), pos: 0, track: cues && cues.length ? 'site' : 'ai', subName: tr ? tr.name || tr.code : '' };
  S.sources = [src, ...S.sources.filter((s) => s.id !== id)];
  saveSrc(id, { cues: cues || [] }, true);
  save();
  await openSource(id);
  siteDownload(src);
  if (!(cues && cues.length) && S.set.aiAuto !== false) { if (await startAi(src)) toast(T`วิดีโอนี้ไม่มีซับ — AI ในเครื่องกำลังฟังแล้วทำซับให้`); }
  return true;
}
function siteDownload(src) {
  if (src.video || dl.has(src.id)) return;
  dl.set(src.id, 0);
  if (R && R.src === src) { renderCtrl(); makePlayer(); }
  api.invoke('yt:download', { id: src.id, url: src.url, title: src.title }).then((r) => {
    if (r && r.ok) return;
    dl.delete(src.id); toast(T`โหลดวิดีโอจากเว็บนี้ไม่สำเร็จ`, { kind: 'err' });
    if (R && R.src === src) { renderCtrl(); makePlayer(); }
  });
}

async function openYouTube(url) {
  cancelLoad = false;
  busy(T`กำลังอ่านข้อมูลคลิป…`);
  const info = await api.invoke('yt:info', { url });
  if (cancelLoad) return;
  if (!info || !info.ok) { busy(''); return toast(whyYt(info && info.reason), { kind: 'err' }); }
  const id = 'yt-' + info.id;
  const old = S.sources.find((s) => s.id === id);
  if (old && (await loadSrc(id))) { busy(''); return openSource(id); }
  if (!info.tracks.length) {
    // no English / Chinese subtitles: the lesson opens and AI makes them from the sound
    busy('');
    const lang = (info.lang || '').startsWith('zh') ? 'zh' : 'en';
    const src = { id, kind: 'yt', vid: info.id, title: info.title || info.id, url: `https://www.youtube.com/watch?v=${info.id}`, channel: info.channel || '', lang, thumb: info.thumb, dur: (info.duration || 0) * 1000, added: Date.now(), last: Date.now(), pos: 0, track: 'ai', tracks: [] };
    S.sources = [src, ...S.sources.filter((s) => s.id !== id)];
    saveSrc(id, { cues: [] }, true);
    save();
    await openSource(id);
    if (S.set.aiAuto !== false) { if (await startAi(src)) toast(T`คลิปนี้ไม่มีซับ — AI ในเครื่องกำลังฟังแล้วทำซับให้`); }
    return;
  }
  const tr = pickTrack(info.tracks, info.lang);
  busy(T`กำลังดึงซับ ${tr.name}…`);
  const cues = await fetchCues(info.id, tr);
  if (cancelLoad) return;
  busy('');
  if (!cues) return;
  const src = { id, kind: 'yt', vid: info.id, title: info.title || info.id, url: `https://www.youtube.com/watch?v=${info.id}`, channel: info.channel || '', lang: tr.lang, thumb: info.thumb, dur: (info.duration || 0) * 1000, added: Date.now(), last: Date.now(), pos: 0, track: tr.code, tracks: info.tracks };
  S.sources = [src, ...S.sources.filter((s) => s.id !== id)];
  saveSrc(id, { cues }, true);
  save();
  openSource(id);
}
function pickTrack(tracks, vlang) {
  const want = (vlang || '').startsWith('zh') ? 'zh' : (vlang || '').startsWith('en') ? 'en' : null;
  const score = (t) => (t.lang === want ? 4 : 0) + (t.auto ? 0 : 2) + (/^(en|zh-Hans|zh-CN)$/.test(t.code) ? 1 : 0);
  return [...tracks].sort((a, b) => score(b) - score(a))[0];
}
async function fetchCues(vid, tr) {
  const r = await api.invoke('yt:subs', { id: vid, code: tr.code, auto: tr.auto });
  if (!r || !r.ok) { toast(r && r.reason === 'busy' ? T`YouTube ขอให้รอสักครู่ (ขอซับถี่เกินไป) — ลองใหม่ในอีกสักพัก` : whyYt(r && r.reason), { kind: 'err' }); return null; }
  const cues = fromJson3(r.json3);
  if (!cues.length) { toast(T`ซับของคลิปนี้ว่างเปล่า`, { kind: 'err' }); return null; }
  return cues;
}
function whyYt(r) {
  return { badurl: T`ลิงก์นี้ไม่ใช่คลิป YouTube`, network: T`เชื่อมต่ออินเทอร์เน็ตไม่ได้ — เปิดคลิป YouTube ต้องใช้เน็ต (บทที่เคยเปิดแล้ว ทบทวนได้ตลอด)`, unavailable: T`คลิปนี้ดูไม่ได้ (ส่วนตัว / ถูกลบ / จำกัดประเทศ)`, signin: T`คลิปนี้ต้องล็อกอิน YouTube จึงดูได้`, notrack: T`ไม่พบซับที่เลือก`, busy: T`YouTube ให้โหลดซับถี่เกินไป — รอสักครู่แล้วลองใหม่`, noruntime: T`ไม่พบไฟล์ yt-dlp ในโฟลเดอร์ runtime — ติดตั้งแอปใหม่ (ซ่อมใน Prism Hub)` }[r] || T`อ่านคลิปนี้ไม่สำเร็จ`;
}

async function openWeb(url) {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  cancelLoad = false;
  busy(T`กำลังโหลดหน้าเว็บ…`);
  const r = await api.invoke('web:get', { url });
  if (cancelLoad) return;
  busy('');
  if (!r || !r.ok) { if (r && r.reason !== 'network' && (await openSite(url, { quietFail: true }))) return; busy(''); return toast(r && r.reason === 'network' ? T`เชื่อมต่ออินเทอร์เน็ตไม่ได้` : T`เปิดหน้าเว็บนี้ไม่ได้ (${(r && r.status) || '?'})`, { kind: 'err' }); }
  let html = decode(r.b64);
  const cs = (html.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  if (cs && !/utf-?8/i.test(cs)) html = decode(r.b64, cs.toLowerCase());
  const a = article(html, r.url);
  if (!a.paras.length || (a.paras.length < 2 && /<video|og:video/i.test(html))) {
    // no article: maybe the page is a video (yt-dlp knows 1,000+ sites)
    if (await openSite(url, { quietFail: true })) return;
    if (!a.paras.length) return toast(T`ไม่พบเนื้อหาที่อ่านได้ในหน้านี้`, { kind: 'err' });
  }
  return addReading('web', a.title || r.url, a.paras, r.url);
}
export async function openText(text, title) {
  const paras = fromPlain(text);
  if (!paras.length) return;
  return addReading('text', title || paras[0].s[0].slice(0, 60), paras, '');
}
/** a text lesson added without opening it (words kept in Prism Shot point at the text they came from) */
export function addTextSource(text, title) {
  const paras = fromPlain(text);
  if (!paras.length) return null;
  return addReading('text', title || paras[0].s[0].slice(0, 60), paras, '', false);
}
function addReading(kind, title, paras, url, open = true) {
  const id = (kind === 'web' ? 'w-' : 't-') + hashStr(url || paras.map((p) => p.s.join(' ')).join('\n').slice(0, 4000));
  const cues = [];
  paras.forEach((p, pi) => p.s.forEach((t) => cues.push({ t, p: pi, h: p.h ? 1 : 0 })));
  const lang = guessLang(cues.slice(0, 40).map((c) => c.t).join(' '));
  const src = { id, kind, title, url, lang, added: Date.now(), last: Date.now(), pos: 0 };
  S.sources = [src, ...S.sources.filter((s) => s.id !== id)];
  saveSrc(id, { cues }, true);
  save();
  return open ? openSource(id) : src;
}

/** a video file (and maybe subtitle files) from the PC */
export async function openFiles(paths) {
  const vids = paths.filter((p) => /\.(mp4|m4v|webm|mkv|mov|avi|ts|mp3|m4a)$/i.test(p));
  const subs = paths.filter((p) => /\.(srt|vtt|ass|ssa)$/i.test(p));
  if (!vids.length && subs.length && R && R.src.kind === 'file') return loadSubFile(subs[0]); // a subtitle dropped onto the open video
  if (!vids.length) { if (subs.length) toast(T`เปิดวิดีโอก่อน แล้วค่อยลากไฟล์ซับมาวาง`); return; }
  const p = vids[0];
  busy(T`กำลังเปิดวิดีโอ…`);
  const m = await api.invoke('media:open', { path: p });
  busy('');
  if (!m || !m.ok) return toast(T`เปิดไฟล์นี้ไม่ได้`, { kind: 'err' });
  const id = 'f-' + hashStr(p);
  let cues = null, lang = 'en', subName = '';
  const tryList = [...subs.map((x) => ({ path: x, name: x.split(/[\\/]/).pop() })), ...m.subs];
  for (const s of tryList) { const c = await readSub(s.path); if (c && c.length) { cues = c; subName = s.name; break; } }
  const pref = (x) => (/^(eng?|chi|zho|zh|chs|cht)$/i.test(x.lang) ? 0 : !x.lang ? 1 : 2); // English / Chinese tracks first, then unnamed, then the rest
  if (!cues) for (const t of [...m.tracks].sort((a, b) => pref(a) - pref(b))) {
    busy(T`กำลังดึงซับจากในไฟล์…`);
    const r = await api.invoke('media:sub', { path: p, index: t.index });
    busy('');
    if (r && r.ok) { cues = fromSubText(decode(r.b64), 'srt'); subName = t.title || t.lang || T`ซับในไฟล์`; if (cues.length) break; }
  }
  if (cues && cues.length) lang = guessLang(cues.slice(0, 60).map((c) => c.t).join(' '));
  const src = { id, kind: 'file', title: m.name.replace(/\.[^.]+$/, ''), video: p, lang, added: Date.now(), last: Date.now(), pos: 0, subName };
  if (!cues && S.set.aiAuto !== false && native) src.track = 'ai';
  S.sources = [src, ...S.sources.filter((s) => s.id !== id)];
  saveSrc(id, { cues: cues || [] }, true);
  save();
  await openSource(id);
  if (!cues) {
    if (S.set.aiAuto !== false) { src.track = 'ai'; save(); if (R && R.src === src) R.aiNext = 0; }
    if (S.set.aiAuto !== false && (await startAi(src, { quiet: true }))) toast(T`ไม่พบซับของวิดีโอนี้ — AI ในเครื่องกำลังฟังแล้วทำซับให้ (หรือลากไฟล์ .srt มาวาง)`);
    else toast(T`ไม่พบซับของวิดีโอนี้ — ลากไฟล์ .srt / .vtt มาวาง หรือกดปุ่ม "เปิดไฟล์ซับ"`);
  }
}
async function readSub(path) {
  const r = await api.invoke('media:sub', { path });
  if (!r || !r.ok) return null;
  return fromSubText(decode(r.b64), r.ext);
}
async function loadSubFile(path) {
  const cues = await readSub(path);
  if (!cues || !cues.length) return toast(T`อ่านไฟล์ซับนี้ไม่ได้`, { kind: 'err' });
  R.d.cues = cues; R.src.lang = guessLang(cues.slice(0, 60).map((c) => c.t).join(' ')); R.src.subName = path.split(/[\\/]/).pop();
  saveSrc(R.src.id, R.d, true); save();
  openSource(R.src.id);
}

/* ------------------------------------------------------------ the lesson page */
export async function openSource(id) {
  const src = S.sources.find((s) => s.id === id);
  if (!src) return;
  const d = await loadSrc(id);
  if (!d) return toast(T`ไม่พบข้อมูลบทเรียนนี้`, { kind: 'err' });
  let aiNext;
  if (native && src.track === 'ai' && (aiRunning(id) || !d.cues.length)) {
    // AI lines: the finished result, or what is heard so far while the job still runs (Rust has the truth)
    const r = await aiLines(id, d);
    if (r) aiNext = r.next;
  }
  close(false);
  src.last = Date.now(); save();
  R = { src, d, idx: -1, loop: false, dict: null, kind: src.kind, aiNext, undo: [], sel: null, edit: false };
  bus.emit('open-lesson', src);
  $('lr-empty').classList.add('hidden'); $('lr').classList.remove('hidden');
  $('lr').classList.toggle('reading', src.kind === 'web' || src.kind === 'text');
  $('lr-title').textContent = src.title;
  $('lr-title').title = src.title;
  $('lr-sub').innerHTML = subLine(src);
  if (HAN.test(d.cues.slice(0, 50).map((c) => c.t).join(''))) await zhReady();
  // word data for colouring (base forms, pinyin)
  await prepCues(d.cues);
  if (!R || R.src !== src) return;
  makePlayer();
  renderList();
  renderCtrl();
  // translations: start the engine now so the first lines come quickly
  if (S.set.showTh) { if (native) api.invoke('tr:warm'); queueTranslations(); }
  if (src.pos) { const i = d.cues.findIndex((c) => (c.s || 0) >= src.pos - 500); if (i >= 0) setIdx(i, true); }
  updateStats();
  cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
}
function subLine(src) {
  const bits = [];
  if (src.kind === 'yt') bits.push(`${icon('play')}<span>${esc(src.channel || 'YouTube')}</span>`);
  if (src.kind === 'web') bits.push(`${icon('globe')}<span>${esc((src.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0])}</span>`);
  if (src.kind === 'file') bits.push(`${icon('file')}<span>${esc(src.track === 'ai' ? T`ซับจาก AI ในเครื่อง` : src.subName || T`ไม่มีซับ`)}</span>`);
  if (src.kind === 'site') bits.push(`${icon('globe')}<span>${esc(src.channel || src.site || '')}</span>`);
  if (src.kind === 'text') bits.push(`${icon('doc')}<span>${T`ข้อความที่วาง`}</span>`);
  bits.push(`<span class="lang-chip ${src.lang}">${src.lang === 'zh' ? T`จีน` : T`อังกฤษ`}</span>`);
  return bits.join('');
}
function close(clearUi = true) {
  cancelAnimationFrame(raf);
  if (R) {
    if (R.player) { try { R.src.pos = Math.round(R.player.time()); } catch { /* */ } R.player.destroy(); }
    saveSrc(R.src.id, stripTok(R.d), true);
    save();
  }
  clearTranslateQueue();
  stopSpeak();
  closeWord();
  setPlaying(false);
  R = null;
  if (clearUi) { $('lr').classList.add('hidden'); $('lr-empty').classList.remove('hidden'); bus.emit('open-lesson', null); }
}
export const closeLesson = () => close(true);
const stripTok = (d) => ({ ...d, cues: d.cues.map(({ _tok, _kt, _ku, ...c }) => c) });
/** words of new lines + their timings (karaoke) and the words AI was unsure of (dotted underline) */
async function prepCues(cues) {
  if (HAN.test(cues.slice(0, 60).map((c) => c.t).join(''))) await zhReady();
  const en = [], zh = [];
  for (const c of cues) { c._tok = tokenize(c.t); kara(c); for (const t of c._tok) if (t.w) (t.lang === 'zh' ? zh : en).push(t.t); }
  await Promise.all([prepareEn(en), prepareZh(zh)]);
}
function kara(c) {
  c._kt = null; c._ku = null;
  if (!c.w || !c.w.length) return;
  const marks = [];
  let pos = 0;
  for (const x of c.w) { const w = String(x[1] || '').trim(); if (!w) continue; const i = c.t.indexOf(w, pos); if (i < 0) continue; marks.push([i, i + w.length, x[0], x[2]]); pos = i + w.length; }
  if (!marks.length) return;
  const kt = [], ku = new Set();
  let off = 0, k = -1;
  c._tok.forEach((t, ti) => {
    if (t.w) {
      while (k + 1 < marks.length && marks[k + 1][0] <= off) k++;
      kt.push(k >= 0 ? marks[k][2] : c.s);
      if (c.ai) { const m = marks.find((x) => off < x[1] && off + t.t.length > x[0]); if (m && m[3] !== undefined && m[3] < 0.45) ku.add(ti); }
    }
    off += t.t.length;
  });
  c._kt = kt;
  if (ku.size) c._ku = ku;
}

function makePlayer() {
  const box = $('lr-video');
  box.innerHTML = '';
  const src = R.src;
  const onState = (s) => { setPlaying(s === 1); renderPlayBtn(); };
  if (src.kind === 'yt' && !(src.video && src.useLocal !== false)) R.player = new YTPlayer(box, src.vid, { start: src.pos || 0, onState, onError: (c) => toast(T`YouTube เล่นคลิปนี้ในโปรแกรมไม่ได้ (รหัส ${c}) — กดปุ่มโหลดไว้ดูออฟไลน์ หรือเปิดใน YouTube`, { kind: 'err' }) });
  else if (src.video) {
    api.invoke('media:url', src.video).then((u) => {
      if (!R || R.src !== src) return;
      if (!u || !u.ok) { box.innerHTML = `<div class="lr-novideo">${icon('warn')}<span>${T`ไม่พบไฟล์วิดีโอแล้ว (ถูกย้ายหรือลบ)`}</span></div>`; if (src.kind === 'yt') { src.useLocal = false; makePlayer(); } return; }
      R.player = new VideoPlayer(box, u.url, { start: src.pos || 0, onState, onError: () => convert(src.video) });
      R.player.setRate(S.set.rate || 1);
    });
  } else if (src.kind === 'site') {
    R.player = null;
    const f = dl.get(src.id);
    box.innerHTML = `<div class="lr-novideo">${f !== undefined ? `<div class="progress"><i id="dl-bar" style="width:${Math.round(f * 100)}%"></i></div><span>${T`กำลังโหลดวิดีโอ… (AI ทำซับไปพร้อมกันได้)`}</span>`
      : `${icon('warn')}<span>${T`ยังไม่มีไฟล์วิดีโอ`}</span><button class="pill-btn small" data-c2="sitedl">${icon('download')}<span>${T`โหลดวิดีโอ`}</span></button>`}</div>`;
    const b = box.querySelector('[data-c2="sitedl"]'); if (b) b.onclick = () => siteDownload(src);
  } else { R.player = null; box.innerHTML = ''; }
  if (R.player) R.player.setRate(S.set.rate || 1);
}
async function convert(path, full = false) {
  const box = $('lr-video');
  box.innerHTML = `<div class="lr-novideo"><div class="progress"><i id="cv-bar" style="width:0%"></i></div><span>${full ? T`กำลังแปลงวิดีโอให้เล่นได้ (อาจใช้เวลาหลายนาที)…` : T`ไฟล์นี้เล่นตรงๆ ไม่ได้ — กำลังจัดรูปแบบใหม่…`}</span></div>`;
  const off = api.on('media:progress', (p) => {
    const b = document.getElementById('cv-bar'); if (b && p.f !== undefined) b.style.width = Math.round(p.f * 100) + '%';
    if (p.done) {
      off();
      if (!R) return;
      if (!p.ok) { box.innerHTML = `<div class="lr-novideo">${icon('warn')}<span>${T`เล่นไฟล์นี้ไม่ได้`}</span></div>`; return; }
      box.innerHTML = '';
      R.player = new VideoPlayer(box, p.url, { start: R.src.pos || 0, onState: (s) => { setPlaying(s === 1); renderPlayBtn(); }, onError: () => { if (!full) convert(path, true); } });
    }
  });
  const r = await api.invoke('media:convert', { path, full });
  if (r && r.url) { off(); box.innerHTML = ''; R.player = new VideoPlayer(box, r.url, { start: R.src.pos || 0, onState: (s) => { setPlaying(s === 1); renderPlayBtn(); }, onError: () => { if (!full) convert(path, true); } }); }
}

/* ------------------------------------------------------------ lines */
function tokHtml(t, ci, ti) {
  if (!t.w) return esc(t.t);
  const cls = wordClass(t) + (R && R.d.cues[ci] && R.d.cues[ci]._ku && R.d.cues[ci]._ku.has(ti) ? ' unsure' : '');
  const py = t.lang === 'zh' && S.set.pinyin ? (PINYIN.get(t.t) || [])[0] : '';
  const inner = py ? `<ruby>${esc(t.t)}<rt>${esc(py)}</rt></ruby>` : esc(t.t);
  return `<span class="tok ${cls}" data-c="${ci}" data-t="${ti}">${inner}</span>`;
}
const lineHtml = (c, ci) => c._tok.map((t, ti) => tokHtml(t, ci, ti)).join('');
function renderList() {
  const list = $('lr-lines'), timed = R.kind !== 'web' && R.kind !== 'text';
  const out = [];
  let lastP = -1;
  R.d.cues.forEach((c, i) => {
    if (!timed && c.p !== lastP) { if (lastP >= 0) out.push('</div>'); out.push(`<div class="para${c.h ? ' head' : ''}">`); lastP = c.p; }
    out.push(`<div class="cue${timed ? '' : ' sent'}" data-i="${i}">${timed ? `<button class="cue-time" data-seek="${i}" title="${T`เล่นจากบรรทัดนี้`}">${fmtTime(c.s)}</button>` : `<button class="cue-say" data-say="${i}" title="${T`อ่านประโยคนี้ให้ฟัง`}">${icon('speaker')}</button>`}<div class="cue-body"><div class="cue-t">${lineHtml(c, i)}</div><div class="cue-th">${c.th ? esc(c.th) : ''}</div></div><button class="cue-ok" data-known="${i}" title="${T`รู้ทุกคำในบรรทัดนี้แล้ว`}">${icon('check')}</button></div>`);
  });
  if (!timed && lastP >= 0) out.push('</div>');
  list.innerHTML = out.join('') || aiPanel();
  list.classList.toggle('editing', !!R.edit);
  markSel();
  list.classList.toggle('no-th', !S.set.showTh);
  list.style.setProperty('--sub-font', (S.set.subFont || 21) - 4 + 'px');
}
const aiRunning = (id) => JOBS.has(id) || (S.asrQ || []).some((x) => x.key === id);
/** lines from Rust: finished → all of them; still running → what is heard so far (+ the next piece to expect) */
async function aiLines(id, d) {
  const r = await api.invoke('asr:result', id);
  const old = new Map(d.cues.map((c) => [c.t, c.th]));
  const keepTh = (cs) => cs.map((c) => ({ ...c, th: c.th || old.get(c.t) || undefined }));
  if (r && r.ok && r.cues && !aiRunning(id)) { if (r.cues.length) d.cues = keepTh(r.cues); return { next: undefined }; }
  if (r && r.partial) { d.cues = keepTh(r.partial); return { next: r.done }; }
  if (aiRunning(id)) { d.cues = []; return { next: 0 }; }
  return null;
}
function aiPanel() {
  const src = R.src, j = JOBS.get(src.id);
  if (j) return `<div class="ai-panel"><div class="ai-orb">${icon('sparkle')}</div><b>${T`AI กำลังฟังคลิปนี้แล้วทำซับให้`}</b>
    <div class="progress${j.phase === 'prep' || j.phase === 'wait' ? ' indet' : ''}"><i id="ai-bar" style="width:${Math.round((j.f || 0) * 100)}%"></i></div><span class="muted" id="ai-phase">${esc(phaseText(j))}</span>
    <p class="muted small">${T`บรรทัดจะค่อยๆ ขึ้นมาระหว่างทำ — เล่นคลิปหรือไปเรียนอย่างอื่นก่อนก็ได้ ปิดโปรแกรมแล้วเปิดใหม่ก็ทำต่อจากเดิม`}</p>
    <button class="pill-btn small" data-ai="cancel">${icon('x')}<span>${T`ยกเลิก`}</span></button></div>`;
  if (canAi(src)) return `<div class="ai-panel"><div class="ai-orb">${icon('sparkle')}</div><b>${T`คลิปนี้ยังไม่มีซับ`}</b>
    <p class="muted">${T`ให้ AI ในเครื่องฟังเสียงแล้วเขียนซับภาษาอังกฤษ / จีนให้ — ฟรี ไม่ต้องส่งข้อมูลออกไปไหน`}</p>
    <div class="ai-btns"><button class="pill-btn primary" data-ai="quick">${icon('sparkle')}<span>${T`ทำซับด้วย AI`}</span></button><button class="pill-btn" data-ai="start">${T`เลือกโหมด / ภาษา…`}</button></div>
    ${src.kind === 'file' ? `<p class="muted small">${T`หรือลากไฟล์ .srt / .vtt มาวาง`}</p>` : ''}</div>`;
  return `<div class="lr-nosub">${icon('warn')}<p>${T`ยังไม่มีซับ — ลากไฟล์ .srt / .vtt มาวาง`}</p></div>`;
}
async function aiAct(a) {
  if (!R) return;
  const src = R.src;
  if (a === 'cancel') return cancelAi(src.id);
  if (a === 'quick') return useAi({});
  if (a === 'start' || a === 'new') {
    const o = await aiDialog(src);
    if (!o || !R || R.src !== src) return;
    src.aiLang = o.lang; save();
    return useAi({ fresh: a === 'new', mode: o.mode, lang: o.lang === 'auto' ? '' : o.lang });
  }
}
/** switch this lesson to AI lines: the saved result if there is one, else start listening (lines come in as heard) */
async function useAi({ fresh = false, mode, lang } = {}) {
  const src = R.src, d = R.d;
  if (src.track !== 'ai' && src.kind !== 'yt' && d.cues.length) d.alt = { track: src.track || 'orig', name: src.subName || '', cues: stripTok(d).cues };
  if (!fresh && !JOBS.has(src.id) && !src.aiPartial) {
    const r = await api.invoke('asr:result', src.id);
    if (r && r.ok && r.cues && r.cues.length) return applyCues(r.cues, 'ai', r.lang);
  }
  src.track = 'ai';
  if (!JOBS.has(src.id) || fresh) { d.cues = []; R.aiNext = 0; }
  saveSrc(src.id, stripTok(d), true); save();
  renderList(); renderCtrl(); updateStats(); renderCap();
  if (!(await startAi(src, { fresh, mode, lang, front: true }))) { renderList(); updateStats(); }
  else { renderList(); updateStats(); }
}
async function applyCues(cues, track, lang) {
  const src = R.src, d = R.d;
  await prepCues(cues);
  if (!R || R.d !== d) return;
  d.cues = cues; src.track = track; if (lang) src.lang = lang;
  saveSrc(src.id, stripTok(d), true); save();
  $('lr-sub').innerHTML = subLine(src);
  renderList(); renderCtrl(); setIdxForce(); renderCap(); updateStats();
  if (S.set.showTh) queueTranslations();
}
let resyncing = false;
bus.on('asr', async (p) => {
  if (!R || !p || p.key !== R.src.id) return;
  if (p.piece !== undefined && R.aiNext === undefined && R.src.track === 'ai') {
    // we don't know which pieces are already shown (lesson opened before the job resumed): take Rust's list
    if (resyncing) return;
    resyncing = true;
    const d = R.d, r = await aiLines(R.src.id, d);
    resyncing = false;
    if (!R || R.d !== d) return;
    R.aiNext = r ? r.next || 0 : 0;
    await prepCues(d.cues);
    if (!R || R.d !== d) return;
    renderList(); setIdxForce(); renderCtrl(); updateStats();
    if (S.set.showTh) queueTranslations();
    return;
  }
  if (p.piece !== undefined && p.piece >= (R.aiNext || 0) && (R.src.track === 'ai' || !R.d.cues.length)) {
    if (R.src.track !== 'ai') { R.src.track = 'ai'; save(); }
    R.aiNext = p.piece + 1;
    const add = (p.cues || []).map((c) => ({ ...c }));
    if (add.length) {
      const d = R.d;
      if (p.lang && p.lang !== R.src.lang) { R.src.lang = p.lang; $('lr-sub').innerHTML = subLine(R.src); }
      await prepCues(add);
      if (!R || R.d !== d) return;
      const st = $('lr-lines').scrollTop;
      d.cues.push(...add);
      renderList(); $('lr-lines').scrollTop = st;
      setIdxForce(); renderCtrl();
      if (S.set.showTh) queueTranslations();
    }
  }
  const j = JOBS.get(R.src.id);
  const bar = document.getElementById('ai-bar'), ph = document.getElementById('ai-phase');
  if (j && bar) { bar.style.width = Math.round((j.f || 0) * 100) + '%'; bar.parentElement.classList.toggle('indet', j.phase === 'prep' || j.phase === 'wait'); }
  if (j && ph) ph.textContent = phaseText(j);
  if (!R.d.cues.length && !bar) renderList();
  updateStats();
});
bus.on('asr-done', async (p) => {
  if (!R || p.key !== R.src.id) return;
  const d = R.d;
  if (p.ok && R.src.track === 'ai') {
    const cs = p.cues || [];
    if (d.cues.length !== cs.length || d.cues.some((c, i) => c.t !== cs[i].t)) {
      const old = new Map(d.cues.map((c) => [c.t, c.th]));
      const nc = cs.map((c) => ({ ...c, th: old.get(c.t) || undefined }));
      await prepCues(nc);
      if (!R || R.d !== d) return;
      d.cues = nc;
      renderList(); setIdxForce();
    }
    R.src.lang = p.lang || R.src.lang;
    saveSrc(R.src.id, stripTok(d), true); save();
    $('lr-sub').innerHTML = subLine(R.src);
    renderCtrl();
    if (S.set.showTh) queueTranslations();
    if (!p.empty) toast(T`ทำซับเสร็จแล้ว ${d.cues.length} บรรทัด — คำที่ขีดเส้นประคือคำที่ AI ไม่แน่ใจ`);
  } else if (!d.cues.length) renderList();
  R.aiNext = undefined;
  updateStats();
});

/* ------------------------------------------------------------ editing lines (any lesson with timed lines) */
function pushUndo() { if (!R) return; R.undo.push(JSON.stringify(stripTok(R.d).cues)); if (R.undo.length > 40) R.undo.shift(); }
async function commit() {
  const d = R.d;
  await prepCues(d.cues);
  if (!R || R.d !== d) return;
  renderList(); setIdxForce(); renderCap(); updateStats();
  saveSrc(R.src.id, stripTok(d), true);
  if (R.src.track === 'ai' && native) api.invoke('asr:save', { key: R.src.id, cues: stripTok(d).cues, lang: R.src.lang });
  if (S.set.showTh) queueTranslations();
}
async function undoEdit() {
  if (!R || !R.undo.length) { toast(T`ไม่มีการแก้ให้ย้อน`); return; }
  R.d.cues = JSON.parse(R.undo.pop());
  R.editing = undefined;
  await commit();
  toast(T`ย้อนการแก้แล้ว`);
}
function toggleEdit(on = !R.edit) {
  if (!R || R.kind === 'web' || R.kind === 'text') return;
  finishEdit(false);
  R.edit = on;
  $('lr-lines').classList.toggle('editing', on);
  renderCtrl();
  if (on) toast(T`โหมดแก้ซับ: คลิกบรรทัดเพื่อแก้คำ · Enter บันทึก · Ctrl+Enter แยกบรรทัด · Ctrl+Z ย้อน · กด E อีกครั้งเพื่อออก`);
}
function startEdit(i) {
  if (!R || R.editing === i) return;
  finishEdit(false);
  const c = R.d.cues[i];
  const el = document.querySelector(`#lr-lines .cue[data-i="${i}"] .cue-body`);
  if (!c || !el) return;
  R.editing = i;
  if (R.player && R.player.playing()) R.player.pause();
  el.innerHTML = `<textarea class="cue-ed" spellcheck="false" rows="2">${esc(c.t)}</textarea>
    <div class="cue-edbar">
      <button class="pill-btn small primary" data-ed="ok" title="Enter">${icon('check')}<span>${T`บันทึก`}</span></button>
      <button class="pill-btn small" data-ed="x" title="Esc">${T`ยกเลิก`}</button>
      <i class="ed-gap"></i>
      <button class="icon-btn" data-ed="play" title="${T`ฟังบรรทัดนี้`}">${icon('play')}</button>
      <button class="icon-btn" data-ed="split" title="${T`แยกบรรทัดตรงเคอร์เซอร์ (Ctrl+Enter)`}">${icon('scissors')}</button>
      <button class="icon-btn" data-ed="merge" title="${T`รวมกับบรรทัดถัดไป`}">${icon('layers')}</button>
      <button class="ed-time" data-ed="early" title="${T`เริ่มบรรทัดเร็วขึ้น 0.25 วินาที`}">−0.25s</button>
      <button class="ed-time" data-ed="late" title="${T`เริ่มบรรทัดช้าลง 0.25 วินาที`}">+0.25s</button>
      <button class="icon-btn" data-ed="del" title="${T`ลบบรรทัดนี้`}">${icon('trash')}</button>
      ${canAi(R.src) ? `<button class="pill-btn small" data-ed="redo" title="${T`ให้ AI ฟังบรรทัดนี้ใหม่ด้วยโหมดแม่นยำ`}">${icon('sparkle')}<span>${T`ให้ AI ฟังใหม่`}</span></button>` : ''}
    </div>`;
  const ta = el.querySelector('textarea');
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); editOp('split'); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
  };
  el.querySelectorAll('[data-ed]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); editOp(b.dataset.ed); }; });
}
function finishEdit(keep) {
  if (!R || R.editing === undefined) return;
  const i = R.editing, c = R.d.cues[i];
  const ta = document.querySelector('#lr-lines .cue-ed');
  R.editing = undefined;
  const text = ta ? ta.value.replace(/\s+/g, ' ').trim() : '';
  if (keep && c && ta && text !== c.t) {
    pushUndo();
    if (!text) R.d.cues.splice(i, 1);
    else { c.t = text; c.th = undefined; c.w = undefined; c.ed = 1; }
    commit();
    return;
  }
  renderList(); setIdxForce();
}
function editOp(op) {
  if (!R || R.editing === undefined) return;
  const i = R.editing, cs = R.d.cues, c = cs[i];
  const ta = document.querySelector('#lr-lines .cue-ed');
  if (op === 'ok') return finishEdit(true);
  if (op === 'x') return finishEdit(false);
  if (op === 'play') return playCue(i);
  if (op === 'redo') { finishEdit(false); return redoLines(i, i); }
  const v = ta ? ta.value : c.t;
  pushUndo();
  if (op === 'split') {
    const k = ta ? ta.selectionStart : 0;
    const a = v.slice(0, k).trim(), b = v.slice(k).trim();
    if (!a || !b) { R.undo.pop(); return toast(T`วางเคอร์เซอร์ตรงจุดที่จะแยกบรรทัดก่อน`); }
    const zh = HAN.test(v);
    let t = c.s + (c.e - c.s) * (a.length / Math.max(1, v.length));
    let wa, wb;
    if (c.w && c.w.length && !zh) { const n = a.split(/\s+/).filter(Boolean).length; if (n < c.w.length) { t = c.w[n][0]; wa = c.w.slice(0, n); wb = c.w.slice(n); } }
    t = Math.max(c.s + 200, Math.min(c.e - 200, t));
    cs.splice(i, 1, { ...c, t: a, e: t, w: wa, th: undefined, ed: 1 }, { ...c, s: t, t: b, w: wb, th: undefined, ed: 1 });
  } else if (op === 'merge') {
    const n = cs[i + 1];
    if (!n) { R.undo.pop(); return toast(T`ไม่มีบรรทัดถัดไปให้รวม`); }
    const zh = HAN.test(v + n.t);
    cs.splice(i, 2, { ...c, t: (v.trim() + (zh ? '' : ' ') + n.t).trim(), e: n.e, w: c.w && n.w ? [...c.w, ...n.w] : undefined, th: undefined, ed: 1 });
  } else if (op === 'del') cs.splice(i, 1);
  else if (op === 'early' || op === 'late') {
    const prev = cs[i - 1];
    c.s = Math.round(op === 'early' ? Math.max(prev ? prev.s + 100 : 0, c.s - 250) : Math.min(c.e - 200, c.s + 250));
    if (prev && prev.e > c.s) prev.e = c.s;
    R.editing = undefined; commit(); return;
  }
  R.editing = undefined;
  commit();
}

/* ------------------------------------------------------------ choose lines for AI to hear again (Shift+click times) */
function selectTo(i) {
  if (!R.sel) R.sel = { a: i, b: i, anchor: i };
  else { R.sel.a = Math.min(R.sel.anchor, i); R.sel.b = Math.max(R.sel.anchor, i); }
  markSel(); updateStats();
}
function clearSel() { if (!R || !R.sel) return false; R.sel = null; markSel(); updateStats(); return true; }
function markSel() {
  document.querySelectorAll('#lr-lines .cue.sel').forEach((e) => e.classList.remove('sel'));
  if (!R || !R.sel) return;
  for (let k = R.sel.a; k <= R.sel.b; k++) { const el = document.querySelector(`#lr-lines .cue[data-i="${k}"]`); if (el) el.classList.add('sel'); }
}
function redoLines(a, b) {
  const cs = R.d.cues;
  if (!cs[a] || !cs[b]) return;
  R.redo = { s: cs[a].s, e: cs[b].e };
  for (let k = a; k <= b; k++) { const el = document.querySelector(`#lr-lines .cue[data-i="${k}"]`); if (el) el.classList.add('redoing'); }
  redoRange(R.src, cs[a].s, cs[b].e, cs[a - 1] ? cs[a - 1].t : '').then((ok) => { if (ok) toast(T`AI กำลังฟัง ${b - a + 1} บรรทัดนี้ใหม่…`); });
  R.sel = null; updateStats();
}
bus.on('asr-range', async (p) => {
  if (!R || p.key !== R.src.id) return;
  document.querySelectorAll('#lr-lines .cue.redoing').forEach((e) => e.classList.remove('redoing'));
  if (!p.ok) return toast(T`ฟังใหม่ไม่สำเร็จ`, { kind: 'err' });
  const add = (p.cues || []).filter((c) => c.s >= p.s - 600 && c.s < p.e + 300);
  if (!add.length) return toast(T`AI ไม่ได้ยินเสียงพูดในช่วงนี้ — ใช้บรรทัดเดิม`);
  pushUndo();
  const cs = R.d.cues;
  const first = cs.findIndex((c) => c.s >= p.s - 10);
  let last = first;
  while (last + 1 < cs.length && cs[last + 1].s < p.e - 10) last++;
  add.forEach((c) => { c.fix = 1; });
  if (first < 0) cs.push(...add); else cs.splice(first, last - first + 1, ...add);
  await commit();
  toast(T`ฟังใหม่แล้ว ได้ ${add.length} บรรทัด (Ctrl+Z = ย้อนกลับ)`);
});

function refreshWords() {
  // a word's status changed: repaint classes without rebuilding the list
  if (!R) return;
  document.querySelectorAll('#lr-lines .tok, #lr-cap .tok').forEach((el) => {
    const c = R.d.cues[+el.dataset.c], t = c && c._tok[+el.dataset.t];
    if (!t) return;
    el.className = 'tok ' + wordClass(t);
  });
  updateStats();
}
bus.on('words', refreshWords);
bus.on('cards', refreshWords);

function updateStats() {
  if (!R) return;
  const seen = new Set();
  let nNew = 0, nLearn = 0;
  for (const c of R.d.cues) for (const t of c._tok || []) {
    if (!t.w) continue;
    const k = t.lang + ':' + headOf(t);
    if (seen.has(k)) continue; seen.add(k);
    const cl = wordClass(t);
    if (cl === 'w-new') nNew++; else if (cl === 'w-learn') nLearn++;
  }
  const done = R.d.cues.filter((c) => c.th).length;
  $('lr-stats').innerHTML = `<span class="st-new" title="${T`คำที่ยังไม่รู้ในบทนี้`}"><i></i>${T`คำใหม่ ${nNew}`}</span><span class="st-learn"><i></i>${T`กำลังจำ ${nLearn}`}</span>`
    + (S.set.showTh && R.d.cues.length ? `<span class="st-tr" title="${T`แปลด้วย TranslateGemma ในเครื่อง`}">${done < R.d.cues.length ? `<b class="spin"></b>` : icon('check')}${T`แปลแล้ว ${done}/${R.d.cues.length}`}</span>` : '')
    + (JOBS.has(R.src.id) && R.d.cues.length ? `<span class="st-ai" title="${T`AI ในเครื่องกำลังทำซับ`}">${icon('sparkle')}<span>${esc(phaseText(JOBS.get(R.src.id)))}</span><button class="st-x" data-stx="1" title="${T`ยกเลิก`}">${icon('x')}</button></span>`
      : R.src.track === 'ai' && R.d.cues.length ? `<span class="st-ai done" title="${T`ซับนี้ AI ในเครื่องทำ — คำที่ขีดเส้นประคือคำที่ AI ไม่แน่ใจ แก้ได้ด้วยปุ่ม AI › แก้ซับ`}">${icon('sparkle')}<span>${T`ซับ AI`}</span></span>` : '')
    + (R.sel ? `<span class="st-sel">${T`เลือก ${R.sel.b - R.sel.a + 1} บรรทัด`}<button class="pill-btn small primary" data-sel="redo">${icon('sparkle')}<span>${T`ให้ AI ฟังใหม่`}</span></button><button class="pill-btn small" data-sel="x">${T`ยกเลิก`}</button></span>` : '');
  const stx = $('lr-stats').querySelector('[data-stx]'); if (stx) stx.onclick = () => cancelAi(R.src.id);
  $('lr-stats').querySelectorAll('[data-sel]').forEach((b) => { b.onclick = () => { if (b.dataset.sel === 'redo' && R.sel) redoLines(R.sel.a, R.sel.b); else clearSel(); }; });
}

/* ------------------------------------------------------------ current line */
function cueAt(ms) {
  const cs = R.d.cues;
  let lo = 0, hi = cs.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].s <= ms) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function setIdx(i, scroll = true) {
  if (!R || i === R.idx) return;
  R.idx = i;
  document.querySelectorAll('#lr-lines .cue.now').forEach((e) => e.classList.remove('now'));
  const el = document.querySelector(`#lr-lines .cue[data-i="${i}"]`);
  if (el) { el.classList.add('now'); if (scroll && !R.userScroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  renderCap();
  if (S.set.showTh) prioritise(i);
}
function renderCap() {
  const cap = $('lr-cap');
  if (!R || R.kind === 'web' || R.kind === 'text') { cap.innerHTML = ''; return; }
  const c = R.d.cues[R.idx];
  if (R.dict) return renderDictation();
  cap.style.setProperty('--cap-font', (S.set.subFont || 21) + 'px');
  cap.innerHTML = c ? `<div class="cap-t">${lineHtml(c, R.idx)}</div>${S.set.showTh ? `<div class="cap-th">${c.th ? esc(c.th) : ''}</div>` : ''}` : `<div class="cap-t muted">${R.d.cues.length ? T`กดเล่นคลิป หรือคลิกบรรทัดด้านขวา` : ''}</div>`;
}
let lastSave = 0;
function tick() {
  raf = requestAnimationFrame(tick);
  if (!R || !R.player || R.kind === 'web' || R.kind === 'text') return;
  const t = R.player.time();
  const c = R.d.cues[R.idx];
  // repeat this line / stop at the end of each line
  if (c && R.player.playing() && t >= c.e - 40) {
    if (R.loop) { R.player.seek(c.s); return; }
    if (R.stopAt === R.idx || (S.set.autoPause && !R.dict) || (R.dict && R.dict.playing)) { R.player.pause(); R.stopAt = null; if (R.dict) R.dict.playing = false; return; }
  }
  if (R.dict) return; // dictation moves line by line itself
  const i = cueAt(t + 120);
  if (i !== R.idx && i >= 0 && (!c || t > c.e - 40 || t < c.s - 200 || i > R.idx)) setIdx(i);
  // karaoke: words already spoken in auto captions
  if (c && c._kt && R.player.playing()) {
    const n = c._kt.filter((x) => x <= t).length;
    if (n !== R.kar) { R.kar = n; markKaraoke(n); }
  }
  if (performance.now() - lastSave > 10000) { lastSave = performance.now(); R.src.pos = Math.round(t); save(); }
}
function markKaraoke(n) {
  const cap = $('lr-cap').querySelector('.cap-t');
  if (!cap) return;
  const toks = [...cap.querySelectorAll('.tok')];
  toks.forEach((el, i) => el.classList.toggle('said', i < n));
}
export function playCue(i, { stop = true } = {}) {
  if (!R) return;
  const c = R.d.cues[i];
  if (!c) return;
  if (R.kind === 'web' || R.kind === 'text') { setIdx(i, false); return speak(c.t, R.src.lang); }
  if (!R.player) return;
  setIdx(i, true);
  R.player.seek(c.s);
  R.player.play();
  R.stopAt = stop ? i : null;
}
const step = (d) => { if (!R) return; const i = Math.max(0, Math.min(R.d.cues.length - 1, (R.idx < 0 ? 0 : R.idx) + d)); if (R.kind === 'web' || R.kind === 'text') { setIdx(i); speak(R.d.cues[i].t, R.src.lang); } else playCue(i, { stop: S.set.autoPause }); };
export function togglePlay() {
  if (!R) return;
  if (R.kind === 'web' || R.kind === 'text') return readAloud();
  if (!R.player) return;
  if (R.player.playing()) R.player.pause(); else { R.stopAt = null; R.player.play(); }
}
let reading = false;
async function readAloud() {
  // read the page aloud sentence by sentence with the offline voice
  if (reading) { reading = false; stopSpeak(); renderPlayBtn(); return; }
  reading = true; renderPlayBtn();
  for (let i = Math.max(0, R.idx); reading && R && i < R.d.cues.length; i++) {
    setIdx(i, true);
    setPlaying(true);
    const ok = await speakWait(R.d.cues[i].t, R.src.lang);
    if (!ok) break;
  }
  reading = false; setPlaying(false); renderPlayBtn();
}
function speakWait(text, lang) {
  return new Promise((res) => {
    api.invoke('tts:say', { text, sid: lang === 'zh' ? S.set.voiceZh : S.set.voiceEn, speed: S.set.speed || 1 }).then((r) => {
      if (!r || !r.ok || !reading) return res(false);
      const a = new Audio(r.url);
      a.onended = () => res(true); a.onerror = () => res(false);
      stopRead = () => { a.pause(); res(false); };
      a.play().catch(() => res(false));
    });
  });
}
let stopRead = () => {};

/* ------------------------------------------------------------ translations (background, current line first) */
let trRun = 0;
function queueTranslations() {
  const run = ++trRun;
  const src = R.src, d = R.d;
  const order = () => { const i = Math.max(0, R && R.d === d ? R.idx : 0); return d.cues.map((c, k) => k).filter((k) => !d.cues[k].th).sort((a, b) => (a >= i ? a - i : 1e6 + i - a) - (b >= i ? b - i : 1e6 + i - b)); };
  (async () => {
    let fails = 0;
    while (run === trRun && R && R.d === d) {
      const next = order()[0];
      if (next === undefined) break;
      const c = d.cues[next];
      const th = await translate(c.t, src.lang === 'zh' ? 'zh' : 'en');
      if (run !== trRun || !R || R.d !== d) return;
      if (th === null) { if (++fails > 2) { toast(T`ตัวแปลภาษาในเครื่องยังไม่พร้อม — ดูได้ที่หน้าแรก > สถานะ`, { kind: 'err' }); break; } await new Promise((r) => setTimeout(r, 1500)); continue; }
      c.th = th;
      const el = document.querySelector(`#lr-lines .cue[data-i="${next}"] .cue-th`);
      if (el) el.textContent = th;
      if (next === R.idx) renderCap();
      saveSrc(src.id, stripTok(d));
      updateStats();
    }
  })();
}
function prioritise() { /* order() reads R.idx each round, so the line being watched is always translated next */ }

/* ------------------------------------------------------------ dictation: listen and type */
function startDictation(on) {
  if (!R || R.kind === 'web' || R.kind === 'text') return;
  R.dict = on ? { i: Math.max(0, R.idx), state: 'type', playing: false } : null;
  $('lr').classList.toggle('dictating', !!on);
  if (on) { if (R.player && R.player.playing()) R.player.pause(); R.loop = false; setIdx(R.dict.i, true); dictPlay(); }
  renderCap(); renderCtrl();
}
function dictPlay() {
  const c = R.d.cues[R.dict.i];
  if (!c || !R.player) return;
  R.dict.playing = true;
  R.player.seek(c.s); R.player.play();
}
const normEn = (s) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
const normZh = (s) => [...s.replace(/[^㐀-鿿豈-﫿A-Za-z0-9]/g, '')];
function diff(a, b) {
  // LCS between expected (a) and typed (b) → marks for expected words
  const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ok = new Array(n).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { ok[i] = true; i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++; }
  return ok;
}
function renderDictation() {
  const cap = $('lr-cap'), d = R.dict, c = R.d.cues[d.i];
  if (!c) { cap.innerHTML = `<div class="cap-t">${T`จบแล้ว!`}</div>`; return; }
  const zh = R.src.lang === 'zh';
  let res = '';
  if (d.state === 'check') {
    const exp = zh ? normZh(c.t) : normEn(c.t), got = zh ? normZh(d.typed) : normEn(d.typed);
    const ok = diff(exp, got);
    const score = exp.length ? ok.filter(Boolean).length / exp.length : 1;
    res = `<div class="dict-res"><div class="dict-score ${score >= 0.9 ? 'good' : score >= 0.6 ? 'mid' : 'bad'}">${Math.round(score * 100)}%</div><div class="dict-exp">${exp.map((w, k) => `<span class="${ok[k] ? 'ok' : 'miss'}">${esc(w)}</span>`).join(zh ? '' : ' ')}</div><div class="cap-t">${lineHtml(c, d.i)}</div>${c.th ? `<div class="cap-th">${esc(c.th)}</div>` : ''}</div>`;
  }
  cap.innerHTML = `<div class="dict"><div class="dict-head"><b>${T`ฟังแล้วพิมพ์ตาม`}</b><span class="muted">${T`บรรทัด ${d.i + 1}/${R.d.cues.length}`}</span><span class="ed-fill"></span>
      <button class="pill-btn small" id="dict-replay" title="${T`ฟังอีกครั้ง (Tab)`}">${icon('replay')}<span>${T`ฟังซ้ำ`}</span><kbd>Tab</kbd></button>
      <button class="pill-btn small" id="dict-slow" title="${T`ฟังช้าๆ`}">${icon('clock')}<span>0.7×</span></button>
      <button class="pill-btn small" id="dict-hint" title="${T`ใบ้ตัวแรกของแต่ละคำ (Ctrl+H)`}">${icon('bulb')}<span>${T`ใบ้`}</span></button></div>
    <input id="dict-in" class="dict-in" type="text" spellcheck="false" autocomplete="off" placeholder="${T`พิมพ์สิ่งที่ได้ยิน แล้วกด Enter`}" value="${esc(d.typed || '')}" ${d.state === 'check' ? 'readonly' : ''}>
    ${d.hint ? `<div class="dict-hint">${esc(zh ? c.t.replace(/[㐀-鿿](?=[㐀-鿿])/g, (x, k) => (k % 3 ? '＿' : x)) : c.t.replace(/\b(\w)(\w*)/g, (m, a, b) => a + b.replace(/\w/g, '_')))}</div>` : ''}
    ${res}
    <div class="dict-foot muted">${d.state === 'check' ? T`Enter = บรรทัดถัดไป · Shift+Enter = ลองบรรทัดนี้ใหม่` : T`Enter = ตรวจ · Tab = ฟังซ้ำ · Ctrl+→ = ข้ามบรรทัด`}</div></div>`;
  const inp = $('dict-in');
  inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  inp.oninput = () => { d.typed = inp.value; };
  inp.onkeydown = (e) => {
    if (e.key === 'Tab') { e.preventDefault(); dictPlay(); }
    else if (e.key === 'Enter' && d.state === 'type') { e.preventDefault(); d.typed = inp.value; d.state = 'check'; bump('d'); if (R.player) R.player.pause(); renderDictation(); }
    else if (e.key === 'Enter' && d.state === 'check') { e.preventDefault(); if (e.shiftKey) { d.state = 'type'; d.typed = ''; d.hint = false; renderDictation(); dictPlay(); } else dictNext(1); }
    else if (e.key === 'ArrowRight' && e.ctrlKey) { e.preventDefault(); dictNext(1); }
    else if (e.key === 'ArrowLeft' && e.ctrlKey) { e.preventDefault(); dictNext(-1); }
    else if (e.key.toLowerCase() === 'h' && e.ctrlKey) { e.preventDefault(); d.hint = !d.hint; renderDictation(); }
    else if (e.key === 'Escape') { e.preventDefault(); startDictation(false); }
  };
  $('dict-replay').onclick = () => dictPlay();
  $('dict-slow').onclick = () => { if (!R.player) return; R.player.setRate(0.7); dictPlay(); setTimeout(() => R && R.player && R.player.setRate(S.set.rate || 1), Math.max(1000, (c.e - c.s) / 0.7 + 400)); };
  $('dict-hint').onclick = () => { d.hint = !d.hint; renderDictation(); };
}
function dictNext(k) {
  const d = R.dict;
  d.i = Math.max(0, Math.min(R.d.cues.length - 1, d.i + k));
  d.state = 'type'; d.typed = ''; d.hint = false;
  setIdx(d.i, true);
  renderDictation();
  dictPlay();
}

/* ------------------------------------------------------------ controls */
function renderPlayBtn() {
  const b = $('lr-play'); if (!b) return;
  const on = R && (R.kind === 'web' || R.kind === 'text' ? reading : R.player && R.player.playing());
  b.innerHTML = icon(on ? 'pause' : 'play');
}
function renderCtrl() {
  if (!R) return;
  const reading2 = R.kind === 'web' || R.kind === 'text';
  const tracks = (R.src.tracks || []);
  const rate = S.set.rate || 1;
  $('lr-ctrl').innerHTML = `
    <button class="icon-btn" data-c="prev" title="${T`บรรทัดก่อนหน้า (←)`}">${icon('kprev')}</button>
    <button class="lr-play" id="lr-play" data-c="play" title="${reading2 ? T`อ่านให้ฟังทีละประโยค (Space)` : T`เล่น / หยุด (Space)`}"></button>
    <button class="icon-btn" data-c="next" title="${T`บรรทัดถัดไป (→)`}">${icon('knext')}</button>
    <i class="ctl-sep"></i>
    ${reading2 ? '' : `<button class="ctl-tog ${R.loop ? 'on' : ''}" data-c="loop" title="${T`เล่นบรรทัดนี้วนซ้ำ (R)`}">${icon('replay')}<span>${T`วนบรรทัด`}</span></button>
    <button class="ctl-tog ${S.set.autoPause ? 'on' : ''}" data-c="autopause" title="${T`หยุดทุกครั้งที่จบบรรทัด (A)`}">${icon('pause')}<span>${T`หยุดทีละบรรทัด`}</span></button>
    <button class="ctl-tog ${R.dict ? 'on' : ''}" data-c="dict" title="${T`ฝึกฟัง: ซ่อนซับ ฟังแล้วพิมพ์ตาม (D)`}">${icon('type')}<span>${T`ฟังแล้วพิมพ์`}</span></button>
    <label class="ctl-sel" title="${T`ความเร็ว`}">${icon('clock')}<select id="lr-rate">${[0.5, 0.65, 0.75, 0.85, 1, 1.25, 1.5].map((r) => `<option value="${r}" ${r === rate ? 'selected' : ''}>${r}×</option>`).join('')}</select></label>`}
    <span class="ed-fill"></span>
    <button class="ctl-tog ${S.set.showTh ? 'on' : ''}" data-c="th" title="${T`แสดงคำแปลไทยใต้บรรทัด (T)`}"><b class="ctl-th">ไทย</b></button>
    ${R.src.lang === 'zh' ? `<button class="ctl-tog ${S.set.pinyin ? 'on' : ''}" data-c="pinyin" title="${T`แสดงพินอินบนตัวจีน`}"><b class="ctl-th">pīn</b></button>` : ''}
    <button class="icon-btn" data-c="font-" title="${T`ตัวอักษรเล็กลง (-)`}">${icon('minus')}</button>
    <button class="icon-btn" data-c="font+" title="${T`ตัวอักษรใหญ่ขึ้น (+)`}">${icon('plus')}</button>
    ${trackSel(tracks)}
    ${reading2 ? '' : `<button class="ctl-tog ai-btn ${JOBS.has(R.src.id) ? 'busy' : ''} ${R.edit ? 'on' : ''}" data-c="ai" title="${T`ซับด้วย AI · แก้ซับ · ส่งออก · ซับสด`}">${icon('sparkle')}<span>${R.edit ? T`กำลังแก้ซับ` : 'AI'}</span></button>`}
    ${R.src.kind === 'file' ? `<button class="icon-btn" data-c="subfile" title="${T`เปิดไฟล์ซับ`}">${icon('doc')}</button>` : ''}
    ${R.src.kind === 'yt' || (R.src.kind === 'site' && !R.src.video) ? offlineBtn() : ''}
    ${R.src.url ? `<button class="icon-btn" data-c="web" title="${T`เปิดในเบราว์เซอร์`}">${icon('open')}</button>` : ''}`;
  renderPlayBtn();
  $('lr-ctrl').querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => ctl(b.dataset.c); });
  const rs = $('lr-rate'); if (rs) rs.onchange = () => { S.set.rate = +rs.value; if (R.player) R.player.setRate(S.set.rate); save(); };
  const ts = $('lr-track'); if (ts) ts.onchange = async () => {
    if (ts.value === 'ai') return useAi({});
    if (ts.value === 'orig') { const a = R.d.alt; if (!a) return; R.d.cues = a.cues; R.src.track = a.track; R.src.subName = a.name || R.src.subName; delete R.d.alt; await commit(); renderCtrl(); $('lr-sub').innerHTML = subLine(R.src); return; }
    const [code, auto] = ts.value.split('|'); const t = R.src.tracks.find((x) => x.code === code && !!x.auto === (auto === '1'));
    busy(T`กำลังดึงซับ ${t.name}…`);
    const cues = await fetchCues(R.src.vid, t);
    busy('');
    if (!cues) return;
    R.src.track = code; R.src.lang = t.lang; R.d.cues = cues; saveSrc(R.src.id, R.d, true); save(); openSource(R.src.id);
  };
}
function trackSel(tracks) {
  const src = R.src, o = [];
  for (const t of tracks) o.push(`<option value="${esc(t.code)}|${t.auto ? 1 : 0}" ${t.code === src.track ? 'selected' : ''}>${esc(t.name)}${t.auto ? ' ' + T`(อัตโนมัติ)` : ''}</option>`);
  if (src.kind !== 'yt' && (src.track !== 'ai' ? R.d.cues.length : R.d.alt)) o.push(`<option value="orig" ${src.track !== 'ai' ? 'selected' : ''}>${esc((src.track !== 'ai' ? src.subName : R.d.alt && R.d.alt.name) || T`ซับเดิม`)}</option>`);
  if (canAi(src) && (o.length || src.track === 'ai')) o.push(`<option value="ai" ${src.track === 'ai' ? 'selected' : ''}>✨ ${T`AI ในเครื่อง`}</option>`);
  return o.length > 1 ? `<label class="ctl-sel" title="${T`ซับที่ใช้`}">${icon('doc')}<select id="lr-track">${o.join('')}</select></label>` : '';
}
function aiMenu(btn) {
  const src = R.src, r = btn.getBoundingClientRect(), running = JOBS.has(src.id), cues = R.d.cues;
  const items = [];
  if (running) items.push({ icon: 'x', label: T`ยกเลิกการทำซับ`, run: () => cancelAi(src.id) });
  else if (canAi(src)) {
    if (src.track !== 'ai') items.push({ icon: 'sparkle', label: T`ใช้ซับจาก AI ในเครื่อง`, run: () => useAi({}) });
    else if (src.aiPartial) items.push({ icon: 'play', label: T`ทำซับต่อจากที่ค้างไว้`, run: () => useAi({}) });
    items.push({ icon: 'refresh', label: src.track === 'ai' && cues.length ? T`ทำซับ AI ใหม่ทั้งหมด…` : T`ทำซับด้วย AI (เลือกโหมด / ภาษา)…`, run: () => aiAct('new') });
  }
  if (cues.length) {
    items.push('-');
    items.push({ icon: 'edit', label: R.edit ? T`ออกจากโหมดแก้ซับ (E)` : T`แก้ซับ (E)`, run: () => toggleEdit() });
    if (canAi(src) && !running) items.push({ icon: 'replay', label: T`ให้ AI ฟังบรรทัดนี้ใหม่`, run: () => redoLines(Math.max(0, R.idx), Math.max(0, R.idx)) });
    if (canAi(src) && !running) items.push({ icon: 'cursor', label: T`เลือกหลายบรรทัด: Shift+คลิกที่เวลา`, run: () => toast(T`กด Shift ค้างแล้วคลิกเวลาของบรรทัดแรกและบรรทัดสุดท้าย แล้วกด "ให้ AI ฟังใหม่"`) });
    if (R.undo.length) items.push({ icon: 'undo', label: T`ย้อนการแก้ (Ctrl+Z)`, run: undoEdit });
    items.push('-');
    const lt = src.lang === 'zh' ? T`จีน` : T`อังกฤษ`;
    items.push({ icon: 'download', label: T`ส่งออกซับ .srt`, run: () => exportSubs(src, stripTok(R.d).cues, 'srt', false) });
    items.push({ icon: 'download', label: T`ส่งออก .srt (${lt} + ไทย)`, run: () => exportSubs(src, stripTok(R.d).cues, 'srt', true) });
    items.push({ icon: 'download', label: T`ส่งออก .vtt`, run: () => exportSubs(src, stripTok(R.d).cues, 'vtt', false) });
    items.push({ icon: 'doc', label: T`ส่งออกเป็นข้อความ .txt`, run: () => exportSubs(src, stripTok(R.d).cues, 'txt', !!S.set.showTh) });
  }
  items.push('-');
  items.push({ icon: 'ear', label: T`ซับสดจากเสียงในคอม (Ctrl+Shift+L)`, run: openLive });
  ctxMenu(r.left, r.top - 8 - Math.min(460, items.length * 34), items, T`ซับด้วย AI`);
}
function offlineBtn() {
  const s = R.src;
  if (s.kind === 'site') return dl.has(s.id) ? `<span class="ctl-dl" title="${T`กำลังโหลดวิดีโอ — กดเพื่อยกเลิก`}" data-c="dlcancel"><i style="width:${Math.round((dl.get(s.id) || 0) * 100)}%"></i><span>${Math.round((dl.get(s.id) || 0) * 100)}%</span></span>` : `<button class="icon-btn" data-c="sitedl" title="${T`โหลดวิดีโอ`}">${icon('download')}</button>`;
  if (dl.has(s.vid)) return `<span class="ctl-dl" title="${T`กำลังโหลดเก็บไว้ดูออฟไลน์ — กดเพื่อยกเลิก`}" data-c="dlcancel"><i style="width:${Math.round((dl.get(s.vid) || 0) * 100)}%"></i><span>${Math.round((dl.get(s.vid) || 0) * 100)}%</span></span>`;
  if (s.video) return `<button class="ctl-tog ${s.useLocal !== false ? 'on' : ''}" data-c="uselocal" title="${T`มีไฟล์ในเครื่องแล้ว — กดเพื่อสลับดูจากไฟล์ / จาก YouTube`}">${icon('download')}<span>${T`ออฟไลน์`}</span></button>`;
  return `<button class="icon-btn" data-c="download" title="${T`โหลดคลิปเก็บไว้ดูออฟไลน์ (ไปที่ Videos\\Prism LLearn)`}">${icon('download')}</button>`;
}
const dl = new Map();
api.on('yt:progress', (p) => {
  if (!p.done) { const b = document.getElementById('dl-bar'); if (b && R && R.src.id === p.id) b.style.width = Math.round((p.f || 0) * 100) + '%'; }
  if (p.done) {
    dl.delete(p.id);
    const s = S.sources.find((x) => x.vid === p.id || x.id === p.id);
    if (p.ok && s) { s.video = p.path; s.useLocal = true; save(); toast(T`โหลดคลิปเก็บไว้แล้ว — ดูได้แม้ไม่มีเน็ต`); if (R && R.src === s) { R.src.pos = Math.round(R.player ? R.player.time() : 0); makePlayer(); } }
    else if (!p.ok && s) toast(T`โหลดคลิปไม่สำเร็จ`, { kind: 'err' });
  } else dl.set(p.id, p.f);
  if (R && (R.src.vid === p.id || R.src.id === p.id)) { renderCtrl(); if (p.done && R.src.kind === 'site' && !R.src.video) makePlayer(); }
});
async function ctl(c) {
  if (!R) return;
  if (c === 'play') togglePlay();
  else if (c === 'prev') step(-1);
  else if (c === 'next') step(1);
  else if (c === 'loop') { R.loop = !R.loop; if (R.loop && R.idx >= 0 && R.player && !R.player.playing()) playCue(R.idx, { stop: false }); renderCtrl(); }
  else if (c === 'autopause') { S.set.autoPause = !S.set.autoPause; save(); renderCtrl(); }
  else if (c === 'dict') startDictation(!R.dict);
  else if (c === 'th') { S.set.showTh = !S.set.showTh; save(); $('lr-lines').classList.toggle('no-th', !S.set.showTh); renderCap(); renderCtrl(); if (S.set.showTh) queueTranslations(); updateStats(); }
  else if (c === 'pinyin') { S.set.pinyin = !S.set.pinyin; save(); renderList(); renderCap(); renderCtrl(); setIdxForce(); }
  else if (c === 'font+' || c === 'font-') { S.set.subFont = Math.max(14, Math.min(40, (S.set.subFont || 21) + (c === 'font+' ? 2 : -2))); save(); renderCap(); $('lr-lines').style.setProperty('--sub-font', S.set.subFont - 4 + 'px'); }
  else if (c === 'web') api.invoke('open:url', R.src.url);
  else if (c === 'subfile') { const p = await api.invoke('pick:open', 'sub'); if (p) loadSubFile(p); }
  else if (c === 'download') { dl.set(R.src.vid, 0); renderCtrl(); const r = await api.invoke('yt:download', { id: R.src.vid, title: R.src.title }); if (!r || !r.ok) { dl.delete(R.src.vid); renderCtrl(); toast(T`เริ่มโหลดไม่ได้`, { kind: 'err' }); } }
  else if (c === 'dlcancel') { const k = R.src.vid || R.src.id; if (await confirmBox(T`ยกเลิกการโหลด?`, T`ไฟล์ที่โหลดมาครึ่งทางจะถูกลบ`, T`ยกเลิกการโหลด`)) { await api.invoke('yt:cancel', k); dl.delete(k); renderCtrl(); if (R.src.kind === 'site') makePlayer(); } }
  else if (c === 'sitedl') siteDownload(R.src);
  else if (c === 'ai') aiMenu($('lr-ctrl').querySelector('[data-c="ai"]'));
  else if (c === 'uselocal') { R.src.pos = Math.round(R.player ? R.player.time() : 0); R.src.useLocal = R.src.useLocal === false; save(); makePlayer(); renderCtrl(); }
}
function setIdxForce() { const i = R.idx; R.idx = -1; setIdx(i, false); }

/* ------------------------------------------------------------ clicks on words / lines */
function wireList() {
  const list = $('lr-lines');
  list.addEventListener('click', (e) => {
    const ab = e.target.closest('[data-ai]');
    if (ab) return aiAct(ab.dataset.ai);
    if (e.target.closest('.cue-ed, .cue-edbar')) return;
    if (R && R.edit && R.kind !== 'web' && R.kind !== 'text') { const cue = e.target.closest('.cue'); if (cue && e.target.closest('.cue-body')) return startEdit(+cue.dataset.i); }
    const tok = e.target.closest('.tok');
    if (tok && !getSelection().toString().trim()) return clickTok(tok);
    const b = e.target.closest('[data-seek],[data-say],[data-known]');
    if (b && b.dataset.seek !== undefined) { if (e.shiftKey && canAi(R.src) && !JOBS.has(R.src.id)) { getSelection().removeAllRanges(); return selectTo(+b.dataset.seek); } clearSel(); return playCue(+b.dataset.seek, { stop: S.set.autoPause }); }
    if (b && b.dataset.say !== undefined) { setIdx(+b.dataset.say, false); return speak(R.d.cues[+b.dataset.say].t, R.src.lang); }
    if (b && b.dataset.known !== undefined) return knowLine(+b.dataset.known);
    const cue = e.target.closest('.cue');
    if (cue && !e.target.closest('.cue-th') && R.kind !== 'web' && R.kind !== 'text') playCue(+cue.dataset.i, { stop: S.set.autoPause });
  });
  list.addEventListener('scroll', () => { R && (R.userScroll = true); clearTimeout(list._t); list._t = setTimeout(() => { if (R) R.userScroll = false; }, 2500); }, { passive: true });
  $('lr-cap').addEventListener('click', (e) => { const tok = e.target.closest('.tok'); if (tok && !getSelection().toString().trim()) clickTok(tok); });
  // select several words with the mouse → look up the phrase ("run into", "加油站")
  for (const box of [list, $('lr-cap')]) box.addEventListener('mouseup', () => setTimeout(() => {
    const sel = getSelection(), txt = sel.toString().replace(/\s+/g, ' ').trim();
    if (!txt || txt.length > 60 || !sel.rangeCount) return;
    const a = sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest('.cue, .cap-t');
    const cueEl = a && a.closest('.cue');
    const ci = cueEl ? +cueEl.dataset.i : R.idx;
    const c = R.d.cues[ci]; if (!c) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    openPop(txt, ci, rect, guessLang(txt));
    sel.removeAllRanges();
  }, 0));
}
function clickTok(el) {
  const ci = +el.dataset.c, c = R.d.cues[ci], t = c && c._tok[+el.dataset.t];
  if (!t) return;
  if (R.player && R.player.playing() && R.kind !== 'web') R.player.pause();
  if (reading) { reading = false; stopRead(); stopSpeak(); renderPlayBtn(); }
  openPop(t.t, ci, el, t.lang, headOf(t));
}
function openPop(text, ci, anchor, lang, head) {
  const c = R.d.cues[ci];
  const src = R.src;
  openWord({ lang, surface: text, head, sentence: c.t, sentTh: c.th || null, anchor,
    src: { id: src.id, kind: src.kind, t0: c.s, t1: c.e, title: src.title, vid: src.vid || null },
    onPlay: () => playCue(ci) });
}
function knowLine(i) {
  const c = R.d.cues[i];
  for (const t of c._tok) if (t.w && wordClass(t) === 'w-new') setWord(t.lang, headOf(t), 2);
  toast(T`ทำเครื่องหมายว่ารู้ทุกคำในบรรทัดนี้แล้ว`);
}

/* ------------------------------------------------------------ keys (lesson page) */
export function lessonKey(e) {
  if (R && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z' && !e.target.closest('input, textarea, select') && R.undo.length) { e.preventDefault(); undoEdit(); return true; }
  if (R && e.key === 'Escape' && !e.target.closest('input, textarea, select') && (clearSel() || (R.edit && (toggleEdit(false), true)))) { e.preventDefault(); return true; }
  if (!R || e.target.closest('input, textarea, select') || e.ctrlKey || e.altKey || e.metaKey) return false;
  const k = e.key;
  const run = (f) => { e.preventDefault(); f(); return true; };
  if (k === ' ') return run(togglePlay);
  if (k === 'ArrowLeft') return run(() => step(-1));
  if (k === 'ArrowRight') return run(() => step(1));
  const l = k.toLowerCase();
  if (l === 'r') return run(() => ctl('loop'));
  if (l === 'a') return run(() => ctl('autopause'));
  if (l === 'd') return run(() => ctl('dict'));
  if (l === 't') return run(() => ctl('th'));
  if (l === 'e' && R.kind !== 'web' && R.kind !== 'text' && R.d.cues.length) return run(() => toggleEdit());
  if (k === '+' || k === '=') return run(() => ctl('font+'));
  if (k === '-') return run(() => ctl('font-'));
  if (k === 'Enter' && R.idx >= 0) return run(() => playCue(R.idx));
  return false;
}

export function initReader({ onOpen }) {
  wireList();
  setOpenKey(() => (R ? R.src.id : null));
  $('lr-close').onclick = () => { closeLesson(); onOpen && onOpen(null); };
  bus.on('wordpop', (o) => { document.querySelectorAll('.tok.picked').forEach((x) => x.classList.remove('picked')); if (o && o.anchor && o.anchor.classList) o.anchor.classList.add('picked'); });
}
export function pauseIfPlaying() { if (R && R.player && R.player.playing()) R.player.pause(); }
export { uid };
