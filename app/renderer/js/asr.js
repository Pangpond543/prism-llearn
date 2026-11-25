// AI subtitles on the page: start / cancel jobs (Rust asr.rs does the work), the queue that survives a restart (S.asrQ),
// the queue card on Home, results for lessons that are not open, exporting subtitles, and the live-subtitle window.
import { api, native, T, esc, $, toast, bus, htmlBox } from './core.js';
import { icon } from './icons.js';
import { S, save, loadSrc, saveSrc } from './store.js';
import { addCard } from './words.js';

export const JOBS = new Map(); // lesson id → {phase, f, eta, done, total}
export let AST = { device: 'gpu', installed: true, best: true, fast: true };
let openKey = () => null;
export function setOpenKey(f) { openKey = f; }

/** what to listen to for a lesson: the file on the PC if there is one, else the link (only the sound is fetched) */
export function jobOf(src) {
  if (!src) return null;
  if (src.video) return { kind: 'file', src: src.video };
  if (src.kind === 'yt') return { kind: 'yt', src: src.url || `https://www.youtube.com/watch?v=${src.vid}` };
  if (src.kind === 'site' && src.url) return { kind: 'yt', src: src.url };
  return null;
}
export const canAi = (src) => native && !!jobOf(src);

export function whyAi(r, name) {
  return { nomodel: T`ไม่พบไฟล์โมเดลฟังเสียง (โฟลเดอร์ runtime\\whisper)`, engine: T`ตัวฟังเสียงเริ่มทำงานไม่ได้`, network: T`เชื่อมต่ออินเทอร์เน็ตไม่ได้ — ดึงเสียงจากคลิปไม่ได้`,
    download: T`ดึงเสียงจากคลิปไม่สำเร็จ`, noaudio: T`วิดีโอนี้ไม่มีเสียง`, missing: T`ไม่พบไฟล์วิดีโอแล้ว (ถูกย้ายหรือลบ)`, disk: T`บันทึกไฟล์เสียงไม่ได้ (ดิสก์เต็ม?)`,
    otherlang: T`คลิปนี้พูดภาษา ${name || '?'} — ทำซับได้เฉพาะภาษาอังกฤษและจีน`, nosrc: T`บทเรียนนี้ไม่มีเสียงให้ฟัง`, short: T`ช่วงที่เลือกสั้นเกินไป` }[r] || T`ทำซับด้วย AI ไม่สำเร็จ`;
}
export function phaseText(j) {
  if (!j) return '';
  const pct = Math.round((j.f || 0) * 100);
  const eta = j.eta > 0 ? (j.eta >= 90 ? T` · เหลือราว ${Math.round(j.eta / 60)} นาที` : T` · เหลือไม่ถึง ${Math.max(1, Math.ceil(j.eta / 60))} นาที`) : '';
  return { wait: T`รอคิว`, prep: T`กำลังเตรียม…`, download: T`กำลังดึงเสียงจากคลิป ${pct}%`, audio: T`กำลังแยกเสียง ${pct}%`,
    asr: j.total ? T`AI กำลังฟัง ${pct}% (${j.done || 0}/${j.total} ช่วง)${eta}` : T`AI กำลังฟัง…` }[j.phase] || '';
}

export async function startAi(src, { mode, lang, fresh = false, front = false, quiet = false } = {}) {
  const j = jobOf(src);
  if (!j) return false;
  mode = mode || S.set.aiMode || 'best';
  const job = { key: src.id, ...j, lang: lang || (src.aiLang && src.aiLang !== 'auto' ? src.aiLang : ''), mode, title: src.title, fresh, front };
  const r = native ? await api.invoke('asr:add', job) : { ok: false, reason: 'browser' };
  if (!r || !r.ok) { if (!quiet) toast(whyAi(r && r.reason), { kind: 'err' }); return false; }
  S.asrQ = [...(S.asrQ || []).filter((x) => x.key !== src.id), { key: job.key, kind: job.kind, src: job.src, lang: job.lang, mode, title: job.title }];
  save();
  if (!JOBS.has(src.id)) JOBS.set(src.id, { key: src.id, phase: 'wait', f: 0, title: src.title });
  if (!src.track || src.track === 'ai' || fresh) { src.track = 'ai'; save(); }
  bus.emit('asr', { key: src.id });
  renderQueue();
  return true;
}
export async function cancelAi(key) { await api.invoke('asr:cancel', key); }
/** listen to [s, e] again with the accurate model (a few lines the learner chose) */
export async function redoRange(src, s, e, prompt) {
  const j = jobOf(src);
  if (!j) return false;
  const r = await api.invoke('asr:add', { key: src.id, ...j, range: [Math.round(s), Math.round(e)], prompt: prompt || '', title: src.title, mode: 'best' });
  if (!r || !r.ok) { toast(whyAi(r && r.reason), { kind: 'err' }); return false; }
  return true;
}

const dropQ = (key) => { const n = (S.asrQ || []).length; S.asrQ = (S.asrQ || []).filter((x) => x.key !== key); if (n !== S.asrQ.length) save(); };
if (native) {
  api.on('asr:progress', (p) => { JOBS.set(p.key, { ...(JOBS.get(p.key) || {}), ...p }); bus.emit('asr', p); renderQueue(); });
  api.on('asr:queue', (st) => {
    AST = st;
    const live = new Set((st.jobs || []).map((j) => j.key));
    for (const j of st.jobs || []) JOBS.set(j.key, { ...(JOBS.get(j.key) || {}), ...j, cues: undefined });
    for (const k of [...JOBS.keys()]) if (!live.has(k)) JOBS.delete(k);
    renderQueue();
  });
  api.on('asr:range', (p) => bus.emit('asr-range', p));
  api.on('asr:done', async (p) => {
    JOBS.delete(p.key);
    dropQ(p.key);
    renderQueue();
    const src = S.sources.find((s) => s.id === p.key);
    if (src && !p.ok && p.reason === 'cancel') { src.aiPartial = 1; save(); }
    if (p.ok && src) {
      delete src.aiPartial;
      src.track = 'ai'; src.lang = p.lang || src.lang; src.ai = Date.now(); save();
      if (openKey() !== p.key) {
        // a lesson that is not open: its lines are ready for next time
        const d = (await loadSrc(p.key)) || { cues: [] };
        const old = new Map((d.cues || []).map((c) => [c.t, c.th]));
        d.cues = (p.cues || []).map((c) => ({ ...c, th: old.get(c.t) || undefined }));
        saveSrc(p.key, d, true);
        if (!p.empty) toast(T`ทำซับ "${src.title.slice(0, 40)}" เสร็จแล้ว`, { action: () => bus.emit('open-source', p.key), label: T`เปิดบทเรียน` });
      }
    }
    if (p.ok && p.empty) toast(T`AI ไม่ได้ยินเสียงพูดในคลิปนี้ (อาจเป็นเพลงหรือเสียงเงียบ)`, { kind: 'err' });
    if (!p.ok && p.reason !== 'cancel') toast(whyAi(p.reason, p.name), { kind: 'err' });
    bus.emit('asr-done', p);
  });
}
/** after a restart: jobs that were not finished continue where they stopped (pieces already heard are cached) */
export async function resumeQueue() {
  if (!native) return;
  AST = await api.invoke('asr:state');
  for (const j of S.asrQ || []) {
    if (!S.sources.some((s) => s.id === j.key)) { dropQ(j.key); continue; }
    const r = await api.invoke('asr:add', j);
    if (r && r.ok) JOBS.set(j.key, { key: j.key, phase: 'wait', f: 0, title: j.title });
  }
  renderQueue();
}

/* ------------------------------------------------------------ queue card on Home */
export function renderQueue() {
  const box = $('aiq');
  if (!box) return;
  const list = [...JOBS.values()].filter((j) => !j.range);
  box.classList.toggle('hidden', !list.length);
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="aiq-head">${icon('sparkle')}<b>${T`คิวทำซับด้วย AI`}</b><span class="muted">${AST.device === 'cpu' ? T`ใช้ CPU (ช้ากว่า)` : T`ใช้การ์ดจอ`}</span></div>
    ${list.map((j) => `<div class="aiq-row" data-k="${esc(j.key)}"><button class="aiq-t" data-open="${esc(j.key)}" title="${T`เปิดบทเรียน`}">${esc(j.title || j.key)}</button>
      <div class="aiq-bar"><div class="progress${j.phase === 'prep' ? ' indet' : ''}"><i style="width:${Math.round((j.f || 0) * 100)}%"></i></div><span class="muted">${esc(phaseText(j))}</span></div>
      <button class="icon-btn" data-x="${esc(j.key)}" title="${T`ยกเลิก (ส่วนที่ฟังแล้วเก็บไว้ ทำต่อได้)`}">${icon('x')}</button></div>`).join('')}`;
  box.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => bus.emit('open-source', b.dataset.open); });
  box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => cancelAi(b.dataset.x); });
}

/* ------------------------------------------------------------ export */
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (ms, sep) => { ms = Math.max(0, Math.round(ms)); return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`; };
export async function exportSubs(src, cues, fmt, withTh) {
  if (!cues || !cues.length) return toast(T`ยังไม่มีซับให้ส่งออก`, { kind: 'err' });
  const line = (c) => (withTh && c.th ? `${c.t}\n${c.th}` : c.t);
  let text = '';
  if (fmt === 'srt') text = cues.map((c, i) => `${i + 1}\n${stamp(c.s, ',')} --> ${stamp(c.e, ',')}\n${line(c)}\n`).join('\n');
  else if (fmt === 'vtt') text = 'WEBVTT\n\n' + cues.map((c) => `${stamp(c.s, '.')} --> ${stamp(c.e, '.')}\n${line(c)}\n`).join('\n');
  else text = cues.map((c) => line(c)).join(withTh ? '\n\n' : '\n') + '\n';
  const base = (src.title || 'subtitles').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'subtitles';
  const name = `${base}${withTh ? '.th' : ''}.${src.lang || 'en'}.${fmt}`;
  const p = await api.invoke('pick:save', { kind: fmt === 'txt' ? 'txt' : 'sub', name });
  if (!p) return;
  const r = await api.invoke('fs:write', { path: p, text, bom: fmt === 'txt' });
  if (r && r.ok) toast(T`บันทึกไฟล์ซับแล้ว`, { action: () => api.invoke('reveal', p), label: T`เปิดโฟลเดอร์` }); else toast(T`บันทึกไฟล์ไม่สำเร็จ`, { kind: 'err' });
}

/* ------------------------------------------------------------ live subtitles (the floating window talks to us) */
let liveLines = [], liveId = '';
export async function openLive() {
  if (!native) return;
  const r = await api.invoke('live:open');
  if (!r || !r.ok) toast(T`เปิดหน้าต่างซับสดไม่ได้`, { kind: 'err' });
}
if (native) {
  api.on('live:final', (p) => { if (!liveLines.length) liveId = 't-live' + Date.now().toString(36); liveLines.push({ t: p.text, lang: p.lang, at: p.t }); if (liveLines.length > 2000) liveLines.shift(); });
  api.on('live:state', (p) => { if (p && p.on === false && liveLines.length >= 3 && S.set.liveSave !== false) keepLiveSession(); else if (p && p.on === false) liveLines = []; });
  api.on('live:tell', (a) => {
    if (!a) return;
    if (a.act === 'card') { addCard({ lang: a.lang, head: a.head, show: a.surface || a.head, read: a.read || '', mean: a.mean || '', en: a.en || '', ex: a.ex || '', exTh: a.exTh || '', src: { id: liveId, kind: 'text', title: T`ซับสด` } }); }
    if (a.act === 'words') bus.emit('words', {});
  });
}
/** a live session becomes a reading lesson (the sentences heard, to look up and review later) */
function keepLiveSession() {
  const lines = liveLines; liveLines = [];
  const d = new Date(lines[0].at || Date.now());
  const id = liveId || 't-live' + d.getTime().toString(36);
  const lang = lines.filter((l) => l.lang === 'zh').length > lines.length / 2 ? 'zh' : 'en';
  const title = T`ซับสด ${d.toLocaleDateString()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const src = { id, kind: 'text', live: 1, title, url: '', lang, added: Date.now(), last: Date.now(), pos: 0 };
  S.sources = [src, ...S.sources.filter((s) => s.id !== id)];
  saveSrc(id, { cues: lines.map((l) => ({ t: l.t, p: 0 })) }, true);
  save();
  bus.emit('sources');
  toast(T`เก็บซับสด ${lines.length} ประโยคเป็นบทเรียนแล้ว — เปิดดูคำศัพท์ได้ที่หน้าแรก`, { action: () => bus.emit('open-source', id), label: T`เปิด` });
}

/* ------------------------------------------------------------ choose how to make AI subtitles */
export function aiDialog(src) {
  return htmlBox(`<h3>${icon('sparkle')} ${T`ทำซับด้วย AI ในเครื่อง`}</h3>
    <p class="muted">${T`AI ฟังเสียงในคลิปแล้วเขียนซับให้ ทำงานในเครื่อง ไม่มีค่าใช้จ่าย ทำครั้งเดียวจำไว้ตลอด`}</p>
    <div class="ai-opt"><span>${T`โหมด`}</span><div class="seg" id="ai-mode"><button data-v="best">${T`แม่นยำ`}</button><button data-v="fast">${T`เร็ว`}</button></div></div>
    <p class="muted small" id="ai-mode-note"></p>
    <div class="ai-opt"><span>${T`ภาษาที่พูดในคลิป`}</span><div class="seg" id="ai-lang"><button data-v="auto">${T`ให้ AI ดูเอง`}</button><button data-v="en">${T`อังกฤษ`}</button><button data-v="zh">${T`จีน`}</button></div></div>
    <div class="modal-btns"><button class="pill-btn" data-x>${T`ยกเลิก`}</button><button class="pill-btn primary" data-ok>${icon('sparkle')}<span>${T`เริ่มทำซับ`}</span></button></div>`, (m, close) => {
    let mode = S.set.aiMode || 'best', lg = src.aiLang || 'auto';
    const sync = () => {
      m.querySelectorAll('#ai-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === mode));
      m.querySelectorAll('#ai-lang button').forEach((b) => b.classList.toggle('on', b.dataset.v === lg));
      m.querySelector('#ai-mode-note').textContent = (mode === 'best' ? T`แม่นยำ: โมเดลใหญ่ (large-v3-turbo) ฟังชัด เหมาะกับการ์ดจอ` : T`เร็ว: โมเดลเล็ก เบาเครื่อง เหมาะกับคอมที่ไม่มีการ์ดจอ (ฟังพลาดบ่อยกว่า)`)
        + (AST.device === 'cpu' ? ' ' + (mode === 'best' ? T`(เครื่องนี้ใช้ CPU: ใช้เวลาพอๆ กับความยาวคลิป โหมดเร็วเร็วกว่าราว 3 เท่า)` : T`(เครื่องนี้ใช้ CPU: เร็วกว่าโหมดแม่นยำราว 3 เท่า)`) : '');
    };
    m.querySelectorAll('#ai-mode button').forEach((b) => { b.onclick = () => { mode = b.dataset.v; sync(); }; });
    m.querySelectorAll('#ai-lang button').forEach((b) => { b.onclick = () => { lg = b.dataset.v; sync(); }; });
    sync();
    m.querySelector('[data-x]').onclick = () => close(null);
    m.querySelector('[data-ok]').onclick = () => { S.set.aiMode = mode; save(); close({ mode, lang: lg }); };
  });
}
