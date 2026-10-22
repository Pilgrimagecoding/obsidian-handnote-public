// Synthetic handwriting used by the browser tests. Not real Apple Pencil data: it exercises the
// pipeline (pressure ramps, speed changes, sharp corners, small glyphs) deterministically.

// 永 — the classic "eight principles" character, box 0..100
export const YONG = [
  [[47, 6], [51, 10], [55, 16]],
  [[28, 26], [45, 25], [62, 23], [61, 40], [60, 60], [59, 82], [57, 90], [50, 84]],
  [[13, 46], [26, 45], [38, 43], [30, 52], [22, 61], [14, 70]],
  [[84, 33], [77, 40], [70, 47], [64, 53]],
  [[63, 52], [70, 60], [78, 70], [86, 78], [95, 84]],
];

// a cursive-like "lll" loop line and a quick circle
export function loops(n = 4) {
  const pts = [];
  for (let i = 0; i <= 120 * n; i++) {
    const t = i / 120;
    pts.push([t * 22 + 10 * Math.sin(t * Math.PI * 2) * 0.6, 50 - 30 * Math.abs(Math.sin(t * Math.PI))]);
  }
  return [pts];
}

export function circle(r = 40) {
  const pts = [];
  for (let i = 0; i <= 64; i++) pts.push([50 + r * Math.cos((i / 64) * Math.PI * 2), 50 + r * Math.sin((i / 64) * Math.PI * 2)]);
  return [pts];
}

/** Densify a polyline (Catmull-Rom) into timed pen samples with a natural pressure profile. */
export function toSamples(poly, { x0, y0, scale, speed = 120, hz = 240, pBase = 0.32, t0 = 0 }) {
  const P = poly.map(([x, y]) => [x0 + x * scale, y0 + y * scale]);
  const dense = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    for (let k = 0; k < 16; k++) {
      const t = k / 16, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  dense.push(P[P.length - 1]);
  let len = 0;
  const cum = [0];
  for (let i = 1; i < dense.length; i++) {
    len += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
    cum.push(len);
  }
  const dur = Math.max(40, (len / speed) * 1000);
  const n = Math.max(2, Math.round((dur / 1000) * hz));
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    // ease-in-out: pen accelerates then decelerates
    const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    const target = e * len;
    while (j < cum.length - 2 && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const w = (target - cum[j]) / seg;
    const x = dense[j][0] + (dense[j + 1][0] - dense[j][0]) * w;
    const y = dense[j][1] + (dense[j + 1][1] - dense[j][1]) * w;
    const ramp = Math.min(1, u / 0.12) * Math.min(1, (1 - u) / 0.15);
    const p = Math.max(0.02, pBase * (0.35 + 0.65 * ramp) * (1 + 0.15 * Math.sin(u * 9)));
    out.push({ x, y, p, t: t0 + (i * 1000) / hz });
  }
  return out;
}
