// forest: a woodland drawn as glyph tiles behind the page.
//
// Same visual grammar as ascii-pond (square tiles on a fine grid, glyphs etched on top), but a
// landscape instead of creatures: distant ridges, layered conifers, a mist band, grass that leans
// with the wind, and small lives in it (birds and falling leaves by day, fireflies and stars at
// night). Light theme is day, dark theme is night.
//
// The still layers are painted once per size/theme into offscreen canvases; only the nearest trees,
// grass and the particles are redrawn while it runs. It exposes the same instance shape as
// ascii-pond's mount(), so the page can swap one engine for the other.
import { clamp, smoothstep, mix, shade, packRgb, hash3, valueNoise } from "../vendor/ascii-pond/util.js";

const CELL_SCALE = Math.SQRT1_2;
const FONT = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const NEAR_REFRESH = 1000 / 14;
const IGNORE = "a, button, input, textarea, select, label, [data-pond-ignore], [data-pond-avoid]";

// ─── palettes ───────────────────────────────────────────────────────────────
export const LIGHT = {
  light: true,
  page: [245, 244, 241],
  ink: [38, 37, 35],
  glyphTo: [30, 34, 30],
  glyphMix: 0.5,
  sun: [238, 186, 118],
  cloud: [238, 238, 234],
  cloudShade: [206, 208, 204],
  ridge: [[196, 202, 204], [176, 188, 186]],
  snow: [250, 250, 247],
  far: [[150, 170, 160], [140, 162, 154], [158, 174, 158]],
  farGround: [154, 172, 160],
  mid: [[108, 140, 112], [96, 130, 108], [122, 148, 106], [88, 122, 104]],
  midGround: [118, 146, 108],
  near: [[66, 100, 76], [56, 92, 80], [78, 110, 72], [62, 96, 66]],
  autumn: [[212, 142, 86], [222, 180, 104], [200, 116, 82]],
  trunk: [116, 92, 72],
  ground: [[98, 128, 84], [88, 118, 80]],
  grass: [70, 104, 66],
  flowers: [[222, 128, 108], [234, 192, 92], [252, 252, 248], [168, 142, 204]],
  leaves: [[132, 160, 92], [218, 166, 82], [206, 122, 70]],
  bird: [74, 72, 68],
  mist: 0.42,
  rim: [170, 196, 126],
  alpha: { ridge: 0.72, far: 0.78, mid: 0.9, near: 0.96 },
};

export const DARK = {
  light: false,
  page: [26, 25, 23],
  ink: [255, 247, 240],
  glyphTo: [170, 196, 186],
  glyphMix: 0.32,
  moon: [238, 230, 206],
  star: [238, 232, 214],
  ridge: [[62, 70, 84], [44, 54, 60]],
  snow: [112, 120, 134],
  far: [[44, 54, 60], [42, 52, 60], [46, 56, 58]],
  farGround: [40, 48, 54],
  mid: [[34, 50, 50], [32, 48, 52], [38, 52, 48], [31, 47, 48]],
  midGround: [27, 35, 33],
  near: [[13, 20, 19], [12, 19, 20], [15, 22, 19], [12, 20, 18]],
  autumn: [[58, 46, 36], [62, 52, 38], [54, 40, 34]],
  trunk: [36, 30, 27],
  ground: [[15, 21, 18], [14, 19, 17]],
  grass: [60, 86, 70],
  flowers: [[120, 84, 78], [126, 112, 70], [150, 150, 140], [102, 92, 126]],
  firefly: [226, 238, 140],
  mist: 0.4,
  rim: [92, 124, 120],
  alpha: { ridge: 0.85, far: 0.9, mid: 0.95, near: 1 },
};

// ─── small helpers ──────────────────────────────────────────────────────────
const fbm = (x, seed) => (valueNoise(x, 0.5, seed) * 0.6 + valueNoise(x * 2.1, 3.5, seed + 1) * 0.28 + valueNoise(x * 4.3, 7.5, seed + 2) * 0.12);
const pick = (list, h) => list[Math.min(list.length - 1, Math.floor(h * list.length))];
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A grid of tiles with glyphs; later puts cover earlier ones. */
class Layer {
  constructor(cols, rows) {
    const n = cols * rows;
    this.cols = cols;
    this.rows = rows;
    this.tile = new Uint32Array(n);
    this.ta = new Float32Array(n);
    this.glyph = new Uint16Array(n);
    this.gc = new Uint32Array(n);
    this.ga = new Float32Array(n);
    this.mark = new Uint8Array(n);
    this.used = [];
    this.mask = null;
    this.canvas = document.createElement("canvas");
  }
  clear() {
    for (const i of this.used) { this.mark[i] = 0; this.ta[i] = 0; this.ga[i] = 0; this.glyph[i] = 0; }
    this.used.length = 0;
  }
  /** tile: rgb or null to keep what is there; glyph: a character, "" for none. */
  put(c, r, tile, ta, glyph, gc, ga) {
    c = Math.round(c); r = Math.round(r);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return;
    if (this.mask) {
      const m = this.mask(c, r);
      if (m <= 0 || hash3(c, r, 91) > m) return;
      if (m < 1) { ta *= 0.55 + 0.45 * m; ga *= 0.55 + 0.45 * m; }
    }
    const i = r * this.cols + c;
    if (!this.mark[i]) { this.mark[i] = 1; this.used.push(i); }
    if (tile) { this.tile[i] = packRgb(tile); this.ta[i] = ta; }
    this.glyph[i] = glyph ? glyph.charCodeAt(0) : 0;
    if (glyph) { this.gc[i] = packRgb(gc); this.ga[i] = ga; }
  }
}

// ─── the scene: geometry, built once per size ───────────────────────────────
/**
 * Everything is placed in cell units with a fixed seed, so a resize keeps the composition.
 * `framed` scenes (the garden column) dissolve at their left and right edges.
 */
function compose(cols, rows, framed) {
  const R = rows, C = cols;
  const F = framed ? Math.round(R * 0.66) : Math.round(clamp(R * 0.5, 18, 58));
  const random = rng(20261031);
  // Mountains: a few named peaks with noise on their flanks, so the skyline has a shape.
  const peaks = [];
  for (let k = 0, n = framed ? 3 : 5; k < n; k++) {
    peaks.push({ x: C * (k + 0.15 + random() * 0.7) / n, h: 0.3 + random() * 0.7, w: C * (0.035 + random() * 0.06) * (framed ? 1.6 : 1) });
  }
  const range = (x) => {
    let v = 0;
    for (const p of peaks) v = Math.max(v, p.h * Math.exp(-Math.abs(x - p.x) / p.w));
    const ridged = 1 - Math.abs(2 * valueNoise(x * 0.07, 1.5, 17) - 1);
    return v * (0.82 + 0.18 * ridged) + ridged * 0.16 + (fbm(x * 0.2, 13) - 0.5) * 0.08;
  };
  const ridges = [
    { top: (x) => R - F * (0.6 + 0.42 * range(x)), depth: 10 },
    { top: (x) => R - F * (0.4 + 0.3 * fbm(x * 0.05 + 9, 23)), depth: 8, forested: true },
  ];
  const farBase = (x) => R - F * 0.36 + (fbm(x * 0.05, 31) - 0.5) * 3;
  const midBase = (x) => R - F * 0.17 + (fbm(x * 0.06, 37) - 0.5) * 2;
  const groundTop = (x) => R - 2 - Math.round(fbm(x * 0.07, 41) * 2.2);

  const far = [];
  for (let x = -2; x < C + 2; x += 1.4 + random() * 1.8) {
    far.push({ x, base: farBase(x), h: Math.max(3, F * (0.09 + random() * 0.09)), tone: random(), seed: far.length });
  }
  const mid = [];
  for (let x = -3; x < C + 3; x += 3.5 + random() * 5.5) {
    if (fbm(x * 0.05, 43) < 0.36) continue;
    const round = random() < 0.24;
    mid.push({ x: x + random(), base: midBase(x) + random() * 2.5, h: Math.max(5, F * (round ? 0.16 + random() * 0.1 : 0.14 + random() * 0.24)), round, autumn: round && random() < 0.4, tone: random(), seed: 100 + mid.length });
  }
  mid.sort((a, b) => a.base - b.base);
  // Near trees frame the page from both sides; the middle stays open meadow.
  const nearSpots = framed
    ? [[0.03, 0.92, 0], [0.11, 0.72, 0], [0.19, 0.42, 1], [0.86, 0.6, 0], [0.95, 0.86, 0]]
    : [[0.015, 0.96, 0], [0.065, 0.78, 0], [0.12, 0.56, 0], [0.2, 0.36, 1], [0.79, 0.4, 1], [0.875, 0.62, 0], [0.93, 0.9, 0], [0.985, 0.74, 0]];
  const near = nearSpots.map(([fx, fh, round], k) => {
    const x = Math.round(fx * C + (random() - 0.5) * 2);
    const h = Math.min(R - 3, Math.max(8, F * fh * (0.92 + random() * 0.16)));
    return { x, base: groundTop(x) + 1, h, round: Boolean(round), autumn: Boolean(round) && k % 2 === 1, tone: random(), seed: 300 + k };
  });
  const bushes = [];
  for (let k = 0; k < Math.round(C / 26); k++) {
    const x = Math.round(random() * C);
    bushes.push({ x, base: groundTop(x) + 1, w: 3 + Math.round(random() * 4), h: 2 + Math.round(random() * 2), tone: random(), seed: 500 + k });
  }
  const sky = framed ? { x: C * 0.28, y: R * 0.17 } : { x: C * 0.8, y: R * 0.11 };
  const moon = framed ? { x: C * 0.3, y: R * 0.17 } : { x: C * 0.2, y: R * 0.11 };
  const stars = [];
  const starCount = Math.round(C * R * 0.011);
  for (let k = 0; k < starCount; k++) {
    const x = random() * C, y = Math.pow(random(), 1.4) * (R - F * 0.7);
    stars.push({ x, y, bright: random() < 0.12, phase: random() * 6.28, speed: 0.4 + random() * 1.2 });
  }
  const clouds = [];
  for (let k = 0; k < (framed ? 2 : 4); k++) {
    const w = 12 + random() * 14, h = 3.5 + random() * 2.5;
    const puffs = [];
    for (let j = 0, n = 3 + Math.floor(random() * 3); j < n; j++) puffs.push([w * (j + 0.5) / n, h * (0.4 + 0.6 * Math.sin((Math.PI * (j + 0.5)) / n)) * (0.8 + random() * 0.4)]);
    const cells = [];
    for (let r = -Math.ceil(h * 1.1); r <= 0; r++) {
      for (let c = -2; c <= w + 2; c++) {
        let inside = 0;
        for (const [px, pr] of puffs) inside = Math.max(inside, 1 - (Math.pow((c - px) / (pr * 1.5), 2) + Math.pow(r / pr, 2)));
        if (inside > 0) cells.push({ c, r, k: inside, top: -r / h });
      }
    }
    clouds.push({ x: random() * C, y: R * (framed ? 0.3 + k * 0.1 : 0.08 + random() * 0.24), w, cells, speed: 0.18 + random() * 0.3, seed: 700 + k });
  }
  const mask = framed
    ? (c) => smoothstep(0, 7, c) * smoothstep(0, 7, C - 1 - c)
    : null;
  return { C, R, F, framed, ridges, far, mid, near, bushes, sky, moon, stars, clouds, groundTop, mask };
}

// ─── drawing shapes into layers ─────────────────────────────────────────────
function glyphColor(pal, tile) {
  return mix(tile, pal.glyphTo, pal.glyphMix);
}

/**
 * A layered conifer. `light` is the side the sun or moon is on (+1 right, -1 left).
 * `sway` leans the crown by whole cells, most at the tip.
 */
function pine(L, pal, t, base, colour, alpha, detail, light, sway = 0) {
  const h = Math.round(t.h);
  const trunk = Math.max(1, Math.round(h * 0.13));
  const crown = h - trunk;
  const top = Math.round(base) - h;
  const half = h * 0.3 * (0.84 + 0.3 * hash3(t.seed, 1, 5));
  const tiers = clamp(Math.round(crown / 5.5), 2, 7);
  const lit = mix(colour, pal.rim, 0.32), dim = shade(colour, pal.light ? 0.84 : 0.8);
  for (let k = 0; k < trunk; k++) {
    const r = Math.round(base) - 1 - k;
    if (detail) L.put(t.x, r, pal.trunk, alpha, "|", shade(pal.trunk, pal.light ? 0.6 : 1.8), 0.7);
    else L.put(t.x, r, shade(colour, 0.9), alpha, "", null, 0);
  }
  for (let k = 0; k < crown; k++) {
    const f = crown > 1 ? k / (crown - 1) : 1;
    const tier = (f * tiers) % 1;
    const wobble = (hash3(t.seed, k, 7) - 0.5) * 0.8;
    const w = k === 0 ? 0 : Math.max(0.5, half * (0.12 + 0.88 * f) * (0.36 + 0.64 * tier) + wobble);
    const dx = Math.round(sway * (1 - f) * (1 - f));
    const r = top + k;
    const left = Math.round(t.x - w), right = Math.round(t.x + w);
    for (let c = left; c <= right; c++) {
      const u = w ? (c - t.x) / w : 0;
      const shadeK = clamp(0.5 + 0.5 * u * light - (tier > 0.82 ? 0.25 : 0) + (hash3(c, r, t.seed) - 0.5) * 0.25, 0, 1);
      const tile = mix(dim, lit, shadeK);
      let g = "";
      if (detail) {
        if (k === 0) g = "^";
        else if (c === left) g = "/";
        else if (c === right) g = "\\";
        else {
          const h2 = hash3(c, r, t.seed + 3);
          g = h2 < 0.5 ? "^" : h2 < 0.68 ? "'" : h2 < 0.76 ? "." : "";
        }
      } else if (k === 0) g = "^";
      L.put(c + dx, r, tile, alpha, g, glyphColor(pal, tile), detail ? (detail > 1 ? 0.85 : 0.6) : 0.4);
    }
  }
}

/** A broadleaf tree: a lumpy crown of overlapping blobs on a short trunk. */
function broadleaf(L, pal, t, base, colour, alpha, detail, light, sway = 0) {
  const h = Math.round(t.h);
  const trunk = Math.max(2, Math.round(h * 0.32));
  const cy = Math.round(base) - trunk - h * 0.32;
  const ry = h * 0.36, rx = ry * 1.2;
  const blobs = [[0, 0, 1]];
  for (let k = 0; k < 5; k++) {
    const a = hash3(t.seed, k, 2) * 6.28;
    blobs.push([Math.cos(a) * rx * 0.55, Math.sin(a) * ry * 0.5, 0.55 + hash3(t.seed, k, 3) * 0.25]);
  }
  for (let k = 0; k < trunk + Math.round(ry * 0.5); k++) {
    const r = Math.round(base) - 1 - k;
    L.put(t.x, r, pal.trunk, alpha, k > trunk - 2 && detail ? (k % 2 ? "/" : "\\") : detail ? "|" : "", shade(pal.trunk, pal.light ? 0.6 : 1.8), 0.7);
    if (h > 14 && k < 2) L.put(t.x + 1, r, shade(pal.trunk, 0.9), alpha, detail ? "|" : "", shade(pal.trunk, pal.light ? 0.6 : 1.8), 0.6);
  }
  const lit = mix(colour, pal.rim, 0.32), dim = shade(colour, pal.light ? 0.82 : 0.78);
  const r0 = Math.floor(cy - ry * 1.3), r1 = Math.ceil(cy + ry * 1.2);
  for (let r = r0; r <= r1; r++) {
    const f = clamp((r - r0) / (r1 - r0), 0, 1);
    const dx = Math.round(sway * (1 - f) * 0.8);
    for (let c = Math.floor(t.x - rx * 1.4); c <= Math.ceil(t.x + rx * 1.4); c++) {
      let inside = 0, edgeX = 0;
      for (const [bx, by, s] of blobs) {
        const nx = (c - t.x - bx) / (rx * s), ny = (r - cy - by) / (ry * s);
        const d = 1 - (nx * nx + ny * ny);
        if (d > inside) { inside = d; edgeX = nx; }
      }
      if (inside <= 0) continue;
      const shadeK = clamp(0.45 + 0.45 * edgeX * light + (0.5 - f) * 0.4 + (hash3(c, r, t.seed) - 0.5) * 0.3, 0, 1);
      const tile = mix(dim, lit, shadeK);
      let g = "";
      if (detail) {
        const h2 = hash3(c, r, t.seed + 9);
        if (inside < 0.18) g = edgeX < 0 ? "(" : ")";
        else g = h2 < 0.32 ? "&" : h2 < 0.52 ? "%" : h2 < 0.66 ? "*" : h2 < 0.74 ? "o" : "";
      }
      L.put(c + dx, r, tile, alpha, g, glyphColor(pal, tile), detail > 1 ? 0.8 : 0.55);
    }
  }
}

function tree(L, pal, t, colour, alpha, detail, light, sway) {
  (t.round ? broadleaf : pine)(L, pal, t, t.base, colour, alpha, detail, light, sway);
}

function treeColour(pal, list, t) {
  return t.autumn ? pick(pal.autumn, t.tone) : pick(list, t.tone);
}

// ─── layers ─────────────────────────────────────────────────────────────────
function paintSky(L, pal, s) {
  if (pal.light) {
    // A soft sun: a warm disc with a ring of dotted rays.
    const rad = s.framed ? clamp(s.R * 0.06, 3, 6.5) : clamp(s.R * 0.04, 2.6, 3.4), ax = 1.16;
    for (let r = Math.floor(s.sky.y - rad * 2); r <= s.sky.y + rad * 2; r++) {
      for (let c = Math.floor(s.sky.x - rad * 2 * ax); c <= s.sky.x + rad * 2 * ax; c++) {
        const d = Math.hypot((c - s.sky.x) / ax, r - s.sky.y);
        if (d <= rad) {
          const k = 1 - d / rad;
          L.put(c, r, mix(pal.sun, [252, 236, 200], k * 0.6), 0.42 + 0.3 * k, k > 0.5 ? "" : ".", shade(pal.sun, 0.85), 0.45);
        } else if (d < rad + 2.4 && hash3(c, r, 13) < 0.22) {
          L.put(c, r, null, 0, "·", pal.sun, 0.55 * (1 - (d - rad) / 2.4));
        }
      }
    }
  } else {
    // A crescent moon with a faint dotted halo.
    const rad = s.framed ? clamp(s.R * 0.055, 3.6, 5.6) : 3.4, ax = 1.16;
    const ox = rad * 1.0, oy = -rad * 0.3;
    for (let r = Math.floor(s.moon.y - rad * 2.6); r <= s.moon.y + rad * 2.6; r++) {
      for (let c = Math.floor(s.moon.x - rad * 2.6 * ax); c <= s.moon.x + rad * 2.6 * ax; c++) {
        const dx = (c - s.moon.x) / ax, dy = r - s.moon.y;
        const d = Math.hypot(dx, dy), cut = Math.hypot(dx - ox, dy - oy);
        if (d <= rad && cut > rad * 1.02) {
          L.put(c, r, pal.moon, 0.88, hash3(c, r, 4) < 0.18 ? "o" : "", shade(pal.moon, 0.78), 0.5);
        } else if (d > rad + 0.8 && d < rad * 2.4 && hash3(c, r, 17) < 0.1) {
          L.put(c, r, null, 0, ".", pal.moon, 0.35 * (1 - d / (rad * 2.4)));
        }
      }
    }
  }
}

function paintRidges(L, pal, s) {
  s.ridges.forEach((ridge, k) => {
    const colour = pal.ridge[k];
    for (let c = 0; c < s.C; c++) {
      const exact = ridge.top(c), top = Math.round(exact);
      const lean = ridge.top(c + 1) - ridge.top(c - 1);
      // Snow sits on the high ground of the far range, with a ragged lower edge.
      const snowLine = s.R - s.F * 0.86 + (hash3(c, 0, 57) - 0.5) * 2;
      for (let r = top; r <= top + ridge.depth; r++) {
        const depth = (r - top) / ridge.depth;
        const snowy = !ridge.forested && r < snowLine;
        const sunny = (pal.light ? -lean : lean) > 0.4;
        const tile = snowy ? pal.snow : mix(sunny ? shade(colour, pal.light ? 1.04 : 1.18) : colour, pal.page, depth * 0.55);
        let g = "";
        if (r === top) g = Math.abs(lean) < 0.5 ? (ridge.forested ? "^" : "-") : lean > 0 ? "\\" : "/";
        else if (ridge.forested) g = hash3(c, r, 50 + k) < 0.3 ? "^" : "";
        else if (hash3(c, r, 50 + k) < 0.07) g = snowy ? "'" : ".";
        L.put(c, r, tile, pal.alpha.ridge * (1 - depth * 0.85), g, glyphColor(pal, tile), 0.4 * (1 - depth));
      }
    }
  });
}

function paintFar(L, pal, s) {
  for (const t of s.far) {
    pine(L, pal, t, t.base, pick(pal.far, t.tone), pal.alpha.far, 0, pal.light ? 1 : -1);
    for (let k = 0; k < 4; k++) L.put(t.x, t.base + k, pal.farGround, pal.alpha.far * (1 - k / 4), "", null, 0);
  }
  for (let c = 0; c < s.C; c++) {
    const base = Math.round(s.R - s.F * 0.36 + (fbm(c * 0.05, 31) - 0.5) * 3);
    for (let k = 0; k < 6; k++) L.put(c, base + k, pal.farGround, pal.alpha.far * (1 - k / 6), "", null, 0);
  }
}

function paintMid(L, pal, s) {
  // A soft understory behind the trunks, so the wood reads as continuous.
  const under = Math.round(s.R - s.F * 0.36);
  for (let c = 0; c < s.C; c++) {
    for (let r = under; r < s.R; r++) {
      const k = clamp((r - under) / (s.F * 0.14), 0, 1);
      L.put(c, r, mix(pal.farGround, pal.midGround, k), pal.alpha.mid * (0.5 + 0.5 * k), "", null, 0);
    }
  }
  for (const t of s.mid) tree(L, pal, t, treeColour(pal, pal.mid, t), pal.alpha.mid, 1, pal.light ? 1 : -1, 0);
  for (let c = 0; c < s.C; c++) {
    const top = Math.round(s.R - s.F * 0.1 + (fbm(c * 0.06, 37) - 0.5) * 2);
    for (let r = top; r < s.R; r++) {
      const g = hash3(c, r, 71);
      L.put(c, r, pal.midGround, pal.alpha.mid, g < 0.08 ? "," : g < 0.12 ? "'" : "", glyphColor(pal, pal.midGround), 0.45);
    }
  }
}

// ─── mount ──────────────────────────────────────────────────────────────────
export function mount(canvas, options = {}) {
  const o = { theme: "light", paused: false, feed: true, maxFps: 30, maxDpr: 2, ...options };
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const styles = new Map();
  const style = (rgb) => {
    let s = styles.get(rgb);
    if (!s) { s = `rgb(${rgb >>> 16},${(rgb >>> 8) & 255},${rgb & 255})`; styles.set(rgb, s); }
    return s;
  };
  let pal = o.theme === "dark" ? DARK : LIGHT;
  let paused = true, disposed = false, frameId = 0, paintId = 0;
  let last = 0, lastPaint = 0, time = 0, nearAt = -1e9;
  let vw = 0, vh = 0, dpr = 1, cw = 8, ch = 10, fontSize = 7;
  let scene = null, layers = null, area = null, framed = false, frameEl = null;
  let fade = null;
  const fps = clamp(Number(o.maxFps) || 30, 1, 60);
  const life = { leaves: [], birds: [], flies: [], shooting: null, attract: null, gust: { at: -99, x: 0 }, nextBirds: 6, nextStar: 9 };

  // ── layout ──
  function measure() {
    const r = canvas.getBoundingClientRect();
    const nextDpr = Math.min(window.devicePixelRatio || 1, o.maxDpr);
    if (r.width < 1 || r.height < 1) return false;
    let resized = false;
    if (r.width !== vw || r.height !== vh || nextDpr !== dpr) {
      vw = r.width; vh = r.height; dpr = nextDpr;
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
      const base = clamp(Math.round(vw / 125), 8, 12);
      cw = base * CELL_SCALE; ch = (base + 2) * CELL_SCALE;
      fontSize = Math.round((base + 2) * 0.72) * CELL_SCALE;
      resized = true;
    }
    frameEl = document.querySelector("[data-forest-frame]");
    const box = frameEl?.getBoundingClientRect();
    const nextFramed = Boolean(box && box.width > 40 && box.height > 40);
    const next = nextFramed
      ? { x: box.left - r.left, y: box.top - r.top, w: box.width, h: box.height }
      : { x: 0, y: 0, w: vw, h: vh };
    const reshape = resized || !area || nextFramed !== framed || Math.abs(next.w - area.w) > 0.5 || Math.abs(next.h - area.h) > 0.5;
    area = next; framed = nextFramed;
    if (reshape) build();
    return true;
  }
  function build() {
    const cols = Math.ceil(area.w / cw), rows = Math.ceil(area.h / ch);
    scene = compose(cols, rows, framed);
    // On the full page, tuck the sun or moon behind the summary bar's glass, where it blooms.
    const anchor = !framed && document.querySelector(".scene-heading")?.getBoundingClientRect();
    if (anchor && anchor.height) {
      const y = (anchor.top + (window.scrollY || 0) + anchor.height / 2) / ch;
      if (y < rows * 0.35) scene.sky.y = scene.moon.y = y;
    }
    layers = { sky: new Layer(cols, rows), ridge: new Layer(cols, rows), far: new Layer(cols, rows), mid: new Layer(cols, rows), near: new Layer(cols, rows) };
    for (const L of Object.values(layers)) L.mask = scene.mask;
    paintSky(layers.sky, pal, scene);
    paintRidges(layers.ridge, pal, scene);
    paintFar(layers.far, pal, scene);
    paintMid(layers.mid, pal, scene);
    for (const key of ["sky", "ridge", "far", "mid"]) render(layers[key]);
    nearAt = -1e9;
    seedLife();
  }
  function seedLife() {
    const s = scene;
    life.leaves.length = 0;
    life.birds.length = 0;
    life.flies.length = 0;
    const count = Math.round(clamp(s.C * s.R / 520, 10, 30));
    for (let k = 0; k < count; k++) life.flies.push(newFly(Math.random() * area.w, (s.R - Math.random() * s.F * 0.55) * ch));
  }
  function newFly(x, y) {
    return { x, y, a: Math.random() * 6.28, speed: 6 + Math.random() * 10, phase: Math.random() * 6.28, rate: 0.35 + Math.random() * 0.5, front: Math.random() < 0.3 };
  }
  /** Draw one layer's tiles into its own canvas. */
  function render(L) {
    const c = L.canvas;
    c.width = Math.round(area.w * dpr);
    c.height = Math.round(area.h * dpr);
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, area.w, area.h);
    g.font = `600 ${fontSize}px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const cols = L.cols;
    for (const i of L.used) {
      const x = (i % cols) * cw, y = ((i / cols) | 0) * ch;
      if (L.ta[i] > 0) {
        g.globalAlpha = L.ta[i];
        g.fillStyle = style(L.tile[i]);
        g.fillRect(x + CELL_SCALE, y + CELL_SCALE, cw - CELL_SCALE, ch - CELL_SCALE);
      }
      if (L.glyph[i] && L.ga[i] > 0) {
        g.globalAlpha = L.ga[i];
        g.fillStyle = style(L.gc[i]);
        g.fillText(String.fromCharCode(L.glyph[i]), x + cw / 2, y + ch / 2 + CELL_SCALE);
      }
    }
    g.globalAlpha = 1;
  }

  // ── wind ──
  /** Wind at column c: a slow breath plus gusts that sweep across from the left. */
  function wind(c, t) {
    const lag = t - (c * cw) / 140;
    let w = 0.32 + 0.22 * Math.sin(lag * 0.21) + 0.14 * Math.sin(lag * 0.53 + 1.3);
    const g = t - life.gust.at - Math.abs(c * cw - life.gust.x) / 220;
    if (g > 0 && g < 3) w += 0.9 * Math.sin((g / 3) * Math.PI);
    return w;
  }

  function paintNear() {
    const L = layers.near, s = scene;
    L.clear();
    const light = pal.light ? 1 : -1;
    for (const t of s.near) {
      const sway = (wind(t.x, time) - 0.32) * 1.5 + 0.25 * Math.sin(time * 0.8 + t.seed);
      tree(L, pal, t, treeColour(pal, pal.near, t), pal.alpha.near, 2, light, t.round ? sway * 0.7 : sway);
    }
    for (const b of s.bushes) {
      const colour = pick(pal.near, b.tone);
      for (let r = 0; r < b.h; r++) {
        const w = b.w * Math.sqrt(1 - Math.pow(r / b.h, 2));
        for (let c = Math.round(b.x - w); c <= Math.round(b.x + w); c++) {
          const tile = shade(colour, 0.9 + 0.25 * hash3(c, r, b.seed));
          const h2 = hash3(c, r, b.seed + 1);
          L.put(c, b.base - 1 - r, tile, pal.alpha.near, h2 < 0.4 ? "&" : h2 < 0.6 ? "%" : "", glyphColor(pal, tile), 0.7);
        }
      }
    }
    for (let c = 0; c < s.C; c++) {
      const top = s.groundTop(c);
      for (let r = top; r < s.R; r++) {
        const tile = pick(pal.ground, hash3(c, r, 81));
        const h2 = hash3(c, r, 83);
        L.put(c, r, tile, pal.alpha.near, h2 < 0.12 ? "," : h2 < 0.2 ? "." : h2 < 0.24 ? '"' : "", glyphColor(pal, tile), 0.55);
      }
      const lean = wind(c, time) + 0.18 * Math.sin(time * 2.3 + c * 0.45);
      const h1 = hash3(c, 1, 87);
      if (h1 < 0.78) {
        const blade = lean > 0.62 ? "/" : lean > 0.36 ? (h1 < 0.4 ? "/" : "|") : h1 < 0.3 ? "," : "|";
        L.put(c, top - 1, null, 0, blade, pal.grass, 0.85);
        if (h1 < 0.18) L.put(c + (lean > 0.62 ? 1 : 0), top - 2, null, 0, lean > 0.45 ? "/" : "'", pal.grass, 0.7);
      }
      const h3 = hash3(c, 2, 89);
      if (h3 < 0.05) L.put(c, top - 1, null, 0, h3 < 0.02 ? "*" : h3 < 0.035 ? "o" : "+", pick(pal.flowers, h3 * 20), pal.light ? 0.95 : 0.6);
    }
    render(L);
  }

  // ── life ──
  function step(dt) {
    time += dt;
    const s = scene;
    if (!s) return;
    if (pal.light) {
      // Leaves let go more readily in a gust.
      const breeze = wind(s.C / 2, time);
      if (life.leaves.length < 26 && Math.random() < dt * (0.5 + breeze * 1.6)) spawnLeaf();
      for (const l of life.leaves) {
        l.age += dt;
        const w = wind(l.x / cw, time);
        l.vx += ((w * 34 - 6) - l.vx) * dt * 1.5;
        l.x += (l.vx + Math.sin(l.age * l.wob) * 10) * dt;
        l.y += l.vy * dt * (0.8 + 0.4 * Math.sin(l.age * 2.1));
        const ground = (s.groundTop(Math.round(l.x / cw)) - 0.5) * ch;
        if (l.y >= ground) { l.y = ground; l.rest += dt; }
      }
      life.leaves = life.leaves.filter((l) => l.rest < 2.5 && l.x > -20 && l.x < area.w + 40);
      life.nextBirds -= dt;
      if (life.nextBirds <= 0 && !life.birds.length) {
        flock(Math.random() < 0.5 ? -20 : area.w + 20, ch * s.R * (0.1 + Math.random() * 0.22));
        life.nextBirds = 14 + Math.random() * 16;
      }
      for (const b of life.birds) { b.x += b.vx * dt; b.y += b.vy * dt + Math.sin(time * 1.3 + b.k) * 3 * dt; b.vy *= Math.exp(-dt * 0.6); }
      life.birds = life.birds.filter((b) => b.x > -60 && b.x < area.w + 60 && b.y > -40);
    } else {
      const lowest = (s.R - 2) * ch, highest = (s.R - s.F * 0.62) * ch;
      for (const f of life.flies) {
        let turn = (valueNoise(time * 0.3, f.phase * 10, 5) - 0.5) * 3;
        if (life.attract && time < life.attract.until) {
          const want = Math.atan2(life.attract.y - f.y, life.attract.x - f.x);
          let d = want - f.a;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          turn += d * 1.6;
        }
        if (f.y > lowest) turn += Math.cos(f.a) > 0 ? -1.5 : 1.5;
        if (f.y < highest && (!life.attract || time >= life.attract.until)) turn += Math.cos(f.a) > 0 ? 1.5 : -1.5;
        f.a += turn * dt;
        f.x += Math.cos(f.a) * f.speed * dt;
        f.y += Math.sin(f.a) * f.speed * dt;
        if (f.x < -10) f.x = area.w + 10;
        if (f.x > area.w + 10) f.x = -10;
        f.y = clamp(f.y, highest - 60, lowest + 4);
      }
      life.nextStar -= dt;
      if (life.nextStar <= 0 && !life.shooting) {
        shoot(Math.random() * area.w * 0.8 + area.w * 0.1, Math.random() * (s.R - s.F) * ch * 0.6);
        life.nextStar = 16 + Math.random() * 24;
      }
      if (life.shooting) {
        life.shooting.t += dt;
        if (life.shooting.t > 1.1) life.shooting = null;
      }
    }
  }
  function spawnLeaf(x, y) {
    const s = scene;
    if (x === undefined) {
      const t = Math.random() < 0.65 ? s.near[Math.floor(Math.random() * s.near.length)] : s.mid[Math.floor(Math.random() * s.mid.length)];
      if (!t) return;
      x = (t.x + (Math.random() - 0.5) * t.h * 0.4) * cw;
      y = (t.base - t.h * (0.35 + Math.random() * 0.5)) * ch;
    }
    life.leaves.push({ x, y, vx: 0, vy: 14 + Math.random() * 16, age: 0, rest: 0, wob: 1.5 + Math.random() * 2, spin: 2 + Math.random() * 3, colour: pick(pal.leaves, Math.random()) });
  }
  function flock(x, y, away) {
    const dir = away ?? (x < area.w / 2 ? 1 : -1);
    const n = 3 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) {
      const row = Math.ceil(k / 2), side = k % 2 ? 1 : -1;
      life.birds.push({ x: x - dir * row * 14, y: y + side * row * 9 * (k ? 1 : 0), vx: dir * (46 + Math.random() * 8), vy: away !== undefined ? -18 - Math.random() * 10 : 0, k: k * 0.7 });
    }
  }
  function shoot(x, y) {
    life.shooting = { x, y, dx: Math.random() < 0.5 ? -1 : 1, t: 0 };
  }

  // ── painting ──
  let glow = null;
  function glowSprite() {
    if (glow) return glow;
    glow = document.createElement("canvas");
    glow.width = glow.height = 48;
    const g = glow.getContext("2d");
    const grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
    const [r, gr, b] = DARK.firefly;
    grad.addColorStop(0, `rgba(${r},${gr},${b},0.55)`);
    grad.addColorStop(0.4, `rgba(${r},${gr},${b},0.16)`);
    grad.addColorStop(1, `rgba(${r},${gr},${b},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 48, 48);
    return glow;
  }
  function cellText(glyph, x, y, rgb, alpha) {
    const c = Math.floor(x / cw), r = Math.floor(y / ch);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = style(packRgb(rgb));
    ctx.fillText(glyph, c * cw + cw / 2, r * ch + ch / 2 + CELL_SCALE);
  }
  function cellTile(x, y, rgb, alpha) {
    const c = Math.floor(x / cw), r = Math.floor(y / ch);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = style(packRgb(rgb));
    ctx.fillRect(c * cw + CELL_SCALE, r * ch + CELL_SCALE, cw - CELL_SCALE, ch - CELL_SCALE);
  }
  function drawFlies(front) {
    const sprite = glowSprite();
    for (const f of life.flies) {
      if (f.front !== front) continue;
      const pulse = Math.pow(Math.max(0, Math.sin(time * f.rate * 6.28 * (life.attract && time < life.attract.until ? 1.6 : 1) + f.phase)), 2);
      const b = 0.15 + 0.85 * pulse;
      ctx.globalAlpha = b;
      ctx.drawImage(sprite, f.x - 18, f.y - 18, 36, 36);
      cellTile(f.x, f.y, DARK.firefly, 0.25 + 0.65 * b);
      cellText(b > 0.6 ? "*" : "·", f.x, f.y, [250, 252, 220], 0.4 + 0.6 * b);
    }
  }
  function paint() {
    if (!scene) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, vw, vh);
    if (area.x > vw || area.y > vh || area.x + area.w < 0 || area.y + area.h < 0) return;
    if (time * 1000 - nearAt > NEAR_REFRESH || nearAt < 0) { paintNear(); nearAt = time * 1000; }
    const s = scene;
    // In the full-page scene, the forest settles a little as the page scrolls.
    const sink = framed || reducedMotion.matches ? 0 : Math.min(window.scrollY || 0, 900) * 0.09;
    ctx.save();
    ctx.translate(area.x, area.y);
    if (framed) { ctx.beginPath(); ctx.rect(0, 0, area.w, area.h); ctx.clip(); }
    ctx.font = `600 ${fontSize}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const layer = (L, k) => ctx.drawImage(L.canvas, 0, 0, L.canvas.width, L.canvas.height, 0, Math.round(sink * k), area.w, area.h);
    if (!pal.light) {
      for (const st of s.stars) {
        const tw = 0.5 + 0.5 * Math.sin(time * st.speed + st.phase);
        const glyph = st.bright ? (tw > 0.7 ? "+" : "·") : ".";
        const m = s.mask ? s.mask(Math.floor(st.x), 0) : 1;
        cellText(glyph, st.x * cw, st.y * ch, pal.star, (st.bright ? 0.5 + 0.5 * tw : 0.18 + 0.35 * tw) * m);
      }
    }
    const orb = pal.light ? s.sky : s.moon;
    const ox = orb.x * cw, oy = orb.y * ch, orbR = Math.min(area.w, area.h) * (pal.light ? 0.2 : 0.16);
    const halo = ctx.createRadialGradient(ox, oy, 0, ox, oy, orbR);
    const [hr, hg, hb] = pal.light ? pal.sun : pal.moon;
    halo.addColorStop(0, `rgba(${hr},${hg},${hb},${pal.light ? 0.28 : 0.12})`);
    halo.addColorStop(1, `rgba(${hr},${hg},${hb},0)`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = halo;
    ctx.fillRect(ox - orbR, oy - orbR, orbR * 2, orbR * 2);
    layer(layers.sky, 0);
    if (pal.light) {
      for (const cl of s.clouds) {
        const x0 = Math.floor(((cl.x + time * cl.speed) % (s.C + cl.w + 8)) - cl.w - 4);
        for (const cell of cl.cells) {
          const col = x0 + cell.c, row = Math.floor(cl.y) + cell.r;
          const m = s.mask ? s.mask(col, row) : 1;
          if (m <= 0) continue;
          const tone = mix(pal.cloudShade, pal.cloud, clamp(cell.top * 1.2, 0, 1));
          ctx.globalAlpha = Math.min(0.75, 0.25 + cell.k * 1.2) * m;
          ctx.fillStyle = style(packRgb(tone));
          ctx.fillRect(col * cw + CELL_SCALE, row * ch + CELL_SCALE, cw - CELL_SCALE, ch - CELL_SCALE);
          if (cell.r === 0 && hash3(cell.c, 0, cl.seed) < 0.5) cellText("~", col * cw, row * ch, shade(pal.cloudShade, 0.85), 0.55 * m);
        }
      }
      ctx.globalAlpha = 1;
    } else if (life.shooting) {
      const sh = life.shooting, k = sh.t / 1.1;
      for (let j = 0; j < 9; j++) {
        const x = sh.x + sh.dx * (k * 220 - j * 9), y = sh.y + k * 90 - j * 3.7;
        cellText(j === 0 ? "*" : j < 4 ? "-" : ".", x, y, pal.star, (1 - k) * (1 - j / 9));
      }
    }
    layer(layers.ridge, 0.25);
    layer(layers.far, 0.45);
    // Mist pools between the far trees and the middle wood.
    const mistTop = (s.R - s.F * 0.46) * ch + sink * 0.5, mistBottom = (s.R - s.F * 0.12) * ch + sink * 0.6;
    const grad = ctx.createLinearGradient(0, mistTop, 0, mistBottom);
    const [pr, pg, pb] = pal.page;
    grad.addColorStop(0, `rgba(${pr},${pg},${pb},0)`);
    grad.addColorStop(0.55, `rgba(${pr},${pg},${pb},${pal.mist})`);
    grad.addColorStop(1, `rgba(${pr},${pg},${pb},0.08)`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = grad;
    ctx.fillRect(0, mistTop, area.w, mistBottom - mistTop);
    for (let k = 0; k < Math.round(s.C / 9); k++) {
      const x = ((hash3(k, 0, 95) * s.C + time * (0.4 + hash3(k, 1, 95) * 0.5)) % s.C) * cw;
      const y = mistTop + (0.4 + hash3(k, 2, 95) * 0.4) * (mistBottom - mistTop);
      const m = s.mask ? s.mask(Math.floor(x / cw), 0) : 1;
      cellText(hash3(k, 3, 95) < 0.5 ? "~" : "-", x, y, pal.light ? [255, 255, 255] : [120, 126, 134], 0.5 * m);
    }
    layer(layers.mid, 0.7);
    if (pal.light) {
      for (const b of life.birds) cellText(Math.sin(time * 9 + b.k * 3) > 0 ? "v" : "-", b.x, b.y, pal.bird, 0.85);
    } else drawFlies(false);
    layer(layers.near, 1);
    ctx.translate(0, Math.round(sink));
    if (pal.light) {
      for (const l of life.leaves) {
        const glyph = l.rest ? "_" : "/-\\|"[Math.floor(l.age * l.spin) % 4];
        cellText(glyph, l.x, l.y, l.colour, l.rest ? 0.9 * (1 - l.rest / 2.5) : 0.95);
      }
    } else drawFlies(true);
    ctx.restore();
    if (fade) {
      const k = (performance.now() - fade.start) / 700;
      if (k >= 1) fade = null;
      else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1 - smoothstep(0, 1, k);
        ctx.drawImage(fade.canvas, 0, 0);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ── loop and events ──
  function frame(now) {
    frameId = 0;
    if (disposed || paused || document.hidden) return;
    if (now - lastPaint < 1000 / fps - 0.5) { frameId = requestAnimationFrame(frame); return; }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = lastPaint = now;
    measure();
    step(dt);
    paint();
    frameId = requestAnimationFrame(frame);
  }
  function requestPaint() {
    if (disposed || !paused || paintId) return;
    paintId = requestAnimationFrame(() => { paintId = 0; if (!disposed && measure()) { nearAt = -1e9; paint(); } });
  }
  function onClick(e) {
    if (paused || !o.feed || !scene || e.button !== 0) return;
    if (e.composedPath().some((n) => n instanceof Element && n.matches(IGNORE))) return;
    if (window.getSelection()?.toString()) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left - area.x, y = e.clientY - r.top - area.y;
    if (x < 0 || y < 0 || x > area.w || y > area.h) return;
    const sky = y < (scene.R - scene.F * 0.55) * ch;
    if (pal.light) {
      life.gust = { at: time, x };
      if (sky) { life.birds.length = 0; flock(x, y, x < area.w / 2 ? -1 : 1); }
      for (let k = 0; k < 7; k++) spawnLeaf(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 30);
    } else if (sky) {
      shoot(x, y);
    } else {
      life.attract = { x, y, until: time + 5 };
      for (let k = 0; k < 3 && life.flies.length < 48; k++) life.flies.push(newFly(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.5) * 30));
    }
  }
  const onResize = () => requestPaint();
  const observer = new ResizeObserver(onResize);
  const mutations = new MutationObserver(onResize);
  const onFonts = () => { if (scene) { area = null; measure(); requestPaint(); } };
  addEventListener("resize", onResize, { passive: true });
  addEventListener("scroll", onResize, { passive: true, capture: true });
  addEventListener("pond-layout", onResize);
  addEventListener("click", onClick);
  document.fonts?.addEventListener("loadingdone", onFonts);
  observer.observe(canvas);
  mutations.observe(document.getElementById("root") || document.body, { childList: true, subtree: true });

  const instance = {
    canvas,
    get paused() { return paused; },
    pause() {
      if (disposed) return;
      paused = true;
      cancelAnimationFrame(frameId); frameId = 0;
      requestPaint();
    },
    resume() {
      if (disposed || !paused) return;
      paused = false;
      cancelAnimationFrame(paintId); paintId = 0;
      last = lastPaint = performance.now() - 1000 / fps;
      frameId = requestAnimationFrame(frame);
    },
    destroy() {
      if (disposed) return;
      instance.pause();
      cancelAnimationFrame(paintId);
      disposed = true;
      observer.disconnect(); mutations.disconnect();
      removeEventListener("resize", onResize); removeEventListener("scroll", onResize, true);
      removeEventListener("pond-layout", onResize); removeEventListener("click", onClick);
      document.fonts?.removeEventListener("loadingdone", onFonts);
      canvas.width = canvas.height = 0;
    },
    measure: requestPaint,
    feed(x, y) {
      onClick({ button: 0, clientX: x, clientY: y, composedPath: () => [] });
    },
    setFeeding(enabled) { o.feed = enabled; },
    setTheme(isLight) {
      const next = isLight ? LIGHT : DARK;
      if (next === pal) return;
      if (!paused && !reducedMotion.matches && canvas.width) {
        const snap = document.createElement("canvas");
        snap.width = canvas.width; snap.height = canvas.height;
        snap.getContext("2d").drawImage(canvas, 0, 0);
        fade = { canvas: snap, start: performance.now() };
      }
      pal = next;
      if (area) build();
      if (paused) requestPaint();
    },
  };
  measure();
  // Let a few seconds of life accumulate so the first frame is not empty.
  for (let k = 0; k < 90; k++) step(1 / 30);
  paint();
  if (!o.paused) instance.resume();
  return instance;
}
