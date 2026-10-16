"use client";

import { useEffect, useRef, useState } from "react";
import { buildCopyableDeckPrompt, parseDeck, type Deck } from "@/lib/deck";
import { cache, hash } from "@/lib/store";
import { copyText, download } from "@/lib/clipboard";
import { buildPptx, canEncodeFast, diagramImage, renderVideo, slideCanvas, speakWithBrowserVoice } from "@/lib/slides";
import PromptBox from "./PromptBox";

type Props = {
  step: number;
  transcript: string;
  subject: string;
  level: string;
  extra: string;
  model: string;
  anthropicKey: string;
  openaiKey: string;
  canUseClaude: boolean;
  canUseOpenAI: boolean;
  /** changes when a new lecture file is chosen, so cached state is reloaded */
  sessionId: string;
};

type Busy = { label: string; fraction?: number } | null;

const FREE_VOICES = [
  { id: "hi-IN-SwaraNeural", label: "Swara: female, Hindi-English (free)" },
  { id: "hi-IN-MadhurNeural", label: "Madhur: male, Hindi-English (free)" },
];
const OPENAI_VOICES = [
  { id: "coral", label: "Coral: female, warm (OpenAI key)" },
  { id: "sage", label: "Sage: female, calm (OpenAI key)" },
  { id: "shimmer", label: "Shimmer: female, bright (OpenAI key)" },
  { id: "ash", label: "Ash: male, clear (OpenAI key)" },
  { id: "ballad", label: "Ballad: male, soft (OpenAI key)" },
  { id: "onyx", label: "Onyx: male, deep (OpenAI key)" },
];
const isFreeVoice = (v: string) => v.startsWith("hi-IN-");

const clipKey = (voice: string, narration: string) => `tts:${voice}:${hash(narration)}`;

export default function VideoStep(p: Props) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [images, setImages] = useState<(HTMLImageElement | null)[]>([]);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [voice, setVoice] = useState("hi-IN-SwaraNeural");
  const [video, setVideo] = useState<{ key: string; blob: Blob; url: string } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState<"" | "ok" | "failed">("");
  const [pasted, setPasted] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Restore the cached deck and video for this lecture.
  useEffect(() => {
    let alive = true;
    setDeck(null);
    setVideo(null);
    (async () => {
      const d = await cache.get<Deck>("deck");
      const v = await cache.get<{ key: string; blob: Blob; voice: string }>("video");
      if (!alive) return;
      if (d) setDeck(d);
      if (v) { setVideo({ key: v.key, blob: v.blob, url: URL.createObjectURL(v.blob) }); setVoice(v.voice); }
    })();
    return () => { alive = false; };
  }, [p.sessionId]);

  // Draw diagrams and slide thumbnails when the visible slide content changes (not on narration edits).
  const visualKey = deck ? JSON.stringify([deck.title, deck.slides.map(({ narration: _n, ...rest }) => rest)]) : "";
  useEffect(() => {
    if (!deck) { setImages([]); setThumbs([]); return; }
    let alive = true;
    (async () => {
      const imgs: (HTMLImageElement | null)[] = [];
      for (const s of deck.slides) imgs.push(await diagramImage(s.diagram));
      if (!alive) return;
      setImages(imgs);
      setThumbs(deck.slides.map((_, i) => slideCanvas(deck, i, imgs[i]).toDataURL("image/jpeg", 0.75)));
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualKey]);

  function saveDeck(d: Deck) {
    setDeck(d);
    cache.set("deck", d);
  }

  async function generate() {
    setError("");
    setBusy({ label: "Planning the slides (this can take a minute)" });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/slides", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", ...(p.anthropicKey ? { "x-anthropic-key": p.anthropicKey } : {}) },
        body: JSON.stringify({ transcript: p.transcript, subject: p.subject, level: p.level, extra: p.extra, model: p.model }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        const n = (acc.match(/"narration"\s*:/g) || []).length;
        if (n) setBusy({ label: `Writing slide ${n} and its narration` });
      }
      const errAt = acc.indexOf("\u0000ERROR:");
      if (errAt >= 0) throw new Error(acc.slice(errAt + 7));
      saveDeck(parseDeck(acc));
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function copyPrompt() {
    const text = buildCopyableDeckPrompt(p.transcript, p.subject, p.level, p.extra);
    setPrompt(text);
    const ok = await copyText(text);
    setCopied(ok ? "ok" : "failed");
    if (ok) setTimeout(() => setCopied(""), 3000);
  }

  function loadPasted() {
    setError("");
    try { saveDeck(parseDeck(pasted)); setPasted(""); }
    catch (e) { setError("Could not read that reply: " + (e instanceof Error ? e.message : String(e))); }
  }

  function editNarration(i: number, text: string) {
    if (!deck) return;
    const d = { ...deck, slides: deck.slides.map((s, j) => (j === i ? { ...s, narration: text } : s)) };
    saveDeck(d);
  }

  async function makePptx() {
    if (!deck) return;
    setBusy({ label: "Building PowerPoint" });
    try { download(await buildPptx(deck, images), `${(deck.title || "lecture").replace(/[^\w\- ]+/g, "").slice(0, 60)}.pptx`); }
    catch (e) { setError("PowerPoint export failed: " + e); }
    finally { setBusy(null); }
  }

  /** Voice clips are cached per narration text, so only new or edited slides are re-generated. */
  async function voiceClips(d: Deck): Promise<(Blob | null)[]> {
    const clips: (Blob | null)[] = new Array(d.slides.length).fill(null);
    let done = 0, next = 0;
    const work = async () => {
      while (next < d.slides.length) {
        const i = next++;
        const text = d.slides[i].narration.trim();
        if (text) {
          const key = clipKey(voice, text);
          let blob = await cache.get<Blob>(key);
          if (!blob) {
            let res: Response | null = null;
            // the free service occasionally drops a request, so retry a couple of times
            for (let attempt = 0; attempt < 3; attempt++) {
              res = await fetch(isFreeVoice(voice) ? "/api/tts-free" : "/api/tts", {
                method: "POST",
                headers: { "Content-Type": "application/json", ...(p.openaiKey ? { "x-openai-key": p.openaiKey } : {}) },
                body: JSON.stringify({ text, voice }),
              });
              if (res.ok || !isFreeVoice(voice)) break;
              await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
            }
            if (!res || !res.ok) throw new Error(`Slide ${i + 1}: ${res ? await res.text() : "no response"}`);
            blob = await res.blob();
            await cache.set(key, blob);
          }
          clips[i] = blob;
        }
        done++;
        setBusy({ label: `Recording the Hinglish voice-over (${done}/${d.slides.length} slides)`, fraction: done / d.slides.length });
      }
    };
    await Promise.all(isFreeVoice(voice) ? [work(), work()] : [work(), work(), work()]);
    return clips;
  }

  async function makeVideo() {
    if (!deck) return;
    setError("");
    const key = hash(JSON.stringify(deck) + voice);
    if (video?.key === key) return;
    try {
      setBusy({ label: "Recording the Hinglish voice-over", fraction: 0 });
      const clips = await voiceClips(deck);
      const label = canEncodeFast()
        ? "Encoding video"
        : "Recording video in real time (keep this tab open and visible; open the app at http://localhost:3000 for much faster encoding)";
      setBusy({ label, fraction: 0 });
      const blob = await renderVideo(deck, images, clips, (f) => setBusy({ label, fraction: f }));
      await cache.set("video", { key, blob, voice });
      setVideo({ key, blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      setError("Video creation failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }

  const hasTranscript = !!p.transcript.trim();
  const videoKey = deck ? hash(JSON.stringify(deck) + voice) : "";

  return (
    <section className="card no-print">
      <h2><span className="num">{p.step}</span> PPT video lecture</h2>
      <p className="muted">
        Turns the transcript into an English slide deck with diagrams and formulas, plus a Hinglish (Hindi + English) voice-over
        in an Indian teaching style.
      </p>
      <div className="row">
        <button onClick={generate} disabled={!hasTranscript || !!busy || !p.canUseClaude} title={p.canUseClaude ? "" : "Add an Anthropic API key in Settings"}>
          🎞 {deck ? "Regenerate" : "Generate"} slides with AI
        </button>
        {busy && abortRef.current && busy.label.startsWith("Writing") && <button className="ghost" onClick={() => abortRef.current?.abort()}>Stop</button>}
        <button className="ghost" onClick={copyPrompt} disabled={!hasTranscript}>{copied === "ok" ? "✓ Copied to clipboard" : "📋 Copy slides prompt"}</button>
      </div>
      {prompt && <PromptBox text={prompt} failed={copied === "failed"} fileName="slides-prompt.txt" onHide={() => setPrompt("")} />}
      {!p.canUseClaude && (
        <ol className="steps">
          <li>Click <b>📋 Copy slides prompt</b>. For a long lecture, use <b>⬇ Download prompt</b> instead.</li>
          <li>Open <a href="https://claude.ai/new" target="_blank" rel="noreferrer">claude.ai</a> with your Pro account and paste the prompt (or attach the downloaded .txt) and send.</li>
          <li>Copy Claude&apos;s whole reply (it starts with <code>{"{"}&quot;title&quot;</code>). If Claude gives you a file instead, download it.</li>
          <li>Paste the reply below (or load the file), click <b>Load slides</b>, then <b>🎬 Create narrated video</b>. The voice is free; no API key needed.</li>
        </ol>
      )}
      <textarea rows={3} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'Paste Claude\'s reply here (starts with {"title": …)'} />
      <div className="row">
        <button className="ghost" onClick={loadPasted} disabled={!pasted.trim()}>Load slides</button>
        <label className="file ghost-file">
          Load reply from file
          <input type="file" accept=".json,.txt,.md" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPasted(await f.text()); e.target.value = ""; }} />
        </label>
      </div>

      {busy && (
        <div className="progress">
          <div className="progress-label">{busy.label}{busy.fraction !== undefined ? ` — ${Math.round(busy.fraction * 100)}%` : "…"}</div>
          <div className="progress-track"><div className={busy.fraction === undefined ? "progress-fill indeterminate" : "progress-fill"} style={busy.fraction !== undefined ? { width: `${busy.fraction * 100}%` } : undefined} /></div>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      {deck && (
        <>
          <div className="grid">
            <label>Narrator voice
              <select value={voice} onChange={(e) => setVoice(e.target.value)}>
                <optgroup label="Free (no API key)">
                  {FREE_VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </optgroup>
                <optgroup label="OpenAI (needs an OpenAI key)">
                  {OPENAI_VOICES.map((v) => <option key={v.id} value={v.id} disabled={!p.canUseOpenAI}>{v.label}</option>)}
                </optgroup>
              </select>
            </label>
          </div>
          <div className="row">
            <button onClick={makeVideo} disabled={!!busy || (!isFreeVoice(voice) && !p.canUseOpenAI)}>
              🎬 {video?.key === videoKey ? "Video ready" : "Create narrated video (MP4)"}
            </button>
            <button className="ghost" onClick={makePptx} disabled={!!busy}>⬇ Download PowerPoint (.pptx)</button>
            {video && <button className="ghost" onClick={() => download(video.blob, `${(deck.title || "lecture").replace(/[^\w\- ]+/g, "").slice(0, 60)}.${video.blob.type.includes("webm") ? "webm" : "mp4"}`)}>⬇ Download video</button>}
          </div>
          {!canEncodeFast() && (
            <p className="hint">
              ⚠️ Fast video encoding isn&apos;t available here, so the video is recorded in real time (a 20-minute video takes 20 minutes). This happens when the app is opened through a network address such as http://192.168…; open <b>http://localhost:3000</b> on this laptop, or the https Vercel link, for encoding in seconds.
            </p>
          )}
          <p className="hint">
            The free voices are Microsoft&apos;s neural Hindi voices (the ones Edge&apos;s Read Aloud uses). They read Hindi and English in the same sentence naturally.
            The PowerPoint has each slide&apos;s narration in its speaker notes. ▶ next to a slide previews the narration with your browser&apos;s own voice.
          </p>
          {video && <video className="video" controls src={video.url} />}
          {video && video.key !== videoKey && <p className="hint">The slides or voice changed since this video was made. Create it again to update it; unchanged slides reuse their saved voice clips.</p>}

          <div className="slides">
            {deck.slides.map((s, i) => (
              <div className="slide-item" key={i}>
                {thumbs[i] ? <img src={thumbs[i]} alt={`Slide ${i + 1}: ${s.title}`} /> : <div className="slide-placeholder">Drawing slide {i + 1}…</div>}
                <div className="slide-script">
                  <div className="row slide-head">
                    <b>{i + 1}. {s.title}</b>
                    <button className="ghost small" onClick={() => speakWithBrowserVoice(s.narration)} title="Preview with the browser's Hindi voice (free)">▶</button>
                  </div>
                  <textarea rows={5} value={s.narration} onChange={(e) => editNarration(i, e.target.value)} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
