// The word card that opens when a word is clicked: meaning in Thai (dictionary + "in this sentence"), reading (IPA /
// pinyin), voice, English definitions, and Keep / Known / Skip. Works for a single word or a selected phrase.
import { T, esc, $, bus } from './core.js';
import { icon } from './icons.js';
import { S, wstat, setWord, bump } from './store.js';
import { lookup, speak, addCard, findCard, removeCard, translate } from './words.js';

const POS = { n: 'น.', v: 'ก.', adj: 'ว.', adv: 'กว.', prep: 'บ.', conj: 'สัน.', pron: 'ส.', interj: 'อ.', phr: 'วลี', det: 'นห.', num: 'จน.', part: 'คำช่วย', contr: 'คำย่อ' };
const posName = (p) => T(POS[p] || p || '');
let cur = null; // { lang, head, surface, sentence, sentTh, src, anchor, onPlay, data }

export function closeWord() { const p = $('wordpop'); if (p) p.classList.add('hidden'); cur = null; bus.emit('wordpop', null); }
export const wordOpen = () => !!cur;

/** o: { lang, surface, sentence, sentTh (Promise|string), src:{id,kind,t0,t1,title,url}, anchor (element|rect), onPlay(), head } */
export async function openWord(o) {
  cur = { ...o };
  bump('l');
  const pop = $('wordpop');
  pop.classList.remove('hidden');
  pop.innerHTML = `<div class="wp-load"><div class="progress indet"><i></i></div></div>`;
  place(pop, o.anchor);
  bus.emit('wordpop', o);
  const me = cur;
  const r = await lookup(o.lang, o.surface);
  if (cur !== me) return;
  cur.data = r;
  cur.head = (r && r.head) || o.head || o.surface.toLowerCase();
  render();
  // Thai for the sentence (to point at the meaning used here) and, when the dictionary has no Thai, for the word itself
  Promise.resolve(o.sentTh || (o.sentence ? translate(o.sentence, o.lang, { front: true }) : null)).then((th) => { if (cur === me && th) { cur.sentTh = th; render(); } });
  if (!thaiList(r).length) translate(o.surface, o.lang, { front: true }).then((th) => { if (cur === me && th) { cur.wordTh = th; render(); } });
  if (S.set.autoSay !== false) speak(o.surface, o.lang);
}

function thaiList(r) {
  if (!r || !r.ok) return [];
  const e = r.e, out = [];
  const add = (t, p) => { t = String(t).trim(); if (t && !out.some((x) => x.t === t)) out.push({ t, p }); };
  if (r.lang === 'zh') { for (const t of e[1] || []) add(t); }
  else {
    for (const [t, p] of e[3] || []) add(t, p);
    for (const t of e[2] || []) add(t);
    if (r.also && r.also.e) { for (const [t, p] of r.also.e[3] || []) add(t, p); for (const t of r.also.e[2] || []) add(t); }
  }
  return out;
}
// the dictionary meaning that shows up in the sentence's translation = the one meant here
function bestIn(list, sentTh) {
  if (!sentTh) return -1;
  let best = -1, len = 0;
  list.forEach((x, i) => { const core = x.t.replace(/^(การ|ความ|ที่|ทำให้)/, ''); if (core.length >= 2 && sentTh.includes(core) && core.length > len) { best = i; len = core.length; } });
  return best;
}

function render() {
  if (!cur) return;
  const pop = $('wordpop'), r = cur.data || {}, e = r.e || [];
  const zh = cur.lang === 'zh';
  const th = thaiList(r);
  const hit = bestIn(th, cur.sentTh);
  if (hit > 0) th.unshift(th.splice(hit, 1)[0]);
  const reading = zh ? (e[0] || []).map((x) => x[0]).filter((v, i, a) => a.indexOf(v) === i).join(' · ') : (e[0] || '');
  const st = wstat(cur.lang, cur.head);
  const card = findCard(cur.lang, cur.head);
  const lemmaNote = !zh && r.head && r.head !== cur.surface.toLowerCase() ? `<span class="wp-lemma">${T`รูปเดิม`} <b>${esc(r.head)}</b></span>` : '';
  const hsk = zh && e[2] ? `<span class="badge cool">HSK ${e[2]}</span>` : '';
  const rank = !zh && e[4] ? `<span class="badge ${e[4] <= 3000 ? 'ok' : e[4] <= 12000 ? '' : 'hot'}" title="${T`ยิ่งเลขน้อย ยิ่งเจอบ่อย`}">${T`คำที่พบบ่อยอันดับ ${e[4].toLocaleString()}`}</span>` : '';
  const defs = zh ? (e[0] || []).map((x) => `<div class="wp-def"><b>${esc(x[0])}</b> ${esc(x[1].slice(0, 5).join('; '))}</div>`).join('')
    : (e[1] || []).map(([p, g]) => `<div class="wp-def"><i>${esc(posName(p))}</i> ${g.slice(0, 2).map(esc).join(' · ')}${g.length > 2 ? `<span class="wp-more" title="${esc(g.slice(2).join(' · '))}"> +${g.length - 2}</span>` : ''}</div>`).join('');
  const sent = cur.sentence ? `<div class="wp-sent"><div class="wp-sent-src">${hl(cur.sentence, cur.surface)}</div><div class="wp-sent-th">${cur.sentTh ? esc(cur.sentTh) : `<span class="muted">${T`กำลังแปลประโยค…`}</span>`}</div></div>` : '';
  pop.innerHTML = `
    <div class="wp-head">
      <div class="wp-word">${esc(cur.surface)}</div>
      <button class="icon-btn wp-say" data-a="say" title="${T`ฟังเสียง (V)`}">${icon('speaker')}</button>
      ${cur.onPlay ? `<button class="icon-btn" data-a="play" title="${T`ฟังประโยคนี้จากคลิป (P)`}">${icon('replay')}</button>` : ''}
      <span class="ed-fill"></span>
      <button class="icon-btn" data-a="x" title="${T`ปิด (Esc)`}">${icon('x')}</button>
    </div>
    <div class="wp-read">${reading ? `<span class="wp-ipa">${esc(reading)}</span>` : ''}${lemmaNote}${hsk}${rank}</div>
    <div class="wp-th">${th.length ? th.slice(0, 7).map((x, i) => `<button class="wp-mean${i === 0 && hit >= 0 ? ' hit' : ''}" data-mean="${esc(x.t)}" title="${T`ใช้ความหมายนี้ในบัตรคำ`}">${x.p ? `<i>${esc(posName(x.p))}</i>` : ''}${esc(x.t)}${i === 0 && hit >= 0 ? `<em>${T`ในประโยคนี้`}</em>` : ''}</button>`).join('')
      : cur.wordTh ? `<button class="wp-mean hit" data-mean="${esc(cur.wordTh)}">${esc(cur.wordTh)}<em>${T`แปลด้วย AI ในเครื่อง`}</em></button>` : `<span class="muted">${r.ok === false && r.reason === 'nodict' ? T`ไม่พบไฟล์พจนานุกรม` : T`กำลังหาความหมาย…`}</span>`}</div>
    ${defs ? `<div class="wp-defs">${defs}</div>` : ''}
    ${sent}
    <div class="wp-acts">
      <button class="pill-btn ${st === 1 ? 'on' : 'primary'}" data-a="keep" title="${T`เก็บไว้ทบทวน (S)`}">${icon(st === 1 ? 'check' : 'plus')}<span>${st === 1 ? T`อยู่ในบัตรคำแล้ว` : T`เก็บเป็นบัตรคำ`}</span><kbd>S</kbd></button>
      <button class="pill-btn ${st === 2 ? 'on' : ''}" data-a="known" title="${T`รู้แล้ว ไม่ต้องไฮไลต์ (K)`}">${icon('check')}<span>${T`รู้แล้ว`}</span><kbd>K</kbd></button>
      <button class="pill-btn ${st === 3 ? 'on' : ''}" data-a="skip" title="${T`ไม่ต้องเรียน เช่น ชื่อคน (X)`}">${icon('x')}<span>${T`ข้าม`}</span><kbd>X</kbd></button>
      ${card ? `<button class="icon-btn" data-a="del" title="${T`ลบบัตรคำนี้`}">${icon('trash')}</button>` : ''}
    </div>`;
  pop.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => act(b.dataset.a); });
  pop.querySelectorAll('[data-mean]').forEach((b) => { b.onclick = () => keep(b.dataset.mean); });
  place(pop, cur.anchor);
}
function hl(s, w) {
  const i = s.toLowerCase().indexOf(w.toLowerCase());
  return i < 0 ? esc(s) : esc(s.slice(0, i)) + `<mark>${esc(s.slice(i, i + w.length))}</mark>` + esc(s.slice(i + w.length));
}
function keep(mean) {
  const r = cur.data || {}, e = r.e || [];
  const th = thaiList(r);
  const best = th[Math.max(0, bestIn(th, cur.sentTh))];
  const reading = cur.lang === 'zh' ? ((e[0] || [])[0] || [])[0] || '' : e[0] || '';
  const en = cur.lang === 'zh' ? ((e[0] || [])[0] || [, []])[1].slice(0, 3).join('; ') : ((e[1] || [])[0] || [, []])[1].slice(0, 1).join('');
  addCard({ lang: cur.lang, head: cur.head, show: cur.surface, read: reading, mean: mean || (best && best.t) || cur.wordTh || '', en, ex: cur.sentence || '', exTh: cur.sentTh || '', src: cur.src || null });
  render();
}
export function act(a) {
  if (!cur) return false;
  if (a === 'x') closeWord();
  else if (a === 'say') speak(cur.surface, cur.lang);
  else if (a === 'play') cur.onPlay && cur.onPlay();
  else if (a === 'keep') { if (wstat(cur.lang, cur.head) === 1 && findCard(cur.lang, cur.head)) { closeWord(); return true; } keep(); }
  else if (a === 'known') { setWord(cur.lang, cur.head, wstat(cur.lang, cur.head) === 2 ? 0 : 2); const c = findCard(cur.lang, cur.head); if (c && wstat(cur.lang, cur.head) === 2) c.known = true; closeWord(); }
  else if (a === 'skip') { setWord(cur.lang, cur.head, wstat(cur.lang, cur.head) === 3 ? 0 : 3); closeWord(); }
  else if (a === 'del') { const c = findCard(cur.lang, cur.head); if (c) removeCard(c.id); render(); }
  return true;
}
/** keys while the card is open: S K X V P Esc */
export function wordKey(e) {
  if (!cur || e.ctrlKey || e.altKey || e.target.closest('input, textarea')) return false;
  const k = e.key.toLowerCase();
  const map = { s: 'keep', k: 'known', x: 'skip', v: 'say', p: 'play', escape: 'x' };
  if (!map[k]) return false;
  e.preventDefault(); e.stopPropagation();
  return act(map[k]);
}

function place(pop, a) {
  if (!a) return;
  const r = a.getBoundingClientRect ? a.getBoundingClientRect() : a;
  const w = pop.offsetWidth || 380, h = pop.offsetHeight || 220;
  let x = r.left + r.width / 2 - w / 2, y = r.bottom + 10;
  if (y + h > innerHeight - 10) y = r.top - h - 10;
  y = Math.max(60, Math.min(innerHeight - h - 10, y)); // anchor scrolled away → keep the card on screen
  x = Math.max(10, Math.min(innerWidth - w - 10, x));
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
}
addEventListener('pointerdown', (e) => { if (cur && !e.target.closest('#wordpop') && !e.target.closest('.tok')) closeWord(); }, true);
addEventListener('resize', () => { if (cur) place($('wordpop'), cur.anchor); });
