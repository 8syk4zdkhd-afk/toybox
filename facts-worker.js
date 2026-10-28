/*
  TOYBOX — facts-worker.js
  Listens to a song (in the background, so the app never stutters) and works out
  its tempo (BPM) and key. You can always fix either one in the player.

  Tempo, simply:
  1. Find the moments the sound suddenly gets louder or brighter (drum hits, new notes).
  2. In 12-second stretches of the song, find the beat lengths that repeat the most.
  3. Lay a "metronome" over the hits for each guess and keep the one that lines up best.
  4. Vote across the whole song, then pick between double/half time (e.g. 90 vs 180).

  Key, simply:
  1. Find the clear notes in each moment of the song (the peaks in the sound).
  2. Check how in-tune the recording is (some songs sit a little sharp or flat).
  3. Add up how much of each of the 12 notes is heard, letting each peak also vote
     for the note it's likely an overtone of.
  4. See which major or minor scale that mix of notes fits best.
*/

const CFG = (typeof self !== 'undefined' && self.cfg) || {};
const opt = (name, fallback) => (CFG[name] !== undefined ? CFG[name] : fallback);

if (typeof self !== 'undefined' && !self.__bench) {
  self.onmessage = (event) => {
    const { id, samples, rate } = event.data;
    let bpm = null;
    let key = null;
    try { bpm = detectTempo(samples, rate); } catch (e) { bpm = null; }
    try { key = detectKey(samples, rate); } catch (e) { key = null; }
    self.postMessage({ id, bpm, key });
  };
}

// ---------- A small FFT (turns a slice of sound into its frequencies) ----------
const fftTables = new Map();
function tablesFor(n) {
  if (!fftTables.has(n)) {
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    const rev = new Uint32Array(n);
    for (let i = 0, j = 0; i < n; i++) {
      rev[i] = j;
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
    }
    const hann = new Float64Array(n);
    for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    fftTables.set(n, { cos, sin, rev, hann });
  }
  return fftTables.get(n);
}

function fft(re, im, inverse) {
  const n = re.length;
  const { cos, sin, rev } = tablesFor(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? -1 : 1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sign * sin[k * step];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// Magnitude spectrum of one windowed slice.
function magnitudes(samples, start, n, re, im, out) {
  const { hann } = tablesFor(n);
  for (let i = 0; i < n; i++) { re[i] = (samples[start + i] || 0) * hann[i]; im[i] = 0; }
  fft(re, im, false);
  for (let k = 0; k < n / 2; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  return out;
}

// =====================================================================
// Tempo
// =====================================================================

// How strongly "something new starts" at each moment (about 170 times a second).
function onsetStrength(samples, rate) {
  const n = 512, hop = 64;
  const frames = Math.floor((samples.length - n) / hop);
  if (frames < 10) return null;
  const half = n / 2;
  const re = new Float64Array(n), im = new Float64Array(n), mag = new Float64Array(half);
  // Log-spaced bands from about 30 Hz to 5 kHz, so bass drums and hi-hats both count.
  const binHz = rate / n;
  const bandOf = new Int16Array(half).fill(-1);
  const edges = [];
  for (let f = 30; f < Math.min(5500, rate / 2); f *= Math.pow(2, 1 / 4)) edges.push(f);
  const bands = edges.length - 1;
  for (let k = 1; k < half; k++) {
    const f = k * binHz;
    for (let b = 0; b < bands; b++) if (f >= edges[b] && f < edges[b + 1]) { bandOf[k] = b; break; }
  }
  // Bands too narrow to hold a bin borrow their nearest bin.
  const bandHasBin = new Uint8Array(bands);
  for (let k = 1; k < half; k++) if (bandOf[k] >= 0) bandHasBin[bandOf[k]] = 1;
  const prev = new Float64Array(bands), cur = new Float64Array(bands), prev2 = new Float64Array(bands);
  const flux = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    magnitudes(samples, f * hop, n, re, im, mag);
    cur.fill(0);
    for (let k = 1; k < half; k++) if (bandOf[k] >= 0) cur[bandOf[k]] += mag[k];
    for (let b = 0; b < bands; b++) {
      if (!bandHasBin[b]) { const k = Math.max(1, Math.round(Math.sqrt(edges[b] * edges[b + 1]) / binHz)); cur[b] = mag[Math.min(half - 1, k)]; }
      cur[b] = Math.log1p(opt('fluxGain', 1000) * cur[b]);
    }
    let sum = 0;
    if (f >= 2) {
      for (let b = 0; b < bands; b++) {
        // compare with the frame before last, and the loudest neighbour (ignores wobbly vibrato)
        const ref = Math.max(prev2[b], b > 0 ? prev2[b - 1] : 0, b < bands - 1 ? prev2[b + 1] : 0);
        const d = cur[b] - (opt('superflux', 1) ? ref : prev[b]);
        if (d > 0) sum += d;
      }
    }
    flux[f] = sum;
    prev2.set(prev); prev.set(cur);
  }
  // Smooth out jitter (a gentle low-pass, about 8 Hz).
  const fps = rate / hop;
  const smooth = new Float32Array(frames);
  const w = Math.max(1, Math.round(fps / opt('lowpassHz', 8) / 2));
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += flux[f];
    if (f - 2 * w - 1 >= 0) acc -= flux[f - 2 * w - 1];
    const i = f - w;
    if (i >= 0) smooth[i] = acc / (2 * w + 1);
  }
  // Subtract a slow-moving average so only the jumps remain.
  const out = new Float32Array(frames);
  const mw = Math.round(fps * 0.5);
  let macc = 0;
  for (let f = 0; f < frames + mw; f++) {
    if (f < frames) macc += smooth[f];
    if (f - 2 * mw - 1 >= 0) macc -= smooth[f - 2 * mw - 1];
    const i = f - mw;
    if (i >= 0 && i < frames) {
      const count = Math.min(frames - 1, i + mw) - Math.max(0, i - mw) + 1;
      out[i] = Math.max(0, smooth[i] - macc / count);
    }
  }
  return { oss: out, fps };
}

// For one stretch of hits: which beat length fits best? Returns [{ lag, score }].
function windowCandidates(oss, start, size, fps, minLag, maxLag, acfSum) {
  let N = 1; while (N < size * 2) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  let mean = 0;
  for (let i = 0; i < size; i++) mean += oss[start + i];
  mean /= size;
  for (let i = 0; i < size; i++) re[i] = oss[start + i] - mean;
  fft(re, im, false);
  const c = opt('acfPower', 0.5);
  for (let k = 0; k < N; k++) { re[k] = Math.pow(re[k] * re[k] + im[k] * im[k], c); im[k] = 0; }
  fft(re, im, true);
  const acf = new Float64Array(maxLag * 4 + 4);
  for (let i = 0; i < acf.length && i < N; i++) acf[i] = re[i] / N;
  if (acfSum && acf[0] > 0) for (let i = 0; i < acfSum.length && i < acf.length; i++) acfSum[i] += acf[i] / acf[0];
  // Count the repeats at twice and four times the beat length too.
  const eac = new Float64Array(maxLag + 2);
  for (let t = minLag; t <= maxLag + 1; t++) eac[t] = acf[t] + (opt('h2', 1)) * acf[2 * t] + (opt('h4', 1)) * acf[4 * t];
  const peaks = [];
  for (let t = minLag + 1; t <= maxLag; t++) if (eac[t] > eac[t - 1] && eac[t] >= eac[t + 1] && eac[t] > 0) peaks.push(t);
  peaks.sort((a, b) => eac[b] - eac[a]);
  const top = peaks.slice(0, opt('candidates', 10));
  if (!top.length) return [];

  // Lay a metronome over the hits for each guess, at every starting point.
  const results = top.map((t) => {
    // refine the beat length between bins
    const a = eac[t - 1], b = eac[t], cc = eac[t + 1];
    const d = a - 2 * b + cc;
    const lag = t + (d ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - cc)) / d)) : 0);
    let best = 0, sum = 0, sumSq = 0, count = 0;
    const phases = Math.ceil(lag);
    for (let ph = 0; ph < phases; ph++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += pick(oss, start + ph + k * lag, start + size);
      for (let k = 0; k < 2; k++) s += 0.5 * pick(oss, start + ph + k * 2 * lag, start + size);
      for (let k = 0; k < 3; k++) s += 0.5 * pick(oss, start + ph + k * 1.5 * lag, start + size);
      if (s > best) best = s;
      sum += s; sumSq += s * s; count++;
    }
    const mean2 = sum / count;
    const variance = sumSq / count - mean2 * mean2;
    return { lag, best, variance };
  });
  const totalBest = results.reduce((s, r) => s + r.best, 0) || 1;
  const totalVar = results.reduce((s, r) => s + r.variance, 0) || 1;
  results.forEach((r) => { r.score = r.best / totalBest + r.variance / totalVar; });
  return results;
}
function pick(arr, pos, end) {
  const i = Math.round(pos);
  return i < end && i < arr.length ? arr[i] : 0;
}

function detectTempo(all, rate) {
  // Listen to up to 2 minutes, skipping the very start (intros are often quiet).
  const skip = all.length > rate * 30 ? Math.floor(Math.min(all.length * 0.08, rate * 10)) : 0;
  const samples = all.subarray(skip, Math.min(all.length, skip + Math.floor(rate * opt('seconds', 120))));
  const o = onsetStrength(samples, rate);
  if (!o) return null;
  const { oss, fps } = o;
  if (oss.length < fps * 4) return null; // shorter than 4 seconds: can't tell
  let energy = 0;
  for (let i = 0; i < oss.length; i++) energy += oss[i];
  if (energy < 1e-6) return null;

  const minLag = Math.floor((60 * fps) / 210), maxLag = Math.ceil((60 * fps) / 50);
  const size = Math.min(oss.length, Math.round(fps * opt('windowSeconds', 12)));
  const hop = Math.max(1, Math.round(fps * opt('hopSeconds', 1)));

  // Vote: each stretch of the song adds its best guesses to a tally of beat lengths (in BPM).
  const tally = new Float64Array(2201); // 0.1 BPM steps from 0 to 220
  const addVote = (bpm, w) => {
    const sigma = opt('voteSigma', 1.2) * 10;
    const c = Math.round(bpm * 10);
    for (let i = Math.max(0, c - 4 * sigma); i <= Math.min(2200, c + 4 * sigma); i++) tally[i] += w * Math.exp(-0.5 * Math.pow((i - c) / sigma, 2));
  };
  const acfSum = new Float64Array(maxLag * 2 + 4);
  for (let start = 0; start + size <= oss.length; start += hop) {
    const cands = windowCandidates(oss, start, size, fps, minLag, maxLag, acfSum);
    if (!cands.length) continue;
    cands.sort((a, b) => b.score - a.score);
    const topN = opt('votesPerWindow', 1);
    for (let i = 0; i < Math.min(topN, cands.length); i++) addVote((60 * fps) / cands[i].lag, i === 0 ? 1 : cands[i].score / cands[0].score * 0.5);
  }
  let peak = 0;
  for (let i = 500; i <= 2100; i++) if (tally[i] > tally[peak]) peak = i;
  if (!tally[peak]) return null;
  let bpm = peak / 10;

  return chooseOctave(bpm, oss, fps, acfSum);
}

// Double or half time? (90 or 180? 70 or 140?) Weigh how strongly the song repeats at each,
// against the tempos songs usually have (most sit between about 70 and 170).

function chooseOctave(bpm, oss, fps, acfSum) {
  const center = opt('priorCenter', 120), width = opt('priorWidth', 0.8);
  const prior = (b) => Math.exp(-0.5 * Math.pow(Math.log2(b / center) / width, 2));
  // How strongly the song repeats at this beat length (averaged over the whole song).
  const strength = (b) => {
    const lag = (60 * fps) / b;
    const i = Math.floor(lag);
    if (i + 2 >= acfSum.length) return 0;
    return Math.max(0, acfSum[i - 1] || 0, acfSum[i], acfSum[i + 1], acfSum[i + 2] || 0);
  };
  const options = [];
  for (const f of [0.5, 1, 2]) {
    const b = bpm * f;
    if (b < opt('minBpm', 55) || b > opt('maxBpm', 200)) continue;
    options.push({ bpm: b, s: strength(b), score: Math.pow(strength(b), opt('sPow', 0.5)) * prior(b) });
  }
  if (!options.length) return Math.round(bpm);
  options.sort((x, y) => y.score - x.score);
  return Math.round(options[0].bpm);
}


// =====================================================================
// Key
// =====================================================================
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const PROFILES = {
  // Krumhansl & Kessler (1982)
  krumhansl: [[6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]],
  // Temperley (MIREX 2005)
  temperley2005: [[0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400], [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330]],
  // Temperley (revised, 1999)
  temperley: [[5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0], [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0]],
  // Sha'ath (KeyFinder)
  shaath: [[6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4], [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2]],
  // Faraldo et al. (2016), from pop/dance music
  bgate: [[1.00, 0.00, 0.42, 0.00, 0.53, 0.37, 0.00, 0.77, 0.00, 0.38, 0.21, 0.30], [1.00, 0.00, 0.36, 0.39, 0.00, 0.38, 0.00, 0.74, 0.27, 0.00, 0.42, 0.23]],
  edma: [[1.00, 0.29, 0.50, 0.40, 0.60, 0.56, 0.32, 0.80, 0.31, 0.45, 0.42, 0.39], [1.00, 0.31, 0.44, 0.58, 0.33, 0.49, 0.29, 0.78, 0.43, 0.29, 0.53, 0.32]],
  braw: [[1.0000, 0.1573, 0.4200, 0.1570, 0.5296, 0.3669, 0.1632, 0.7711, 0.1676, 0.3827, 0.2113, 0.2965], [1.0000, 0.2330, 0.3615, 0.3905, 0.2925, 0.3777, 0.1961, 0.7425, 0.2701, 0.2161, 0.4228, 0.2272]],
};

// Clear notes in one slice: [{ freq, mag }]
function spectralPeaks(mag, binHz, minHz, maxHz, maxPeaks) {
  const peaks = [];
  let top = 0;
  const lo = Math.max(2, Math.floor(minHz / binHz)), hi = Math.min(mag.length - 2, Math.ceil(maxHz / binHz));
  for (let k = lo; k <= hi; k++) if (mag[k] > top) top = mag[k];
  if (top <= 0) return peaks;
  const floor = top * opt('peakFloor', 0.001);
  for (let k = lo; k <= hi; k++) {
    const m = mag[k];
    if (m > floor && m > mag[k - 1] && m >= mag[k + 1]) {
      // find the exact top of the peak between bins (on a log scale)
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(m + 1e-12), c = Math.log(mag[k + 1] + 1e-12);
      const d = a - 2 * b + c;
      const p = d ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
      peaks.push({ freq: (k + p) * binHz, mag: Math.exp(b - 0.25 * (a - c) * p) });
    }
  }
  peaks.sort((x, y) => y.mag - x.mag);
  return peaks.slice(0, maxPeaks);
}

// Even out loud bass and quiet treble, so the bass doesn't drown out the chords.
function whiten(peaks, mag, binHz) {
  if (!opt('whiten', 1)) return;
  // a broad, smooth outline of the spectrum
  const env = (f) => {
    const b = Math.max(1, Math.floor((f - Math.max(50, f * 0.34)) / binHz));
    const e = Math.min(mag.length - 1, Math.ceil((f + Math.max(50, f * 0.58)) / binHz));
    let s = 0, w = 0;
    const c = (b + e) / 2, h = Math.max(1, (e - b) / 2);
    for (let i = b; i <= e; i++) { let x = 1 - Math.abs(i - c) / h; x = x * x * x * x; s += x * mag[i] * mag[i]; w += x; }
    return Math.sqrt(s / Math.max(1e-12, w));
  };
  for (const p of peaks) p.mag /= Math.max(1e-9, env(p.freq));
}

function detectKey(samples, rate) {
  const n = opt('keyN', 8192);
  const hop = opt('keyHop', 4096);
  const frames = Math.floor((samples.length - n) / hop);
  if (frames < 3) return null;
  const every = Math.max(1, Math.floor(frames / opt('keyMaxFrames', 600)));
  const binHz = rate / n;
  const re = new Float64Array(n), im = new Float64Array(n), mag = new Float64Array(n / 2);
  const minHz = opt('minHz', 55), maxHz = Math.min(opt('maxHz', 1500), rate / 2 - binHz * 2);

  // 1. Peaks in every slice (and the bass notes on their own)
  const framesPeaks = [];
  const framesBass = [];
  for (let f = 0; f < frames; f += every) {
    magnitudes(samples, f * hop, n, re, im, mag);
    const peaks = spectralPeaks(mag, binHz, minHz, maxHz, opt('maxPeaks', 60));
    if (!peaks.length) continue;
    const low = peaks.filter((p) => p.freq < opt('bassMaxHz', 200)).map((p) => ({ freq: p.freq, mag: p.mag }));
    whiten(peaks, mag, binHz);
    framesPeaks.push(peaks);
    framesBass.push(low);
  }
  if (!framesPeaks.length) return null;

  // 2. How in tune is it? (in cents away from A = 440)
  let tuning = 0;
  if (opt('tuning', 1)) {
    const hist = new Float64Array(100);
    for (const peaks of framesPeaks) for (const p of peaks) {
      const cents = 1200 * Math.log2(p.freq / 440);
      let dev = ((cents % 100) + 150) % 100 - 50; // -50..50
      const i = Math.round(dev + 50) % 100;
      hist[i] += p.mag;
    }
    // smooth the histogram circularly and take the top
    let bestI = 50, bestV = -1;
    for (let i = 0; i < 100; i++) {
      let v = 0;
      for (let d = -5; d <= 5; d++) v += hist[(i + d + 100) % 100] * (1 - Math.abs(d) / 6);
      if (v > bestV) { bestV = v; bestI = i; }
    }
    tuning = bestI - 50;
  }
  const ref = 440 * Math.pow(2, tuning / 1200);

  // 3. Add up the 12 notes
  const harmonics = [];
  const H = opt('harmonics', 2);
  for (let i = 0; i <= H; i++) {
    let semitone = 12 * Math.log2(i + 1);
    const octweight = Math.max(1, (semitone / 12) * 0.5);
    while (semitone >= 12 - 1e-4) semitone -= 12;
    const found = harmonics.find((h) => Math.abs(h.semitone - semitone) < 1e-4);
    if (found) found.weight += 1 / octweight; else harmonics.push({ semitone, weight: 1 / octweight });
  }
  const total = new Float64Array(12);
  const pcp = new Float64Array(12);
  const window = opt('pcpWindow', 1); // semitones wide
  for (const peaks of framesPeaks) {
    pcp.fill(0);
    for (const p of peaks) {
      const m = opt('magPow', 2) === 2 ? p.mag * p.mag : Math.pow(p.mag, opt('magPow', 2));
      for (const h of harmonics) {
        const f0 = p.freq * Math.pow(2, -h.semitone / 12);
        const pos = 12 * Math.log2(f0 / ref); // in semitones from A
        const left = Math.ceil(pos - window / 2), right = Math.floor(pos + window / 2);
        for (let i = left; i <= right; i++) {
          const w = Math.cos((Math.PI * Math.abs(pos - i)) / window);
          const wc = opt('sqCos', 1) ? w * w : w;
          pcp[(((i + 9) % 12) + 12) % 12] += wc * m * h.weight; // +9: A -> index 9 (C = 0)
        }
      }
    }
    let top = 0;
    for (let i = 0; i < 12; i++) if (pcp[i] > top) top = pcp[i];
    if (top <= 0) continue;
    for (let i = 0; i < 12; i++) total[i] += pcp[i] / top;
  }
  let top = 0;
  for (let i = 0; i < 12; i++) if (total[i] > top) top = total[i];
  if (top <= 0) return null;
  for (let i = 0; i < 12; i++) {
    total[i] /= top;
    if (total[i] < opt('pcpThreshold', 0.2)) total[i] = 0;
  }

  // The bass usually lands on the key's home note, which tells a minor key from its
  // relative major (they share the same notes, e.g. A minor and C major).
  const bass = new Float64Array(12);
  for (const low of framesBass) {
    const b = new Float64Array(12);
    let top = 0;
    for (const p of low) {
      const pc = (((Math.round(12 * Math.log2(p.freq / ref)) + 9) % 12) + 12) % 12;
      b[pc] += p.mag * p.mag;
      if (b[pc] > top) top = b[pc];
    }
    if (top > 0) for (let i = 0; i < 12; i++) bass[i] += b[i] / top;
  }
  let bassTop = 0, bassMean = 0;
  for (let i = 0; i < 12; i++) { if (bass[i] > bassTop) bassTop = bass[i]; bassMean += bass[i] / 12; }
  const bassAt = (pc) => (bassTop > 0 ? (bass[pc] - bassMean) / bassTop : 0);
  const bassWeight = opt('bassWeight', 0.3);

  // 4. Which scale fits?
  const names = String(opt('profile', 'shaath')).split('+');
  let best = -Infinity, name = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, idx] of [['major', 0], ['minor', 1]]) {
      let r = 0;
      for (const pn of names) r += correlation(total, (i) => PROFILES[pn][idx][(i - tonic + 12) % 12]);
      r = r / names.length + bassWeight * bassAt(tonic);
      if (r > best) { best = r; name = `${NOTE_NAMES[tonic]} ${mode}`; }
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
