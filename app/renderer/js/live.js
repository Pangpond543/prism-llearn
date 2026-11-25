// The live-subtitle window (always on top): what the PC plays → English / Chinese lines (Rust live.rs, whisper),
// Thai under each line (the offline translator), click a word → a small card (dictionary meaning, voice, keep as card).
// Cards are kept by the main window (it owns the learner's data): we only send it a message (live:tell).
import { api, native, T, esc, $, setTheme, savedTheme, setLook, savedLook, recall, remember } from './core.js';
import { icon, hydrateIcons } from './icons.js';
import { translateDom } from './i18n.js';
import { tokenize, zhReady, HAN } from './text.js';

const opt = { lang: recall('lv.lang', 'auto'), th: recall('lv.th', '1') === '1', font: +recall('lv.font', '24'), op: +recall('lv.op', '0.72') };
const lines = []; // {t, lang, th, toks}
let partial = '', paused = false;

function apply() {
  document.documentElement.style.setProperty('--lv-font', opt.font + 'px');
  document.documentElement.style.setProperty('--lv-a', String(opt.op));
  $('lv-th').classList.toggle('on', opt.th);
  document.querySelectorAll('#lv-lang button').forEach((b) => b.classList.toggle('on', b.dataset.v === opt.lang));
  $('lv-pause').innerHTML = icon(paused ? 'play' : 'pause');
}
function save() { remember('lv.lang', opt.lang); remember('lv.th', opt.th ? '1' : '0'); remember('lv.font', String(opt.font)); remember('lv.op', String(opt.op)); }

function lineHtml(l, li) {
  return `<div class="lv-line"><div class="lv-t">${l.toks.map((t, ti) => (t.w ? `<span class="tok lv-w${l.low && l.low.has(t.t) ? ' unsure' : ''}" data-l="${li}" data-t="${ti}">${esc(t.t)}</span>` : esc(t.t))).join('')}</div>${opt.th ? `<div class="lv-th">${l.th ? esc(l.th) : l.th === null ? '' : '<span class="spin"></span>'}</div>` : ''}</div>`;
}
function render() {
  const box = $('lv-lines');
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (!lines.length && !partial) { box.innerHTML = `<div class="lv-hint">${T`เปิดวิดีโอ เพลง หรือไลฟ์อะไรก็ได้ในคอม — ซับภาษาอังกฤษ / จีนจะขึ้นที่นี่ คลิกคำเพื่อดูความหมาย`}</div>`; return; }
  box.innerHTML = lines.slice(-30).map((l) => lineHtml(l, lines.indexOf(l))).join('') + (partial ? `<div class="lv-line partial"><div class="lv-t">${esc(partial)}</div></div>` : '');
  if (atEnd || !box.dataset.user) box.scrollTop = box.scrollHeight;
}
async function addLine(p) {
  if (p.lang === 'zh' || HAN.test(p.text)) await zhReady();
  const l = { t: p.text, lang: p.lang, th: opt.th ? undefined : null, toks: tokenize(p.text), low: new Set(p.low || []) };
  lines.push(l);
  if (lines.length > 200) lines.shift();
  partial = '';
  render();
  if (opt.th) translateLine(l);
}
async function translateLine(l) {
  const r = await api.invoke('tr:text', { text: l.t, src: l.lang === 'zh' ? 'zh' : 'en', tgt: 'th' });
  l.th = r && r.ok ? r.text : null;
  render();
}

/* ------------------------------------------------------------ word card */
function thaiOf(r) {
  if (!r || !r.ok) return [];
  const e = r.e, out = [];
  const add = (t) => { t = String(t).trim(); if (t && !out.includes(t)) out.push(t); };
  if (r.lang === 'zh') (e[1] || []).forEach(add); else { (e[3] || []).forEach((x) => add(x[0])); (e[2] || []).forEach(add); }
  return out;
}
let card = null;
async function openCard(el) {
  const l = lines[+el.dataset.l], t = l && l.toks[+el.dataset.t];
  if (!t) return;
  const lg = t.lang === 'zh' ? 'zh' : 'en';
  const box = $('lv-card');
  card = { l, t, lg };
  box.classList.remove('hidden');
  box.innerHTML = `<div class="progress indet"><i></i></div>`;
  place(el);
  const r = await api.invoke(lg === 'zh' ? 'dict:zh' : 'dict:en', t.t);
  if (!card || card.t !== t) return;
  const th = thaiOf(r), e = (r && r.e) || [];
  const read = lg === 'zh' ? ((e[0] || [])[0] || [])[0] || '' : e[0] || '';
  const en = lg === 'zh' ? (((e[0] || [])[0] || [, []])[1] || []).slice(0, 3).join('; ') : (((e[1] || [])[0] || [, []])[1] || []).slice(0, 1).join('');
  card.data = { head: (r && r.head) || t.t.toLowerCase(), read, mean: th[0] || '', en };
  box.innerHTML = `<div class="lvc-head"><b>${esc(t.t)}</b>${read ? `<span class="muted">${esc(read)}</span>` : ''}<span class="lv-fill"></span>
      <button class="icon-btn" data-c="say" title="${T`ฟังเสียง`}">${icon('speaker')}</button><button class="icon-btn" data-c="x" title="${T`ปิด`}">${icon('x')}</button></div>
    <div class="lvc-th">${th.length ? th.slice(0, 5).map((x) => `<span>${esc(x)}</span>`).join('') : en ? `<span class="muted">${esc(en)}</span>` : `<span class="muted">${T`ไม่พบในพจนานุกรม`}</span>`}</div>
    <div class="lvc-acts"><button class="pill-btn small primary" data-c="keep">${icon('plus')}<span>${T`เก็บเป็นบัตรคำ`}</span></button></div>`;
  box.querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => cardAct(b.dataset.c); });
  place(el);
  api.invoke('tts:say', { text: t.t, sid: lg === 'zh' ? 3 : 0, speed: 1 }).then((x) => { if (x && x.ok && card && card.t === t) new Audio(x.url).play().catch(() => {}); });
}
function cardAct(c) {
  if (!card) return;
  if (c === 'x') { $('lv-card').classList.add('hidden'); card = null; return; }
  if (c === 'say') api.invoke('tts:say', { text: card.t.t, sid: card.lg === 'zh' ? 3 : 0, speed: 1 }).then((x) => { if (x && x.ok) new Audio(x.url).play().catch(() => {}); });
  if (c === 'keep') {
    const d = card.data || {};
    api.invoke('live:tell', { act: 'card', lang: card.lg, head: d.head || card.t.t, surface: card.t.t, read: d.read, mean: d.mean, en: d.en, ex: card.l.t, exTh: card.l.th || '' });
    const b = $('lv-card').querySelector('[data-c="keep"]');
    if (b) { b.innerHTML = `${icon('check')}<span>${T`เก็บแล้ว`}</span>`; b.classList.remove('primary'); b.disabled = true; }
  }
}
function place(el) {
  const box = $('lv-card'), r = el.getBoundingClientRect();
  const w = box.offsetWidth || 300, h = box.offsetHeight || 120;
  let x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  let y = r.top - h - 8; if (y < 46) y = Math.min(innerHeight - h - 6, r.bottom + 8);
  box.style.left = x + 'px'; box.style.top = Math.max(4, y) + 'px';
}

/* ------------------------------------------------------------ state from Rust */
function state(p) {
  const s = $('lv-state');
  if (p.err) { s.textContent = p.err === 'nomodel' ? T`ไม่พบโมเดลฟังเสียง` : T`ตัวฟังเสียงเริ่มไม่ได้`; s.className = 'lv-state bad'; return; }
  if (p.other) { s.textContent = T`ได้ยินภาษา ${p.other} — ทำซับได้เฉพาะอังกฤษ / จีน`; s.className = 'lv-state warn'; return; }
  if (p.warn === 'device') { s.textContent = T`ลำโพงเปลี่ยน — กำลังเชื่อมต่อใหม่…`; s.className = 'lv-state warn'; return; }
  if (p.on === false) { s.textContent = T`หยุดอยู่`; s.className = 'lv-state'; return; }
  if (p.loading) { s.textContent = T`กำลังโหลด AI…`; s.className = 'lv-state'; return; }
  s.textContent = p.device === 'cpu' ? T`กำลังฟัง (CPU)` : T`กำลังฟัง`;
  s.className = 'lv-state on';
}
async function start() { const r = await api.invoke('live:start', { lang: opt.lang, mode: 'best' }); if (r && !r.ok) state({ err: r.reason }); else state({ on: true }); }

function boot() {
  setTheme(savedTheme()); setLook(savedLook());
  translateDom(document.body);
  hydrateIcons();
  apply();
  if (!native) return;
  api.on('live:partial', (p) => { partial = p.text || ''; render(); });
  api.on('live:final', (p) => addLine(p));
  api.on('live:state', state);
  api.on('live:level', (p) => { const l = $('lv-level'); l.style.width = Math.round((p.v || 0) * 100) + '%'; l.classList.toggle('sp', !!p.speech); });
  $('lv-lang').querySelectorAll('button').forEach((b) => { b.onclick = () => { opt.lang = b.dataset.v; save(); apply(); api.invoke('live:set', { lang: opt.lang }); }; });
  $('lv-th').onclick = () => { opt.th = !opt.th; save(); apply(); if (opt.th) lines.filter((l) => l.th === null || l.th === undefined).slice(-3).forEach((l) => { l.th = undefined; translateLine(l); }); render(); };
  $('lv-small').onclick = () => { opt.font = Math.max(14, opt.font - 2); save(); apply(); };
  $('lv-big').onclick = () => { opt.font = Math.min(48, opt.font + 2); save(); apply(); };
  $('lv-op').onclick = () => { const v = [0.35, 0.55, 0.72, 0.9]; opt.op = v[(v.indexOf(opt.op) + 1) % v.length] ?? 0.72; save(); apply(); };
  $('lv-pause').onclick = async () => { paused = !paused; apply(); if (paused) api.invoke('live:stop'); else start(); };
  $('lv-x').onclick = () => api.invoke('live:close');
  $('lv-lines').addEventListener('click', (e) => { const w = e.target.closest('.lv-w'); if (w) openCard(w); });
  $('lv-lines').addEventListener('scroll', () => { const b = $('lv-lines'); b.dataset.user = b.scrollHeight - b.scrollTop - b.clientHeight > 40 ? '1' : ''; }, { passive: true });
  addEventListener('pointerdown', (e) => { if (card && !e.target.closest('#lv-card') && !e.target.closest('.lv-w')) { $('lv-card').classList.add('hidden'); card = null; } }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (card) { $('lv-card').classList.add('hidden'); card = null; } } });
  start();
}
boot();
