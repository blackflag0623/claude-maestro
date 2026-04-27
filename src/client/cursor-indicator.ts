/**
 * 9×9 grid in the terminal's top-right corner that runs a slowly-evolving
 * decorative animation. xterm's own cursor is hidden (see styles.css) so the
 * Claude CLI's in-stream cursor is the sole input-position indicator; this
 * grid is purely ambient.
 */

const N = 9;
const FADE_MS = 1400;
const MIN_LIFE_MS = 4500;
const MAX_LIFE_MS = 9000;
const BASE_OPACITY = 0.06;
const PEAK_OPACITY = 0.92;

type Pattern = (t: number, x: number, y: number, i: number) => number;

export interface CursorIndicator {
  el: HTMLElement;
  stop: () => void;
}

export function buildCursorIndicator(): CursorIndicator {
  const wrap = document.createElement('div');
  wrap.className = 'chase-indicator';
  const cells: HTMLElement[] = [];
  for (let i = 0; i < N * N; i++) {
    const cell = document.createElement('div');
    cell.className = 'chase-indicator__cell';
    wrap.appendChild(cell);
    cells.push(cell);
  }

  const ringIdx = buildRingIndex();
  const patterns = buildPatterns(ringIdx);

  let prev: Pattern | null = null;
  let curr = pickRandom(patterns);
  let switchAt = performance.now() + randomLife();
  let fadeStart: number | null = null;
  let raf = 0;
  let stopped = false;

  const start = performance.now();
  const tick = (now: number) => {
    if (stopped) return;
    if (!wrap.isConnected) {
      // Detached (e.g. node unmounted). Pause cheaply.
      raf = requestAnimationFrame(tick);
      return;
    }
    if (fadeStart === null && now >= switchAt) {
      let next = curr;
      while (next === curr) next = pickRandom(patterns);
      prev = curr;
      curr = next;
      fadeStart = now;
    }
    let blend = 1;
    if (fadeStart !== null) {
      blend = Math.min(1, (now - fadeStart) / FADE_MS);
      if (blend >= 1) {
        prev = null;
        fadeStart = null;
        switchAt = now + randomLife();
      }
    }
    const t = (now - start) / 1000;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const a = curr(t, x, y, i);
        const v = prev ? a * blend + prev(t, x, y, i) * (1 - blend) : a;
        const op = BASE_OPACITY + (PEAK_OPACITY - BASE_OPACITY) * clamp01(v);
        cells[i].style.opacity = op.toFixed(3);
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    el: wrap,
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
    },
  };
}

function buildRingIndex(): Int8Array {
  const ring: Array<[number, number]> = [];
  for (let x = 0; x < N; x++) ring.push([x, 0]);
  for (let y = 1; y < N; y++) ring.push([N - 1, y]);
  for (let x = N - 2; x >= 0; x--) ring.push([x, N - 1]);
  for (let y = N - 2; y >= 1; y--) ring.push([0, y]);
  const idx = new Int8Array(N * N).fill(-1);
  ring.forEach(([x, y], i) => {
    idx[y * N + x] = i;
  });
  return idx;
}

function buildPatterns(ringIdx: Int8Array): Pattern[] {
  const center = (N - 1) / 2;
  const ringLen = 4 * (N - 1); // 32 for N=9
  const fall = (d: number, k: number) => Math.max(0, 1 - d / k);
  const ringDist = (r: number, head: number) => {
    const d = Math.abs(r - head);
    return Math.min(d, ringLen - d);
  };

  const ringChase = (dir: 1 | -1): Pattern => {
    const speed = 10;
    return (t, _x, _y, i) => {
      const r = ringIdx[i];
      if (r < 0) return 0;
      const head = mod(t * speed * dir, ringLen);
      return fall(ringDist(r, head), 5);
    };
  };

  const dualRing: Pattern = (t, _x, _y, i) => {
    const r = ringIdx[i];
    if (r < 0) return 0;
    const a = mod(t * 8, ringLen);
    const b = (a + ringLen / 2) % ringLen;
    return Math.max(fall(ringDist(r, a), 4), fall(ringDist(r, b), 4));
  };

  const diagonalSweep: Pattern = (t, x, y) => {
    const period = N * 2;
    const wrapped = mod((x + y) - t * 6, period);
    const d = Math.min(wrapped, period - wrapped);
    return fall(d, 3);
  };

  const concentric: Pattern = (t, x, y) => {
    const d = Math.max(Math.abs(x - center), Math.abs(y - center));
    const phase = (t * 2.2) % 5;
    return fall(Math.abs(d - phase), 1.2);
  };

  const plasma: Pattern = (t, x, y) => {
    const v =
      Math.sin(x * 0.9 + t * 1.7) +
      Math.sin(y * 0.8 - t * 1.3) +
      Math.sin((x + y) * 0.6 + t * 2.1) +
      Math.sin(Math.hypot(x - center, y - center) * 1.1 - t * 1.9);
    return clamp01((v + 4) / 8);
  };

  const spiral: Pattern = (t, x, y) => {
    const dx = x - center, dy = y - center;
    const r = Math.hypot(dx, dy);
    const a = Math.atan2(dy, dx);
    return Math.max(0, Math.sin(a * 2 + r * 1.8 - t * 4));
  };

  const rain: Pattern = (t, x, y) => {
    const phase = (x * 0.37) % 1;
    const speed = 4 + ((x * 31) % 3);
    const head = ((t * speed + phase * N) % (N + 4)) - 2;
    return fall(Math.abs(y - head), 2);
  };

  const heartbeat: Pattern = (t, x, y) => {
    const beat = Math.max(0, Math.sin(t * 3.1));
    const d = Math.hypot(x - center, y - center) / center;
    return Math.max(0, beat * (1 - d * 0.7));
  };

  return [
    ringChase(1), ringChase(-1), dualRing,
    diagonalSweep, concentric, plasma, spiral, rain, heartbeat,
  ];
}

const mod = (n: number, m: number) => ((n % m) + m) % m;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const randomLife = () => MIN_LIFE_MS + Math.random() * (MAX_LIFE_MS - MIN_LIFE_MS);
const pickRandom = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
