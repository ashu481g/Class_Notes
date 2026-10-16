"use client";

import { download } from "@/lib/clipboard";

/** Shows a generated prompt with a download button, used when copying needs a manual fallback. */
export default function PromptBox({ text, failed, fileName, onHide }: { text: string; failed: boolean; fileName: string; onHide: () => void }) {
  return (
    <div className="prompt-box">
      <p className="hint">
        {failed
          ? <>⚠️ Your browser blocked automatic copying. Click inside the box, press <b>Ctrl+A</b> then <b>Ctrl+C</b>, or download it as a file.</>
          : <>Paste this into <a href="https://claude.ai/new" target="_blank" rel="noreferrer">claude.ai</a>. For long lectures, the download is easier to attach as a file.</>}
      </p>
      <textarea readOnly rows={6} value={text} onFocus={(e) => e.currentTarget.select()} />
      <div className="row">
        <button className="ghost" onClick={() => download(new Blob([text], { type: "text/plain" }), fileName)}>⬇ Download prompt (.txt)</button>
        <button className="ghost" onClick={onHide}>Hide</button>
      </div>
    </div>
  );
}
