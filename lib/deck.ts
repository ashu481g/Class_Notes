// Slide deck + narration script generated from the lecture transcript.

export type Slide = {
  title: string;
  bullets: string[];
  /** Plain-text formula with Unicode symbols (e.g. "F = m·a"), or "" */
  formula: string;
  diagram: { type: "none" | "mermaid" | "svg"; code: string };
  /** What the presenter says for this slide, in Hinglish */
  narration: string;
};

export type Deck = { title: string; slides: Slide[] };

export const DECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "slides"],
  properties: {
    title: { type: "string" },
    slides: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "bullets", "formula", "diagram", "narration"],
        properties: {
          title: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          formula: { type: "string" },
          diagram: {
            type: "object",
            additionalProperties: false,
            required: ["type", "code"],
            properties: {
              type: { type: "string", enum: ["none", "mermaid", "svg"] },
              code: { type: "string" },
            },
          },
          narration: { type: "string" },
        },
      },
    },
  },
} as const;

export const DECK_SYSTEM_PROMPT = `You are an experienced Indian college lecturer who makes clear, visual teaching presentations. You turn a lecture transcript into a slide deck plus a spoken narration script for each slide. The deck will be turned into a narrated video.

The transcript comes from automatic speech recognition and may mis-hear technical terms; correct them from context and ignore filler and classroom chatter.

Slides (on-screen text):
- All on-screen text is in English only: titles, bullets, formulas and diagram labels. No Hindi or Hinglish on slides, not even in Roman script (write "Today's Agenda", not "Agenda Aaj Ka"). Hinglish belongs only in the narration.
- Short and scannable: a title of at most 8 words, 3 to 5 bullets of at most 12 words each.
- Formulas go in the "formula" field as plain text with Unicode symbols (for example "F = m·a", "v² = u² + 2as", "∫₀¹ x² dx = 1/3"), not LaTeX. Use "" when the slide has none.
- Add a diagram whenever it helps understanding, even if the professor only described it in words. Use "mermaid" for concept maps, processes, flowcharts, cycles, hierarchies and timelines: flowchart TD or LR, short node labels wrapped in double quotes, at most about 10 nodes. Use "svg" for figures Mermaid cannot draw (free-body diagrams, circuits, vectors, graphs of functions, geometry): one self-contained <svg> with a viewBox, a white background rect, dark strokes, labels in English, no scripts. Use type "none" with code "" otherwise.
- Include standard formulas and canonical diagrams for each topic even when the professor did not write them out.
- Deck structure: a title slide, an agenda slide, one or more slides per topic in lecture order, worked example slides where useful, a key formulas/summary slide, and a final quick quiz slide with 3 questions.

Narration (spoken audio):
- Write it the way a friendly Indian teacher explains in class, in natural Hinglish: Hindi for the conversational flow and English for technical terms, formulas and key phrases. Example: "तो दोस्तों, अब हम Newton's second law देखते हैं। Simple भाषा में, net force बराबर होता है mass times acceleration."
- Write Hindi words in Devanagari and English words in English (Latin script), so a text-to-speech voice pronounces both correctly. Read formulas out in words.
- Explain the slide rather than reading it: give the intuition, a real-life Indian example where natural, and connect it to the previous slide. About 60 to 120 words per slide; shorter for the title and agenda slides.`;

export function buildDeckUserMessage(transcript: string, subject?: string, level?: string, extra?: string) {
  const context = [
    subject?.trim() && `Subject / course: ${subject.trim()}`,
    level?.trim() && `Audience level: ${level.trim()}`,
    extra?.trim() && `Extra instructions: ${extra.trim()}`,
  ].filter(Boolean);
  return `${context.length ? context.join("\n") + "\n\n" : ""}Lecture transcript:\n\n<transcript>\n${transcript.trim()}\n</transcript>\n\nCreate the slide deck with narration.`;
}

/** Self-contained prompt for claude.ai when no API key is configured. */
export function buildCopyableDeckPrompt(transcript: string, subject?: string, level?: string, extra?: string) {
  return `${DECK_SYSTEM_PROMPT}

Output format: reply with one JSON object in a single \`\`\`json code block, with no commentary before or after it, and do not split it across several messages. It is pasted into an app that turns it into slides and a narrated video, so it must be valid JSON (escape double quotes and newlines inside strings) matching this JSON Schema:
${JSON.stringify(DECK_SCHEMA)}

---

${buildDeckUserMessage(transcript, subject, level, extra)}`;
}

/** Accepts the model's reply, tolerating ```json fences or text around the object. */
export function parseDeck(text: string): Deck {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON object found in the reply.");
  const deck = JSON.parse(text.slice(start, end + 1)) as Deck;
  if (!Array.isArray(deck.slides) || !deck.slides.length) throw new Error("The reply has no slides.");
  deck.slides = deck.slides.map((s) => ({
    title: String(s.title ?? ""),
    bullets: Array.isArray(s.bullets) ? s.bullets.map(String) : [],
    formula: String(s.formula ?? ""),
    diagram: s.diagram && s.diagram.type !== "none" && s.diagram.code ? s.diagram : { type: "none", code: "" },
    narration: String(s.narration ?? ""),
  }));
  return deck;
}
