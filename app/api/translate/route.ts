// /app/api/translate/route.ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 環境変数で差し替え可能。未指定なら軽量の 4o-mini
const MODEL = process.env.OPENAI_TRANSLATE_MODEL ?? "gpt-4o-mini-2024-07-18";

type Tone = "neutral" | "formal" | "casual";
type Action = "to_ja" | "to_guest";
type DetectResult =
  | string
  | { code?: string; lang?: string; language?: string }
  | Array<{ code?: string; lang?: string; language?: string }>;

interface TranslateRequest {
  action: Action;       // "to_ja" | "to_guest"
  text: string;         // 翻訳したい本文
  guestSource?: string; // ゲスト原文（to_guest のとき必須：ここからゲスト言語を推定）
  tone?: Tone;          // to_guest のときのみ適用
  guestLang?: string;       // ★追加: UIで選んだ言語コード("en"など/"auto"可)
  overrideLang?: string;    // ★追加: ヒント用("auto"可)
}

type IncomingPayload = Partial<TranslateRequest> & {
  mode?: string;
  target?: string;
  message?: string;
  content?: string;
};

function isAction(value: string): value is Action {
  return value === "to_ja" || value === "to_guest";
}

interface OkResponse {
  ok: true;
  sourceLang: string;   // 入力本文の推定言語
  targetLang: string;   // 出力言語
  translation: string;  // 翻訳結果
}

interface ErrResponse {
  ok: false;
  error: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as IncomingPayload | null;

    // ① 互換シム（ここを新規追加）
    // - フロントが {mode:"to_ja"} を送ってきても受ける
    // - text の別名（message/content）も吸収
    const raw: IncomingPayload = { ...(body ?? {}) };
    if (!raw.action) {
      if (typeof raw.mode === "string" && isAction(raw.mode)) {
        raw.action = raw.mode;           // "to_ja" → action
      } else if (
        typeof raw.target === "string" &&
        raw.target.toLowerCase().startsWith("ja")
      ) {
        raw.action = "to_ja";            // target が ja 系なら to_ja と解釈
      }
    }
    if (!raw.text) {
      raw.text = raw.message ?? raw.content ?? "";
    }
    // 以降この payload を使う
    const payload = raw as TranslateRequest;

    // ② 必須チェック（payload に対して行う）
    if (!payload?.text || !payload?.action) {
      return Response.json(
        { ok: false, error: "Missing required fields: 'text' and 'action'." } as ErrResponse,
        { status: 400 }
      );
    }

    const action = payload.action;

    // 入力本文のざっくり言語推定（失敗時は 'und'）
    const sourceLang = guessLangFromText(payload.text);

    // ① ゲスト原文 → 日本語
    if (action === "to_ja") {
      const translated = await translate({
        text: payload.text,
        targetLang: "ja",
        tone: "neutral",
      });

      return Response.json(
        {
          ok: true,
          sourceLang,
          targetLang: "ja",
          translation: translated,
        } as OkResponse
      );
    }

    // ② あなたの返答（日本語） → ゲストの言語
    const guestRaw = (payload.guestSource ?? "").trim();
    if (!guestRaw) {
      return Response.json(
        { ok: false, error: "Missing 'guestSource' for action 'to_guest'." } as ErrResponse,
        { status: 400 }
      );
    }

    // UI選択 > ヒント > 自動判定 の優先順位で targetLang を決定
    let targetLang: string | undefined;

    // 1) 手動選択を最優先
    if (payload.guestLang && payload.guestLang !== "auto") {
      targetLang = payload.guestLang;
    }

    // 2) 次点で overrideLang
    if (!targetLang && payload.overrideLang && payload.overrideLang !== "auto") {
      targetLang = payload.overrideLang;
    }

    // 3) まだ未決定なら自動判定（まず規則、und ならモデル）
    if (!targetLang) {
      let detected: string = guessLangFromText(guestRaw);
      if (detected === "und") {
        const det = (await detectLanguageViaModel(guestRaw)) as DetectResult;
        const code: string =
          typeof det === "string"
            ? det
            : Array.isArray(det)
              ? (det[0]?.code ?? det[0]?.lang ?? det[0]?.language ?? "en")
              : (det.code ?? det.lang ?? det.language ?? "en");
        detected = code;
      }
      targetLang = detected; // 例: "en"
    }

    const tone: Tone = payload.tone ?? "neutral";

    const translated = await translate({
      text: payload.text,         // 日本語の返信
      targetLang: targetLang!,    // 最終決定した言語
      tone,
    });

    return Response.json(
      {
        ok: true,
        sourceLang,               // デバッグ用ざっくり推定
        targetLang: targetLang!,  // 実際に使ったターゲット
        translation: translated,
      } as OkResponse
    );

  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error in /api/translate";
    return Response.json({ ok: false, error: message } as ErrResponse, { status: 500 });
  }
}


/* ===== 言語判定ユーティリティ ===== */

// 短い「漢字だけ」→ 中国語への誤爆を避けるため 'und' 扱いにする
const SHORT_KANJI_RE = /^[\u3400-\u9FFF]{1,6}$/;
function isShortKanjiOnly(s: string): boolean {
  return SHORT_KANJI_RE.test(s.trim());
}

/** ざっくり文字種で判定（失敗時 'und'）。中国語は簡体/繁体を分ける */
function guessLangFromText(s: string):
  | "ja" | "ko" | "zh-Hant" | "zh-Hans" | "en"
  | "es" | "fr" | "de" | "it" | "pt" | "ro" | "tr"
  | "ru" | "uk"
  | "hi" | "ta" | "te" | "bn" | "kn" | "ml" | "pa"
  | "th" | "vi" | "id" | "my" | "lo"
  | "he" | "ar" | "fa" | "ur" | "ps"
  | "und" {
  if (!s) return "und";
  if (isShortKanjiOnly(s)) return "und";

  // ===== 非ラテン系 =====
  // ヘブライ語 U+0590–05FF
  if (/[\u0590-\u05FF]/u.test(s)) return "he";

  // 日本語 / 韓国語
  if (/[ぁ-ゖァ-ヺー]/u.test(s)) return "ja";
  if (/[가-힣]/u.test(s)) return "ko";

  // 中国語（繁体/簡体の粗判）
  if (/[體國臺與優來麼說話發點這們嗎員門車長灣歡愛學習廣龍雞貓邊醫]/u.test(s)) return "zh-Hant";
  if (/[为这们吗级购广龙爱边医门]/u.test(s)) return "zh-Hans";

  // ミャンマー（ビルマ） U+1000–109F + Ext-A/B
  if (/[\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F]/u.test(s)) return "my";
  // ラオス U+0E80–0EFF
  if (/[\u0E80-\u0EFF]/u.test(s)) return "lo";
  // タイ U+0E00–0E7F
  if (/[\u0E00-\u0E7F]/u.test(s)) return "th";

  // インド系ブロック
  if (/[\u0900-\u097F]/u.test(s)) return "hi"; // デーヴァナーガリー（例: ヒンディー）
  if (/[\u0B80-\u0BFF]/u.test(s)) return "ta"; // タミル
  if (/[\u0C00-\u0C7F]/u.test(s)) return "te"; // テルグ
  if (/[\u0980-\u09FF]/u.test(s)) return "bn"; // ベンガル
  if (/[\u0C80-\u0CFF]/u.test(s)) return "kn"; // カンナダ
  if (/[\u0D00-\u0D7F]/u.test(s)) return "ml"; // マラヤーラム
  if (/[\u0A00-\u0A7F]/u.test(s)) return "pa"; // グルムキー（パンジャーブ語）

  // アラビア文字（base + supplement + ext-A）
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u.test(s)) {
    // パシュトゥー固有
    if (/[ځڅښږڼټډړګ]/u.test(s)) return "ps";
    // ウルドゥー固有
    if (/[ٹڈڑےٰںھہ]/u.test(s)) return "ur";
    // ペルシア（Farsi）固有
    if (/[پچژگ]/u.test(s)) return "fa";
    // 既定はアラビア語
    return "ar";
  }

  // キリル系 — ウクライナ→ロシア→その他
  if (/[їєіґЇЄІҐ]/u.test(s)) return "uk";
  if (/[ёэыЁЭЫ]/u.test(s)) return "ru";
  if (/\p{Script=Cyrillic}/u.test(s)) return "ru";

  // ===== ラテン系（独自文字や頻出語）=====
  // トルコ語（独自文字）
  if (/[ğĞşŞıİöÖüÜçÇ]/u.test(s)) return "tr";
  // ルーマニア語（独自文字）
  if (/[ăâîșşţțĂÂÎȘŞŢȚ]/u.test(s)) return "ro";
  // イタリア語（機能語）
  if (/\b(che|non|per|con|ciao|grazie|più|sono|sei|siete|degli|delle|dell|alla|alle|allo|agli|gli|una|uno|un|nel|nella|dai|dal|dalla)\b/i.test(s)) {
    return "it";
  }

  // ベトナム語ダイアクリティクス
  if (/[ăâêôơưđĂÂÊÔƠƯĐ]/u.test(s)) return "vi";
  // インドネシア語の頻出語
  if (/\b(yang|dan|tidak|saya|anda)\b/i.test(s)) return "id";

  // 西欧（ざっくり）
  if (/\b(el|la|de|y|¿|¡)\b/i.test(s)) return "es";
  if (/\b(le|la|de|des|est|avec)\b/i.test(s)) return "fr";
  if (/\b(der|die|das|und|nicht|ist)\b/i.test(s)) return "de";
  if (/\b(o|a|de|que|não|está)\b/i.test(s)) return "pt";

  // 英語は「全文がASCIIのときのみ」（Wi-Fi混入で英語落ちするのを回避）
  if (!/[^\x00-\x7F]/.test(s) && /[A-Za-z]/.test(s)) return "en";

  return "und";
}


/** LLMで言語コードを推定（JSON返答を要求） */
async function detectLanguageViaModel(text: string): Promise<string> {
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a language detector. Reply ONLY with JSON like {\"lang\":\"<code>\"}. " +
          "Use ISO 639-1 if possible. For Chinese, use 'zh-Hans' or 'zh-Hant'.",
      },
      { role: "user", content: `Detect the language code for:\n${text}` },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{\"lang\":\"und\"}";
  const json = extractJson(raw);
  if (!json) return "und";
  try {
    const parsed = JSON.parse(json) as { lang?: string };
    const lang = (parsed.lang ?? "und").trim();
    return lang || "und";
  } catch {
    return "und";
  }
}

/** 実際の翻訳 */
async function translate(args: { text: string; targetLang: string; tone: Tone }): Promise<string> {
  const { text, targetLang, tone } = args;

  const toneHint =
    tone === "formal"
      ? "Use polite, professional hospitality tone."
      : tone === "casual"
      ? "Use friendly and light tone (no slang)."
      : "Use neutral, clear tone.";

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a precise translation engine for Airbnb hosts. " +
          "Translate the user's message into the requested target language. " +
          "Preserve meaning, keep URLs/numbers/dates as-is, avoid adding information. " +
          "Reply ONLY with JSON: {\"translation\":\"...\"}.",
      },
      {
        role: "user",
        content:
          `Target language: ${targetLang}\n` +
          `${toneHint}\n` +
          "Keep sentences concise and natural for guest communication.\n" +
          "Text to translate:\n" +
          text,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{\"translation\":\"\"}";
  const json = extractJson(raw);
  if (json) {
    const parsed = safeParse<{ translation?: string }>(json);
    const t = (parsed.translation ?? "").trim();
    if (t) return t;
  }
  // 念のためのフォールバック
  return raw.trim();
}

/* ===== 文字列ユーティリティ ===== */

function extractJson(s: string): string | null {
  // ```json ... ``` または ``` ... ``` を優先的に抽出
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();
  // 先頭から { ... } を強引に取り出す
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) return s.slice(first, last + 1).trim();
  return null;
}

function safeParse<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return {} as T;
  }
}
