// Cloud transcription of one short WAV chunk via OpenAI's speech-to-text API.
// The browser sends ~2-minute 16 kHz chunks, which stay under Vercel's 4.5 MB request limit.
export const runtime = "nodejs";
export const maxDuration = 120;

const MODELS = new Set(["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"]);

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY || req.headers.get("x-openai-key") || "";
  if (!apiKey) return new Response("No OpenAI API key configured.", { status: 400 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof Blob)) return new Response("Missing audio chunk.", { status: 400 });
  const model = String(form.get("model") || "whisper-1");

  const upstream = new FormData();
  upstream.append("file", file, "chunk.wav");
  upstream.append("model", MODELS.has(model) ? model : "whisper-1");
  upstream.append("response_format", "text");
  const language = String(form.get("language") || "");
  if (language) upstream.append("language", language);
  const prompt = String(form.get("prompt") || "");
  if (prompt) upstream.append("prompt", prompt.slice(0, 800)); // vocabulary hint: course name, key terms

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: upstream,
  });
  const text = await res.text();
  if (!res.ok) return new Response(`OpenAI error ${res.status}: ${text.slice(0, 500)}`, { status: 502 });
  return new Response(text.trim(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
