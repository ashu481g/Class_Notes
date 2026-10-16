// Tells the browser which API keys the server already has (never the keys themselves).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
  });
}
