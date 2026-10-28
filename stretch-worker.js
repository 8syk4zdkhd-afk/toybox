/*
  TOYBOX — stretch-worker.js
  Makes a slower or faster copy of a song that keeps its pitch, in the background,
  in high quality. (The phone's own speed change can sound watery or robotic.)

  How it works, simply (a "phase vocoder"):
  • Cut the song into short, overlapping slices (about a tenth of a second each).
  • Turn each slice into its notes (frequencies) with an FFT.
  • Lay the slices back down closer together (faster) or further apart (slower),
    turning each note's "position in its wave cycle" just the right amount so the
    notes keep flowing smoothly instead of wobbling.
  • Notes are kept in step with their neighbours ("phase locking"), which keeps
    chords and voices clear, and both speakers get the same treatment, so the
    stereo picture stays put.
  • On drum hits the slices start fresh, so hits stay punchy.
*/

self.onmessage = (event) => {
  const { id, channels, sampleRate, rate } = event.data;
  try {
    const wav = stretchToWav(channels, sampleRate, rate, (p) => self.postMessage({ id, progress: p }));
    self.postMessage({ id, wav }, wav);
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};

// ---------- FFT ----------
function makeFft(n) {
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  const rev = new Uint32Array(n);
  for (let i = 0, j = 0; i < n; i++) {
    rev[i] = j;
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
  }
  return function fft(re, im, inverse) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const wr = cos[w], wi = sign * sin[w];
          const a = i + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

const TWO_PI = 2 * Math.PI;
const wrap = (x) => x - TWO_PI * Math.round(x / TWO_PI); // into -π..π

// rate > 1 = faster (shorter), rate < 1 = slower (longer). Returns WAV file parts (ArrayBuffers).
function stretchToWav(channels, sampleRate, rate, onProgress) {
  const left = channels[0];
  const right = channels[1] || channels[0];
  const stereo = channels.length > 1;
  const inLen = left.length;
  const outLen = Math.max(1, Math.round(inLen / rate));

  // Slice size: ~85 ms at 48 kHz (good for bass notes), 4 overlapping slices per slice length.
  const N = sampleRate > 32000 ? 4096 : 2048;
  const half = N / 2;
  const Hs = N / 4; // spacing of slices in the new copy
  const fft = makeFft(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N);
  // overlap-add makes Hann² slices sum to 1.5 at 4× overlap
  let wsum = 0;
  for (let i = 0; i < N; i += Hs) wsum += win[i] * win[i];
  const norm = 1 / (wsum || 1);

  const re = new Float64Array(N), im = new Float64Array(N);
  const Lre = new Float64Array(half + 1), Lim = new Float64Array(half + 1);
  const Rre = new Float64Array(half + 1), Rim = new Float64Array(half + 1);
  const mag = new Float64Array(half + 1), phase = new Float64Array(half + 1);
  const prevPhase = new Float64Array(half + 1), synPhase = new Float64Array(half + 1);
  const prevLogMag = new Float64Array(half + 1);
  const rot = new Float64Array(half + 1);
  const isPeak = new Uint8Array(half + 1);
  const peaks = new Int32Array(half + 1);
  const omega = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) omega[k] = (TWO_PI * k) / N;

  // Output: overlap-add into a rolling buffer, written out as 16-bit samples once finished.
  const acc = [new Float64Array(N * 2), new Float64Array(N * 2)];
  const parts = [];
  const chunkFrames = 16384;
  let chunk = new Int16Array(chunkFrames * 2);
  let chunkFill = 0;
  let written = 0;
  const emit = (l, r) => {
    if (written >= outLen) return;
    chunk[chunkFill * 2] = l > 1 ? 32767 : l < -1 ? -32768 : Math.round(l * 32767);
    chunk[chunkFill * 2 + 1] = r > 1 ? 32767 : r < -1 ? -32768 : Math.round(r * 32767);
    chunkFill++; written++;
    if (chunkFill === chunkFrames) { parts.push(chunk.buffer); chunk = new Int16Array(chunkFrames * 2); chunkFill = 0; }
  };

  // Drum-hit detector state
  let fluxAvg = 0, lastFlux = 0, sinceHit = 99;

  const frames = Math.ceil(outLen / Hs) + 2;
  let prevAnalysis = null;
  let accStart = -half; // output sample index of acc[*][0]
  let lastProgress = 0;

  for (let t = 0; t < frames; t++) {
    const synCenter = t * Hs; // output position (centre of slice)
    const anaCenter = Math.round(synCenter * rate); // where that is in the original
    const Ha = prevAnalysis === null ? Hs * rate : anaCenter - prevAnalysis;
    prevAnalysis = anaCenter;

    // 1. Windowed slice of both channels, packed into one FFT (left = real, right = imaginary)
    const start = anaCenter - half;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      const inside = j >= 0 && j < inLen;
      re[i] = inside ? left[j] * win[i] : 0;
      im[i] = inside ? right[j] * win[i] : 0;
    }
    fft(re, im, false);
    for (let k = 0; k <= half; k++) {
      const nk = (N - k) % N;
      Lre[k] = 0.5 * (re[k] + re[nk]); Lim[k] = 0.5 * (im[k] - im[nk]);
      Rre[k] = 0.5 * (im[k] + im[nk]); Rim[k] = -0.5 * (re[k] - re[nk]);
      const mr = Lre[k] + Rre[k], mi = Lim[k] + Rim[k]; // the middle (both speakers together)
      mag[k] = Math.sqrt(mr * mr + mi * mi);
      phase[k] = Math.atan2(mi, mr);
    }

    // 2. Is this slice a drum hit? (a sudden jump in loudness across many notes)
    let flux = 0;
    for (let k = 1; k < half; k++) {
      const lm = Math.log(1 + mag[k] * 100);
      const d = lm - prevLogMag[k];
      if (d > 0) flux += d;
      prevLogMag[k] = lm;
    }
    flux /= half;
    const hit = t > 2 && rate !== 1 && sinceHit >= 3 && flux > fluxAvg * 2 + 0.002 && flux > lastFlux * 1.1;
    sinceHit = hit ? 0 : sinceHit + 1;
    fluxAvg = fluxAvg * 0.9 + flux * 0.1;
    lastFlux = flux;

    // 3. New wave positions for each note
    if (t === 0 || hit) {
      for (let k = 0; k <= half; k++) synPhase[k] = phase[k];
    } else {
      // peaks: the loudest bins around them lead, their neighbours follow
      let np = 0;
      for (let k = 2; k < half - 1; k++) {
        const m = mag[k];
        isPeak[k] = m > mag[k - 1] && m >= mag[k + 1] && m > mag[k - 2] && m >= mag[k + 2] ? 1 : 0;
        if (isPeak[k]) peaks[np++] = k;
      }
      if (!np) { peaks[np++] = 1; }
      for (let p = 0; p < np; p++) {
        const k = peaks[p];
        const expected = omega[k] * Ha;
        const dev = wrap(phase[k] - prevPhase[k] - expected);
        const trueFreq = omega[k] + dev / Ha;
        synPhase[k] = synPhase[k] + trueFreq * Hs;
      }
      // every bin follows its nearest peak, keeping its own offset from it
      let p = 0;
      for (let k = 0; k <= half; k++) {
        while (p < np - 1 && Math.abs(peaks[p + 1] - k) < Math.abs(peaks[p] - k)) p++;
        const pk = peaks[p];
        if (k !== pk) synPhase[k] = synPhase[pk] + (phase[k] - phase[pk]);
      }
      // wrap the leaders now (their followers were set from them)
      for (let q = 0; q < np; q++) synPhase[peaks[q]] = wrap(synPhase[peaks[q]]);
    }
    for (let k = 0; k <= half; k++) {
      rot[k] = synPhase[k] - phase[k];
      prevPhase[k] = phase[k];
      synPhase[k] = wrap(synPhase[k]);
    }
    rot[0] = 0; rot[half] = 0; // the lowest and highest bins must stay real

    // 4. Turn both channels by the same amount, and back into sound (packed again)
    for (let k = 0; k <= half; k++) {
      const c = Math.cos(rot[k]), s = Math.sin(rot[k]);
      const lr = Lre[k] * c - Lim[k] * s, li = Lre[k] * s + Lim[k] * c;
      const rr = Rre[k] * c - Rim[k] * s, ri = Rre[k] * s + Rim[k] * c;
      // Y = L + i·R, with the mirror half filled in so the outputs stay real
      re[k] = lr - ri; im[k] = li + rr;
      if (k > 0 && k < half) {
        const nk = N - k;
        re[nk] = lr + ri; im[nk] = -li + rr;
      }
    }
    fft(re, im, true);

    // 5. Overlap-add into the output
    const outStart = synCenter - half;
    for (let i = 0; i < N; i++) {
      const j = outStart + i - accStart;
      const w = win[i] * norm / N;
      acc[0][j] += re[i] * w;
      acc[1][j] += im[i] * w;
    }
    // everything before the next slice's start is finished: write it out
    const doneUntil = (t + 1) * Hs - half;
    const ready = doneUntil - accStart;
    if (ready > 0) {
      for (let i = 0; i < ready; i++) {
        const outIndex = accStart + i;
        if (outIndex >= 0) emit(acc[0][i], stereo ? acc[1][i] : acc[0][i]);
      }
      acc[0].copyWithin(0, ready); acc[1].copyWithin(0, ready);
      acc[0].fill(0, acc[0].length - ready); acc[1].fill(0, acc[1].length - ready);
      accStart += ready;
    }
    if (onProgress && t - lastProgress > 400) { lastProgress = t; onProgress(t / frames); }
  }
  while (written < outLen) emit(0, 0);
  if (chunkFill) parts.push(chunk.slice(0, chunkFill * 2).buffer);

  // WAV header (16-bit stereo PCM)
  const dataBytes = outLen * 4;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  return [header, ...parts];
}

if (typeof module === 'object' && module.exports) module.exports = { stretchToWav };
