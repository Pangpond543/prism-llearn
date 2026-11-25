// Prism LLearn — page entry: Prism shell (title bar, TH/EN, theme, About/update), views, keys, drag & drop, test hooks.
import { api, native, T, lang, theme, setTheme, savedTheme, setLook, savedLook, remember, toast, htmlBox, promptBox, hideCtx, esc, $, bus } from './core.js';
import { icon, hydrateIcons } from './icons.js';
import { translateDom, tr } from './i18n.js';
import { startBackground } from './bg.js';
import { S, loadState, save, saveNow, setView, streak } from './store.js';
import { addCard, findCard, lookup } from './words.js';
import { openLink, openText, addTextSource, openFiles, openSource, initReader, lessonKey, current, closeLesson, pauseIfPlaying, playCue } from './reader.js';
import { wordKey, wordOpen, closeWord } from './popup.js';
import { renderReviewHome, reviewKey, counts, inSession, leaveReview } from './review.js';
import { renderHome, placement, renderStatus } from './home.js';
import { renderWords, initWords } from './wordlist.js';
import { resumeQueue, openLive } from './asr.js';

addEventListener('error', (e) => api.invoke('app:log', 'JS error: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
addEventListener('unhandledrejection', (e) => api.invoke('app:log', 'JS rejection: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));

/* ------------------------------------------------------ from Prism Shot */
// Prism Shot's "keep in LLearn" (a word from a screenshot) and "learn in LLearn" (the text of a screenshot) drop JSON
// files into %APPDATA%\com.prism.llearn\inbox; Rust hands them over once (and deletes them).
let inboxBusy = false;
async function takeInbox() {
  if (!native || inboxBusy) return;
  inboxBusy = true;
  try {
    const items = await api.invoke('inbox:take').catch(() => []);
    if (!Array.isArray(items) || !items.length) return;
    let n = 0, lesson = null, last = '';
    for (const it of items) {
      if (it.type === 'card' && it.head && (it.lang === 'en' || it.lang === 'zh')) {
        const title = it.title || T`ภาพจาก Prism Shot`;
        const src = it.text ? await addTextSource(it.text, title) : null;
        let read = it.read || '';
        if (!read) { const r = await lookup(it.lang, it.head); const e = r && r.ok ? r.e || [] : []; read = it.lang === 'zh' ? (((e[0] || [])[0] || [])[0] || '') : (e[0] || ''); }
        const old = findCard(it.lang, it.head);
        addCard({ lang: it.lang, head: it.head, show: it.show || it.head, read, mean: it.mean || (old && old.mean) || '', en: it.en || '', ex: it.ex || '', exTh: it.exTh || '', src: src ? { kind: 'text', id: src.id, title: src.title } : (old ? old.src : null) });
        n++; last = it.show || it.head;
      } else if (it.type === 'lesson' && it.text) lesson = it;
    }
    if (n) { await saveNow(); toast(n === 1 ? T`รับคำจาก Prism Shot: ${last}` : T`รับคำจาก Prism Shot ${n} คำ`, { kind: 'ok' }); }
    if (lesson) {
      pauseIfPlaying();
      showView('learn');
      await openText(lesson.text, lesson.title || T`ภาพจาก Prism Shot`);
      renderCrumbs();
    }
  } finally { inboxBusy = false; }
}

/* ------------------------------------------------------------ about/update */
const AUTHOR = 'Thanakorn Damrikitjaroen', MODEL = 'Claude Opus 5.5';
const PURPOSE = 'Prism LLearn helps you learn English and Chinese from the YouTube videos, web pages and video files you like — click any word for its Thai meaning, sound and reading, keep it as a card, review at the right time, and watch your learning days fill the heatmap. Translation, dictionaries and voices run on your PC.';
async function showInfo() {
  const info = await api.invoke('about:info');
  const link = info.repo ? `https://github.com/${info.repo}` : '';
  htmlBox(`
    <div class="about">
      <div class="prism-logo big"><i></i><i></i><i></i><b class="lg"><svg viewBox="18 18 64 64" aria-hidden="true"><rect x="23" y="26" width="54" height="40" rx="13" fill="#fff"/><path d="M34 62 L30 76 L47 64 Z" fill="#fff"/><path d="M39.5 57 L50 34 L60.5 57 M43.6 49 H56.4" fill="none" stroke="var(--lg-deep)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg></b></div>
      <h3>Prism LLearn <small>v${esc(info.version)}</small></h3>
      <p class="about-purpose">${esc(PURPOSE)}</p>
      <dl class="kv">
        <dt>${T`เวอร์ชัน`}</dt><dd>${esc(info.version)} · Tauri ${esc(info.tauri || '')} · TranslateGemma 4B · Kokoro · yt-dlp</dd>
        <dt>${T`ผู้พัฒนา`}</dt><dd>${AUTHOR}</dd>
        <dt>${T`โมเดล AI ที่สร้าง`}</dt><dd>${MODEL}</dd>
        <dt>${T`พจนานุกรม`}</dt><dd>Wiktionary · VOLUBILIS · CC-CEDICT · HSK (CC BY-SA / MIT)</dd>
        <dt>GitHub</dt><dd>${link ? `<a href="#" id="about-repo">${esc(link)}</a>` : T`<span class="muted">ยังไม่ได้ตั้งค่าลิงก์</span>`}</dd>
      </dl>
      <div class="about-update" id="about-update"><span class="muted">${link ? T`กดเพื่อตรวจว่ามีเวอร์ชันใหม่บน GitHub หรือไม่` : T`ใส่ชื่อ repository ในไฟล์ prism.config.json (เช่น "owner/prism") เพื่อเปิดใช้การอัปเดต`}</span></div>
      <div class="modal-btns"><button class="pill-btn" data-x>${T`ปิด`}</button><button class="pill-btn primary" id="about-check">${icon('refresh')}<span>${T`ตรวจหาอัปเดต`}</span></button></div>
    </div>`, (m, close) => {
    const box = m.querySelector('#about-update'), btn = m.querySelector('#about-check');
    const say = (html) => { box.innerHTML = html; };
    const why = (r) => ({
      norepo: T`ยังไม่ได้ตั้งค่าลิงก์ GitHub — ใส่ชื่อ repository ในไฟล์ prism.config.json`,
      notfound: T`ไม่พบ repository นี้บน GitHub`, noversion: T`repository นี้ยังไม่มีเลขเวอร์ชัน`,
      network: T`เชื่อมต่อ GitHub ไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองใหม่`, uptodate: T`เป็นเวอร์ชันล่าสุดอยู่แล้ว`,
      extract: T`แตกไฟล์อัปเดตไม่สำเร็จ`, layout: T`ไฟล์อัปเดตมีโครงสร้างไม่ถูกต้อง`, notprism: T`ไฟล์ที่ดาวน์โหลดมาไม่ใช่โปรแกรม Prism`,
      build: T`คอมไพล์เวอร์ชันใหม่ไม่สำเร็จ — ต้องติดตั้ง Rust (cargo) ในเครื่องนี้`,
      noasset: T`เวอร์ชันใหม่ยังไม่มีไฟล์สำหรับอัปเดตอัตโนมัติ — กดลิงก์ GitHub ด้านบนเพื่อดาวน์โหลดเอง`,
    }[r.reason] || T`เกิดข้อผิดพลาดระหว่างอัปเดต`);
    m.querySelector('[data-x]').onclick = () => close(null);
    if (link) m.querySelector('#about-repo').onclick = (e) => { e.preventDefault(); api.invoke('about:openRepo'); };
    const off = api.on('update:step', ({ step }) => {
      const label = { download: T`กำลังดาวน์โหลด`, extract: T`กำลังแตกไฟล์`, copy: T`กำลังติดตั้ง`, build: T`กำลังคอมไพล์โปรแกรม (Rust)` }[step] || step;
      say(`<span>${label}…</span><div class="progress indet"><i></i></div>`);
    });
    const apply = async () => {
      btn.disabled = true;
      await saveNow();
      say(T`<span>กำลังดาวน์โหลด…</span><div class="progress indet"><i></i></div>`);
      const r = await api.invoke('update:apply');
      if (!r.ok) { say(`<span class="bad">${esc(why(r))}</span>`); btn.disabled = false; return; }
      say(`<span class="good">${T`ติดตั้งเวอร์ชัน ${esc(r.version)} แล้ว — เริ่มโปรแกรมใหม่เพื่อใช้งาน`}</span>`);
      btn.innerHTML = T`<span>เริ่มโปรแกรมใหม่</span>`; btn.disabled = false;
      btn.onclick = () => { off(); api.invoke('app:relaunch'); };
    };
    btn.onclick = async () => {
      btn.disabled = true;
      say(T`<span>กำลังตรวจสอบ…</span><div class="progress indet"><i></i></div>`);
      const r = await api.invoke('update:check');
      btn.disabled = false;
      if (!r.ok) { say(`<span class="bad">${esc(why(r))}</span>`); return; }
      if (!r.hasUpdate) { say(`<span class="good">${T`เป็นเวอร์ชันล่าสุดอยู่แล้ว (v${esc(r.current)})`}</span>`); return; }
      say(`<span class="good">${T`มีเวอร์ชันใหม่ v${esc(r.latest)} (ตอนนี้ใช้ v${esc(r.current)})`}</span>`);
      btn.innerHTML = `${icon('download')}<span>${T`อัปเดตเลย`}</span>`;
      btn.onclick = apply;
    };
  });
}

/* ------------------------------------------------------------ views */
const VIEWS = ['home', 'learn', 'review', 'words', 'keys'];
let view = 'home';
function showView(v) {
  if (!VIEWS.includes(v)) v = 'home';
  if (view === 'learn' && v !== 'learn') { pauseIfPlaying(); closeWord(); }
  if (view === 'review' && v !== 'review') leaveReview();
  view = v; setView(v);
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
  document.querySelectorAll('.dock-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  S.ui.view = v; save();
  try { localStorage.setItem('prism.view', v); } catch { /* */ }
  if (v === 'home') renderHome();
  if (v === 'review') renderReviewHome();
  if (v === 'words') renderWords();
  if (v === 'learn' && !current()) renderRecentMini();
  if (v === 'keys') renderKeys();
  renderCrumbs();
}
function renderCrumbs() {
  const names = { home: T`หน้าแรก`, learn: T`เรียน`, review: T`ทบทวน`, words: T`คลังคำ`, keys: T`คีย์ลัด` };
  const r = current();
  $('crumbs').innerHTML = `<span class="crumb last">${esc(names[view])}</span>${view === 'learn' && r ? `<span class="crumb-sep">›</span><span class="crumb last">${esc(r.src.title.slice(0, 60))}</span>` : ''}`;
}
function refreshBadges() {
  const c = counts('all');
  const n = c.due + c.fresh;
  $('rv-badge').textContent = n ? (n > 99 ? '99+' : n) : '';
  const st = streak();
  const sb = $('tb-streak');
  sb.lastElementChild.textContent = st.cur;
  sb.classList.toggle('lit', !!st.cur);
  sb.title = T`เรียนติดต่อกัน ${st.cur} วัน (สูงสุด ${st.best})`;
}
function renderRecentMini() {
  const box = $('recent2');
  const list = [...S.sources].sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, 6);
  box.innerHTML = list.map((s) => `<button class="rm glass" data-id="${esc(s.id)}">${icon(s.kind === 'yt' ? 'play' : s.kind === 'web' ? 'globe' : s.kind === 'file' || s.kind === 'site' ? 'film' : s.live ? 'ear' : 'doc')}<span>${esc(s.title)}</span></button>`).join('');
  box.querySelectorAll('[data-id]').forEach((b) => { b.onclick = () => openSrc(b.dataset.id); });
}
async function openSrc(id) { showView('learn'); await openSource(id); renderCrumbs(); }
async function go(input) {
  const v = String(input || '').trim();
  if (!v) return;
  showView('learn');
  await openLink(v);
  renderCrumbs();
}
async function pickFile() {
  if (!native) return;
  const p = await api.invoke('pick:open', 'media');
  if (!p) return;
  showView('learn');
  await openFiles([p]);
  renderCrumbs();
}

/* ------------------------------------------------------------ shortcuts */
const KEYS = [
  [T`ทั่วไป`, [['F1', T`หน้าคีย์ลัด`], ['Ctrl+1 … 4', T`หน้าแรก / เรียน / ทบทวน / คลังคำ`], ['Ctrl+L', T`วางลิงก์ใหม่`], ['Ctrl+O', T`เปิดวิดีโอในเครื่อง`], ['Ctrl+V', T`วางลิงก์ / ข้อความ (นอกช่องพิมพ์) แล้วเริ่มเรียนทันที`], ['Ctrl+Shift+L', T`ซับสดจากเสียงในคอม`]]],
  [T`หน้าเรียน`, [['Space', T`เล่น / หยุด (บทความ: อ่านให้ฟัง)`], ['← / →', T`บรรทัดก่อน / ถัดไป`], ['Enter', T`ฟังบรรทัดนี้อีกครั้ง`], ['R', T`วนบรรทัดนี้`], ['A', T`หยุดทุกครั้งที่จบบรรทัด`], ['D', T`ฝึกฟังแล้วพิมพ์ตาม`], ['T', T`แสดง / ซ่อนคำแปลไทย`], ['+ / -', T`ขนาดตัวอักษร`], [T`ลากเลือกหลายคำ`, T`ดูความหมายทั้งวลี`]]],
  [T`ซับด้วย AI`, [['E', T`เปิด / ปิดโหมดแก้ซับ (คลิกบรรทัดเพื่อแก้)`], ['Enter', T`บันทึกบรรทัดที่แก้`], ['Ctrl+Enter', T`แยกบรรทัดตรงเคอร์เซอร์`], ['Ctrl+Z', T`ย้อนการแก้ซับ`], [T`Shift+คลิกเวลา`, T`เลือกหลายบรรทัดให้ AI ฟังใหม่`], ['Esc', T`ยกเลิกการเลือก / ออกจากโหมดแก้`]]],
  [T`กล่องคำศัพท์`, [['S', T`เก็บเป็นบัตรคำ`], ['K', T`รู้แล้ว (เลิกไฮไลต์)`], ['X', T`ข้าม (เช่น ชื่อคน)`], ['V', T`ฟังเสียงคำ`], ['P', T`ฟังประโยคจากคลิป`], ['Esc', T`ปิด`]]],
  [T`ทบทวน`, [['Space', T`ดูความหมาย`], ['1 2 3 4', T`ลืม / ยาก / จำได้ / ง่ายมาก`], ['Enter', T`จำได้`], ['V', T`ฟังเสียง`], ['P', T`ฟังจากคลิป`], ['Esc', T`พักไว้ก่อน`]]],
  [T`ฟังแล้วพิมพ์`, [['Enter', T`ตรวจ / บรรทัดถัดไป`], ['Tab', T`ฟังซ้ำ`], ['Ctrl+H', T`ใบ้`], ['Ctrl+← / →', T`บรรทัดก่อน / ข้าม`], ['Shift+Enter', T`ลองบรรทัดนี้ใหม่`], ['Esc', T`เลิกฝึก`]]],
];
function renderKeys() {
  $('keys').innerHTML = KEYS.map(([h, rows]) => `<div class="card glass keys-card"><h3>${esc(h)}</h3>${rows.map(([k, d]) => `<div class="key-row"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('')}</div>`).join('');
}
function onKey(e) {
  if (e.key === 'F1') { e.preventDefault(); showView('keys'); return; }
  if (wordOpen() && wordKey(e)) return;
  if (e.ctrlKey && !e.shiftKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); showView(VIEWS[+e.key - 1]); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); showView('home'); $('add-in').focus(); $('add-in').select(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); pickFile(); return; }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); openLive(); return; }
  if ($('modal').classList.contains('hidden') === false) return;
  if (view === 'learn' && lessonKey(e)) return;
  if (view === 'review' && reviewKey(e)) return;
}
// Ctrl+V outside a text box: a pasted link / text starts a lesson right away
addEventListener('paste', (e) => {
  if (e.target.closest && e.target.closest('input, textarea, [contenteditable=true]')) return;
  const t = (e.clipboardData && e.clipboardData.getData('text')) || '';
  if (t.trim()) { e.preventDefault(); go(t); }
});

/* -------------------------------------------------------------------- boot */
async function boot() {
  api.invoke('app:lang', lang);
  translateDom(document.body);
  document.querySelectorAll('[placeholder]').forEach((el) => { el.placeholder = tr(el.placeholder); });
  hydrateIcons();
  setLook(savedLook());
  setTheme(savedTheme());
  startBackground($('bg'));
  $('win-min').onclick = () => api.invoke('win:min');
  $('win-max').onclick = () => api.invoke('win:max');
  $('win-close').onclick = async () => { closeLesson(); await saveNow(); if (native) api.invoke('win:close'); else window.close(); };
  $('btn-info').onclick = showInfo;
  const themeIcon = () => { $('btn-theme').firstElementChild.innerHTML = icon(theme.dark ? 'day' : 'moon'); };
  {
    const pop = $('theme-pop'), tbtn = $('btn-theme'), isOpen = () => !pop.classList.contains('hidden');
    const sync = () => {
      pop.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', (b.dataset.mode === 'dark') === theme.dark));
      pop.querySelectorAll('[data-look]').forEach((b) => b.classList.toggle('on', (b.dataset.look === 'classic') === theme.classic));
    };
    const place = () => { const r = tbtn.getBoundingClientRect(), w = pop.offsetWidth; pop.style.left = Math.max(8, Math.min(r.right - w + 8, innerWidth - w - 8)) + 'px'; pop.style.top = r.bottom + 12 + 'px'; };
    const close = () => { pop.classList.add('hidden'); tbtn.classList.remove('open'); };
    tbtn.onclick = () => { if (isOpen()) { close(); return; } hideCtx(); sync(); pop.classList.remove('hidden'); tbtn.classList.add('open'); place(); };
    pop.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { const d = b.dataset.mode === 'dark'; setTheme(d); themeIcon(); sync(); }; });
    pop.querySelectorAll('[data-look]').forEach((b) => { b.onclick = () => { setLook(b.dataset.look === 'classic'); sync(); }; });
    addEventListener('pointerdown', (e) => { if (isOpen() && !pop.contains(e.target) && !tbtn.contains(e.target)) close(); }, true);
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { e.stopPropagation(); close(); } }, true);
    addEventListener('resize', () => { if (isOpen()) place(); });
  }
  themeIcon();
  const ls = $('lang-switch');
  ls.dataset.lang = lang;
  ls.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === lang);
    b.onclick = async () => {
      if (b.dataset.lang === lang) return;
      ls.dataset.lang = b.dataset.lang;
      remember('prism.lang', b.dataset.lang);
      closeLesson(); await saveNow();
      setTimeout(() => { if (new URLSearchParams(location.search).has('lang')) location.search = ''; else location.reload(); }, 260);
    };
  });
  addEventListener('pointermove', (e) => {
    const g = e.target.closest && e.target.closest('.glass'); if (!g) return;
    const r = g.getBoundingClientRect();
    g.style.setProperty('--mx', e.clientX - r.left + 'px'); g.style.setProperty('--my', e.clientY - r.top + 'px');
  });
  addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctx')) hideCtx(); }, true);
  addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea, [contenteditable=true], .lr-lines, .lr-cap')) e.preventDefault(); });
  addEventListener('keydown', onKey, true);

  await loadState();
  document.querySelectorAll('.dock-btn[data-view]').forEach((b) => { b.onclick = () => showView(b.dataset.view); });
  $('dock-open').onclick = pickFile; $('dock-live').onclick = () => openLive(); $('add-file').onclick = pickFile; $('lr-file').onclick = pickFile;
  for (const [inp, btn] of [['add-in', 'add-go'], ['add-in2', 'add-go2']]) {
    $(inp).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = $(inp).value; $(inp).value = ''; go(v); } e.stopPropagation(); };
    $(btn).onclick = () => { const v = $(inp).value; $(inp).value = ''; if (v.trim()) go(v); else $(inp).focus(); };
  }
  $('lr-paste').onclick = async () => {
    const v = await htmlBox(`<h3>${T`วางข้อความที่อยากอ่าน`}</h3><textarea class="paste-box" spellcheck="false" placeholder="${T`ข้อความภาษาอังกฤษหรือจีน (เนื้อเพลง ข่าว บทความ…)`}"></textarea><div class="modal-btns"><button class="pill-btn" data-x>${T`ยกเลิก`}</button><button class="pill-btn primary" data-ok>${T`เริ่มอ่าน`}</button></div>`, (m, close) => {
      const ta = m.querySelector('textarea'); ta.focus();
      m.querySelector('[data-x]').onclick = () => close(null);
      m.querySelector('[data-ok]').onclick = () => close(ta.value);
      ta.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' && e.ctrlKey) close(ta.value); };
    });
    if (v && v.trim()) { await openText(v); renderCrumbs(); }
  };
  initReader({ onOpen: () => { renderCrumbs(); renderRecentMini(); } });
  initWords();
  bus.on('go', (v) => showView(v));
  bus.on('open-source', (id) => openSrc(id));
  bus.on('goto-source', async (src) => {
    if (!src || !S.sources.some((s) => s.id === src.id)) return toast(T`บทเรียนนี้ถูกลบไปแล้ว`);
    await openSrc(src.id);
    const r = current();
    if (r && src.t0 !== undefined) { const i = r.d.cues.findIndex((c) => c.s === src.t0); if (i >= 0) setTimeout(() => playCue(i), 600); }
  });
  bus.on('open-lesson', () => renderCrumbs());
  bus.on('sources', () => { if (view === 'home') renderHome(); });
  let badgeT = 0; const badges = () => { clearTimeout(badgeT); badgeT = setTimeout(refreshBadges, 300); };
  bus.on('cards', badges); bus.on('act', badges); bus.on('review-end', badges);
  setInterval(refreshBadges, 60000);
  refreshBadges();

  // drag & drop: video + subtitle files, or a link / text dragged from the browser
  document.body.insertAdjacentHTML('beforeend', `<div class="drop-zone-all">${T`วางไฟล์วิดีโอ / ซับ หรือลิงก์ที่นี่`}</div>`);
  api.on('app:drop', async ({ paths }) => { if (paths && paths.length) { showView('learn'); await openFiles(paths); renderCrumbs(); } });
  api.on('app:dragover', (on) => document.body.classList.toggle('drag-over', !!on));
  addEventListener('dragover', (e) => { e.preventDefault(); });
  addEventListener('drop', (e) => { e.preventDefault(); const t = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'); if (t) go(t.split('\n')[0]); });

  showView(S.ui.view === 'learn' ? 'home' : S.ui.view || 'home');
  api.invoke('app:ready');
  setTimeout(() => resumeQueue(), 2500); // AI subtitle jobs that were not finished continue
  // words and texts sent from Prism Shot: now, when the window gets focus, and every few seconds
  setTimeout(takeInbox, 800);
  addEventListener('focus', () => takeInbox());
  setInterval(takeInbox, 4000);
  // the dictionaries load in the background; the voice too (so the first word speaks quickly)
  if (native) setTimeout(() => api.invoke('tts:warm'), 1500);
  const testing = !!(await api.invoke('about:info')).test || (!native && new URLSearchParams(location.search).has('act'));
  if (!S.placed.en && !S.placed.zh && !Object.keys(S.words).length && !S.cards.length && !testing) setTimeout(() => firstRun(), 900);

  // self-test hook: PRISM_ACT=en,dark,info,view:<v>,open:<url>,text:<urlencoded>,file:<path>,word:<n>,play,dict,review,wait:<ms>,quit
  const acts = String((await api.invoke('about:info')).test || (!native && new URLSearchParams(location.search).get('act')) || '').split(',').filter(Boolean);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const a of acts) {
    const [cmd, arg] = [a.split(':')[0], a.split(':').slice(1).join(':')];
    api.invoke('app:log', 'test act ' + a);
    if (cmd === 'en' || cmd === 'th') { if (lang !== cmd) { remember('prism.lang', cmd); location.reload(); return; } }
    else if (cmd === 'dark' || cmd === 'light') { setTheme(cmd === 'dark'); themeIcon(); }
    else if (cmd === 'classic' || cmd === 'glass') setLook(cmd === 'classic');
    else if (cmd === 'info') showInfo();
    else if (cmd === 'updfake') window.__prismUpdFake = true;
    else if (cmd === 'view') showView(arg);
    else if (cmd === 'open') await go(decodeURIComponent(arg));
    else if (cmd === 'text') { showView('learn'); await openText(decodeURIComponent(arg)); }
    else if (cmd === 'file') { showView('learn'); await openFiles([decodeURIComponent(arg)]); }
    else if (cmd === 'src') await openSrc(arg);
    else if (cmd === 'word') { const el = [...document.querySelectorAll('#lr-lines .cue.now .tok, #lr-lines .tok')][+arg || 0]; if (el) { el.scrollIntoView({ block: 'center' }); await wait(400); el.click(); } }
    else if (cmd === 'cue') playCue(+arg || 0);
    else if (cmd === 'click') { const el = document.querySelector(decodeURIComponent(arg)); if (el) { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); el.click(); } }
    else if (cmd === 'key') document.body.dispatchEvent(new KeyboardEvent('keydown', { key: arg === 'space' ? ' ' : arg, bubbles: true }));
    else if (cmd === 'placement') placement(arg || 'en');
    else if (cmd === 'review') { showView('review'); }
    else if (cmd === 'rvstart') { showView('review'); (await import('./review.js')).start(); }
    else if (cmd === 'wait') await wait(+arg || 500);
    else if (cmd === 'live') openLive();
    else if (cmd === 'del') { const { deleteSrc } = await import('./store.js'); for (const id of arg.split('+')) await deleteSrc(id); }
    else if (cmd === 'aimenu') { const b = document.querySelector('#lr-ctrl [data-c="ai"]'); if (b) b.click(); }
    else if (cmd === 'edit') { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })); }
    else if (cmd === 'editcue') { const el = document.querySelector(`#lr-lines .cue[data-i="${+arg || 0}"] .cue-t`); if (el) el.click(); }
    else if (cmd === 'shiftcue') { const el = document.querySelector(`#lr-lines .cue[data-i="${+arg || 0}"] .cue-time`); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); }
    else if (cmd === 'aidialog') { const b = document.querySelector('[data-ai="start"]'); if (b) b.click(); }
    else if (cmd === 'scroll') { const l = document.getElementById('lr-lines'); if (l) l.scrollTop = +arg || 0; }
    else if (cmd === 'shot') api.invoke('app:log', 'shot point ' + arg);
    else if (cmd === 'quit') { closeLesson(); await saveNow(); api.invoke('win:close'); }
  }
}

async function firstRun() {
  const r = await htmlBox(`<div class="welcome"><div class="prism-logo big"><i></i><i></i><i></i><b class="lg"><svg viewBox="18 18 64 64" aria-hidden="true"><rect x="23" y="26" width="54" height="40" rx="13" fill="#fff"/><path d="M34 62 L30 76 L47 64 Z" fill="#fff"/><path d="M39.5 57 L50 34 L60.5 57 M43.6 49 H56.4" fill="none" stroke="var(--lg-deep)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg></b></div>
    <h3>${T`ยินดีต้อนรับสู่ Prism LLearn`}</h3>
    <p>${T`เรียนภาษาจากสิ่งที่คุณชอบดูชอบอ่าน: วางลิงก์ YouTube หรือเว็บ คลิกคำที่ไม่รู้ ดูความหมายไทย ฟังเสียง แล้วเก็บไว้ทบทวน — ทุกอย่างทำงานในเครื่อง ไม่มีค่าใช้จ่าย`}</p>
    <p class="muted">${T`เริ่มด้วยการวัดระดับคำศัพท์สั้นๆ (1 นาที) โปรแกรมจะได้ไม่ไฮไลต์คำง่ายๆ ที่คุณรู้แล้ว`}</p>
    <div class="modal-btns"><button class="pill-btn" data-x>${T`ข้าม`}</button><button class="pill-btn" data-zh>${T`วัดระดับภาษาจีน`}</button><button class="pill-btn primary" data-en>${T`วัดระดับภาษาอังกฤษ`}</button></div></div>`, (m, close) => {
    m.querySelector('[data-x]').onclick = () => close(null);
    m.querySelector('[data-en]').onclick = () => close('en');
    m.querySelector('[data-zh]').onclick = () => close('zh');
  });
  if (r) await placement(r); else { S.placed.en = S.placed.zh = true; save(); }
}

boot();

/* >>> prism-update-nudge (tools/brand/apply-web.js) */
{
  // Checks GitHub quietly a few seconds after start (and every 6 h). New version → dot on Info + a chip that slides out
  // once per version; clicking either opens Info already showing "Update now".
  const btn = document.getElementById('btn-info'), SEEN = 'prism.updSeen';
  let found = null;
  const chipOut = (r) => {
    let seen = null; try { seen = localStorage.getItem(SEEN); } catch {}
    if (seen === r.latest || document.querySelector('.upd-chip')) return;
    const chip = document.createElement('button');
    chip.className = 'upd-chip';
    chip.innerHTML = `<i></i><span>${T`มีเวอร์ชันใหม่ v${esc(r.latest)}`}</span><u>${T`(ตอนนี้ v${esc(r.current)})`}</u><b>${T`อัปเดต`}</b>`;
    document.body.appendChild(chip);
    const place = () => { const b = btn.getBoundingClientRect(); chip.style.top = `${b.bottom + 10}px`; chip.style.right = `${Math.max(8, innerWidth - b.right - 6)}px`; };
    place(); addEventListener('resize', place);
    requestAnimationFrame(() => requestAnimationFrame(() => chip.classList.add('show')));
    const hide = () => { chip.classList.remove('show'); removeEventListener('resize', place); setTimeout(() => chip.remove(), 450); };
    chip.onclick = () => { hide(); btn.click(); };
    setTimeout(hide, 10000);
  };
  const check = async () => {
    let r; try { r = window.__prismUpdFake ? { ok: true, hasUpdate: true, latest: '9.9.9', current: '1.0.0' } : await api.invoke('update:check'); } catch { return; } // __prismUpdFake = test hook (PRISM_ACT updfake)
    if (!r || !r.ok || !r.hasUpdate) return;
    const fresh = !found || found.latest !== r.latest;
    found = r;
    btn.classList.add('has-update');
    if (fresh) btn.classList.remove('seen');
    btn.title = T`มีเวอร์ชันใหม่ v${r.latest} — กดเพื่ออัปเดต`;
    chipOut(r);
  };
  setTimeout(check, 4000);
  setInterval(check, 6 * 3600e3);
  btn.addEventListener('click', () => {
    if (!found) return;
    try { localStorage.setItem(SEEN, found.latest); } catch {}
    btn.classList.add('seen');
    document.querySelector('.upd-chip')?.classList.remove('show');
    const t0 = performance.now();
    const go = () => { const c = document.getElementById('about-check'); if (c && !c.disabled && c.isConnected) c.click(); else if (performance.now() - t0 < 2500) requestAnimationFrame(go); };
    requestAnimationFrame(go);
  });
}
/* <<< prism-update-nudge */
