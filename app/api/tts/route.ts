// Text-to-speech for one slide's narration via OpenAI's speech API.
// gpt-4o-mini-tts follows style instructions, which is what gives the natural Indian Hinglish delivery.
export const runtime = "nodejs";
export const maxDuration = 60;

const VOICES = new Set(["coral", "sage", "nova", "shimmer", "alloy", "ash", "ballad", "echo", "fable", "onyx", "verse"]);

const INSTRUCTIONS =
  "Speak like a warm, friendly Indian college teacher explaining to students in class. " +
  "The text mixes Hindi (Devanagari) and English. Use a natural Indian accent and Hinglish rhythm, " +
  "pronounce Hindi words natively and English technical terms clearly the Indian-English way. " +
  "Moderate pace, short natural pauses between ideas, encouraging tone.";

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY || req.headers.get("x-openai-key") || "";
  if (!apiKey) return new Response("No OpenAI API key configured.", { status: 400 });
  const { text, voice } = (await req.json()) as { text?: string; voice?: string };
  if (!text?.trim()) return new Response("Empty narration.", { status: 400 });

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: voice && VOICES.has(voice) ? voice : "coral",
      input: text.slice(0, 4000),
      instructions: INSTRUCTIONS,
      response_format: "mp3",
    }),
  });
  if (!res.ok) return new Response(`OpenAI error ${res.status}: ${(await res.text()).slice(0, 500)}`, { status: 502 });
  return new Response(res.body, { headers: { "Content-Type": "audio/mpeg" } });
}
