// app/api/translate/route.ts
export const runtime = "edge";

import OpenAI from "openai";

const MODEL = "gpt-4o-mini-2024-07-18";

type ResponsesMinimal = {
  output_text?: string;
  content?: Array<{ text?: string }>;
};

// ← GET は“1つだけ”
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("diag") === "1") {
    return Response.json({ ok: true, route: "/api/translate" });
  }
  return new Response("Use POST /api/translate", {
    status: 405,
    headers: { Allow: "POST" },
  });
}

export async function POST(req: Request) {
  try {
    const { mode, text } = await req.json();

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      project: process.env.OPENAI_PROJECT,
    });

    const system =
      mode === "to_ja"
        ? "You are a translator. Translate the user's English into natural Japanese."
        : "You are a translator. Translate the user's Japanese into natural English.";

    const r = (await openai.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
    })) as unknown as ResponsesMinimal;

    const result = r.output_text ?? r.content?.[0]?.text ?? "";

    return Response.json({ ok: true, result, model: MODEL });
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: e?.message ?? "unknown" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
