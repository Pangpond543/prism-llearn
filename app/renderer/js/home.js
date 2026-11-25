// Home: streak + today's goal, "paste a link" box, the learning heatmap (one square per day, like GitHub's
// contribution graph), recent lessons, engine status and settings.
import { api, native, T, esc, $, toast, bus, htmlBox, confirmBox } from './core.js';
import { icon } from './icons.js';
import { lang } from './i18n.js';
import { S, save, dayKey, dayScore, streak, setWord, deleteSrc } from './store.js';
import { counts } from './review.js';
import { VOICES, speak, prepareEn, LEMMA } from './words.js';
import { renderQueue, AST, openLive } from './asr.js';

const MON_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_TH = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const DAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const mon = (i) => (lang === 'en' ? MON_EN : MON_TH)[i];
const dname = (i) => (lang === 'en' ? DAY_EN : DAY_TH)[i];

export function renderHome() {
  const st = streak();
  const today = S.act[dayKey()] || {};
  const min = Math.floor((today.m || 0) / 60);
  const goal = S.goal.min || 15;
  const pct = Math.min(1, min / goal);
  const c = counts('all');
  const known = Object.values(S.words).filter((w) => w.s === 2).length;
  const learning = S.cards.filter((x) => !x.known).length;
  $('home-top').innerHTML = `
    <div class="hm-streak glass card">
      <div class="flame ${st.cur ? 'lit' : ''}">${icon('flame')}</div>
      <div><div class="hm-num">${st.cur}<small>${T`วันติด`}</small></div><div class="muted">${T`สถิติสูงสุด ${st.best} วัน · เรียนมาแล้ว ${st.days} วัน`}</div></div>
    </div>
    <div class="hm-goal glass card" title="${T`เป้าหมายต่อวัน — คลิกเพื่อเปลี่ยน`}">
      <svg viewBox="0 0 44 44" class="ring"><circle cx="22" cy="22" r="18" class="ring-bg"/><circle cx="22" cy="22" r="18" class="ring-fg" style="stroke-dasharray:${(pct * 113.1).toFixed(1)} 113.1"/></svg>
      <div><div class="hm-num">${min}<small>/ ${goal} ${T`นาที`}</small></div><div class="muted">${pct >= 1 ? T`ครบเป้าวันนี้แล้ว!` : T`เวลาเรียนวันนี้`}</div></div>
    </div>
    <div class="hm-stat glass card clickable" data-go="review"><div class="hm-num">${c.due + c.fresh}</div><div class="muted">${T`บัตรคำรอทวน`}</div></div>
    <div class="hm-stat glass card clickable" data-go="words"><div class="hm-num">${learning}</div><div class="muted">${T`กำลังจำ`}</div></div>
    <div class="hm-stat glass card clickable" data-go="words"><div class="hm-num">${known.toLocaleString()}</div><div class="muted">${T`คำที่รู้แล้ว`}</div></div>`;
  $('home-top').querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => bus.emit('go', b.dataset.go); });
  $('home-top').querySelector('.hm-goal').onclick = pickGoal;
  renderHeat();
  renderRecent();
  renderStatus();
  renderQueue();
}

/* ------------------------------------------------------------ heatmap */
function level(a) {
  const s = dayScore(a);
  if (s < 1) return s > 0 ? 1 : 0;
  const g = S.goal.min || 15;
  return s >= g * 1.5 ? 4 : s >= g ? 3 : s >= g / 2 ? 2 : 1;
}
function renderHeat() {
  const box = $('heat');
  // squares grow with the window (GitHub size at the smallest, up to 20 px)
  const cell = Math.max(11, Math.min(20, Math.floor((box.clientWidth - 90) / 53) - 3));
  box.style.setProperty('--hc', cell + 'px');
  const end = new Date(); end.setHours(12, 0, 0, 0);
  const start = new Date(end); start.setDate(start.getDate() - 52 * 7 - end.getDay()); // 53 columns, Sunday first
  const cols = [];
  let total = 0, minutes = 0, words = 0;
  const d = new Date(start);
  const months = [];
  for (let w = 0; w < 53; w++) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const k = dayKey(d), a = S.act[k];
      if (d > end) col.push(`<i class="hc out"></i>`);
      else {
        const lv = level(a);
        if (dayScore(a) >= 1) total++;
        minutes += (a && a.m) || 0; words += (a && a.n) || 0;
        col.push(`<i class="hc l${lv}${k === dayKey() ? ' today' : ''}" data-d="${k}"></i>`);
      }
      if (i === 0 && d.getDate() <= 7) months.push([w, d.getMonth()]);
      d.setDate(d.getDate() + 1);
    }
    cols.push(`<div class="hcol">${col.join('')}</div>`);
  }
  box.innerHTML = `
    <div class="heat-head"><h3>${T`ตารางการเรียน`}</h3><span class="muted">${T`ปีนี้เรียน ${total} วัน · ${Math.round(minutes / 60).toLocaleString()} นาที · คำใหม่ ${words} คำ`}</span><span class="ed-fill"></span>
      <span class="heat-leg muted">${T`น้อย`}<i class="hc l0"></i><i class="hc l1"></i><i class="hc l2"></i><i class="hc l3"></i><i class="hc l4"></i>${T`มาก`}</span></div>
    <div class="heat-grid">
      <div class="heat-days">${[1, 3, 5].map((i) => `<span style="grid-row:${i + 1}">${dname(i)}</span>`).join('')}</div>
      <div class="heat-main"><div class="heat-months">${months.map(([w, m]) => `<span style="left:${w * (cell + 3)}px">${mon(m)}</span>`).join('')}</div><div class="heat-cols">${cols.join('')}</div></div>
    </div>
    <div class="heat-detail" id="heat-detail"></div>`;
  const tip = $('tooltip');
  box.querySelectorAll('.hc[data-d]').forEach((el) => {
    el.onmouseenter = () => {
      const k = el.dataset.d, a = S.act[k] || {};
      const dt = new Date(k + 'T12:00:00');
      tip.innerHTML = `<b>${dt.toLocaleDateString(lang === 'en' ? 'en-GB' : 'th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</b><br>${dayScore(a) ? T`เรียน ${Math.round((a.m || 0) / 60)} นาที · ทวน ${a.r || 0} · คำใหม่ ${a.n || 0}` : T`ไม่ได้เรียน`}`;
      tip.classList.remove('hidden');
      const r = el.getBoundingClientRect();
      tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2)) + 'px';
      tip.style.top = r.top - tip.offsetHeight - 8 + 'px';
    };
    el.onmouseleave = () => tip.classList.add('hidden');
    el.onclick = () => dayDetail(el.dataset.d);
  });
  // start scrolled to today
  const main = box.querySelector('.heat-main'); main.scrollLeft = main.scrollWidth;
}
function dayDetail(k) {
  const box = $('heat-detail');
  const a = S.act[k] || {};
  const inDay = (ms) => ms && dayKey(new Date(ms)) === k;
  const cards = S.cards.filter((c) => inDay(c.c));
  const lessons = S.sources.filter((s) => inDay(s.last) || inDay(s.added));
  const dt = new Date(k + 'T12:00:00');
  box.innerHTML = `<div class="hd glass card">
    <div class="hd-head"><b>${dt.toLocaleDateString(lang === 'en' ? 'en-GB' : 'th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</b><span class="ed-fill"></span><button class="icon-btn" id="hd-x">${icon('x')}</button></div>
    <div class="hd-nums"><span>${icon('clock')}${T`${Math.round((a.m || 0) / 60)} นาที`}</span><span>${icon('cards')}${T`ทวน ${a.r || 0} ครั้ง`}</span><span>${icon('plus')}${T`คำใหม่ ${a.n || 0}`}</span><span>${icon('type')}${T`ฟังพิมพ์ ${a.d || 0} บรรทัด`}</span><span>${icon('search')}${T`เปิดดูคำ ${a.l || 0} ครั้ง`}</span></div>
    ${cards.length ? `<div class="hd-words">${cards.slice(0, 60).map((c) => `<span class="chip ${c.lang}" title="${esc(c.mean || '')}">${esc(c.show || c.head)}</span>`).join('')}${cards.length > 60 ? `<span class="muted">+${cards.length - 60}</span>` : ''}</div>` : ''}
    ${lessons.length ? `<div class="hd-lessons">${lessons.map((s) => `<button class="hd-lesson" data-id="${esc(s.id)}">${icon(s.kind === 'yt' ? 'play' : s.kind === 'web' ? 'globe' : 'doc')}<span>${esc(s.title)}</span></button>`).join('')}</div>` : ''}
    ${!cards.length && !lessons.length && !dayScore(a) ? `<p class="muted">${T`วันนี้ยังไม่มีบันทึก`}</p>` : ''}</div>`;
  $('hd-x').onclick = () => { box.innerHTML = ''; };
  box.querySelectorAll('[data-id]').forEach((b) => { b.onclick = () => bus.emit('open-source', b.dataset.id); });
}
async function pickGoal() {
  const v = await htmlBox(`<h3>${T`เป้าหมายต่อวัน`}</h3><p class="muted">${T`เรียนกี่นาทีถึงจะนับว่า "ครบเป้า" (ช่องในตารางจะเข้มสุด)`}</p>
    <div class="seg goal-seg">${[5, 10, 15, 20, 30, 45, 60].map((m) => `<button data-m="${m}" class="${S.goal.min === m ? 'on' : ''}">${m}</button>`).join('')}</div>
    <div class="modal-btns"><button class="pill-btn" data-x>${T`ปิด`}</button></div>`, (m, close) => {
    m.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => close(+b.dataset.m); });
    m.querySelector('[data-x]').onclick = () => close(null);
  });
  if (v) { S.goal.min = v; save(); renderHome(); }
}

/* ------------------------------------------------------------ recent lessons */
function renderRecent() {
  const box = $('recent');
  const list = [...S.sources].sort((a, b) => (b.last || 0) - (a.last || 0));
  if (!list.length) { box.innerHTML = `<div class="empty-hint muted">${icon('link')}<span>${T`ยังไม่มีบทเรียน — วางลิงก์ YouTube หรือเว็บด้านบนได้เลย`}</span></div>`; return; }
  box.innerHTML = list.slice(0, 24).map((s) => {
    const thumb = s.kind === 'yt' || (s.kind === 'site' && s.thumb) ? `<img src="${esc(s.thumb || `https://i.ytimg.com/vi/${s.vid}/mqdefault.jpg`)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="rc-ico">${icon(s.kind === 'web' ? 'globe' : s.kind === 'file' || s.kind === 'site' ? 'film' : s.live ? 'ear' : 'doc')}</div>`;
    const pct = s.dur ? Math.min(100, Math.round(((s.pos || 0) / s.dur) * 100)) : 0;
    return `<div class="rc glass" data-id="${esc(s.id)}" title="${esc(s.title)}"><div class="rc-thumb">${thumb}${s.video ? `<span class="rc-off" title="${T`มีไฟล์ไว้ดูออฟไลน์`}">${icon('download')}</span>` : ''}${s.track === 'ai' ? `<span class="rc-ai" title="${T`ซับจาก AI ในเครื่อง`}">${icon('sparkle')}</span>` : ''}${pct ? `<i class="rc-prog" style="width:${pct}%"></i>` : ''}</div>
      <div class="rc-t">${esc(s.title)}</div><div class="rc-s muted"><span class="lang-chip ${s.lang}">${s.lang === 'zh' ? T`จีน` : T`อังกฤษ`}</span>${esc(s.channel || (s.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || '')}</div>
      <button class="rc-del icon-btn" data-del="${esc(s.id)}" title="${T`ลบบทเรียนนี้`}">${icon('trash')}</button></div>`;
  }).join('');
  box.querySelectorAll('.rc-thumb img').forEach((img) => img.addEventListener('error', () => img.remove())); // offline: no thumbnail
  box.querySelectorAll('.rc').forEach((el) => { el.onclick = (e) => { if (e.target.closest('[data-del]')) return; bus.emit('open-source', el.dataset.id); }; });
  box.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const s = S.sources.find((x) => x.id === b.dataset.del);
      if (!s) return;
      const ok = await confirmBox(T`ลบบทเรียน "${s.title}"?`, s.video ? T`ซับและคำแปลของบทนี้จะถูกลบ รวมถึงไฟล์วิดีโอที่โหลดไว้ (บัตรคำที่เก็บไว้ยังอยู่)` : T`ซับและคำแปลของบทนี้จะถูกลบ (บัตรคำที่เก็บไว้ยังอยู่)`, T`ลบ`, true);
      if (ok) { await deleteSrc(s.id); renderRecent(); }
    };
  });
}

/* ------------------------------------------------------------ engines + settings */
export async function renderStatus() {
  const box = $('status');
  const tr = native ? await api.invoke('tr:state') : { state: 'browser' };
  const trTxt = { ready: T`พร้อม${tr.gpu === false ? ' (CPU)' : T(' (การ์ดจอ)')}`, loading: T`กำลังโหลดโมเดล…`, off: T`พร้อม (เปิดเมื่อใช้)`, fail: T`ใช้ไม่ได้`, nomodel: T`ยังไม่มีตัวแปล`, downloading: T`กำลังโหลด ${Math.round((tr.f || 0) * 100)}%`, dlfail: T`โหลดไม่สำเร็จ`, browser: '—' }[tr.state] || tr.state;
  const trBtn = tr.state === 'nomodel' || tr.state === 'dlfail' ? `<button class="pill-btn small primary" id="set-trdl" title="${T`โหลดครั้งเดียวจาก Hugging Face (ฟรี) แล้วแปลได้ในเครื่องตลอดไป`}">${icon('download')}<span>${tr.f > 0.01 ? T`โหลดต่อ (2.5 GB)` : T`โหลดตัวแปล (2.5 GB ฟรี)`}</span></button>` : '';
  const as = native ? await api.invoke('asr:state') : { installed: false };
  const ai = !as.installed ? { cls: 'nomodel', txt: T`ไม่พบตัวฟังเสียง` } : !as.best && !as.fast ? { cls: 'nomodel', txt: T`ไม่พบโมเดล` } : { cls: 'ready', txt: as.device === 'cpu' ? T`พร้อม (CPU)` : T`พร้อม (การ์ดจอ)` };
  const vo = (l) => (VOICES[l] || []).map(([id, n]) => `<option value="${id}" ${(l === 'zh' ? S.set.voiceZh : S.set.voiceEn) === id ? 'selected' : ''}>${esc(T(n))}</option>`).join('');
  box.innerHTML = `
    <h3>${T`ตั้งค่า`}</h3>
    <div class="set-row"><span>${icon('lang')}${T`แปลภาษาในเครื่อง`}</span><b class="st-${tr.state}">${esc(trTxt)}</b>${trBtn}</div>${tr.state === 'downloading' ? `<div class="progress" id="trdl-bar"><i style="width:${Math.round((tr.f || 0) * 100)}%"></i></div>` : ''}
    <div class="set-row"><span>${icon('sparkle')}${T`AI ทำซับ`}</span><b class="st-${ai.cls}">${esc(ai.txt)}</b></div>
    <div class="set-row"><span>${icon('sparkle')}${T`ทำซับเองเมื่อคลิปไม่มีซับ`}</span><input type="checkbox" id="set-aiauto" ${S.set.aiAuto !== false ? 'checked' : ''}></div>
    <div class="set-row"><span>${icon('gpu')}${T`โหมดทำซับ`}</span><select id="set-aimode"><option value="best" ${S.set.aiMode !== 'fast' ? 'selected' : ''}>${T`แม่นยำ (large-v3-turbo)`}</option><option value="fast" ${S.set.aiMode === 'fast' ? 'selected' : ''}>${T`เร็ว (small · เบาเครื่อง)`}</option></select></div>
    <div class="set-row"><span>${icon('ear')}${T`ซับสดจากเสียงในคอม`}</span><button class="pill-btn small" id="set-live">${T`เปิด`}</button></div>
    <div class="set-row"><span>${icon('doc')}${T`เก็บซับสดเป็นบทเรียน`}</span><input type="checkbox" id="set-livesave" ${S.set.liveSave !== false ? 'checked' : ''}></div>
    <div class="set-row"><span>${icon('speaker')}${T`เสียงอังกฤษ`}</span><select id="set-ven">${vo('en')}</select><button class="icon-btn" data-test="en" title="${T`ลองฟัง`}">${icon('play')}</button></div>
    <div class="set-row"><span>${icon('speaker')}${T`เสียงจีน`}</span><select id="set-vzh">${vo('zh')}</select><button class="icon-btn" data-test="zh" title="${T`ลองฟัง`}">${icon('play')}</button></div>
    <div class="set-row"><span>${icon('clock')}${T`ความเร็วเสียงอ่าน`}</span><select id="set-speed">${[0.7, 0.8, 0.9, 1, 1.1, 1.2].map((v) => `<option value="${v}" ${(S.set.speed || 1) === v ? 'selected' : ''}>${v}×</option>`).join('')}</select></div>
    <div class="set-row"><span>${icon('cards')}${T`คำใหม่ต่อวัน`}</span><select id="set-new">${[5, 10, 20, 30, 50, 100].map((v) => `<option value="${v}" ${(S.set.newPerDay || 30) === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="set-row"><span>${icon('wave')}${T`อ่านออกเสียงเมื่อคลิกคำ`}</span><input type="checkbox" id="set-autosay" ${S.set.autoSay !== false ? 'checked' : ''}></div>
    <div class="set-row"><span>${icon('target')}${T`วัดระดับคำศัพท์`}</span><button class="pill-btn small" data-place="en">${T`อังกฤษ`}</button><button class="pill-btn small" data-place="zh">${T`จีน`}</button></div>`;
  const dl = $('set-trdl');
  if (dl) dl.onclick = async () => { dl.disabled = true; await api.invoke('tr:download'); renderStatus(); };
  // while the translator downloads, refresh this card every second (stops by itself when done)
  clearTimeout(renderStatus.t);
  if (tr.state === 'downloading') renderStatus.t = setTimeout(() => { if ($('status')) renderStatus(); }, 1000);
  else if (renderStatus.was === 'downloading' && tr.state !== 'dlfail') toast(T`โหลดตัวแปลเสร็จแล้ว — แปลไทยได้เลย`);
  renderStatus.was = tr.state;
  $('set-ven').onchange = (e) => { S.set.voiceEn = +e.target.value; save(); };
  $('set-vzh').onchange = (e) => { S.set.voiceZh = +e.target.value; save(); };
  $('set-speed').onchange = (e) => { S.set.speed = +e.target.value; save(); };
  $('set-new').onchange = (e) => { S.set.newPerDay = +e.target.value; save(); };
  $('set-autosay').onchange = (e) => { S.set.autoSay = e.target.checked; save(); };
  $('set-aiauto').onchange = (e) => { S.set.aiAuto = e.target.checked; save(); };
  $('set-aimode').onchange = (e) => { S.set.aiMode = e.target.value; save(); };
  $('set-livesave').onchange = (e) => { S.set.liveSave = e.target.checked; save(); };
  $('set-live').onclick = () => openLive();
  box.querySelectorAll('[data-test]').forEach((b) => { b.onclick = () => speak(b.dataset.test === 'zh' ? '你好，我们一起学中文吧。' : 'Hello! Let’s learn English together.', b.dataset.test); });
  box.querySelectorAll('[data-place]').forEach((b) => { b.onclick = () => placement(b.dataset.place); });
}

/* ------------------------------------------------------------ placement test: which common words are known already */
export async function placement(lg) {
  const top = native ? await api.invoke('dict:top', { lang: lg, n: lg === 'zh' ? 12000 : 20000 }) : [];
  if (!top || !top.length) return toast(T`ไม่พบไฟล์พจนานุกรม`, { kind: 'err' });
  const bands = lg === 'zh' ? [300, 1000, 2500, 5000, 9000] : [1000, 2500, 5000, 10000, 18000];
  const pick = (hi, lo) => { const pool = top.slice(lo, hi).filter((w) => (lg === 'zh' ? w.length >= 1 : /^[a-z]{3,}$/.test(w))); const out = []; while (out.length < 8 && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]); return out; };
  const sets = bands.map((b, i) => pick(b, i ? bands[i - 1] : 0));
  const res = await htmlBox(`<h3>${lg === 'zh' ? T`วัดระดับคำศัพท์จีน` : T`วัดระดับคำศัพท์อังกฤษ`}</h3>
    <p class="muted">${T`คลิกคำที่คุณรู้ความหมาย (ไม่ต้องแน่ใจ 100%) — โปรแกรมจะไม่ไฮไลต์คำง่ายๆ ที่คุณรู้แล้ว`}</p>
    <div class="place">${sets.map((s, i) => `<div class="place-row"><small class="muted">${T`ระดับ ${i + 1}`}</small>${s.map((w) => `<button class="place-w" data-b="${i}">${esc(w)}</button>`).join('')}</div>`).join('')}</div>
    <div class="modal-btns"><button class="pill-btn" data-x>${T`ข้ามไปก่อน`}</button><button class="pill-btn primary" data-ok>${T`เสร็จแล้ว`}</button></div>`, (m, close) => {
    m.querySelectorAll('.place-w').forEach((b) => { b.onclick = () => b.classList.toggle('on'); });
    m.querySelector('[data-x]').onclick = () => close(null);
    m.querySelector('[data-ok]').onclick = () => close(sets.map((s, i) => m.querySelectorAll(`.place-w.on[data-b="${i}"]`).length / Math.max(1, s.length)));
  });
  S.placed[lg] = true; save();
  if (!res) return;
  let upto = 0;
  res.forEach((r, i) => { if (r >= 0.6) upto = bands[i]; });
  if (!upto) return toast(T`ไม่เป็นไร เริ่มจากคำพื้นฐานกัน — ทุกคำจะไฮไลต์ให้`);
  const words = top.slice(0, upto);
  let heads = words;
  if (lg === 'en') { await prepareEn(words); heads = words.map((w) => (LEMMA.get(w) || [w])[0]); }
  let n = 0;
  for (const h of new Set(heads)) { const k = `${lg}:${h.toLowerCase()}`; if (!S.words[k]) { S.words[k] = { s: 2, t: Date.now(), auto: 1 }; n++; } }
  save();
  bus.emit('words', {});
  toast(T`ตั้ง ${n.toLocaleString()} คำที่ใช้บ่อยว่า "รู้แล้ว" — ถ้าเจอคำที่จริงๆ ไม่รู้ คลิกแล้วกดเก็บได้เลย`);
  renderHome();
}

// the heatmap's squares follow the window size
let rsT = 0;
addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { if ($('view-home').classList.contains('active')) renderHeat(); }, 200); });
