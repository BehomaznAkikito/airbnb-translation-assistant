// app/api/translate/route.ts
export const runtime = "edge";

import OpenAI from "openai";

// 使うモデルは日付付きで固定
const MODEL = "gpt-4o-mini-2024-07-18";

// ★ここをあなたの Default project の ID に置き換え
//   （スクショだと proj_6a5ShAg0Iw5zTzTug0xJa0an）
const DEFAULT_PROJECT_ID = "proj_6a5ShAg0Iw5zTzTug0xJa0an";

// 型：any なし
type RespMinimal = {
  output_text?: string;
  content?: Array<{ text?: string }>;
};

// OpenAI クライアント（Project を明示して “上書き”）
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  project: DEFAULT_PROJECT_ID,
});

export async function GET(req: Request) {
  const url = new URL(req.url);

  // ① 環境ダンプ（“環境変数の値”を見るだけ）
  if (url.searchParams.get("diag") === "env") {
    return Response.json({
      route: "/api/translate",
      model: MODEL,
      vercelEnv: process.env.VERCEL_ENV ?? null,
      projectEnvVar: process.env.OPENAI_PROJECT ?? null, // ← ここは残骸確認用（使わない）
      url: process.env.VERCEL_URL ?? null,
    });
  }

  // ② 実際に OpenAI へ軽く当てて “どの Project で通るか” を確認
  if (url.searchParams.get("diag") === "whoami") {
    try {
      const list = await client.models.list();
      return Response.json({ ok: true, seen: list.data.slice(0, 1).map(m => m.id) });
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string };
      return Response.json(
        { ok: false, status: err.status ?? 500, error: err },
        { status: err.status ?? 500 }
      );
    }
  }

  return new Response("Use POST /api/translate", {
    status: 405,
    headers: { Allow: "POST" },
  });
}

export async function POST(req: Request) {
  const { mode, text } = (await req.json()) as {
    mode: "to_ja" | "from_ja";
    text: string;
  };

  const system =
    mode === "to_ja"
      ? "You are a translator. Translate the user's English into natural Japanese."
      : "You are a translator. Translate the user's Japanese into natural English.";

  try {
    const r = await client.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
    });

    const res = r as RespMinimal;
    const out = res.output_text ?? res.content?.[0]?.text ?? "";
    return Response.json({ ok: true, text: out });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return Response.json({ ok: false, error: err }, { status: err.status ?? 500 });
  }
}
