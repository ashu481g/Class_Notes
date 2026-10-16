// Browser audio helpers: decode, resample, WAV encode, split at pauses.
import type { EnhanceOptions } from "./dsp";

/** Decode any browser-supported file (mp3, m4a, wav, webm, ogg...) to mono at `sampleRate`. */
export async function decodeToMono(file: Blob, sampleRate: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate });
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}

export async function resample(samples: Float32Array, from: number, to: number): Promise<Float32Array> {
  if (from === to) return samples;
  const length = Math.ceil((samples.length * to) / from);
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: to });
  const buf = ctx.createBuffer(1, samples.length, from);
  buf.copyToChannel(new Float32Array(samples), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0, o = 44; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Split audio into chunks of about `targetSec`, cutting at the quietest
 * 100 ms within the last `searchSec` of each chunk so words aren't cut in half.
 */
export function splitAtPauses(samples: Float32Array, sr: number, targetSec: number, searchSec = 8): [number, number][] {
  const out: [number, number][] = [];
  const target = Math.floor(targetSec * sr);
  const search = Math.floor(searchSec * sr);
  const win = Math.floor(0.1 * sr);
  let start = 0;
  while (start < samples.length) {
    let end = start + target;
    if (end >= samples.length) { out.push([start, samples.length]); break; }
    let best = end, bestE = Infinity;
    for (let p = end - search; p + win <= end; p += win / 2) {
      let e = 0;
      for (let i = p; i < p + win; i++) e += samples[i] * samples[i];
      if (e < bestE) { bestE = e; best = p + win / 2; }
    }
    end = Math.floor(best);
    out.push([start, end]);
    start = end;
  }
  return out;
}

export function enhanceInWorker(
  samples: Float32Array,
  sampleRate: number,
  options: EnhanceOptions,
  onProgress: (stage: string, fraction: number) => void,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/dsp.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") onProgress(m.stage, m.fraction);
      else {
        worker.terminate();
        if (m.type === "done") resolve(m.samples);
        else reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    const copy = new Float32Array(samples);
    worker.postMessage({ samples: copy, sampleRate, options }, [copy.buffer]);
  });
}

export function formatTime(sec: number) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
}
