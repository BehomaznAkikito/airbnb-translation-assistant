// app/api/translate/route.ts
export const runtime = "edge";

import OpenAI from "openai";

// ✅ モデルは日付付きで**固定**（環境変数は見ない）
const MODEL = "gpt-4o-mini-2024-07-18" as const;

type ResponsesMinimal = {
  output_text?: string;
  content?: Array<{ text?: string }>;
};

// 診断用: /api/translate?diag=env
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("diag") === "env") {
    return Response.json({
      route: "/api/translate",
      model: MODEL,
      vercelEnv: process.env.VERCEL_ENV ?? null,
      project: process.env.OPENAI_PROJECT ?? null,
      url: process.env.VERCEL_URL ?? null,
    });
  }
  return new Response("Use POST /api/translate", {
    status: 405,
    headers: { Allow: "POST" },
  });
}

type Body = {
  mode: "to_ja" | "from_ja";
  text: string;
  tone?: string;
  targetLocale?: string;
};

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Bad JSON" }, { status: 400 });
  }

  const { mode, text } = body as Body;
  if (!text || !mode) {
    return Response.json({ ok: false, error: "Missing fields" }, { status: 400 });
  }

  const system =
    mode === "to_ja"
      ? "You are a translator. Translate the user's English into natural Japanese."
      : "You are a translator. Translate the user's Japanese into natural English.";

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // ← これだけでOK
  });

  try {
    const r = await openai.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
    });

    const rr = r as unknown as ResponsesMinimal;
    const result = rr.output_text ?? rr.content?.[0]?.text ?? "";
    return Response.json({ ok: true, text: result });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return Response.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: e?.status ?? 500 },
    );
  }
}
