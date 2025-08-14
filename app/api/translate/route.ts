// app/api/translate/route.ts
export const runtime = "edge";

import OpenAI from "openai";

// 固定で使うモデル（日付付き）
const MODEL = "gpt-5-mini-2025-08-07";

// 最小限のレスポンス型（any なし）
type ResponsesMinimal = {
  output_text?: string;
  content?: Array<{ text?: string }>;
};

export async function POST(req: Request) {
  // 診断: OpenAI 呼び出し前に現在の環境を返す
  if (req.headers.get("x-diag") === "1") {
    return Response.json({
      modelUsed: MODEL,
      projectUsed: process.env.OPENAI_PROJECT ?? null,
      vercelEnv:  process.env.VERCEL_ENV ?? null,
      vercelUrl:  process.env.VERCEL_URL ?? null,
      commit:     process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    });
  }

  const { mode, text } = await req.json();

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    project: process.env.OPENAI_PROJECT, // 明示
  });

  const system =
    mode === "to_ja"
      ? "You are a translator. Translate the user's English into natural Japanese."
      : "You are a translator. Translate the user's Japanese into natural English.";

  const r = await openai.responses.create({
    model: MODEL, // 絶対に日付付き
    input: [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
  });

  // 最小型にキャスト
  const rr = r as unknown as ResponsesMinimal;

  // テキストを取り出す
  const result = rr.output_text ?? rr.content?.[0]?.text ?? "";

  // 応答
  return Response.json({ ok: true, result, model: MODEL });
} // ← これが抜けていた
