// Draws slides on a canvas, exports .pptx, and encodes a narrated MP4 entirely in the browser
// (WebCodecs + mp4-muxer: much faster than real time, works in Chrome and Edge).
import type { Deck, Slide } from "./deck";

export const W = 1920;
export const H = 1080;

const C = {
  bg: "#ffffff",
  accent: "#4f46e5",
  title: "#1e1b4b",
  text: "#1f2937",
  muted: "#6b7280",
  formulaBg: "#eef2ff",
};
const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, sans-serif';
const MATH_FONT = '"Cambria Math", Cambria, "Times New Roman", serif';

// ---------- diagrams -> images ----------

function sizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const el = doc.documentElement;
  if (el.nodeName !== "svg") throw new Error("Not an SVG");
  el.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const vb = (el.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    el.setAttribute("width", String(vb[2]));
    el.setAttribute("height", String(vb[3]));
  }
  el.removeAttribute("style");
  return new XMLSerializer().serializeToString(el);
}

function loadImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Diagram image failed to load"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

let mermaidSeq = 0;
export async function diagramImage(d: Slide["diagram"]): Promise<HTMLImageElement | null> {
  if (d.type === "none" || !d.code.trim()) return null;
  try {
    if (d.type === "svg") return await loadImage(sizeSvg(d.code));
    const mermaid = (await import("mermaid")).default;
    // SVG text labels (not HTML) so the diagram can be drawn onto a canvas.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", htmlLabels: false, flowchart: { htmlLabels: false } });
    const id = `slide-mermaid-${++mermaidSeq}`;
    try {
      const { svg } = await mermaid.render(id, d.code);
      return await loadImage(sizeSvg(svg));
    } finally {
      document.getElementById("d" + id)?.remove();
    }
  } catch {
    return null; // a broken diagram should not block the whole deck
  }
}

// ---------- slide drawing ----------

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; }
    else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

export function drawSlide(ctx: CanvasRenderingContext2D, deck: Deck, i: number, img: HTMLImageElement | null) {
  const s = deck.slides[i];
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.accent;
  ctx.fillRect(0, 0, 24, H);
  ctx.textBaseline = "alphabetic";

  // footer
  ctx.font = `28px ${FONT}`;
  ctx.fillStyle = C.muted;
  ctx.textAlign = "left";
  ctx.fillText(deck.title.slice(0, 90), 100, H - 50);
  ctx.textAlign = "right";
  ctx.fillText(`${i + 1} / ${deck.slides.length}`, W - 80, H - 50);
  ctx.textAlign = "left";

  if (i === 0) {
    // title slide
    ctx.fillStyle = C.title;
    ctx.font = `bold 88px ${FONT}`;
    ctx.textAlign = "center";
    const lines = wrap(ctx, s.title || deck.title, W - 360);
    let y = H / 2 - (lines.length * 104) / 2 - 20;
    for (const l of lines) { ctx.fillText(l, W / 2, y + 88); y += 104; }
    ctx.fillStyle = C.accent;
    ctx.fillRect(W / 2 - 120, y + 30, 240, 8);
    ctx.font = `40px ${FONT}`;
    ctx.fillStyle = C.muted;
    let y2 = y + 110;
    for (const l of wrap(ctx, s.bullets.join("  ·  "), W - 400).slice(0, 3)) { ctx.fillText(l, W / 2, y2); y2 += 56; }
    ctx.textAlign = "left";
    return;
  }

  // title
  ctx.fillStyle = C.title;
  ctx.font = `bold 64px ${FONT}`;
  const titleLines = wrap(ctx, s.title, W - 200).slice(0, 2);
  let y = 140;
  for (const l of titleLines) { ctx.fillText(l, 100, y); y += 76; }
  ctx.fillStyle = C.accent;
  ctx.fillRect(100, y - 40, 140, 6);
  const top = y + 10;
  const bottom = H - 120;

  const colW = img ? 860 : W - 200;

  // shrink text until it fits
  for (let scale = 1; scale >= 0.55; scale -= 0.05) {
    const fs = Math.round(42 * scale), lh = Math.round(58 * scale), gap = Math.round(22 * scale);
    const mfs = Math.round(50 * scale);
    ctx.font = `${fs}px ${FONT}`;
    const blocks = s.bullets.map((b) => wrap(ctx, b, colW - 50));
    let h = blocks.reduce((a, b) => a + b.length * lh + gap, 0);
    ctx.font = `${mfs}px ${MATH_FONT}`;
    const fLines = s.formula ? wrap(ctx, s.formula, colW - 60) : [];
    if (fLines.length) h += 40 + fLines.length * (mfs + 18) + 40;
    if (top + h > bottom && scale > 0.56) continue;

    let yy = top + fs;
    ctx.font = `${fs}px ${FONT}`;
    for (const lines of blocks) {
      ctx.fillStyle = C.accent;
      ctx.beginPath();
      ctx.arc(112, yy - fs * 0.33, fs * 0.17, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.text;
      for (const l of lines) { ctx.fillText(l, 150, yy); yy += lh; }
      yy += gap;
    }
    if (fLines.length) {
      const boxH = fLines.length * (mfs + 18) + 40;
      const by = yy - fs + 20;
      ctx.fillStyle = C.formulaBg;
      ctx.beginPath();
      ctx.roundRect(100, by, colW, boxH, 16);
      ctx.fill();
      ctx.fillStyle = C.title;
      ctx.font = `${mfs}px ${MATH_FONT}`;
      ctx.textAlign = "center";
      let fy = by + 20 + mfs;
      for (const l of fLines) { ctx.fillText(l, 100 + colW / 2, fy); fy += mfs + 18; }
      ctx.textAlign = "left";
    }
    break;
  }

  if (img) {
    const bx = 1010, bw = W - 80 - bx, by = top - 10, bh = bottom - by;
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 16);
    ctx.stroke();
    const k = Math.min((bw - 40) / img.width, (bh - 40) / img.height);
    const dw = img.width * k, dh = img.height * k;
    ctx.drawImage(img, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
  }
}

export function slideCanvas(deck: Deck, i: number, img: HTMLImageElement | null) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  drawSlide(canvas.getContext("2d")!, deck, i, img);
  return canvas;
}

// ---------- PowerPoint ----------

function imageToPng(img: HTMLImageElement) {
  const k = Math.min(2, 1600 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { data: c.toDataURL("image/png"), w: c.width, h: c.height };
}

export async function buildPptx(deck: Deck, images: (HTMLImageElement | null)[]): Promise<Blob> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  pptx.title = deck.title;

  deck.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addShape("rect", { x: 0, y: 0, w: 0.17, h: 7.5, fill: { color: "4F46E5" }, line: { color: "4F46E5" } });
    slide.addText(`${i + 1} / ${deck.slides.length}`, { x: 11.3, y: 6.95, w: 1.8, h: 0.4, fontSize: 11, color: "6B7280", align: "right" });
    if (s.narration) slide.addNotes(s.narration);

    if (i === 0) {
      slide.addText(s.title || deck.title, { x: 1, y: 2.3, w: 11.33, h: 1.6, fontSize: 40, bold: true, color: "1E1B4B", align: "center" });
      slide.addText(s.bullets.join("  ·  "), { x: 1.5, y: 4.1, w: 10.33, h: 1, fontSize: 20, color: "6B7280", align: "center" });
      return;
    }
    const img = images[i];
    const textW = img ? 6.2 : 12.1;
    slide.addText(s.title, { x: 0.6, y: 0.35, w: 12.1, h: 0.95, fontSize: 30, bold: true, color: "1E1B4B" });
    slide.addText(
      s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
      { x: 0.6, y: 1.45, w: textW, h: s.formula ? 3.9 : 5.3, fontSize: 20, color: "1F2937", valign: "top", paraSpaceAfter: 8, fit: "shrink" },
    );
    if (s.formula) {
      slide.addText(s.formula, { x: 0.6, y: 5.5, w: textW, h: 1.2, fontSize: 24, fontFace: "Cambria Math", color: "1E1B4B", align: "center", fill: { color: "EEF2FF" }, fit: "shrink" });
    }
    if (img) {
      const png = imageToPng(img);
      const boxW = 5.9, boxH = 5.2;
      const k = Math.min(boxW / png.w, boxH / png.h);
      const w = png.w * k, h = png.h * k;
      slide.addImage({ data: png.data, x: 7.0 + (boxW - w) / 2, y: 1.45 + (boxH - h) / 2, w, h });
    }
  });
  return (await pptx.write({ outputType: "blob" })) as Blob;
}

// ---------- narrated video ----------

const SR = 48000;
const FPS = 5;
const PAUSE = 0.8; // seconds of silence after each slide's narration

async function pickCodecs() {
  const videoCodecs = ["avc1.640028", "avc1.4d0028", "avc1.42003e"];
  let video = "";
  for (const codec of videoCodecs) {
    const r = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate: 2_500_000, framerate: FPS });
    if (r.supported) { video = codec; break; }
  }
  if (!video) throw new Error("This browser cannot encode H.264 video. Use Chrome or Edge.");
  const aac = await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: SR, numberOfChannels: 1, bitrate: 128_000 });
  return { video, audio: aac.supported ? ("aac" as const) : ("opus" as const) };
}

export async function decodeClip(blob: Blob): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: SR });
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  return buf.getChannelData(0).slice();
}

/** True when the browser can use the fast encoder (WebCodecs needs Chrome/Edge on https or localhost). */
export const canEncodeFast = () => typeof window !== "undefined" && typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined";

/**
 * `clips[i]` is the narration audio for slide i (or null for a short silent slide).
 * Uses fast WebCodecs encoding when available, otherwise records the presentation in real time.
 */
export async function renderVideo(
  deck: Deck,
  images: (HTMLImageElement | null)[],
  clips: (Blob | null)[],
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  return canEncodeFast() ? renderVideoFast(deck, images, clips, onProgress) : renderVideoRealtime(deck, images, clips, onProgress);
}

/**
 * Fallback: plays the slides with their narration into a MediaRecorder. Takes as long as the
 * video itself, but works without WebCodecs (e.g. when the app is opened via a network IP over http).
 */
async function renderVideoRealtime(
  deck: Deck,
  images: (HTMLImageElement | null)[],
  clips: (Blob | null)[],
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  if (typeof MediaRecorder === "undefined") throw new Error("This browser cannot record video. Use Chrome or Edge.");
  const actx = new AudioContext({ sampleRate: SR });
  await actx.resume();

  // Decode all narration first and lay the slides out on one timeline.
  const buffers: (AudioBuffer | null)[] = [];
  for (const c of clips) buffers.push(c ? await actx.decodeAudioData(await c.arrayBuffer()) : null);
  const starts: number[] = [];
  let total = 0.5; // short lead-in so the recorder is running before the first word
  for (const b of buffers) {
    starts.push(total);
    total += (b ? b.duration : 3) + PAUSE;
  }

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  drawSlide(ctx, deck, 0, images[0]);

  const dest = actx.createMediaStreamDestination();
  const stream = new MediaStream([...canvas.captureStream(10).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mimeType =
    ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    ) || "";
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
  rec.start(1000);

  // Schedule every clip on the audio clock, then follow that clock to switch slides.
  const t0 = actx.currentTime;
  buffers.forEach((b, i) => {
    if (!b) return;
    const src = actx.createBufferSource();
    src.buffer = b;
    src.connect(dest);
    src.start(t0 + starts[i]);
  });

  await new Promise<void>((resolve) => {
    const tick = () => {
      const t = actx.currentTime - t0;
      let i = 0;
      while (i + 1 < starts.length && t >= starts[i + 1]) i++;
      // redraw regularly: canvas capture only emits frames when the canvas is painted
      drawSlide(ctx, deck, i, images[i]);
      onProgress(Math.min(1, t / total));
      if (t >= total) { clearInterval(timer); resolve(); }
    };
    const timer = setInterval(tick, 200);
    tick();
  });

  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  await actx.close();
  return new Blob(parts, { type: (mimeType || "video/webm").split(";")[0] });
}

async function renderVideoFast(
  deck: Deck,
  images: (HTMLImageElement | null)[],
  clips: (Blob | null)[],
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
  const codecs = await pickCodecs();
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: W, height: H, frameRate: FPS },
    audio: { codec: codecs.audio, sampleRate: SR, numberOfChannels: 1 },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  let failure: unknown = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (failure = e) });
  venc.configure({ codec: codecs.video, width: W, height: H, bitrate: 2_500_000, framerate: FPS, latencyMode: "quality" });
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (failure = e) });
  aenc.configure({ codec: codecs.audio === "aac" ? "mp4a.40.2" : "opus", sampleRate: SR, numberOfChannels: 1, bitrate: 128_000 });

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  let t = 0; // seconds
  const block = 4800; // 0.1 s audio packets
  for (let i = 0; i < deck.slides.length; i++) {
    if (failure) throw failure;
    drawSlide(ctx, deck, i, images[i]);
    const voice = clips[i] ? await decodeClip(clips[i]!) : new Float32Array(SR * 3);
    // video: the slide is static, so a few frames per second is plenty
    const frames = Math.max(1, Math.ceil((voice.length / SR + PAUSE) * FPS));
    // audio padded to exactly the slide's video length, so the two tracks stay in sync
    const samples = new Float32Array(Math.round((frames / FPS) * SR));
    samples.set(voice.subarray(0, samples.length));
    for (let f = 0; f < frames; f++) {
      const frame = new VideoFrame(canvas, { timestamp: Math.round((t + f / FPS) * 1e6), duration: Math.round(1e6 / FPS) });
      venc.encode(frame, { keyFrame: f % (FPS * 10) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    }

    // audio
    for (let o = 0; o < samples.length; o += block) {
      const n = Math.min(block, samples.length - o);
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: SR,
        numberOfFrames: n,
        numberOfChannels: 1,
        timestamp: Math.round((t + o / SR) * 1e6),
        data: samples.slice(o, o + n),
      });
      aenc.encode(data);
      data.close();
    }
    t += frames / FPS;
    onProgress((i + 1) / deck.slides.length);
  }

  await venc.flush();
  await aenc.flush();
  if (failure) throw failure;
  muxer.finalize();
  return new Blob([target.buffer], { type: "video/mp4" });
}

// ---------- free preview with the browser's own Hindi voice ----------

export function speakWithBrowserVoice(text: string) {
  const synth = window.speechSynthesis;
  synth.cancel();
  const voices = synth.getVoices();
  const preferred = ["Swara", "Madhur", "Google हिन्दी", "Kalpana", "Hemant", "Lekha"];
  const voice =
    voices.find((v) => v.lang.startsWith("hi") && preferred.some((p) => v.name.includes(p))) ||
    voices.find((v) => v.lang.startsWith("hi")) ||
    voices.find((v) => v.lang === "en-IN");
  const u = new SpeechSynthesisUtterance(text);
  if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = "hi-IN";
  u.rate = 0.95;
  synth.speak(u);
  return !!voice;
}
