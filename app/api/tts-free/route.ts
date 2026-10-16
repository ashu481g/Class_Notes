// Free text-to-speech with Microsoft's neural Hindi voices (the same voices Edge's "Read aloud" uses).
// No API key needed. Note: this goes through the endpoint the Edge browser uses, not an official
// paid API, so Microsoft could change or rate-limit it; the OpenAI voice is the supported fallback.
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export const runtime = "nodejs";
export const maxDuration = 60;

// hi-IN neural voices read Devanagari Hindi and Latin-script English in the same sentence naturally.
const VOICES = new Set(["hi-IN-SwaraNeural", "hi-IN-MadhurNeural"]);

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function POST(req: Request) {
  const { text, voice, rate } = (await req.json()) as { text?: string; voice?: string; rate?: string };
  if (!text?.trim()) return new Response("Empty narration.", { status: 400 });

  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice && VOICES.has(voice) ? voice : "hi-IN-SwaraNeural", OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXml(text.slice(0, 5000)), { rate: rate || "-5%" });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      audioStream.on("data", (c: Buffer) => chunks.push(c));
      audioStream.on("end", () => resolve());
      audioStream.on("error", reject);
      audioStream.on("close", () => resolve());
    });
    const audio = Buffer.concat(chunks);
    if (!audio.length) return new Response("The free voice service returned no audio. Try again, or use the OpenAI voice.", { status: 502 });
    return new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/mpeg" } });
  } catch (err) {
    return new Response(`Free voice service failed: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  } finally {
    tts.close();
  }
}
