/*
  TOYBOX — facts-worker.js
  Listens to a song (in the background, so the app never stutters) and guesses
  its tempo (BPM) and key. You can always tap either one in the player to fix it.

  How the guessing works, simply:
  • Tempo: find the moments the sound suddenly gets louder or brighter (drum hits,
    new notes), then look for the gap between them that repeats the most.
  • Key: add up how much of each of the 12 notes (C, C#, D…) is in the song,
    then see which major or minor scale that mix of notes fits best.
*/

self.onmessage = (event) => {
  const { id, samples, rate } = event.data;
  let bpm = null;
  let key = null;
  try { bpm = detectTempo(samples, rate); } catch (e) { bpm = null; }
  try { key = detectKey(samples, rate); } catch (e) { key = null; }
  self.postMessage({ id, bpm, key });
};

// ---------- A small FFT (turns a slice of sound into its notes/frequencies) ----------
const fftTables = new Map();
function tablesFor(n) {
  if (!fftTables.has(n)) {
    const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    const win = new Float32Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    fftTables.set(n, { cos, sin, win });
  }
  return fftTables.get(n);
}

function fft(re, im) {
  const n = re.length;
  const { cos, sin } = tablesFor(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// Strength of each frequency in one slice of the song.
function spectrum(samples, start, n, re, im, out) {
  const { win } = tablesFor(n);
  for (let i = 0; i < n; i++) { re[i] = (samples[start + i] || 0) * win[i]; im[i] = 0; }
  fft(re, im);
  for (let k = 0; k < n / 2; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  return out;
}

// ---------- Tempo ----------
function detectTempo(all, rate) {
  // Listen to up to 80 seconds, skipping the very start (intros are often quiet).
  const skip = Math.floor(all.length * 0.1);
  const samples = all.subarray(skip, Math.min(all.length, skip + Math.floor(rate * 80)));
  const n = 512, hop = 128;
  const fps = rate / hop;
  const frames = Math.floor((samples.length - n) / hop);
  if (frames < fps * 4) return null; // shorter than 4 seconds: can't tell

  const re = new Float32Array(n), im = new Float32Array(n);
  let prev = new Float32Array(n / 2), cur = new Float32Array(n / 2);
  const flux = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    spectrum(samples, f * hop, n, re, im, cur);
    let sum = 0;
    for (let k = 1; k < n / 2; k++) {
      const v = Math.log1p(100 * cur[k]);
      const d = v - prev[k];
      if (d > 0) sum += d;
      prev[k] = v;
    }
    flux[f] = f === 0 ? 0 : sum;
  }

  // Keep only the sudden jumps (subtract the running average).
  const env = new Float32Array(frames);
  const half = Math.round(fps * 0.2);
  let run = 0;
  for (let f = 0; f < Math.min(frames, half); f++) run += flux[f];
  for (let f = 0; f < frames; f++) {
    const add = f + half < frames ? flux[f + half] : 0;
    const drop = f - half - 1 >= 0 ? flux[f - half - 1] : 0;
    run += add - drop;
    const count = Math.min(frames - 1, f + half) - Math.max(0, f - half) + 1;
    env[f] = Math.max(0, flux[f] - run / count);
  }
  let energy = 0;
  for (let f = 0; f < frames; f++) energy += env[f];
  if (energy < 1e-6) return null;

  // Which gap between hits repeats the most? (50 to 210 BPM)
  const minLag = Math.floor((60 * fps) / 210), maxLag = Math.ceil((60 * fps) / 50);
  const acf = new Float32Array(maxLag * 2 + 2);
  for (let lag = minLag; lag < acf.length; lag++) {
    let s = 0;
    for (let f = 0; f + lag < frames; f++) s += env[f] * env[f + lag];
    acf[lag] = s / (frames - lag);
  }
  let best = -1, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    // Songs are most often near 120 BPM, so lean gently towards that.
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.9, 2));
    const score = (acf[lag] + 0.5 * acf[lag * 2]) * prior;
    if (score > best) { best = score; bestLag = lag; }
  }
  // Fine-tune between two neighbouring gaps.
  const a = acf[bestLag - 1] || 0, b = acf[bestLag], c = acf[bestLag + 1] || 0;
  const denom = a - 2 * b + c;
  const shift = denom ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  let bpm = (60 * fps) / (bestLag + shift);
  while (bpm < 70) bpm *= 2;
  while (bpm >= 180) bpm /= 2;
  return Math.round(bpm);
}

// ---------- Key ----------
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
// How much each note of the scale tends to be heard in pop/rock songs (major and minor),
// starting from the key's own note. (Profiles from Ibrahim Sha'ath's KeyFinder.)
const MAJOR = [7.24, 3.50, 3.58, 2.85, 5.82, 4.56, 2.45, 6.99, 3.39, 4.56, 4.07, 4.46];
const MINOR = [7.00, 3.14, 4.36, 5.40, 3.67, 4.09, 3.91, 6.20, 3.63, 2.87, 5.35, 3.83];

function detectKey(samples, rate) {
  const n = 8192;
  const frames = Math.floor(samples.length / n);
  if (frames < 3) return null;
  const every = Math.max(1, Math.floor(frames / 400)); // at most ~400 slices
  const binHz = rate / n;

  // Which note each frequency belongs to (from low A1 up to about A6).
  const noteOf = new Int8Array(n / 2).fill(-1);
  for (let k = 1; k < n / 2; k++) {
    const hz = k * binHz;
    if (hz < 55 || hz > 1800) continue;
    const midi = 69 + 12 * Math.log2(hz / 440);
    const nearest = Math.round(midi);
    if (Math.abs(midi - nearest) > 0.35) continue; // in between two notes: skip
    noteOf[k] = ((nearest % 12) + 12) % 12;
  }

  const re = new Float32Array(n), im = new Float32Array(n), mag = new Float32Array(n / 2);
  const total = new Float64Array(12);
  const slice = new Float64Array(12);
  for (let f = 0; f < frames; f += every) {
    spectrum(samples, f * n, n, re, im, mag);
    slice.fill(0);
    for (let k = 1; k < n / 2; k++) if (noteOf[k] >= 0) slice[noteOf[k]] += mag[k];
    let top = 0;
    for (let i = 0; i < 12; i++) if (slice[i] > top) top = slice[i];
    if (top < 1e-4) continue; // silence
    for (let i = 0; i < 12; i++) total[i] += slice[i] / top;
  }
  if (total.every((v) => v === 0)) return null;

  let best = -Infinity, name = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [profile, kind] of [[MAJOR, 'major'], [MINOR, 'minor']]) {
      const r = correlation(total, (i) => profile[(i - tonic + 12) % 12]);
      if (r > best) { best = r; name = `${NOTE_NAMES[tonic]} ${kind}`; }
    }
  }
  return name;
}

function correlation(xs, profileAt) {
  let mx = 0, my = 0;
  for (let i = 0; i < 12; i++) { mx += xs[i]; my += profileAt(i); }
  mx /= 12; my /= 12;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < 12; i++) {
    const dx = xs[i] - mx, dy = profileAt(i) - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : -Infinity;
}
