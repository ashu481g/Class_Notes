// Pure-TypeScript speech enhancement: filters, spectral noise reduction,
// phase-vocoder pitch shift and loudness levelling. Runs inside a Web Worker.

export type EnhanceOptions = {
  denoise: boolean;
  /** 0 (gentle) .. 1 (aggressive) */
  denoiseStrength: number;
  clarity: boolean;
  /** semitones, e.g. -4 .. +4. 0 = unchanged */
  pitch: number;
  level: boolean;
};

export type Progress = (stage: string, fraction: number) => void;

// ---------- FFT (radix-2, in place) ----------

class FFT {
  readonly n: number;
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;

  constructor(n: number) {
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  forward(re: Float64Array, im: Float64Array) {
    this.transform(re, im);
  }

  inverse(re: Float64Array, im: Float64Array) {
    this.transform(im, re); // swap trick
    const s = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }

  private transform(re: Float64Array, im: Float64Array) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = this.cos[k], s = this.sin[k];
          const tre = re[l] * c + im[l] * s;
          const tim = im[l] * c - re[l] * s;
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  }
}

function frameSize(sr: number) {
  // ~64 ms analysis window, power of two
  return 2 ** Math.floor(Math.log2(0.064 * sr));
}

// ---------- Biquad filters (RBJ cookbook) ----------

type Coefs = [number, number, number, number, number]; // b0 b1 b2 a1 a2 (normalised)

function biquad(type: "highpass" | "lowpass" | "peak" | "lowshelf", f: number, sr: number, q = 0.707, gainDb = 0): Coefs {
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const A = 10 ** (gainDb / 40);
  const alpha = sw / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (type) {
    case "highpass":
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case "lowpass":
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case "peak":
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
      break;
    case "lowshelf": {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + sq);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - sq);
      a0 = (A + 1) + (A - 1) * cw + sq;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - sq;
      break;
    }
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function applyBiquad(x: Float32Array, [b0, b1, b2, a1, a2]: Coefs) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    x[i] = yi;
  }
}

// ---------- Spectral noise reduction ----------

/**
 * Learns the noise spectrum from the quietest 10% of frames (fans, hum, hiss
 * between sentences), then applies smoothed spectral subtraction.
 */
export function denoise(x: Float32Array, sr: number, strength: number, progress: Progress): Float32Array {
  const N = frameSize(sr);
  const hop = N / 2;
  const bins = N / 2 + 1;
  if (x.length < N * 4) return x;

  const win = new Float64Array(N); // sqrt-Hann: analysis * synthesis = Hann, sums to 1 at 50% overlap
  for (let i = 0; i < N; i++) win[i] = Math.sin((Math.PI * i) / N);

  const frames = Math.floor((x.length - N) / hop) + 1;
  const fft = new FFT(N);
  const re = new Float64Array(N), im = new Float64Array(N);

  // Pass 1: frame energies -> pick quiet frames as the noise sample
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const o = f * hop;
    for (let i = 0; i < N; i += 4) e += x[o + i] * x[o + i];
    energy[f] = e;
  }
  const sorted = Array.from(energy).filter((e) => e > 1e-10).sort((a, b) => a - b);
  const threshold = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0;
  const quiet: number[] = [];
  for (let f = 0; f < frames; f++) if (energy[f] > 1e-10 && energy[f] <= threshold) quiet.push(f);
  const stride = Math.max(1, Math.floor(quiet.length / 3000));

  const noise = new Float64Array(bins);
  let count = 0;
  for (let q = 0; q < quiet.length; q += stride) {
    const o = quiet[q] * hop;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft.forward(re, im);
    for (let k = 0; k < bins; k++) noise[k] += re[k] * re[k] + im[k] * im[k];
    count++;
  }
  if (!count) return x;
  for (let k = 0; k < bins; k++) noise[k] /= count;

  // Pass 2: subtract
  const over = 1.5 + 2.5 * strength; // over-subtraction factor
  const floor = 0.3 - 0.24 * strength; // residual floor (-10 dB .. -24 dB)
  const prevGain = new Float64Array(bins).fill(1);
  const gain = new Float64Array(bins);
  const out = new Float32Array(x.length);

  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft.forward(re, im);
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k] + 1e-20;
      let g = Math.sqrt(Math.max(0, 1 - (over * noise[k]) / p));
      g = Math.max(floor, g);
      // temporal smoothing tames "musical noise"; let speech onsets through quickly
      g = g > prevGain[k] ? 0.2 * prevGain[k] + 0.8 * g : 0.6 * prevGain[k] + 0.4 * g;
      gain[k] = g;
    }
    for (let k = 0; k < bins; k++) {
      // 3-bin frequency smoothing
      const g = (gain[Math.max(0, k - 1)] + 2 * gain[k] + gain[Math.min(bins - 1, k + 1)]) / 4;
      prevGain[k] = gain[k];
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    fft.inverse(re, im);
    for (let i = 0; i < N; i++) out[o + i] += re[i] * win[i];
    if (f % 2000 === 0) progress("Removing background noise", f / frames);
  }
  return out;
}

// ---------- Pitch shift (phase vocoder + resample) ----------

export function pitchShift(x: Float32Array, sr: number, semitones: number, progress: Progress): Float32Array {
  if (!semitones) return x;
  const N = frameSize(sr);
  const Ha = N / 4;
  const Hs = Math.round(Ha * 2 ** (semitones / 12));
  const ratio = Hs / Ha;
  const bins = N / 2 + 1;
  if (x.length < N * 2) return x;

  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  const frames = Math.floor((x.length - N) / Ha) + 1;
  const outLen = (frames - 1) * Hs + N;
  const stretched = new Float32Array(outLen);
  const wsum = new Float32Array(outLen);
  const fft = new FFT(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const prevPhase = new Float64Array(bins);
  const sumPhase = new Float64Array(bins);
  const TWO_PI = 2 * Math.PI;

  for (let f = 0; f < frames; f++) {
    const o = f * Ha;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft.forward(re, im);
    for (let k = 0; k < bins; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const phase = Math.atan2(im[k], re[k]);
      const expected = (TWO_PI * k * Ha) / N;
      let delta = phase - prevPhase[k] - expected;
      delta -= TWO_PI * Math.round(delta / TWO_PI);
      prevPhase[k] = phase;
      sumPhase[k] = f === 0 ? phase : sumPhase[k] + (expected + delta) * ratio;
      re[k] = mag * Math.cos(sumPhase[k]);
      im[k] = mag * Math.sin(sumPhase[k]);
    }
    for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    fft.inverse(re, im);
    const so = f * Hs;
    for (let i = 0; i < N; i++) {
      stretched[so + i] += re[i] * win[i];
      wsum[so + i] += win[i] * win[i];
    }
    if (f % 4000 === 0) progress("Adjusting pitch", f / frames);
  }
  for (let i = 0; i < outLen; i++) if (wsum[i] > 1e-3) stretched[i] /= wsum[i];

  // Resample the time-stretched signal back to the original duration
  const y = new Float32Array(x.length);
  for (let i = 0; i < y.length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    if (j + 1 >= outLen) break;
    const t = pos - j;
    y[i] = stretched[j] * (1 - t) + stretched[j + 1] * t;
  }
  return y;
}

// ---------- Loudness levelling (slow AGC + soft limiter) ----------

export function levelVoice(x: Float32Array, sr: number): Float32Array {
  const block = Math.round(0.05 * sr);
  const nb = Math.ceil(x.length / block);
  const db = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let e = 0;
    const end = Math.min(x.length, (b + 1) * block);
    for (let i = b * block; i < end; i++) e += x[i] * x[i];
    db[b] = 10 * Math.log10(e / Math.max(1, end - b * block) + 1e-12);
  }
  const s = Array.from(db).sort((a, b) => a - b);
  const noiseDb = s[Math.floor(s.length * 0.2)];
  const gateDb = noiseDb + 8;
  const targetDb = -20;
  const maxGainDb = 18;

  const gains = new Float64Array(nb);
  let g = 0; // dB
  for (let b = 0; b < nb; b++) {
    if (db[b] > gateDb) {
      const want = Math.min(maxGainDb, Math.max(-12, targetDb - db[b]));
      g += (want - g) * (want < g ? 0.3 : 0.03); // fast attack, slow release
    }
    gains[b] = g;
  }
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const p = i / block - 0.5;
    const b = Math.max(0, Math.min(nb - 1, Math.floor(p)));
    const b2 = Math.min(nb - 1, b + 1);
    const t = Math.max(0, Math.min(1, p - b));
    const gd = gains[b] * (1 - t) + gains[b2] * t;
    y[i] = x[i] * 10 ** (gd / 20);
  }
  return y;
}

function softLimitAndNormalize(x: Float32Array) {
  const thr = 0.8;
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > thr) x[i] = Math.sign(x[i]) * (thr + (1 - thr) * Math.tanh((a - thr) / (1 - thr)));
    peak = Math.max(peak, Math.abs(x[i]));
  }
  if (peak > 0) {
    const k = 0.97 / peak;
    for (let i = 0; i < x.length; i++) x[i] *= k;
  }
}

// ---------- Full chain ----------

export function enhance(input: Float32Array, sr: number, o: EnhanceOptions, progress: Progress): Float32Array {
  let x: Float32Array = new Float32Array(input);

  progress("Filtering rumble and hum", 0);
  applyBiquad(x, biquad("highpass", 80, sr, 0.707));
  applyBiquad(x, biquad("highpass", 80, sr, 0.707)); // 4th-order total

  if (o.denoise) x = denoise(x, sr, o.denoiseStrength, progress);
  if (o.pitch) x = pitchShift(x, sr, o.pitch, progress);

  if (o.clarity) {
    progress("Boosting voice clarity", 0);
    applyBiquad(x, biquad("lowshelf", 220, sr, 0.707, -3)); // reduce boominess
    applyBiquad(x, biquad("peak", 3000, sr, 1.0, 5)); // presence: consonants & intelligibility
    applyBiquad(x, biquad("lowpass", Math.min(0.45 * sr, 11000), sr, 0.707)); // remove hiss above speech
  }

  if (o.level) {
    progress("Levelling loudness", 0);
    x = levelVoice(x, sr);
  }
  softLimitAndNormalize(x);
  progress("Done", 1);
  return x;
}
