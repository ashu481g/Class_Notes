import Anthropic from "@anthropic-ai/sdk";
import { DECK_SCHEMA, DECK_SYSTEM_PROMPT, buildDeckUserMessage } from "@/lib/deck";

export const runtime = "nodejs";
export const maxDuration = 300;

const MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

type Body = { transcript: string; subject?: string; level?: string; extra?: string; model?: string };

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  const apiKey = process.env.ANTHROPIC_API_KEY || req.headers.get("x-anthropic-key") || "";
  if (!apiKey) return new Response("No Anthropic API key configured. Add one in Settings or copy the prompt instead.", { status: 400 });
  if (!body.transcript?.trim()) return new Response("Transcript is empty.", { status: 400 });

  const client = new Anthropic({ apiKey });
  const stream = client.beta.messages.stream({
    model: body.model && MODELS.has(body.model) ? body.model : "claude-opus-5-5",
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: DECK_SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: DECK_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildDeckUserMessage(body.transcript, body.subject, body.level, body.extra) }],
  });

  // Stream the JSON as it is written so the browser can show progress; it parses at the end.
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        stream.on("text", (t) => controller.enqueue(encoder.encode(t)));
        const final = await stream.finalMessage();
        if (final.stop_reason === "max_tokens") controller.enqueue(encoder.encode("\n\u0000ERROR:The deck hit the length limit. Try a shorter transcript."));
        else if (final.stop_reason === "refusal") controller.enqueue(encoder.encode("\n\u0000ERROR:The model declined this request. Try the copyable prompt instead."));
      } catch (err) {
        const msg =
          err instanceof Anthropic.AuthenticationError ? "Invalid Anthropic API key."
          : err instanceof Anthropic.RateLimitError ? "Rate limited by the Anthropic API, please retry in a minute."
          : err instanceof Anthropic.APIError ? `Anthropic API error ${err.status}: ${err.message}`
          : String(err);
        controller.enqueue(encoder.encode(`\n\u0000ERROR:${msg}`));
      } finally {
        controller.close();
      }
    },
    cancel() {
      stream.abort();
    },
  });
  return new Response(readable, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
