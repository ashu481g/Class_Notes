"use client";

import { useEffect, useId, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

function Mermaid({ code }: { code: string }) {
  const id = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
      try {
        const { svg } = await mermaid.render(id, code);
        if (!cancelled) { setSvg(svg); setError(""); }
      } catch (e) {
        if (!cancelled) setError(String(e));
        document.getElementById("d" + id)?.remove(); // mermaid leaves an error node behind
      }
    })();
    return () => { cancelled = true; };
  }, [code, id]);

  if (error) {
    return (
      <div className="figure figure-error">
        <small>Diagram could not be drawn, showing its source:</small>
        <pre><code>{code}</code></pre>
      </div>
    );
  }
  return <div className="figure" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function SvgFigure({ code }: { code: string }) {
  // Rendered through <img>, so any script inside the SVG can never run.
  const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(code.trim());
  return (
    <div className="figure">
      <img src={src} alt="Diagram" />
    </div>
  );
}

export default function NotesView({ markdown, streaming }: { markdown: string; streaming: boolean }) {
  return (
    <div className="notes">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code({ className, children }) {
            const lang = /language-(\w+)/.exec(className || "")?.[1];
            const text = String(children).replace(/\n$/, "");
            if (lang === "mermaid" || lang === "svg") {
              if (streaming) return <span className="figure-pending">Drawing diagram…</span>;
              return lang === "mermaid" ? <Mermaid code={text} /> : <SvgFigure code={text} />;
            }
            return <code className={className}>{children}</code>;
          },
          pre({ children }) {
            return <pre>{children}</pre>;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
