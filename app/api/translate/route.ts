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
    // 受信ボディ（型はまだ確定しない）
    const bodyUnknown = (await req.json()) as unknown;

    // 互換シム用の入力型（any禁止）
    type Incoming = Partial<TranslateRequest> & {
      mode?: string;    // 例: "to_ja"
      target?: string;  // 例: "ja"
      message?: string; // text の別名
      content?: string; // text の別名
    };
    const raw = bodyUnknown as Incoming;

    // --- 互換シム：action / text を正規化 -------------------------
    // action: { action:"to_ja" } が正だが、{ mode:"to_ja" } / { target:"ja" } も受ける
    let actionNorm: TranslateRequest["action"] | undefined =
      raw.action as TranslateRequest["action"] | undefined;

    if (!actionNorm) {
      if (typeof raw.mode === "string") {
        actionNorm = raw.mode as TranslateRequest["action"];
      } else if (
        typeof raw.target === "string" &&
        raw.target.toLowerCase().startsWith("ja")
      ) {
        actionNorm = "to_ja";
      }
    }

    // text: {text} が正だが、{message}/{content} も許容
    const textNorm =
      typeof raw.text === "string" && raw.text.length > 0
        ? raw.text
        : typeof raw.message === "string" && raw.message.length > 0
        ? raw.message
        : typeof raw.content === "string" && raw.content.length > 0
        ? raw.content
        : "";

    // 以降は payload をソースオブジェクトに統一
    const payload: TranslateRequest = {
      ...(raw as TranslateRequest),
      action: actionNorm as TranslateRequest["action"],
      text: textNorm,
    };
    // -------------------------------------------------------------

    // 必須チェック
    if (!payload?.text || !payload?.action) {
      return Response.json(
        { ok: false, error: "Missing required fields: 'text' and 'action'." } as ErrResponse,
        { status: 400 }
      );
    }

    const action = payload.action;

// 入力本文のざっくり言語推定
let sourceLang: string = (await detectLangReliable(payload.text)).code;

// detectLangReliable が und（不明）ならモデルでフォールバック
if (sourceLang === "und") {
  sourceLang = await detectLanguageViaModel(payload.text);
}

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
    // 3) まだ未決定なら自動判定（高精度版）
if (!targetLang) {
  const { code } = await detectLangReliable(guestRaw);
  targetLang = code; // 例: "fr" / "pl" / "sq"
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

  // デーヴァナーガリー（例: ヒンディー）
  if (/[\u0900-\u097F]/u.test(s)) return "hi";

  // タミル語 (Tamil) U+0B80–0BFF
  if (/[\u0B80-\u0BFF]/u.test(s)) return "ta";

  // テルグ語 (Telugu) U+0C00–0C7F
  if (/[\u0C00-\u0C7F]/u.test(s)) return "te";

  // ベンガル語 (Bengali) U+0980–09FF
  if (/[\u0980-\u09FF]/u.test(s)) return "bn";

  // カンナダ語 (Kannada) U+0C80–0CFF
  if (/[\u0C80-\u0CFF]/u.test(s)) return "kn";

  // マラヤーラム語 (Malayalam) U+0D00–0D7F
  if (/[\u0D00-\u0D7F]/u.test(s)) return "ml";

  // パンジャーブ語（グルムキー）(Punjabi/Gurmukhi) U+0A00–0A7F
  if (/[\u0A00-\u0A7F]/u.test(s)) return "pa";


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
  const esCount =
    (s.match(/[¿¡ñ]/g)?.length ?? 0) +
    (s.match(/\b(el|la|los|las|que|para|con|por)\b/gi)?.length ?? 0);
  const ptCount =
    (s.match(/[ãõç]/gi)?.length ?? 0) +
    (s.match(/\b(não|está|que|para|com|você)\b/gi)?.length ?? 0);

  if (esCount >= 2 && esCount > ptCount) return "es";
  if (ptCount >= 2 && ptCount > esCount) return "pt";

  if (/\b(le|la|de|des|est|avec)\b/i.test(s)) return "fr";
  if (/\b(der|die|das|und|nicht|ist)\b/i.test(s)) return "de";

  // 英語は「全文がASCIIのときのみ」（Wi-Fi混入で英語落ちするのを回避）
  if (!/[^\x00-\x7F]/.test(s) && /[A-Za-z]/.test(s)) return "en";
  // 英語は「全文がASCIIのときのみ」（Wi-Fi混入で英語落ちするのを回避）
  if (!/[^\x00-\x7F]/.test(s) && /[A-Za-z]/.test(s)) return "en";

  // 追加: フランス語/スペイン語/ポルトガル語の簡易判定
  if (/\b(le|la|de|des|est|avec|nous|vous|merci|soir[ée]e|ville)\b/i.test(s)) {
    return "fr";
  }
  if (/\b(el|la|de|y|usted|nosotros|intento|puerta|c[oó]digo)\b/i.test(s)) {
    return "es";
  }
  if (/\b(obrigad[oa]|voc(?:ê|es)|não|porta|ontem)\b/i.test(s)) {
    return "pt";
  }
  return "und";
}

const ENGLISH_MARKERS = /\b(the|and|you|your|we|i|to|for|is|are|with|will|can|please|thank|thanks|hello|hi|check|stay|arrival|departure|room|house|booking|reservation|guest|apartment|host|contact|message|tomorrow|today|morning|evening)\b/gi;

function looksLikeMostlyEnglish(text: string): boolean {
  const input = text ?? "";
  if (!input.trim()) return false;

  const asciiLetters = (input.match(/[A-Za-z]/g) ?? []).length;
  if (asciiLetters < 12) return false; // 極端に短い文はスキップ

  const disallowed = input.match(/[^\sA-Za-z0-9.,!?"'`’“”–—():;\/\-]/g)?.length ?? 0;
  if (disallowed > Math.max(2, Math.floor(asciiLetters * 0.1))) return false;

  const markerHits = input.match(ENGLISH_MARKERS)?.length ?? 0;
  return markerHits >= 2;
}
/** 許容コードと表示名（必要に応じて拡張） */
const ALLOWED_LANGS = new Set([
  'ja','en','fr','de','es','pt','it','ro','pl','sq',
  'zh','zh-Hant','ko','ru','uk','tr','nl','sv','no','da','fi',
  'ar','fa','ur','he',
  // 南アジア系（ここを追加）
  'hi','bn','ta','te','kn','ml','pa',
  'th','vi','id','my','lo'
]);

/** 変種を正規化 */
function normalizeLangCode(raw: string): string {
  const c = (raw || '').toLowerCase();
  if (c.startsWith('zh-hant') || c === 'zh-tw') return 'zh-Hant';
  if (c.startsWith('zh') || c === 'zh-hans' || c === 'zh-cn') return 'zh';
  if (c.startsWith('es')) return 'es';
  if (c.startsWith('pt')) return 'pt';
  return c;
}

/** ロマンス語（fr/es/pt）の重み付き簡易判定 */
type Guess = { code: string; scores: Record<string, number> };
function guessRomanceWeighted(s: string): Guess {
  const t = (s || '').toLowerCase();
  const frR = /(avec|nous|vous|bonjour|bonsoir|merci|soir[ée]e|où|quelle|heure|toujours|ville)/g;
  const esR = /(gracias|usted(?:es)?|nosotros|intento|puerta|c[oó]digo|anoche|alrededor)/g;
  const ptR = /(obrigad[oa]|voc(?:ê|es)|n[aã]o|porta|c[oó]digo|ontem|volta)/g;

  let fr = (t.match(frR)?.length ?? 0);
  let es = (t.match(esR)?.length ?? 0);
  let pt = (t.match(ptR)?.length ?? 0);

  if (/[çàâêîôûéèùëïüœ]/.test(t) && !/ñ/.test(t)) fr += 1;
  if (/ñ/.test(t)) es += 1;
  if (/[ãõê]/.test(t)) pt += 1;

  const scores = { fr, es, pt };
  const top = Object.entries(scores).sort((a,b)=>b[1]-a[1])[0];
  const second = Object.entries(scores).sort((a,b)=>b[1]-a[1])[1]?.[1] ?? 0;

  if (top && top[1] >= 2 && top[1] >= second + 1) return { code: top[0], scores };
  return { code: 'und', scores };
}

/** 高精度検出器：ヒューリスティクス→ロマンス加点→LLM確定 */
async function detectLangReliable(text: string): Promise<{ code: string }> {
  // 0) 文字数が極端に短い/漢字だけは und
  if (!text || isShortKanjiOnly(text)) return { code: 'und' };

  // 0.5) 英語っぽさの優先判定（Smart Quotes 等の混入で und になるケースを救済）
  if (looksLikeMostlyEnglish(text)) {
    return { code: 'en' };
  }

  // 1) 既存のざっくり推定
  let code: string = guessLangFromText(text);

  // 2) ロマンス語の曖昧さを追加チェック
  const romance = guessRomanceWeighted(text);
  const romanceSignal = romance.scores.fr + romance.scores.es + romance.scores.pt > 0;

  // 3) 曖昧 or und or 非対応コードなら LLM で確定
  if (code === 'und' || romanceSignal || !ALLOWED_LANGS.has(code)) {
    const det = (await detectLanguageViaModel(text)) as DetectResult;
    const raw =
      typeof det === 'string' ? det :
      Array.isArray(det) ? (det[0]?.code ?? det[0]?.lang ?? det[0]?.language ?? 'en') :
      (det.code ?? det.lang ?? det.language ?? 'en');

    code = normalizeLangCode(raw);
  }

  // 4) 最終正規化＆未知コードは en にフォールバック（UIを壊さないため）
  if (!ALLOWED_LANGS.has(code)) code = 'en';
  if (code !== 'en' && looksLikeMostlyEnglish(text)) code = 'en';
  return { code };
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
