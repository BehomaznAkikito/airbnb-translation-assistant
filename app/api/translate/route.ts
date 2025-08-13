// app/api/translate/route.ts
import OpenAI from "openai";
export const runtime = "edge";

export async function GET() {
  return Response.json({ ok: true, endpoint: "/api/translate" });
}

type ReqBody = {
  mode: "to_ja" | "from_ja";
  text: string;
  tone?: "neutral" | "formal" | "casual";
  targetLocale?: string; // 例: "US English", "Australian English", "German" など
};

export async function POST(req: Request) {
  try {
    const { mode, text, tone = "neutral", targetLocale } = (await req.json()) as ReqBody;

    if (!process.env.OPENAI_API_KEY) {
      return Response.json({ error: "OPENAI_API_KEY is missing" }, { status: 500 });
    }
    if (!text?.trim()) {
      return Response.json({ error: "text is required" }, { status: 400 });
    }

    // プロンプト（Airbnb用に丁寧・簡潔）
    const system =
      mode === "to_ja"
        ? "You are a professional translator. Translate the user's message into natural, polite, concise Japanese suitable for an Airbnb host."
        : `You are a professional translator. Translate the user's message into ${targetLocale || "English"} in a ${tone} tone, suitable for Airbnb host–guest communication. Keep it polite and concise.`;

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const resp = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: text }
      ],
    });

    // 念のため安全に取り出す
    const out =
      (resp as any).output_text?.trim() ||
      (((resp as any).output?.[0]?.content?.[0] || {}) as any)?.text?.value?.trim() ||
      "";

    return Response.json({ text: out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
