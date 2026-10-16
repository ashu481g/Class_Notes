"use client";

import { useEffect, useRef, useState } from "react";
import { cache } from "@/lib/store";
import { formatTime } from "@/lib/audio";

/**
 * Live lecture recorder. Audio is saved to the browser every few seconds while recording,
 * so closing the tab, a crash or a dead battery never loses more than a few seconds.
 */

type RecMeta = { name: string; mimeType: string; count: number; seconds: number };
const CHUNK_MS = 5000;

async function assemble(meta: RecMeta): Promise<Blob> {
  const parts: Blob[] = [];
  for (let i = 0; i < meta.count; i++) {
    const b = await cache.get<Blob>(`rec:${i}`);
    if (b) parts.push(b);
  }
  return new Blob(parts, { type: meta.mimeType || "audio/webm" });
}

export default function Recorder({ onRecorded, hasLecture }: { onRecorded: (blob: Blob, name: string) => void; hasLecture: boolean }) {
  const [state, setState] = useState<"idle" | "recording" | "paused" | "saving">("idle");
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [browserCleanup, setBrowserCleanup] = useState(true);
  const [error, setError] = useState("");
  const [unfinished, setUnfinished] = useState<RecMeta | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const metaRef = useRef<RecMeta | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const rafRef = useRef<number | undefined>(undefined);
  const wakeRef = useRef<{ release: () => Promise<void> } | null>(null);
  const writesRef = useRef<Promise<void>>(Promise.resolve());
  const secondsRef = useRef(0);

  // Offer to recover a recording that was interrupted (tab closed, crash, battery died).
  useEffect(() => {
    cache.get<RecMeta>("recMeta").then((m) => { if (m && m.count > 0) setUnfinished(m); });
    navigator.mediaDevices?.enumerateDevices?.().then((d) => setDevices(d.filter((x) => x.kind === "audioinput"))).catch(() => {});
  }, []);

  // Warn before leaving the page mid-recording.
  useEffect(() => {
    if (state !== "recording" && state !== "paused") return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);

  useEffect(() => () => cleanup(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function cleanup() {
    window.clearInterval(timerRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close().catch(() => {});
    wakeRef.current?.release().catch(() => {});
    wakeRef.current = null;
    setLevel(0);
  }

  async function start() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: browserCleanup,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      // Labels are only available after permission is granted.
      navigator.mediaDevices.enumerateDevices().then((d) => setDevices(d.filter((x) => x.kind === "audioinput"))).catch(() => {});

      // live input level meter
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const draw = () => {
        analyser.getFloatTimeDomainData(buf);
        let e = 0;
        for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
        const db = 20 * Math.log10(Math.sqrt(e / buf.length) + 1e-9);
        setLevel(Math.max(0, Math.min(1, (db + 60) / 50)));
        rafRef.current = requestAnimationFrame(draw);
      };
      draw();

      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const rec = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      recRef.current = rec;
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const ext = rec.mimeType.includes("mp4") ? "m4a" : rec.mimeType.includes("ogg") ? "ogg" : "webm";
      const meta: RecMeta = { name: `lecture-${stamp}.${ext}`, mimeType: rec.mimeType, count: 0, seconds: 0 };
      metaRef.current = meta;

      // Drop leftovers of an earlier unfinished recording the user chose not to recover.
      if (unfinished) { for (let i = 0; i < unfinished.count; i++) await cache.del(`rec:${i}`); setUnfinished(null); }
      await cache.set("recMeta", meta);

      rec.ondataavailable = (e) => {
        if (!e.data.size) return;
        const i = meta.count++;
        meta.seconds = secondsRef.current;
        writesRef.current = writesRef.current.then(() => cache.set(`rec:${i}`, e.data)).then(() => cache.set("recMeta", { ...meta }));
      };
      rec.onstop = async () => {
        setState("saving");
        cleanup();
        await writesRef.current;
        const blob = await assemble(meta);
        onRecorded(blob, meta.name); // starts a new lecture; clears the temporary chunks too
        setState("idle");
      };
      rec.start(CHUNK_MS);

      try { wakeRef.current = await (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen") ?? null; } catch {}

      setSeconds(0);
      secondsRef.current = 0;
      timerRef.current = window.setInterval(() => {
        if (recRef.current?.state === "recording") { secondsRef.current += 1; setSeconds(secondsRef.current); }
      }, 1000);
      setState("recording");
    } catch (e) {
      cleanup();
      setError(e instanceof DOMException && e.name === "NotAllowedError"
        ? "Microphone access was blocked. Allow the microphone for this site in the browser's address bar, then try again."
        : "Could not start recording: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  function pause() { recRef.current?.pause(); setState("paused"); }
  function resume() { recRef.current?.resume(); setState("recording"); }
  function stop() { recRef.current?.stop(); }

  async function recover() {
    if (!unfinished) return;
    setState("saving");
    const blob = await assemble(unfinished);
    setUnfinished(null);
    onRecorded(blob, unfinished.name);
    setState("idle");
  }

  async function discard() {
    if (!unfinished || !confirm("Delete the unfinished recording? This cannot be undone.")) return;
    for (let i = 0; i < unfinished.count; i++) await cache.del(`rec:${i}`);
    await cache.del("recMeta");
    setUnfinished(null);
  }

  const active = state === "recording" || state === "paused";

  return (
    <div className="recorder">
      {unfinished && !active && (
        <div className="recover">
          <span>⚠️ An unfinished recording was found (about {formatTime(unfinished.seconds)}). It was saved while you were recording.</span>
          <div className="row">
            <button onClick={recover} disabled={state === "saving"}>Recover it</button>
            <button className="ghost" onClick={discard}>Delete it</button>
          </div>
        </div>
      )}

      {!active && state !== "saving" && (
        <div className="grid">
          <label>Microphone
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">Default microphone</option>
              {devices.filter((d) => d.deviceId && d.deviceId !== "default").map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={browserCleanup} onChange={(e) => setBrowserCleanup(e.target.checked)} /> Reduce background noise while recording</label>
        </div>
      )}

      <div className="rec-panel">
        <div className={`rec-dot ${state === "recording" ? "on" : ""}`} />
        <div className="rec-time">{formatTime(seconds)}</div>
        <div className="rec-meter" title="Input level"><div style={{ width: `${Math.round(level * 100)}%` }} /></div>
      </div>

      <div className="row">
        {state === "idle" && (
          <button
            className="danger"
            onClick={() => { if (!hasLecture || confirm("Start a new recording? When you stop it, it replaces the current lecture and everything made from it.")) start(); }}
          >
            ● {hasLecture ? "Start a new recording" : "Start recording"}
          </button>
        )}
        {state === "recording" && <button className="ghost" onClick={pause}>❚❚ Pause</button>}
        {state === "paused" && <button className="ghost" onClick={resume}>● Resume</button>}
        {active && <button onClick={stop}>■ Stop &amp; use this recording</button>}
        {state === "saving" && <span className="muted">Saving the recording…</span>}
      </div>
      {state === "paused" && <p className="hint">Paused. The break won&apos;t be in the recording.</p>}
      {active && <p className="hint">💾 Saved every few seconds. Keep this tab open; the screen is kept awake while recording. Watch the level bar: it should move when the professor speaks.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
