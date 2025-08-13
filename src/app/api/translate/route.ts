// src/app/api/translate/route.ts
import OpenAI from "openai";

export const runtime = "edge";

// GET（確認用）
export async function GET() {
  return Response.json({ ok: true, endpoint: "/api/translate" });
}

// 文体ルール
function toneRule(tone: string, locale: string) {
  const base =
    tone === "formal"
      ? "丁寧でビジネスライク、曖昧さを避け、敬称・敬語を適切に用いる。絵文字・スラングは使わない。"
      : tone === "casual"
      ? "簡潔でフレンドリー。口語表現を適度に使い、長文を避ける。過度な絵文字・俗語は控えめ。"
      : "中立で失礼のない標準的な文体。";
  const enRegion =
    locale === "en-US-west"
      ? "アメリカ西海岸の自然な言い回しを選ぶ（気取らずフレンドリー）。"
      : locale === "en-US-east"
      ? "アメリカ東海岸の自然な言い回しを選ぶ（ややきっちり）。"
      : "";
  return `${base} ${enRegion}`.trim();
}

// ロケールヒント
function localeHint(locale: string) {
  switch (locale) {
    case "zh-Hant":
      return "繁體中文（台湾/香港で自然）で書く。";
    case "zh-Hans":
      return "简体中文（中国本土で自然）で書く。";
    case "de-CH":
      return "Schweizer Hochdeutsch（スイス標準ドイツ語）で書く。";
    case "en-AU":
      return "Australian English の自然な表現を使う。";
    case "en-NZ":
      return "New Zealand English の自然な表現を使う。";
    default:
      return "";
  }
}

// POST（翻訳処理）
export async function POST(req: Request) {
  const { mode, text, tone = "neutral", targetLocale, sourceLocale } =
    await req.json();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY" }), {
      status: 500,
    });
  }

  const openai = new OpenAI({ apiKey });

  if (mode === "to_ja") {
    const res = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content:
            "あなたは多言語のホテル/民泊フロント係。原文の敬意を保ちつつ、自然な日本語に翻訳してください。",
        },
        { role: "user", content: `原文:\n${text}\n\n出力: 日本語のみ。` },
      ],
    });
    return Response.json({ text: res.output_text ?? "" });
  }

  if (mode === "from_ja") {
    const toneGuide = toneRule(tone, targetLocale);
    const localeGuide = localeHint(targetLocale);
    const res = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content:
            "あなたは民泊ホストの多言語コンシェルジュ。意味を変えずに自然な翻訳を返します。",
        },
        {
          role: "user",
          content: [
            `文体ガイド: ${toneGuide}`,
            `言語/地域ガイド: ${localeGuide}`,
            sourceLocale ? `参考: ゲスト原文の言語は ${sourceLocale}` : "",
            `日本語原文:\n${text}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });
    return Response.json({ text: res.output_text ?? "" });
  }

  return Response.json({ error: "invalid mode" }, { status: 400 });
}
