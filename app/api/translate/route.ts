// app/api/translate/route.ts
export const runtime = "edge";

import OpenAI from "openai";

// モデルは env か、なければ gpt-4o-mini（※日付なし）
const MODEL = process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-4o-mini";

// ---- GET: 診断用 ----
// --- これを route.ts の GET にする（1つだけ定義）---
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  if (sp.get("diag") === "env") {
    return Response.json(
      {
        route: "/api/translate",
        model: process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-4o-mini",
        vercelEnv: process.env.VERCEL_ENV ?? null,
        project: process.env.OPENAI_PROJECT ?? null,
        url: process.env.VERCEL_URL ?? null,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  // 診断以外の GET でも 200 の JSON を返しておく（405にせずデバッグしやすく）
  return Response.json(
    {
      ok: true,
      route: "/api/translate",
      hint: "POST with JSON { mode: 'to_ja'|'from_ja', text: '...' }. For env, use ?diag=env",
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}


// ---- ユーティリティ: any を使わずに安全に text を取り出す ----
function extractText(resp: unknown): string {
  if (resp && typeof resp === "object") {
    const obj = resp as Record<string, unknown>;
    const ot = obj["output_text"];
    if (typeof ot === "string") return ot;

    const content = obj["content"];
    if (Array.isArray(content) && content.length > 0) {
      const c0 = content[0];
      if (c0 && typeof c0 === "object") {
        const t = (c0 as Record<string, unknown>)["text"];
        if (typeof t === "string") return t;
      }
    }
  }
  return "";
}

// ---- POST: 翻訳本体 ----
export async function POST(req: Request) {
  try {
    const { mode, text, tone, targetLocale } = (await req.json()) as {
      mode: "to_ja" | "from_ja";
      text: string;
      tone?: string;
      targetLocale?: string;
    };

    if (!text || typeof text !== "string") {
      return Response.json(
        { ok: false, error: "text is required" },
        { status: 400 }
      );
    }

    const system =
      mode === "to_ja"
        ? "You are a translator. Translate the user's English into natural Japanese."
        : "You are a translator. Translate the user's Japanese into natural English.";

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      // 同じ Project で権限を束ねているなら指定してOK
      project: process.env.OPENAI_PROJECT,
    });

    const resultRaw = await openai.responses.create({
      model: MODEL,
      input: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
    });

    const result = extractText(resultRaw);
    return Response.json({ ok: true, text: result, model: MODEL });
  } catch (e) {
    // 失敗時のステータスとメッセージをそのまま返す
    let status = 500;
    let message = "unknown";
    let details: unknown = null;

    if (e && typeof e === "object") {
      const err = e as Record<string, unknown>;
      // openai.errors.APIError などは response を持つ
      const resp = err["response"];
      if (resp && typeof resp === "object") {
        const r = resp as Record<string, unknown>;
        if (typeof r["status"] === "number") status = r["status"] as number;
        details = r["data"] ?? r["body"] ?? null;
      }
      if (typeof err["status"] === "number") status = err["status"] as number;
      if (typeof err["message"] === "string") message = err["message"] as string;
    }

    return Response.json(
      { ok: false, error: message, details, model: MODEL },
      { status }
    );
  }
}
