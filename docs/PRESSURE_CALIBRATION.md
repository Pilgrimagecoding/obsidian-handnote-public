# Pressure calibration (v0.2)

## Real data (first iPad report, 0.2.0-beta.1 → beta.2)

Apple Pencil in Obsidian 1.14.5 (`docs/device-reports/2026-10-18-ipad-0.2.0-beta.1.md`): pressure
REAL, **median 0.123, p95 0.337, max 0.469** — nothing above 0.5. beta.1 assumed typical 0.3 and
mapped the curve up to 0.85, so most of the width range was spent on pressure this writer never uses.

Width factor (× nominal width) at the measured pressures (sensitivity as in the presets):

| pressure | 0.02 | 0.05 | 0.08 | **0.123 (median)** | 0.2 | 0.337 (p95) | 0.469 (max) |
|---|---|---|---|---|---|---|---|
| A · Baseline (frozen, typical 0.3) | 0.42 | 0.52 | 0.60 | **0.69** | 0.84 | 1.05 | 1.23 |
| B beta.1 (soft knee, typical 0.3, top 0.85) | 0.26 | 0.34 | 0.42 | **0.53** | 0.74 | 1.04 | 1.12 |
| **B beta.2** (gamma, typical 0.12, heavy 0.45) | 0.31 | 0.65 | 0.82 | **1.01** | 1.29 | 1.68 | 1.96 |

Edge roughness (σ of Δr / r) with pressure noise around this writer's pressure:

| noise | A | B beta.1 | B beta.2 |
|---|---|---|---|
| 0.12 ± 0.02 | 0.0024 | 0.0033 | **0.0023** |
| 0.20 ± 0.03 | 0.0024 | 0.0042 | 0.0025 |
| 0.12 ± 0.04 (heavy noise) | 0.0046 | 0.0089 | 0.0063 |

Why gamma: in the narrower real range the typical pressure falls on the steep part of the soft-knee
curve, which amplifies noise (0.0045 at 0.12 ± 0.02 with knee and smoothing 0.7, vs 0.0023 with
gamma and smoothing 0.85). The user had also switched to gamma by hand. A step from 0.06 → 0.4 is still
followed (width ratio 2.6). Real Pencil noise was not measured; the synthetic noise is an upper
bound guess.

Compatibility: `heavyPressure` is stored per stroke. Strokes without it (written by beta.1) use the
old top 0.85 and render identically (`tests/fixtures/engine-v2-beta1-geometry.json`, 12 cases).
A · Baseline stays frozen, so it also draws this writer's normal writing at ≈ 0.69×.

Still unknown: whether this matches GoodNotes, and whether other writers use the same range
(one device, one writer). Use **Calibrate from my writing** per device.

---

## What exists

| | Fountain **A · v0.1 Baseline** | Fountain **B · Experimental** |
|---|---|---|
| Stroke `engine` | 1 (unchanged from v0.1, bit-for-bit — 48 snapshot checks) | 2 |
| Pressure filter | time EMA, attack 6 ms / release 16 ms | adaptive: 4–40 ms (`pressureSmoothing`), shortened when the **signed** pressure rate is high (deliberate press/release), long for zero-mean sensor noise |
| Pressure → width | gamma 0.65 around fixed typical 0.3, tanh soft ceiling | curve (gamma / linear / smoothstep / **soft knee**) mapped onto `[minWidthRatio, maxWidthRatio]` × nominal width, normalized so **your typical pressure = nominal width** |
| Arc-length width smoothing | 0.35 + 0.6·w | 0.3 + 0.45·w (pressure is already filtered) |
| Entry taper | up to 50 % thinner over 1.2 + 2.2·w × tapering | Pencil: ≥ 82 % (the real pressure ramp forms 起笔); mouse/finger 60 % |
| Exit taper | up to 6.6 units, min 14 % (fast) | ≤ 22 % of the stroke length, weakened by the measured real pressure release |
| Geometry (One Euro + corner release + Catmull-Rom) | shared, unchanged | shared, unchanged |

Geometric smoothing (coordinates) and pressure smoothing are independent stages; changing one never
reshapes 口 / 日 / 国 corners (unit test: corner error < 1.2 screen px for 6- and 12-unit strokes).

## Synthetic comparison (Node, `build/measure.ts`, nominal width 1.6, zoom 1.7)

Stroke width at constant pressure:

| pressure | 0.05 | 0.1 | 0.2 | 0.3 | 0.5 | 0.8 | 1.0 |
|---|---|---|---|---|---|---|---|
| A · Baseline | 0.80 | 1.00 | 1.30 | 1.55 | 1.97 | 2.38 | 2.54 |
| B · Experimental (soft knee) | 0.53 | 0.74 | 1.15 | 1.57 | 1.79 | 2.08 | 2.13 |

| metric | A | B |
|---|---|---|
| heavy (p=1) / light (p=0.1) width | 2.55× | 2.88× |
| edge roughness with ±0.06 pressure noise (σ of Δr / r) | 0.0031 | **0.0019** |
| step 0.12 → 0.7 pressure, width ratio | 2.13 | 2.41 |

Curves evaluated for B (same test): gamma 2.35–2.69× / roughness 0.0047; smoothstep 5.65× but
roughness 0.0117 (noisy, rejected as default); soft knee 2.80–2.88× / 0.0019–0.0021 (chosen).

Interpretation (synthetic only): B draws **light writing thinner**, keeps **normal writing at
nominal width**, grows **gently under heavy pressure**, and has **smoother edges**. Whether this is
closer to GoodNotes is **UNKNOWN** until tested on the iPad.

## How to calibrate with real data

1. ⋯ menu → **Collect input diagnostics** ON.
2. Write a few normal lines with the Pencil (your natural pressure, no effort).
3. ⋯ menu → **Copy input diagnostics** → paste into a note. Check:
   * `verdict: REAL` — the Pencil delivers varying pressure in Obsidian. `CONSTANT` / `NONE` means the
     web view does not provide pressure (then widths fall back to the no-pressure model).
   * `median` — your typical pressure; the histogram shows your light-to-heavy range.
   * `sample interval p50` — ≈4.2 ms means 240 Hz coalesced Pencil samples.
4. Pen panel (tap the active fountain pen) → **Advanced → Calibrate from my writing (typical / heavy)**
   maps your median to the nominal width and your p99 to the maximum width.
5. Adjust **Min width** (light strokes) and **Max width** (heavy strokes) and the curve; compare A/B
   on the same sentence.

Send the copied report with the test results; the defaults will be updated from real data.

## Not measured

Pen-tip-to-pixel latency (not observable from inside a web view), real Apple Pencil pressure
distribution, WKWebView sampling rate in the Obsidian iPad app.
