// /app/api/translate/route.ts
import OpenAI from "openai";

// Node.js 実行（envやCookie操作を安定させる）
export const runtime = "nodejs";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// --- 型 ---
type Tone = "polite" | "neutral" | "casual";
type Role = "guest" | "host";

type Body = {
  text: string;
  role?: Role;          // 省略可：未指定&Cookieなし→guest、Cookieあり→host と推定
  tone?: Tone;          // デフォルト "neutral"
  guestLang?: string;   // 任意：host時にCookieが無い場合の明示指定に使える
};

// --- 小道具 ---
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isISO639ish = (v: string) => /^[a-z]{2}(-[A-Z]{2})?$/.test(v); // 例: "en", "pt-BR"
const cookieName = "guest_lang";
const cookieMaxAgeSec = 60 * 30; // 30分

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") || "";
  const m = raw.split(/;\s*/).map((kv) => kv.split("=")).find(([k]) => k === name);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

function setCookie(res: Response, name: string, value: string, maxAgeSec: number) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAgeSec}`,
    "SameSite=Lax",
    "Secure",
  ];
  res.headers.append("Set-Cookie", parts.join("; "));
}

// --- メイン ---
export async function POST(req: Request) {
  console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY?.slice(0, 6) + "*****");
  try {
    if (!process.env.OPENAI_API_KEY) {
      return Response.json(
        { ok: false, error: { code: "NO_API_KEY", message: "OPENAI_API_KEY is not set" } },
        { status: 401 }
      );
    }

    const body = (await req.json()) as Partial<Body>;
    const text = isNonEmptyStr(body.text) ? body.text : "";

    if (!isNonEmptyStr(text)) {
      return Response.json({ ok: false, error: "Missing 'text'." }, { status: 400 });
    }

    // 1) 言語検出（安価・高速）
    const detect = await client.responses.create({
      model: "gpt-5-nano",
      input: [
        {
          role: "system",
          // detect の system メッセージをこれに
content:
  "Detect the user's language and return ONLY a BCP-47 tag: " +
  "language (ISO 639-1). Include a Script subtag when relevant (e.g., sr-Cyrl, sr-Latn, zh-Hant, zh-Hans). " +
  "Include a Region subtag only if obvious (e.g., pt-BR vs pt-PT). No extra text.",
        },
        { role: "user", content: text },
      ],
    });
    // 検出結果の生文字列（先に raw を作る）
const detectedRaw = detect.output_text
  .trim()
  .toLowerCase()
  .slice(0, 20)
  .replace(/[^a-z-]/g, "");

// BCP-47 っぽいタグ（言語 + 任意で Script または Region）を許可。
// 例: en / ja / de / hi / te / pt-BR / sr-Cyrl / zh-Hant / zh-Hans
const isLangTag = (v: string) =>
  /^(?:[a-z]{2})(?:-(?:[A-Z][a-z]{3}|[A-Z]{2}))?$/i.test(v) ||
  /^zh-(?:Hant|Hans)$/i.test(v);

// 妥当なら採用、ダメなら und（未定義）
const detected = isLangTag(detectedRaw) ? detectedRaw : "und";



    // 2) 役割（phase）を推定
    const cookieLang = readCookie(req, cookieName);
    const role: Role =
      body.role ??
      (cookieLang ? "host" : "guest"); // Cookieがあれば「返信」フェーズとみなす

    const tone: Tone = (["polite", "neutral", "casual"] as const).includes((body.tone as Tone) ?? "neutral")
      ? ((body.tone as Tone) ?? "neutral")
      : "neutral";

    // 3) 翻訳先の決定
    let target: string;
    let phase: "guest_to_ja" | "host_to_guest";

    if (role === "guest") {
      // ゲストの言語 → 日本語（保存）
      target = "ja";
      phase = "guest_to_ja";
    } else {
      // あなたの日本語 → ゲストの言語（Cookie優先 / 指定があれば上書き）
      const to = isNonEmptyStr(body.guestLang) ? body.guestLang.trim() : (cookieLang ?? "");
      if (!isISO639ish(to)) {
        // 保険：CookieもguestLangも無ければ、検出から推定（日本語を送ってくる前提なので非jaを採用/なければ英語）
        const fallback = detected !== "ja" ? detected : "en";
        return Response.json(
          {
            ok: false,
            error:
              `Missing guest language. Provide ` +
              `Cookie "${cookieName}" or body.guestLang (e.g., "en"). ` +
              `Fallback guess would be "${fallback}", but explicit context is safer.`,
          },
          { status: 400 }
        );
      }
      target = to;
      phase = "host_to_guest";
    }

    // 4) トーン指示
    const toneGuide =
      tone === "polite"
        ? "Use a polite/business tone appropriate for Airbnb guest messaging."
        : tone === "casual"
        ? "Use a friendly casual tone appropriate for Airbnb guest messaging."
        : "Use a neutral, clear tone appropriate for Airbnb guest messaging.";

    // 5) 翻訳 or 言い換え
    //    役割ごとに「出力は必ず target だけ」を強制
    const systemLines: string[] = [
      `You are a translation assistant for Airbnb hosts.`,
      `Your output MUST be entirely in ${target}.`,
      `Do not include explanations, prefaces, or the source text.`,
      toneGuide,
    ];

    // source==target のときは言い換えに切り替え
    const mustTranslate =
      (role === "guest" && detected !== "ja") ||
      (role === "host" && detected !== target) ||
      // 検出が "und"（不明）なら一応翻訳扱い
      detected === "und";

    const instruction = mustTranslate
      ? `Translate the user message into ${target}. Keep all factual details, numbers, dates, amounts, times. Do not add or omit information.`
      : `Rewrite the user message in ${target} with the requested tone, without changing meaning, numbers, dates, amounts, or times.`;

    const reply = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: systemLines.join(" ") },
        {
          role: "user",
          content: [
            `Detected source language: ${detected}. Target language: ${target}.`,
            instruction,
            `Text: """${text}"""`,
          ].join("\n"),
        },
      ],
    });

    let out = reply.output_text.trim();

    // 6) 日本語ターゲット時の簡易ポストチェック（英語っぽかったらリトライ）
    if (
      target === "ja" &&
      /[A-Za-z]/.test(out) &&
      (out.replace(/[^\u3040-\u30FF\u4E00-\u9FFF]/g, "").length <
        out.replace(/[^A-Za-z]/g, "").length)
    ) {
      const retry = await client.responses.create({
        model: "gpt-5-mini",
        input: [
          {
            role: "system",
            content: "Translate strictly into Japanese only. No English words unless proper nouns or codes. No explanations.",
          },
          { role: "user", content: `Text: """${text}"""` },
        ],
      });
      out = retry.output_text.trim();
    }

    // 7) レスポンス & Cookie設定（guestフェーズの時だけ保存/更新）
    const payload = {
      ok: true as const,
      phase,
      src: detected,
      target,
      tone,
      text: out,
    };

    const res = Response.json(payload);

    if (phase === "guest_to_ja" && isISO639ish(detected)) {
      // 最初のゲスト言語を保存（30分）
      setCookie(res, cookieName, detected, cookieMaxAgeSec);
    }
    return res;
  } catch (err: unknown) {
    const status = (() => {
      if (typeof err === "object" && err && "status" in err) {
        const s = (err as Record<string, unknown>).status;
        if (typeof s === "number") return s;
      }
      return 500;
    })();

    const message = (() => {
      if (err instanceof Error) return err.message;
      if (typeof err === "object" && err && "error" in err) {
        const e = (err as Record<string, unknown>).error;
        if (
          typeof e === "object" &&
          e !== null &&
          "message" in (e as Record<string, unknown>) &&
          typeof (e as Record<string, unknown>).message === "string"
        ) {
          return (e as Record<string, unknown>).message as string;
        }
      }
      try {
        return JSON.stringify(err);
      } catch {
        return String(err);
      }
    })();

    return Response.json({ ok: false, error: message }, { status });
  }
}
