// Word bank (คลังคำ): every card + words marked known / skipped. Search, filter, edit the meaning, play, delete,
// and export as CSV (Excel) or an Anki import file.
import { api, native, T, esc, $, toast, bus, confirmBox } from './core.js';
import { icon } from './icons.js';
import { S, save, setWord, dayKey } from './store.js';
import { speak, removeCard } from './words.js';

const fmtDue = (ms) => {
  const d = Math.round((ms - Date.now()) / 864e5);
  if (ms <= Date.now()) return T`ถึงรอบแล้ว`;
  if (d < 1) return T`วันนี้`;
  return d === 1 ? T`พรุ่งนี้` : T`อีก ${d} วัน`;
};

export function renderWords() {
  const box = $('wl');
  const q = (S.ui.wq || '').trim().toLowerCase();
  const lang = S.ui.wordsLang || 'all', f = S.ui.wordsFilter || 'all';
  const known = Object.entries(S.words).filter(([, v]) => v.s === 2 && !v.auto).map(([k, v]) => ({ k, lang: k.split(':')[0], head: k.slice(k.indexOf(':') + 1), v }));
  const skipped = Object.entries(S.words).filter(([, v]) => v.s === 3).map(([k, v]) => ({ k, lang: k.split(':')[0], head: k.slice(k.indexOf(':') + 1), v }));
  let cards = S.cards.filter((c) => lang === 'all' || c.lang === lang);
  if (f === 'due') cards = cards.filter((c) => c.srs.st !== 0 && c.srs.due <= Date.now());
  if (f === 'new') cards = cards.filter((c) => c.srs.st === 0);
  if (f === 'today') cards = cards.filter((c) => dayKey(new Date(c.c)) === dayKey());
  if (q) cards = cards.filter((c) => [c.head, c.show, c.mean, c.read, c.ex].some((x) => String(x || '').toLowerCase().includes(q)));
  cards.sort((a, b) => b.c - a.c);
  const showCards = f !== 'known' && f !== 'skip';
  const extra = f === 'known' ? known : f === 'skip' ? skipped : [];
  const extraF = extra.filter((x) => (lang === 'all' || x.lang === lang) && (!q || x.head.includes(q)));
  $('wl-count').textContent = showCards ? T`${cards.length} ใบ` : T`${extraF.length} คำ`;
  if (showCards && !cards.length) { box.innerHTML = `<div class="empty-hint muted">${icon('cards')}<span>${q || f !== 'all' ? T`ไม่พบคำที่ตรงกัน` : T`ยังไม่มีบัตรคำ — คลิกคำในหน้า "เรียน" แล้วกด "เก็บเป็นบัตรคำ"`}</span></div>`; return; }
  if (!showCards) {
    box.innerHTML = extraF.length ? `<div class="wl-chips">${extraF.slice(0, 2000).map((x) => `<span class="chip ${x.lang}" data-k="${esc(x.k)}" title="${T`คลิกเพื่อเอาออก (กลับเป็นคำใหม่)`}">${esc(x.head)}${icon('x')}</span>`).join('')}</div>` : `<div class="empty-hint muted">${T`ไม่มีคำในกลุ่มนี้`}</div>`;
    box.querySelectorAll('[data-k]').forEach((el) => { el.onclick = () => { const [l, ...h] = el.dataset.k.split(':'); setWord(l, h.join(':'), 0); renderWords(); }; });
    return;
  }
  box.innerHTML = cards.slice(0, 1500).map((c) => `
    <div class="wl-row glass" data-id="${c.id}">
      <button class="icon-btn" data-say title="${T`ฟังเสียง`}">${icon('speaker')}</button>
      <div class="wl-w"><b class="${c.lang === 'zh' ? 'zh' : ''}">${esc(c.show || c.head)}</b><small>${esc(c.read || '')}</small></div>
      <div class="wl-m" contenteditable="true" spellcheck="false" data-mean title="${T`แก้ความหมายได้`}">${esc(c.mean || '')}</div>
      <div class="wl-ex muted" title="${esc(c.exTh || '')}">${esc(c.ex || '')}</div>
      <div class="wl-due"><span class="badge ${c.srs.st === 0 ? 'hot' : c.srs.due <= Date.now() ? 'ok' : ''}">${c.srs.st === 0 ? T`ยังไม่ทวน` : fmtDue(c.srs.due)}</span></div>
      <button class="icon-btn" data-src title="${c.src ? esc(c.src.title || '') : ''}" ${c.src ? '' : 'disabled'}>${icon('open')}</button>
      <button class="icon-btn" data-del title="${T`ลบ`}">${icon('trash')}</button>
    </div>`).join('');
  box.querySelectorAll('.wl-row').forEach((row) => {
    const c = S.cards.find((x) => x.id === row.dataset.id);
    row.querySelector('[data-say]').onclick = () => speak(c.show || c.head, c.lang);
    row.querySelector('[data-del]').onclick = async () => { if (await confirmBox(T`ลบบัตรคำ "${c.show || c.head}"?`, T`ประวัติการทวนของคำนี้จะหายไป`, T`ลบ`, true)) { removeCard(c.id); renderWords(); } };
    const src = row.querySelector('[data-src]'); if (c.src) src.onclick = () => bus.emit('goto-source', c.src);
    const m = row.querySelector('[data-mean]');
    m.onblur = () => { const v = m.textContent.trim(); if (v !== c.mean) { c.mean = v; save(); toast(T`บันทึกความหมายแล้ว`); } };
    m.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); m.blur(); } e.stopPropagation(); };
  });
}

export function initWords() {
  $('wl-q').value = S.ui.wq || '';
  $('wl-q').oninput = () => { S.ui.wq = $('wl-q').value; renderWords(); };
  const sync = () => {
    document.querySelectorAll('#wl-lang [data-l]').forEach((b) => b.classList.toggle('on', b.dataset.l === (S.ui.wordsLang || 'all')));
    document.querySelectorAll('#wl-filter [data-f]').forEach((b) => b.classList.toggle('on', b.dataset.f === (S.ui.wordsFilter || 'all')));
  };
  document.querySelectorAll('#wl-lang [data-l]').forEach((b) => { b.onclick = () => { S.ui.wordsLang = b.dataset.l; save(); sync(); renderWords(); }; });
  document.querySelectorAll('#wl-filter [data-f]').forEach((b) => { b.onclick = () => { S.ui.wordsFilter = b.dataset.f; save(); sync(); renderWords(); }; });
  sync();
  $('wl-csv').onclick = () => exportCards('csv');
  $('wl-anki').onclick = () => exportCards('anki');
}

const csvCell = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
function srcLink(c) {
  if (!c.src) return '';
  if (c.src.vid) return `https://www.youtube.com/watch?v=${c.src.vid}&t=${Math.floor((c.src.t0 || 0) / 1000)}s`;
  const s = S.sources.find((x) => x.id === c.src.id);
  return (s && s.url) || c.src.title || '';
}
async function exportCards(kind) {
  const lang = S.ui.wordsLang || 'all';
  const cards = S.cards.filter((c) => lang === 'all' || c.lang === lang);
  if (!cards.length) return toast(T`ยังไม่มีบัตรคำให้ส่งออก`);
  const date = dayKey();
  let text, name, bom = false;
  if (kind === 'csv') {
    const head = ['word', 'base', 'reading', 'meaning_th', 'english', 'sentence', 'sentence_th', 'language', 'source', 'added', 'next_review'];
    text = [head.join(','), ...cards.map((c) => [c.show || c.head, c.head, c.read, c.mean, c.en, c.ex, c.exTh, c.lang, srcLink(c), new Date(c.c).toISOString().slice(0, 10), c.srs.due ? new Date(c.srs.due).toISOString().slice(0, 10) : ''].map(csvCell).join(','))].join('\r\n');
    name = `Prism LLearn ${date}.csv`; bom = true; // BOM: Excel then shows Thai / Chinese correctly
  } else {
    // Anki "Import File": tab separated, HTML allowed, front = word (+ sentence), back = reading + meaning + translation
    const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ');
    text = ['#separator:tab', '#html:true', '#tags column:3', ...cards.map((c) => [
      clean(`<div style="font-size:1.6em">${esc(c.show || c.head)}</div>${c.ex ? `<div style="color:#666">${esc(c.ex)}</div>` : ''}`),
      clean(`<div>${esc(c.read || '')}</div><div style="font-size:1.3em">${esc(c.mean || '')}</div>${c.en ? `<div style="color:#888">${esc(c.en)}</div>` : ''}${c.exTh ? `<div style="color:#666">${esc(c.exTh)}</div>` : ''}`),
      `PrismLLearn ${c.lang}`].join('\t'))].join('\n');
    name = `Prism LLearn ${date} (Anki).txt`;
  }
  if (!native) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([(bom ? '﻿' : '') + text])); a.download = name; a.click(); return; }
  const p = await api.invoke('pick:save', { kind: kind === 'csv' ? 'csv' : 'txt', name });
  if (!p) return;
  const r = await api.invoke('fs:write', { path: p, text, bom });
  if (r && r.ok) toast(T`ส่งออก ${cards.length} คำแล้ว`, { action: () => api.invoke('reveal', p), label: T`เปิดโฟลเดอร์` });
  else toast(T`บันทึกไฟล์ไม่สำเร็จ`, { kind: 'err' });
}
