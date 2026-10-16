"use client";

import { useState } from "react";

export type Source = "lecture" | "transcript";
export type Goal = "audio" | "video" | "notes";
export type Mode = { source: Source; goals: Goal[] };

const SOURCES: { id: Source; icon: string; title: string; text: string }[] = [
  { id: "lecture", icon: "🎙", title: "A lecture recording", text: "Audio or video file, or record one now" },
  { id: "transcript", icon: "📄", title: "A transcript", text: "Text file, or paste the text" },
];

const GOALS: { id: Goal; icon: string; title: string; text: string; lectureOnly?: boolean }[] = [
  { id: "audio", icon: "🔊", title: "Clean audio file", text: "Remove background noise and make the professor's voice clear. Download as a new audio file.", lectureOnly: true },
  { id: "video", icon: "🎬", title: "PPT video lecture", text: "English slides with diagrams and formulas, explained in a Hindi + English voice. Download as video and PowerPoint." },
  { id: "notes", icon: "📝", title: "Class notes", text: "Illustrated study notes with diagrams, formulas and practice questions." },
];

export const describeMode = (m: Mode) =>
  `${m.source === "lecture" ? "Lecture recording" : "Transcript"} → ${m.goals.map((g) => GOALS.find((x) => x.id === g)!.title).join(" + ")}`;

export default function StartChooser({ initial, onDone, onCancel }: { initial: Mode | null; onDone: (m: Mode) => void; onCancel?: () => void }) {
  const [source, setSource] = useState<Source | null>(initial?.source ?? null);
  const [goals, setGoals] = useState<Goal[]>(initial?.goals ?? []);

  const available = GOALS.filter((g) => source === "lecture" || !g.lectureOnly);
  const chosen = goals.filter((g) => available.some((a) => a.id === g));
  const toggle = (g: Goal) => setGoals((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));

  return (
    <section className="card chooser">
      <h2>What do you have?</h2>
      <div className="choices">
        {SOURCES.map((s) => (
          <button key={s.id} type="button" className={`choice ${source === s.id ? "selected" : ""}`} aria-pressed={source === s.id} onClick={() => setSource(s.id)}>
            <span className="choice-icon">{s.icon}</span>
            <span className="choice-title">{s.title}</span>
            <span className="choice-text">{s.text}</span>
          </button>
        ))}
      </div>

      {source && (
        <>
          <h2 className="chooser-q2">What do you want to make? <span className="muted">(choose one or more)</span></h2>
          <div className="choices">
            {available.map((g) => (
              <button key={g.id} type="button" className={`choice ${chosen.includes(g.id) ? "selected" : ""}`} aria-pressed={chosen.includes(g.id)} onClick={() => toggle(g.id)}>
                <span className="choice-check">{chosen.includes(g.id) ? "✓" : ""}</span>
                <span className="choice-icon">{g.icon}</span>
                <span className="choice-title">{g.title}</span>
                <span className="choice-text">{g.text}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="row chooser-actions">
        <button disabled={!source || !chosen.length} onClick={() => source && onDone({ source, goals: GOALS.map((g) => g.id).filter((id) => chosen.includes(id)) })}>
          Continue →
        </button>
        {onCancel && <button className="ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </section>
  );
}
