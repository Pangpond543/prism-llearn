// Review (ทบทวน): cards that are due, then new ones (limit per day). Front: the word + its sentence; Space shows the
// meaning; 1–4 grades it (FSRS). A card made from a video can play the exact moment it came from.
import { api, native, T, esc, $, toast, bus } from './core.js';
import { icon } from './icons.js';
import { S, save, bump, dayKey, setWord } from './store.js';
import { grade, preview, isDue } from './srs.js';
import { speak, stopSpeak } from './words.js';
import { YTPlayer, VideoPlayer } from './players.js';

let Q = null; // { list, i, shown, done, right, startN }
let clip = null, clipT = 0;

export function counts(lang = S.ui.revLang || 'all') {
  const now = Date.now();
  const mine = S.cards.filter((c) => (lang === 'all' || c.lang === lang) && !c.known);
  const due = mine.filter((c) => c.srs.st !== 0 && isDue(c, now)).length;
  const newLeft = Math.max(0, (S.set.newPerDay || 30) - ((S.act[dayKey()] || {}).nr || 0));
  const fresh = Math.min(newLeft, mine.filter((c) => c.srs.st === 0).length);
  const soon = mine.filter((c) => c.srs.st !== 0 && !isDue(c, now)).map((c) => c.srs.due).sort((a, b) => a - b)[0] || 0;
  return { due, fresh, total: mine.length, soon };
}

export function renderReviewHome() {
  if (Q) return;
  const box = $('rv');
  const lang = S.ui.revLang || 'all';
  const c = counts(lang);
  const soon = c.soon ? new Date(c.soon) : null;
  box.innerHTML = `
    <div class="rv-home glass card">
      <div class="rv-big">${icon('cards')}</div>
      <h2>${c.due + c.fresh ? T`วันนี้มีบัตรคำให้ทวน ${c.due + c.fresh} ใบ` : S.cards.length ? T`ทวนครบแล้ววันนี้ เก่งมาก!` : T`ยังไม่มีบัตรคำ`}</h2>
      <p class="muted">${c.due + c.fresh ? T`ถึงรอบทวน ${c.due} · คำใหม่ ${c.fresh}` : S.cards.length ? (soon ? T`ใบถัดไปถึงรอบ ${soon.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '') : T`เปิดคลิปหรือบทความในหน้า "เรียน" แล้วคลิกคำที่ไม่รู้ กด "เก็บเป็นบัตรคำ"`}</p>
      <div class="seg rv-lang">${['all', 'en', 'zh'].map((l) => `<button data-l="${l}" class="${lang === l ? 'on' : ''}">${{ all: T`ทุกภาษา`, en: T`อังกฤษ`, zh: T`จีน` }[l]}</button>`).join('')}</div>
      <button class="pill-btn primary big" id="rv-start" ${c.due + c.fresh ? '' : 'disabled'}>${icon('play')}<span>${T`เริ่มทวน`}</span><kbd>Enter</kbd></button>
      ${c.total && !(c.due + c.fresh) ? `<button class="pill-btn" id="rv-extra">${icon('refresh')}<span>${T`ทวนเพิ่ม (ใบที่ใกล้ถึงรอบ)`}</span></button>` : ''}
      <div class="rv-tip muted">${T`ระบบจะเว้นระยะให้เอง: คำที่จำได้ดีจะห่างขึ้นเรื่อยๆ คำที่ลืมจะกลับมาเร็ว`}</div>
    </div>`;
  box.querySelectorAll('[data-l]').forEach((b) => { b.onclick = () => { S.ui.revLang = b.dataset.l; save(); renderReviewHome(); }; });
  if ($('rv-start')) $('rv-start').onclick = () => start();
  if ($('rv-extra')) $('rv-extra').onclick = () => start(true);
}

export function start(extra = false) {
  const lang = S.ui.revLang || 'all', now = Date.now();
  const mine = S.cards.filter((c) => (lang === 'all' || c.lang === lang) && !c.known);
  let list;
  if (extra) list = mine.filter((c) => c.srs.st !== 0).sort((a, b) => a.srs.due - b.srs.due).slice(0, 20);
  else {
    const learning = mine.filter((c) => (c.srs.st === 1 || c.srs.st === 3) && isDue(c, now));
    const reviews = mine.filter((c) => c.srs.st === 2 && isDue(c, now)).sort((a, b) => a.srs.due - b.srs.due);
    const newLeft = Math.max(0, (S.set.newPerDay || 30) - ((S.act[dayKey()] || {}).nr || 0));
    const fresh = mine.filter((c) => c.srs.st === 0).sort((a, b) => a.c - b.c).slice(0, newLeft);
    list = [...learning, ...mix(reviews, fresh)];
  }
  if (!list.length) return renderReviewHome();
  Q = { list, i: 0, shown: false, done: 0, right: 0, startN: list.length };
  show();
}
const mix = (a, b) => { const out = []; let i = 0, j = 0; while (i < a.length || j < b.length) { if (i < a.length) out.push(a[i++]); if (i < a.length) out.push(a[i++]); if (j < b.length) out.push(b[j++]); } return out; };

function show() {
  stopClip();
  const box = $('rv');
  const c = Q.list[Q.i];
  if (!c) return finish();
  const left = Q.list.length - Q.i;
  const zh = c.lang === 'zh';
  const ex = c.ex ? hl(c.ex, c.show || c.head) : '';
  const canClip = c.src && (c.src.kind === 'yt' || c.src.kind === 'file') && c.src.t0 !== undefined;
  box.innerHTML = `
    <div class="rv-top"><div class="rv-bar"><i style="width:${(Q.i / Q.list.length) * 100}%"></i></div><span class="muted">${T`เหลือ ${left}`}</span>
      <button class="icon-btn" id="rv-quit" title="${T`พักไว้ก่อน (Esc)`}">${icon('x')}</button></div>
    <div class="rv-card glass card ${Q.shown ? 'flip' : ''}">
      <div class="rv-kind">${c.srs.st === 0 ? `<span class="badge hot">${T`คำใหม่`}</span>` : c.srs.st === 2 ? `<span class="badge ok">${T`ทบทวน`}</span>` : `<span class="badge">${T`กำลังจำ`}</span>`}<span class="lang-chip ${c.lang}">${zh ? T`จีน` : T`อังกฤษ`}</span></div>
      <div class="rv-word ${zh ? 'zh' : ''}">${esc(c.show || c.head)}</div>
      ${zh && Q.shown || !zh && Q.shown ? `<div class="rv-read">${esc(c.read || '')}${c.head !== (c.show || '').toLowerCase() && !zh ? ` · ${esc(c.head)}` : ''}</div>` : ''}
      <div class="rv-tools">
        <button class="pill-btn small" id="rv-say" title="${T`ฟังเสียง (V)`}">${icon('speaker')}<span>${T`ฟัง`}</span></button>
        ${canClip ? `<button class="pill-btn small" id="rv-clip" title="${T`ฟังจากคลิปที่เจอคำนี้ (P)`}">${icon('play')}<span>${T`ฟังจากคลิป`}</span></button>` : ''}
        ${c.ex ? `<button class="pill-btn small" id="rv-saysent" title="${T`อ่านประโยคให้ฟัง`}">${icon('wave')}<span>${T`ฟังประโยค`}</span></button>` : ''}
      </div>
      <div class="rv-clip hidden" id="rv-clipbox"></div>
      ${ex ? `<div class="rv-ex">${ex}</div>` : ''}
      ${Q.shown ? `<div class="rv-back">
        <div class="rv-mean" id="rv-mean" contenteditable="true" spellcheck="false" title="${T`แก้ความหมายได้ — คลิกแล้วพิมพ์`}">${esc(c.mean || '')}</div>
        ${c.en ? `<div class="rv-en muted">${esc(c.en)}</div>` : ''}
        ${c.exTh ? `<div class="rv-exth">${esc(c.exTh)}</div>` : ''}
        ${c.src && c.src.title ? `<button class="rv-src" id="rv-src">${icon(c.src.kind === 'yt' ? 'play' : c.src.kind === 'web' ? 'globe' : 'file')}<span>${esc(c.src.title)}</span></button>` : ''}
      </div>` : ''}
    </div>
    <div class="rv-grade">${Q.shown
      ? [1, 2, 3, 4].map((g) => `<button class="rv-g g${g}" data-g="${g}"><b>${[T`ลืม`, T`ยาก`, T`จำได้`, T`ง่ายมาก`][g - 1]}</b><small>${preview(c.srs, g, T)}</small><kbd>${g}</kbd></button>`).join('')
      : `<button class="pill-btn primary big" id="rv-show">${T`ดูความหมาย`}<kbd>Space</kbd></button>`}</div>`;
  $('rv-quit').onclick = () => { Q = null; stopClip(); renderReviewHome(); bus.emit('review-end'); };
  $('rv-say').onclick = () => speak(c.show || c.head, c.lang);
  if ($('rv-clip')) $('rv-clip').onclick = () => playClip(c);
  if ($('rv-saysent')) $('rv-saysent').onclick = () => speak(c.ex, c.lang);
  if ($('rv-show')) $('rv-show').onclick = flip;
  if ($('rv-src')) $('rv-src').onclick = () => bus.emit('goto-source', c.src);
  box.querySelectorAll('[data-g]').forEach((b) => { b.onclick = () => rate(+b.dataset.g); });
  const m = $('rv-mean');
  if (m) { m.onblur = () => { const v = m.textContent.trim(); if (v !== c.mean) { c.mean = v; save(); } }; m.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); m.blur(); } e.stopPropagation(); }; }
  if (!Q.shown && S.set.revSay !== false) speak(c.show || c.head, c.lang);
}
function hl(s, w) {
  const i = s.toLowerCase().indexOf(String(w).toLowerCase());
  return i < 0 ? esc(s) : esc(s.slice(0, i)) + `<mark>${esc(s.slice(i, i + w.length))}</mark>` + esc(s.slice(i + w.length));
}
function flip() { if (!Q || Q.shown) return; Q.shown = true; show(); }
function rate(g) {
  const c = Q.list[Q.i];
  if (!c) return;
  const wasNew = c.srs.st === 0;
  c.srs = grade(c.srs, g);
  bump('r');
  if (wasNew) bump('nr');
  if (g > 1) Q.right++;
  Q.done++;
  // still learning (due within the session) → see it again later in this round
  if (c.srs.due - Date.now() < 20 * 60e3) Q.list.splice(Math.min(Q.list.length, Q.i + 1 + Math.max(3, Math.floor((Q.list.length - Q.i) / 2))), 0, c);
  if (c.srs.st === 2 && c.srs.ivl >= 120) setWord(c.lang, c.head, 2); // well known now → stop highlighting it
  save();
  Q.i++; Q.shown = false;
  show();
}
function finish() {
  const box = $('rv');
  const acc = Q.done ? Math.round((Q.right / Q.done) * 100) : 0;
  box.innerHTML = `<div class="rv-home glass card"><div class="rv-big done">${icon('check')}</div><h2>${T`ทวนเสร็จแล้ว!`}</h2>
    <p>${T`ทวนไป ${Q.done} ครั้ง · จำได้ ${acc}%`}</p><button class="pill-btn primary" id="rv-back">${T`กลับ`}</button></div>`;
  Q = null;
  $('rv-back').onclick = () => renderReviewHome();
  bus.emit('review-end');
}

/* a short clip from the lesson the word came from */
async function playClip(c) {
  const box = $('rv-clipbox');
  if (!box) return;
  stopClip();
  box.classList.remove('hidden');
  const s = S.sources.find((x) => x.id === c.src.id);
  const t0 = Math.max(0, (c.src.t0 || 0) - 300), t1 = (c.src.t1 || t0 + 4000) + 300;
  const stopAtEnd = () => { clearInterval(clipT); clipT = setInterval(() => { if (clip && clip.time() >= t1) { clip.pause(); clearInterval(clipT); } }, 60); };
  if (s && s.video && s.useLocal !== false || c.src.kind === 'file') {
    const u = native && s && s.video ? await api.invoke('media:url', s.video) : null;
    if (!u || !u.ok) { box.innerHTML = `<span class="muted">${T`ไม่พบไฟล์วิดีโอ`}</span>`; return; }
    clip = new VideoPlayer(box, u.url, { start: t0 });
    clip.v.addEventListener('loadedmetadata', () => { clip.seek(t0); clip.play(); stopAtEnd(); }, { once: true });
  } else if (c.src.vid) {
    clip = new YTPlayer(box, c.src.vid, { start: t0, onState: (st) => { if (st === 5 || st === -1) { clip.seek(t0); clip.play(); } } });
    // the embed starts paused; play once it is ready
    let n = 0; const go = () => { if (!clip) return; if (clip.ready) { clip.seek(t0); clip.play(); stopAtEnd(); } else if (n++ < 40) setTimeout(go, 200); }; go();
  }
}
function stopClip() { clearInterval(clipT); if (clip) { clip.destroy(); clip = null; } const b = $('rv-clipbox'); if (b) b.classList.add('hidden'); stopSpeak(); }

export function reviewKey(e) {
  if (!Q || e.ctrlKey || e.altKey || e.target.closest('input, textarea, [contenteditable=true]')) {
    if (!Q && e.key === 'Enter' && $('rv-start') && !$('rv-start').disabled && !e.target.closest('input, textarea')) { e.preventDefault(); start(); return true; }
    return false;
  }
  const c = Q.list[Q.i];
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!Q.shown) flip(); else if (e.key === 'Enter') rate(3); return true; }
  if (Q.shown && /^[1-4]$/.test(e.key)) { e.preventDefault(); rate(+e.key); return true; }
  if (e.key.toLowerCase() === 'v' && c) { e.preventDefault(); speak(c.show || c.head, c.lang); return true; }
  if (e.key.toLowerCase() === 'p' && c) { e.preventDefault(); playClip(c); return true; }
  if (e.key === 'Escape') { e.preventDefault(); $('rv-quit').click(); return true; }
  return false;
}
export const inSession = () => !!Q;
export function leaveReview() { stopClip(); }
