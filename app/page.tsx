"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { decodeToMono, encodeWav, enhanceInWorker, formatTime, resample, splitAtPauses } from "@/lib/audio";
import type { EnhanceOptions } from "@/lib/dsp";
import { buildCopyablePrompt } from "@/lib/prompt";
import { cache, hash } from "@/lib/store";
import { copyText, download } from "@/lib/clipboard";
import PromptBox from "@/components/PromptBox";
import StartChooser, { describeMode, type Mode } from "@/components/StartChooser";

const NotesView = dynamic(() => import("@/components/NotesView"), { ssr: false });
const VideoStep = dynamic(() => import("@/components/VideoStep"), { ssr: false });

/** Everything small about the current lecture; big blobs are cached under their own keys. */
type Session = {
  sessionId: string;
  mode?: Mode;
  sourceName: string;
  sampleRate: number;
  opts: EnhanceOptions;
  audioVersion: string;
  engine: "local" | "openai";
  localModel: string;
  cloudModel: string;
  vocab: string;
  transcript: string;
  subject: string;
  level: string;
  extra: string;
  notesModel: string;
  notes: string;
};
/** Transcription progress, so an interrupted run continues where it stopped. */
type TxProgress = { key: string; parts: (string | null)[]; complete: boolean };

type Audio = { samples: Float32Array; sampleRate: number; url: string; blob: Blob };
type Busy = { label: string; fraction?: number } | null;

const LOCAL_MODELS = [
  { id: "onnx-community/whisper-base.en", label: "Whisper Base (English, fast, ~80 MB)" },
  { id: "onnx-community/whisper-small.en", label: "Whisper Small (English, more accurate, ~250 MB)" },
  { id: "onnx-community/whisper-small", label: "Whisper Small (multilingual, ~250 MB)" },
];

function useLocalStorage(key: string, initial: string) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try { const v = localStorage.getItem(key); if (v !== null) setValue(v); } catch {}
  }, [key]);
  const set = (v: string) => { setValue(v); try { localStorage.setItem(key, v); } catch {} };
  return [value, set] as const;
}

function ProgressBar({ busy }: { busy: Busy }) {
  if (!busy) return null;
  return (
    <div className="progress">
      <div className="progress-label">{busy.label}{busy.fraction !== undefined ? ` — ${Math.round(busy.fraction * 100)}%` : "…"}</div>
      <div className="progress-track">
        <div className={busy.fraction === undefined ? "progress-fill indeterminate" : "progress-fill"} style={busy.fraction !== undefined ? { width: `${busy.fraction * 100}%` } : undefined} />
      </div>
    </div>
  );
}

export default function Home() {
  // ---------- settings ----------
  const [anthropicKey, setAnthropicKey] = useLocalStorage("lns.anthropicKey", "");
  const [openaiKey, setOpenaiKey] = useLocalStorage("lns.openaiKey", "");
  const [serverKeys, setServerKeys] = useState({ anthropic: false, openai: false });
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => { fetch("/api/config").then((r) => r.json()).then(setServerKeys).catch(() => {}); }, []);

  // ---------- step 1: capture ----------
  const [sourceName, setSourceName] = useState("");
  const [sourceBlob, setSourceBlob] = useState<Blob | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [restored, setRestored] = useState(false);
  const [resumeNote, setResumeNote] = useState("");
  // What the user starts from and wants to make; decides which steps are shown.
  const [mode, setMode] = useState<Mode | null>(null);
  const [choosing, setChoosing] = useState(false);

  function chooseMode(m: Mode) {
    setMode(m);
    setChoosing(false);
    if (!sessionId) setSessionId(String(Date.now()));
  }
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
      const rec = new MediaRecorder(stream);
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(parts, { type: rec.mimeType });
        selectSource(blob, `lecture-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.webm`);
        download(blob, `lecture-recording-${Date.now()}.webm`); // safety copy of the raw recording
      };
      rec.start(1000);
      recorderRef.current = rec;
      setRecording(true);
      setRecSeconds(0);
      timerRef.current = window.setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch (e) {
      alert("Could not access the microphone: " + e);
    }
  }
  function stopRecording() {
    recorderRef.current?.stop();
    window.clearInterval(timerRef.current);
    setRecording(false);
  }

  // ---------- step 2: enhance ----------
  const [sampleRate, setSampleRate] = useState(24000);
  const [opts, setOpts] = useState<EnhanceOptions>({ denoise: true, denoiseStrength: 0.5, clarity: true, pitch: 0, level: true });
  const [original, setOriginal] = useState<Audio | null>(null);
  const [enhanced, setEnhanced] = useState<Audio | null>(null);
  const [audioBusy, setAudioBusy] = useState<Busy>(null);
  const [audioError, setAudioError] = useState("");
  const [audioVersion, setAudioVersion] = useState("original");

  /** A new input file starts a new round: everything cached for the previous lecture is dropped. */
  async function selectSource(blob: Blob, name: string) {
    await cache.clear();
    await cache.set("source", blob);
    setSourceBlob(blob);
    setSourceUrl(URL.createObjectURL(blob));
    setSourceName(name);
    setSessionId(String(Date.now()));
    setOriginal(null);
    setEnhanced(null);
    setAudioVersion("original");
    setAudioError("");
    setTranscript("");
    setTxError("");
    setNotes("");
    setResumeNote("");
  }

  /** Loading a transcript file also starts a new round (in transcript mode it is the input file). */
  async function selectTranscriptFile(file: File) {
    const text = await file.text();
    await cache.clear();
    setSourceBlob(null);
    setSourceUrl("");
    setSourceName(file.name);
    setSessionId(String(Date.now()));
    setOriginal(null);
    setEnhanced(null);
    setAudioVersion("original");
    setTranscript(text);
    setTxError("");
    setNotes("");
    setResumeNote("");
  }

  async function runEnhance() {
    if (!sourceBlob) return;
    setAudioError("");
    try {
      let orig = original;
      if (!orig || orig.sampleRate !== sampleRate) {
        setAudioBusy({ label: "Decoding audio" });
        const samples = await decodeToMono(sourceBlob, sampleRate);
        const blob = encodeWav(samples, sampleRate);
        orig = { samples, sampleRate, blob, url: URL.createObjectURL(blob) };
        setOriginal(orig);
      }
      const out = await enhanceInWorker(orig.samples, sampleRate, opts, (label, fraction) => setAudioBusy({ label, fraction }));
      const blob = encodeWav(out, sampleRate);
      setEnhanced({ samples: out, sampleRate, blob, url: URL.createObjectURL(blob) });
      const version = "enhanced-" + hash(JSON.stringify(opts) + sampleRate);
      setAudioVersion(version);
      await cache.set("enhanced", { blob, sampleRate });
    } catch (e) {
      setAudioError("Could not process this file: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setAudioBusy(null);
    }
  }

  // ---------- step 3: transcribe ----------
  const [engine, setEngine] = useState<"local" | "openai">("local");
  const [localModel, setLocalModel] = useState(LOCAL_MODELS[0].id);
  const [cloudModel, setCloudModel] = useState("whisper-1");
  const [vocab, setVocab] = useState("");
  const [transcript, setTranscript] = useState("");
  const [txBusy, setTxBusy] = useState<Busy>(null);
  const [txError, setTxError] = useState("");
  const whisperRef = useRef<Worker | null>(null);

  async function audioFor16k(): Promise<Float32Array | null> {
    const src = enhanced ?? original;
    if (src) return resample(src.samples, src.sampleRate, 16000);
    if (sourceBlob) return decodeToMono(sourceBlob, 16000);
    return null;
  }

  async function runTranscribe() {
    setTxError("");
    setTxBusy({ label: "Preparing audio" });
    try {
      const s16 = await audioFor16k();
      if (!s16) throw new Error("Add a recording or audio file first.");
      if (engine === "local") await transcribeLocal(s16);
      else await transcribeCloud(s16);
    } catch (e) {
      setTxError(e instanceof Error ? e.message : String(e));
    } finally {
      setTxBusy(null);
    }
  }

  /**
   * Loads saved progress for this exact audio + engine + model. Finished chunks are skipped,
   * so a reload, crash or network error mid-way never redoes work. A finished run starts fresh.
   */
  async function loadProgress(model: string, total: number) {
    const key = `${engine}|${model}|${audioVersion}|${total}`;
    const saved = await cache.get<TxProgress>("txProgress");
    const progress: TxProgress =
      saved && saved.key === key && !saved.complete ? saved : { key, parts: new Array(total).fill(null), complete: false };
    const done = progress.parts.filter((x) => x !== null).length;
    if (done) setResumeNote(`Resumed: ${done} of ${total} parts were already transcribed.`);
    else setResumeNote("");
    const render = () => setTranscript(progress.parts.filter(Boolean).join("\n\n"));
    const record = (i: number, text: string) => {
      progress.parts[i] = text;
      progress.complete = progress.parts.every((x) => x !== null);
      render();
      cache.set("txProgress", progress);
    };
    render();
    return { progress, record };
  }

  async function transcribeLocal(s16: Float32Array) {
    const chunks = splitAtPauses(s16, 16000, 28, 6);
    const { progress, record } = await loadProgress(localModel, chunks.length);
    const skip = progress.parts.map((x, i) => (x !== null ? i : -1)).filter((i) => i >= 0);
    if (skip.length === chunks.length) return;
    return new Promise<void>((resolve, reject) => {
      whisperRef.current?.terminate();
      const w = new Worker("/whisper-worker.js", { type: "module" });
      whisperRef.current = w;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === "loading") setTxBusy({ label: "Downloading speech model (first time only)", fraction: m.fraction });
        else if (m.type === "ready") setTxBusy({ label: `Transcribing on ${m.gpu ? "GPU" : "CPU"}`, fraction: 0 });
        else if (m.type === "chunk") {
          record(m.index, m.text ? `[${formatTime(m.start)}] ${m.text}` : "");
          setTxBusy({ label: `Transcribing (${formatTime(m.start)})`, fraction: (m.index + 1) / m.total });
        } else if (m.type === "done") { w.terminate(); resolve(); }
        else if (m.type === "error") { w.terminate(); reject(new Error(m.message)); }
      };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || "Speech model failed to load")); };
      w.postMessage({ model: localModel, samples: s16, sampleRate: 16000, chunks, skip });
    });
  }

  async function transcribeCloud(s16: Float32Array) {
    const chunks = splitAtPauses(s16, 16000, 120, 10);
    const { progress, record } = await loadProgress(cloudModel, chunks.length);
    const todo = chunks.map((_, i) => i).filter((i) => progress.parts[i] === null);
    let done = chunks.length - todo.length;
    setTxBusy({ label: "Transcribing in the cloud", fraction: done / chunks.length });
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const i = todo[next++];
        const [s, e] = chunks[i];
        const form = new FormData();
        form.append("file", encodeWav(s16.subarray(s, e), 16000), "chunk.wav");
        form.append("model", cloudModel);
        if (vocab) form.append("prompt", vocab);
        const res = await fetch("/api/transcribe", { method: "POST", body: form, headers: openaiKey ? { "x-openai-key": openaiKey } : {} });
        const text = await res.text();
        if (!res.ok) throw new Error(text);
        record(i, `[${formatTime(s / 16000)}] ${text}`);
        done++;
        setTxBusy({ label: "Transcribing in the cloud", fraction: done / chunks.length });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // ---------- step 4: notes ----------
  const [subject, setSubject] = useState("");
  const [level, setLevel] = useState("Undergraduate");
  const [extra, setExtra] = useState("");
  const [notesModel, setNotesModel] = useState("claude-opus-5-5");
  const [notes, setNotes] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);
  const [copied, setCopied] = useState<"" | "ok" | "failed">("");
  const [promptText, setPromptText] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  async function generateNotes() {
    setNotes("");
    setNotesBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", ...(anthropicKey ? { "x-anthropic-key": anthropicKey } : {}) },
        body: JSON.stringify({ transcript, subject, level, extra, model: notesModel }),
      });
      if (!res.ok || !res.body) { setNotes(`> ❌ ${await res.text()}`); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        setNotes(acc);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setNotes((n) => n + `\n\n> ❌ ${e}`);
    } finally {
      setNotesBusy(false);
    }
  }

  async function copyPrompt() {
    const text = buildCopyablePrompt({ transcript, subject, level, extra });
    setPromptText(text);
    const ok = await copyText(text);
    setCopied(ok ? "ok" : "failed");
    if (ok) setTimeout(() => setCopied(""), 3000);
  }

  // ---------- cache: restore the last lecture on load, save as you go ----------
  useEffect(() => {
    (async () => {
      const s = await cache.get<Session>("session");
      const source = await cache.get<Blob>("source");
      if (s) {
        setSessionId(s.sessionId);
        setMode(s.mode ?? null);
        setSourceName(s.sourceName);
        setSampleRate(s.sampleRate);
        setOpts(s.opts);
        setAudioVersion(s.audioVersion);
        setEngine(s.engine);
        setLocalModel(s.localModel);
        setCloudModel(s.cloudModel);
        setVocab(s.vocab);
        setTranscript(s.transcript);
        setSubject(s.subject);
        setLevel(s.level);
        setExtra(s.extra);
        setNotesModel(s.notesModel);
        setNotes(s.notes);
      }
      if (source) {
        setSourceBlob(source);
        setSourceUrl(URL.createObjectURL(source));
      }
      const enh = await cache.get<{ blob: Blob; sampleRate: number }>("enhanced");
      if (enh) {
        try {
          const samples = await decodeToMono(enh.blob, enh.sampleRate);
          setEnhanced({ samples, sampleRate: enh.sampleRate, blob: enh.blob, url: URL.createObjectURL(enh.blob) });
        } catch {}
      }
      const tx = await cache.get<TxProgress>("txProgress");
      if (tx && !tx.complete && tx.parts.some((x) => x !== null)) {
        const done = tx.parts.filter((x) => x !== null).length;
        setResumeNote(`Transcription was interrupted at ${done} of ${tx.parts.length} parts. Click "Create transcript" to continue from there.`);
      }
      setRestored(true);
    })();
  }, []);

  useEffect(() => {
    if (!restored || !sessionId) return;
    const t = setTimeout(() => {
      const s: Session = {
        sessionId, mode: mode ?? undefined, sourceName, sampleRate, opts, audioVersion, engine, localModel, cloudModel, vocab,
        transcript, subject, level, extra, notesModel, notes,
      };
      cache.set("session", s);
    }, 400);
    return () => clearTimeout(t);
  }, [restored, sessionId, mode, sourceName, sampleRate, opts, audioVersion, engine, localModel, cloudModel, vocab, transcript, subject, level, extra, notesModel, notes]);

  async function startOver() {
    if (!confirm("Clear the saved lecture (audio, transcript, notes, slides and video) from this browser?")) return;
    await cache.clear();
    window.location.reload();
  }

  const canUseClaude = serverKeys.anthropic || !!anthropicKey;
  const canUseOpenAI = serverKeys.openai || !!openaiKey;

  // Which steps to show depends on what the user picked on the start screen.
  const flow = !choosing && mode ? mode : null;
  const has = (g: Mode["goals"][number]) => !!flow?.goals.includes(g);
  const isLecture = flow?.source === "lecture";
  const needsTranscript = has("notes") || has("video");
  let stepNo = 0;
  const nextStep = () => ++stepNo;

  return (
    <main>
      <header className="top no-print">
        <div>
          <h1>Lecture Notes Studio</h1>
          <p className="muted">Clean lecture audio, class notes and PPT video lectures from a recording or transcript.</p>
        </div>
        <div className="row">
          {sessionId && <button className="ghost" onClick={startOver} title="Your work is saved in this browser until you choose a new file">↺ Start over</button>}
          <button className="ghost" onClick={() => setShowSettings((s) => !s)}>⚙ Settings</button>
        </div>
      </header>

      {showSettings && (
        <section className="card no-print">
          <h2>API keys</h2>
          <p className="muted">Keys are stored only in this browser. On your own deployment you can instead set them as environment variables (see README).</p>
          <label>Anthropic API key (for class notes) {serverKeys.anthropic && <span className="pill">set on server</span>}
            <input type="password" value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} placeholder="sk-ant-…" />
          </label>
          <label>OpenAI API key (optional: cloud transcription and the video voice-over) {serverKeys.openai && <span className="pill">set on server</span>}
            <input type="password" value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} placeholder="sk-…" />
          </label>
        </section>
      )}

      {restored && (!mode || choosing) && (
        <StartChooser initial={mode} onDone={chooseMode} onCancel={mode ? () => setChoosing(false) : undefined} />
      )}

      {flow && (
        <div className="mode-bar no-print">
          <span><b>Your plan:</b> {describeMode(flow)}</span>
          <button className="ghost small" onClick={() => setChoosing(true)}>Change</button>
        </div>
      )}

      {/* LECTURE FILE */}
      {isLecture && (
      <section className="card no-print">
        <h2><span className="num">{nextStep()}</span> Upload the lecture</h2>
        <div className="row">
          {!recording ? (
            <button onClick={startRecording}>● Record from microphone</button>
          ) : (
            <button className="danger" onClick={stopRecording}>■ Stop ({formatTime(recSeconds)})</button>
          )}
          <span className="muted">or</span>
          <label className="file">
            Upload audio / video file
            <input type="file" accept="audio/*,video/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) selectSource(f, f.name); }} />
          </label>
        </div>
        {sourceName && <p>Selected: <b>{sourceName}</b></p>}
        {sourceName && <p className="hint">💾 Each step&apos;s results are saved in this browser, so you can close or reload the page and carry on. Choosing a new file starts a fresh lecture.</p>}
        <p className="hint">Tip: sit near the front, put the phone/laptop mic facing the professor, and keep it away from fans and keyboards. A cheap clip-on or USB mic helps more than any software.</p>
      </section>
      )}

      {/* CLEAN AUDIO */}
      {isLecture && has("audio") && (
      <section className="card no-print">
        <h2><span className="num">{nextStep()}</span> Clean up the voice</h2>
        <div className="grid">
          <label className="check"><input type="checkbox" checked={opts.denoise} onChange={(e) => setOpts({ ...opts, denoise: e.target.checked })} /> Remove background noise</label>
          <label>Noise removal strength: {Math.round(opts.denoiseStrength * 100)}%
            <input type="range" min={0} max={1} step={0.05} value={opts.denoiseStrength} disabled={!opts.denoise} onChange={(e) => setOpts({ ...opts, denoiseStrength: +e.target.value })} />
          </label>
          <label className="check"><input type="checkbox" checked={opts.clarity} onChange={(e) => setOpts({ ...opts, clarity: e.target.checked })} /> Voice clarity boost (presence EQ, removes boom &amp; hiss)</label>
          <label className="check"><input type="checkbox" checked={opts.level} onChange={(e) => setOpts({ ...opts, level: e.target.checked })} /> Even out loudness (soft or distant speech becomes louder)</label>
          <label>Pitch shift: {opts.pitch > 0 ? "+" : ""}{opts.pitch} semitones {opts.pitch === 0 && <span className="muted">(unchanged)</span>}
            <input type="range" min={-6} max={6} step={1} value={opts.pitch} onChange={(e) => setOpts({ ...opts, pitch: +e.target.value })} />
          </label>
          <label>Quality
            <select value={sampleRate} onChange={(e) => setSampleRate(+e.target.value)}>
              <option value={16000}>Speech (16 kHz), fastest, best for long lectures</option>
              <option value={24000}>High (24 kHz)</option>
              <option value={44100}>Studio (44.1 kHz), slow for long files</option>
            </select>
          </label>
        </div>
        <div className="row">
          <button onClick={runEnhance} disabled={!sourceBlob || !!audioBusy}>✨ Enhance audio</button>
          {enhanced && <button className="ghost" onClick={() => download(enhanced.blob, (sourceName.replace(/\.[^.]+$/, "") || "lecture") + "-clean.wav")}>⬇ Download clean audio</button>}
        </div>
        <ProgressBar busy={audioBusy} />
        {audioError && <p className="error">{audioError}</p>}
        {sourceUrl && enhanced && (
          <div className="compare">
            <div><b>Before</b><audio controls src={sourceUrl} /></div>
            <div><b>After</b><audio controls src={enhanced.url} /></div>
          </div>
        )}
        {needsTranscript && <p className="hint">The next step transcribes the cleaned audio if you made it, otherwise the original.</p>}
      </section>
      )}

      {/* TRANSCRIPT FILE */}
      {flow?.source === "transcript" && (
        <section className="card no-print">
          <h2><span className="num">{nextStep()}</span> Add the transcript</h2>
          <div className="row">
            <label className="file">
              Upload transcript file
              <input type="file" accept=".txt,.md,.vtt,.srt" onChange={(e) => { const f = e.target.files?.[0]; if (f) selectTranscriptFile(f); e.target.value = ""; }} />
            </label>
            <span className="muted">or paste it below</span>
          </div>
          {sourceName && <p>Selected: <b>{sourceName}</b></p>}
          <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={10} placeholder="Paste the lecture transcript here…" />
          <p className="hint">💾 Your work is saved in this browser until you upload a new file or click Start over.</p>
        </section>
      )}

      {/* TRANSCRIBE */}
      {isLecture && needsTranscript && (
      <section className="card no-print">
        <h2><span className="num">{nextStep()}</span> Transcribe</h2>
        <div className="grid">
          <label>Engine
            <select value={engine} onChange={(e) => setEngine(e.target.value as "local" | "openai")}>
              <option value="local">Free, on this laptop (Whisper in the browser)</option>
              <option value="openai" disabled={!canUseOpenAI}>OpenAI cloud (fast, needs key){canUseOpenAI ? "" : " — add key in Settings"}</option>
            </select>
          </label>
          {engine === "local" ? (
            <label>Model
              <select value={localModel} onChange={(e) => setLocalModel(e.target.value)}>
                {LOCAL_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
          ) : (
            <>
              <label>Model
                <select value={cloudModel} onChange={(e) => setCloudModel(e.target.value)}>
                  <option value="whisper-1">whisper-1</option>
                  <option value="gpt-4o-transcribe">gpt-4o-transcribe (most accurate)</option>
                  <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe (cheapest)</option>
                </select>
              </label>
              <label>Technical vocabulary hint (optional)
                <input value={vocab} onChange={(e) => setVocab(e.target.value)} placeholder="e.g. Thermodynamics: enthalpy, Carnot cycle, entropy" />
              </label>
            </>
          )}
        </div>
        <div className="row">
          <button onClick={runTranscribe} disabled={!sourceBlob || !!txBusy}>📝 Create transcript</button>
          {transcript && <button className="ghost" onClick={() => download(new Blob([transcript], { type: "text/plain" }), "transcript.txt")}>⬇ Download transcript</button>}
          <label className="file ghost-file">
            Load a .txt transcript
            <input type="file" accept=".txt,.md,.vtt,.srt" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setTranscript(await f.text()); }} />
          </label>
        </div>
        <ProgressBar busy={txBusy} />
        {resumeNote && <p className="hint">⏯ {resumeNote}</p>}
        {txError && <p className="error">{txError} — finished parts are saved; click &quot;Create transcript&quot; again to continue.</p>}
        <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={12} placeholder="The transcript appears here. You can edit it, or paste one in." />
        <p className="hint">On-laptop transcription takes roughly 5–20 minutes per lecture hour with a GPU-capable browser (Chrome/Edge), longer on CPU. Keep this tab open.</p>
      </section>
      )}

      {/* LECTURE DETAILS (shared by notes and video) */}
      {needsTranscript && (
      <section className="card no-print">
        <h2><span className="num">{nextStep()}</span> About the lecture</h2>
        <div className="grid">
          <label>Subject / course
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Electrical Engineering, Signals & Systems" />
          </label>
          <label>Level
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              <option>High school</option><option>Undergraduate</option><option>Postgraduate</option><option>Professional</option>
            </select>
          </label>
          <label>AI model
            <select value={notesModel} onChange={(e) => setNotesModel(e.target.value)}>
              <option value="claude-opus-5-5">Claude Opus 5.5 (best notes)</option>
              <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (faster, cheaper)</option>
            </select>
          </label>
          <label>Extra instructions (optional)
            <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="e.g. focus on derivations; add more practice problems" />
          </label>
        </div>
        <p className="hint">Used for both the class notes and the video lecture. The AI model only matters if you added an Anthropic API key in Settings.</p>
      </section>
      )}

      {/* CLASS NOTES */}
      {has("notes") && (
      <section className="card no-print">
        <h2><span className="num">{nextStep()}</span> Class notes</h2>
        <div className="row">
          <button onClick={generateNotes} disabled={!transcript.trim() || notesBusy || !canUseClaude} title={canUseClaude ? "" : "Add an Anthropic API key in Settings"}>🤖 Generate class notes with AI</button>
          {notesBusy && <button className="ghost" onClick={() => abortRef.current?.abort()}>Stop</button>}
          <button className="ghost" onClick={copyPrompt} disabled={!transcript.trim()} title={transcript.trim() ? "" : "Create or paste a transcript first"}>{copied === "ok" ? "✓ Copied to clipboard" : "📋 Copy AI prompt"}</button>
        </div>
        {promptText && <PromptBox text={promptText} failed={copied === "failed"} fileName="class-notes-prompt.txt" onHide={() => setPromptText("")} />}
        {!canUseClaude && <p className="hint">No Anthropic key yet: use <b>Copy AI prompt</b> and paste it into claude.ai (or any AI chat). It contains the full instructions plus your transcript. Then paste the reply below to view it with diagrams and formulas rendered.</p>}
        {!canUseClaude && (
          <textarea rows={4} placeholder="Paste the AI's Markdown reply here to render it…" onChange={(e) => setNotes(e.target.value)} />
        )}
        {notesBusy && <ProgressBar busy={{ label: notes ? "Writing notes" : "Thinking about the lecture (this can take a minute)" }} />}
      </section>
      )}

      {has("notes") && notes && (
        <section className="card notes-card">
          <div className="row no-print">
            <button className="ghost" onClick={() => download(new Blob([notes], { type: "text/markdown" }), "class-notes.md")}>⬇ Download Markdown</button>
            <button className="ghost" onClick={() => window.print()} disabled={notesBusy}>🖨 Print / Save as PDF</button>
          </div>
          <NotesView markdown={notes} streaming={notesBusy} />
        </section>
      )}

      {/* PPT VIDEO LECTURE */}
      {has("video") && (
      <VideoStep
        step={nextStep()}
        transcript={transcript}
        subject={subject}
        level={level}
        extra={extra}
        model={notesModel}
        anthropicKey={anthropicKey}
        openaiKey={openaiKey}
        canUseClaude={canUseClaude}
        canUseOpenAI={canUseOpenAI}
        sessionId={sessionId}
      />
      )}
    </main>
  );
}
