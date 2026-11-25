// When to show a card again — FSRS-4.5 (the open spaced-repetition model Anki uses) with short learning steps for new
// and forgotten cards. Grade: 1 ลืม (again) · 2 ยาก (hard) · 3 ได้ (good) · 4 ง่าย (easy). Aims for 90% recall.
const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const MIN = 60e3, DAY = 864e5;
const clampD = (d) => Math.min(10, Math.max(1, d));
const d0 = (g) => clampD(W[4] - (g - 3) * W[5]);
const s0 = (g) => W[g - 1];
const recall = (days, s) => Math.pow(1 + days / (9 * s), -1);

export const newSrs = () => ({ st: 0, due: 0, s: 0, d: 0, reps: 0, lapses: 0, last: 0, ivl: 0 });

/** → the card's next srs (does not change the given one) */
export function grade(srs, g, now = Date.now()) {
  const c = { ...newSrs(), ...srs };
  c.reps++;
  if (c.st === 0 || c.st === 1 || c.st === 3) { // new / learning / relearning: short steps first
    if (!c.s) { c.s = s0(g); c.d = d0(g); }
    if (g === 1) { c.st = c.st === 3 ? 3 : 1; c.due = now + MIN; }
    else if (g === 2) { c.st = c.st === 3 ? 3 : 1; c.due = now + 6 * MIN; }
    else if (g === 3 && c.st === 0) { c.st = 1; c.due = now + 10 * MIN; }
    else { // graduate
      if (g === 4 && c.st === 0) { c.s = s0(4); c.d = d0(4); }
      c.st = 2; c.ivl = Math.max(1, Math.round(g === 4 ? Math.max(c.s, 4) : c.s)); c.due = now + c.ivl * DAY;
    }
  } else { // review
    const days = Math.max(0, (now - (c.last || now)) / DAY);
    const r = recall(days, c.s);
    const dNew = c.d - W[6] * (g - 3);
    c.d = clampD(W[7] * d0(3) + (1 - W[7]) * dNew);
    if (g === 1) {
      c.lapses++;
      c.s = Math.max(0.1, W[11] * Math.pow(c.d, -W[12]) * (Math.pow(c.s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)));
      c.st = 3; c.due = now + 10 * MIN;
    } else {
      const bonus = (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1);
      c.s = c.s * (Math.exp(W[8]) * (11 - c.d) * Math.pow(c.s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * bonus + 1);
      let ivl = Math.max(1, Math.round(c.s));
      if (g === 2) ivl = Math.max(1, Math.min(ivl, Math.round((c.ivl || 1) * 1.2) || 1));
      if (ivl > 6) ivl = Math.round(ivl * (0.95 + Math.random() * 0.1)); // a little spread so cards don't bunch up
      c.ivl = Math.min(ivl, 3650); c.due = now + c.ivl * DAY;
    }
  }
  c.last = now;
  return c;
}
/** "1 นาที", "3 วัน" … for the grade buttons */
export function preview(srs, g, T) {
  const ms = grade(srs, g, Date.now()).due - Date.now();
  if (ms < 3600e3) return T`${Math.max(1, Math.round(ms / 60e3))} นาที`;
  if (ms < DAY) return T`${Math.round(ms / 3600e3)} ชม.`;
  const d = Math.round(ms / DAY);
  if (d < 31) return T`${d} วัน`;
  if (d < 365) return T`${Math.round(d / 30)} เดือน`;
  return T`${(d / 365).toFixed(1)} ปี`;
}
export const isDue = (c, now = Date.now()) => (c.srs || {}).due <= now;
