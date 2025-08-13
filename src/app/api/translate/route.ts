import OpenAI from "openai";

export const runtime = "edge"; // 速い・安い（NodeでもOK）

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function toneRule(tone: string, locale: string) {
  // 言語ごとの「親密度のさじ加減」を軽く調整
  const base =
    tone === "formal"
      ? "丁寧でビジネスライク、曖昧さを避け、敬称・敬語を適切に用いる。絵文字・スラングは使わない。"
      : tone === "casual"
      ? "簡潔でフレンドリー。口語表現を適度に使い、長文を避ける。過度な絵文字・俗語は控えめ。"
      : "中立で失礼のない標準的な文体。";
  // 英語の地域ニュアンスの軽い誘導
  const enRegion =
    locale === "en-US-west"
      ? "アメリカ西海岸の自然な言い回しを選ぶ（気取らずフレンドリー）。"
      : locale === "en-US-east"
      ? "アメリカ東海岸の自然な言い回しを選ぶ（ややきっちり）。"
      : "";
  return `${base} ${enRegion}`.trim();
}

function localeHint(locale: string) {
  // OpenAIに方言/表記を明示
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

export async function POST(req: Request) {
  const { mode, text, tone = "neutral", targetLocale, sourceLocale } =
    await req.json();

  if (!process.env.OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY" }), {
      status: 500,
    });
  }

  if (mode === "to_ja") {
    // ゲスト原文 → 日本語
    const res = await client.responses.create({
      model: "gpt-5", // ここは利用プランに合わせて。gpt-4oでもOK
      input: [
        {
          role: "system",
          content:
            "あなたは多言語のホテル/民泊フロント係。原文の敬意を保ちつつ、自然な日本語に翻訳してください。固有名詞や日時・部屋番号は正確に。",
        },
        {
          role: "user",
          content: `原文:\n${text}\n\n出力: 日本語のみ。余計な説明は書かない。`,
        },
      ],
    });

    const out = res.output_text || "";
    return Response.json({ text: out });
  }

  if (mode === "from_ja") {
    // 日本語 → 指定言語（トーン付き）
    const toneGuide = toneRule(tone, targetLocale);
    const localeGuide = localeHint(targetLocale);

    const res = await client.responses.create({
      model: "gpt-5", // ここもプランに応じて変更可
      input: [
        {
          role: "system",
          content:
            "あなたは民泊ホストの多言語コンシェルジュ。ゲストに失礼のない自然な翻訳を行い、意味の補完や意図の追加はしない。",
        },
        {
          role: "user",
          content: [
            `次の日本語メッセージを、指定の言語・文体で翻訳してください。`,
            `文体ガイド: ${toneGuide}`,
            `言語/地域ガイド: ${localeGuide}`,
            sourceLocale ? `参考: ゲスト原文の言語は ${sourceLocale}` : "",
            `日本語原文:\n${text}`,
            `出力: 指定言語の本文のみ。`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });

    const out = res.output_text || "";
    return Response.json({ text: out });
  }

  return Response.json({ error: "invalid mode" }, { status: 400 });
}
