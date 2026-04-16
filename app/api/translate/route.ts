// /app/api/translate/route.ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 環境変数で差し替え可能。未指定なら軽量の 4o-mini
const MODEL = process.env.OPENAI_TRANSLATE_MODEL ?? "gpt-4o-mini-2024-07-18";

type Tone = "neutral" | "formal" | "casual";
type Action = "to_ja" | "to_guest";

interface TranslateRequest {
  action: Action;        // "to_ja" | "to_guest"
  text: string;          // 翻訳したい本文
  guestSource?: string;  // ゲスト原文（to_guest のとき必須：ここからゲスト言語を推定）
  tone?: Tone;           // to_guest のときのみ適用
  guestLang?: string;    // UI で選んだ言語コード("en"など/"auto"可)
  overrideLang?: string; // ヒント用("auto"可)
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
    const body = (await req.json()) as TranslateRequest;

    // 入力チェック
    if (!body?.text || !body?.action) {
      return Response.json(
        { ok: false, error: "Missing required fields: 'text' and 'action'." } as ErrResponse,
        { status: 400 }
      );
    }

    const action = body.action;
    const text = (body?.text ?? "").trim();

    // 入力本文の言語推定（規則 → 不明なら LLM）
    const sourceLang = await detectLanguage(text);

    // ① ゲスト原文 → 日本語
    if (action === "to_ja") {
      const translated = await translate({
        text: body.text,
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
    const guestRaw = (body.guestSource ?? "").trim();
    if (!guestRaw) {
      return Response.json(
        { ok: false, error: "Missing 'guestSource' for action 'to_guest'." } as ErrResponse,
        { status: 400 }
      );
    }

    // UI 選択 > ヒント > 自動判定 の優先順位で targetLang を決定
    let targetLang: string | undefined;

    // 1) 手動選択を最優先
    if (body.guestLang && body.guestLang !== "auto") {
      targetLang = body.guestLang;
    }

    // 2) 次点で overrideLang
    if (!targetLang && body.overrideLang && body.overrideLang !== "auto") {
      targetLang = body.overrideLang;
    }

    // 3) まだ未決定なら自動判定（規則 → LLM → 最終的に不明なら en）
    if (!targetLang) {
      const detected = await detectLanguage(guestRaw);
      targetLang = detected !== "und" ? detected : "en";
    }

    const tone: Tone = body.tone ?? "neutral";

    const translated = await translate({
      text: body.text,   // 日本語の返信
      targetLang,        // 最終決定した言語
      tone,
    });

    return Response.json(
      {
        ok: true,
        sourceLang,     // デバッグ用ざっくり推定
        targetLang,     // 実際に使ったターゲット
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

/**
 * 規則＋LLM による言語判定。
 * - 判別確度の高いスクリプトは規則で即断（低レイテンシ）
 * - ラテン系で曖昧な場合は LLM にフォールバック（ほぼ全世界の言語に対応）
 * 返値は BCP-47 / ISO 639-1 コード。判定不能時は "und"。
 */
async function detectLanguage(text: string): Promise<string> {
  const rule = guessLangFromText(text);
  if (rule !== "und") return rule;
  const viaModel = await detectLanguageViaModel(text);
  return viaModel || "und";
}

/**
 * 文字種・特徴語から言語を推定（失敗時 'und'）。
 * - 非ラテン系は Unicode ブロックで決定的に判定
 * - ラテン系はトルコ語/ポーランド語/ハンガリー語など「他言語と被らない独自文字」を持つ言語のみ即断
 * - それ以外は単語マーカー、それでも不明なら 'und' を返し LLM に委譲
 */
function guessLangFromText(s: string): string {
  if (!s) return "und";
  if (isShortKanjiOnly(s)) return "und";

  // ===== 非ラテン系スクリプト（Unicode ブロックで決定的）=====
  // 日本語（ひらがな/カタカナがあれば確実に日本語）
  if (/[ぁ-ゖァ-ヺー]/u.test(s)) return "ja";
  // 韓国語（ハングル音節）
  if (/[가-힣]/u.test(s)) return "ko";
  // 中国語（繁体/簡体の粗判）
  if (/[體國臺與優來麼說話發點這們嗎員門車長灣歡愛學習廣龍雞貓邊醫]/u.test(s)) return "zh-Hant";
  if (/[为这们吗级购广龙爱边医门]/u.test(s)) return "zh-Hans";

  // ヘブライ語
  if (/[\u0590-\u05FF]/u.test(s)) return "he";
  // ギリシャ語
  if (/[\u0370-\u03FF\u1F00-\u1FFF]/u.test(s)) return "el";
  // アルメニア語
  if (/[\u0530-\u058F]/u.test(s)) return "hy";
  // ジョージア語
  if (/[\u10A0-\u10FF\u2D00-\u2D2F]/u.test(s)) return "ka";
  // エチオピア文字（アムハラ語・ティグリニャ語など）
  if (/[\u1200-\u137F]/u.test(s)) return "am";

  // 東南アジア
  if (/[\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F]/u.test(s)) return "my"; // ミャンマー
  if (/[\u0E80-\u0EFF]/u.test(s)) return "lo";                            // ラオス
  if (/[\u1780-\u17FF]/u.test(s)) return "km";                            // クメール
  if (/[\u0E00-\u0E7F]/u.test(s)) return "th";                            // タイ

  // 南アジア
  if (/[\u0D80-\u0DFF]/u.test(s)) return "si";               // シンハラ
  if (/[\u0F00-\u0FFF]/u.test(s)) return "bo";               // チベット
  if (/[\u1800-\u18AF]/u.test(s)) return "mn";               // モンゴル（伝統文字）
  if (/[\u0900-\u097F]/u.test(s)) return "hi";               // デーヴァナーガリー
  if (/[\u0980-\u09FF]/u.test(s)) return "bn";               // ベンガル
  if (/[\u0A00-\u0A7F]/u.test(s)) return "pa";               // グルムキー
  if (/[\u0A80-\u0AFF]/u.test(s)) return "gu";               // グジャラート
  if (/[\u0B00-\u0B7F]/u.test(s)) return "or";               // オリヤー
  if (/[\u0B80-\u0BFF]/u.test(s)) return "ta";               // タミル
  if (/[\u0C00-\u0C7F]/u.test(s)) return "te";               // テルグ
  if (/[\u0C80-\u0CFF]/u.test(s)) return "kn";               // カンナダ
  if (/[\u0D00-\u0D7F]/u.test(s)) return "ml";               // マラヤーラム

  // アラビア文字系
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u.test(s)) {
    if (/[ځڅښږڼټډړګ]/u.test(s)) return "ps"; // パシュトゥー固有
    if (/[ٹڈڑےٰںھہ]/u.test(s)) return "ur"; // ウルドゥー固有
    if (/[پچژگ]/u.test(s)) return "fa";       // ペルシア固有
    return "ar";
  }

  // キリル文字系
  if (/\p{Script=Cyrillic}/u.test(s)) {
    if (/[їєіґЇЄІҐ]/u.test(s)) return "uk";
    if (/[ўЎ]/u.test(s)) return "be";
    if (/[ЉљЊњЏџЋћЂђ]/u.test(s)) return "sr"; // セルビア
    if (/[ЅѕЌќЃѓ]/u.test(s)) return "mk";     // マケドニア
    if (/\b(здравей|благодаря|моля|стая|резервация)\b/iu.test(s)) return "bg";
    return "ru";
  }

  // ===== ラテン系（独自文字や頻出語）=====
  // ▼ トルコ語: 真にトルコ語固有の ğ ş ı İ のみで判定。
  //   ö / ü / ç は他言語と共有されるため判定材料に使わない（旧実装ではスウェーデン語が誤ってトルコ語にされていた）
  if (/[ğĞşŞıİ]/u.test(s)) return "tr";
  // ルーマニア語（ș ț ă â î）
  if (/[ăĂâÂîÎșȘțȚşŞţŢ]/u.test(s)) return "ro";
  // ポーランド語
  if (/[ąĄęĘćĆłŁńŃśŚźŹżŻ]/u.test(s)) return "pl";
  // チェコ/スロバキア語（発音符号が決定的）
  if (/[čČďĎěĚňŇřŘšŠťŤůŮžŽ]/u.test(s)) {
    if (/[ĺĽľĹŕŔ]/u.test(s)) return "sk"; // スロバキア固有
    return "cs";
  }
  // ハンガリー語（ő ű が決定的）
  if (/[őŐűŰ]/u.test(s)) return "hu";
  // ベトナム語
  if (/[ăâêôơưđĂÂÊÔƠƯĐ]/u.test(s)) return "vi";
  // アイスランド語（þ ð が決定的）
  if (/[þÞðÐ]/u.test(s)) return "is";

  // ===== 北欧系 =====
  // ノルウェー/デンマーク/フェロー: æ ø
  if (/[æøÆØ]/u.test(s)) {
    if (/\b(og|ikke|jeg|det|er|har|på|den|som|være|tak|hej|hvordan|skal)\b/i.test(s)) return "da";
    return "no";
  }
  // スウェーデン/フィンランド: å
  if (/[åÅ]/u.test(s)) {
    if (/\b(kiitos|hyvää|hei|terve|päivää|huone|asunto|varaus|olen|olet|minä|sinä)\b/i.test(s)) return "fi";
    return "sv";
  }

  // 単語マーカーでの推定（å/æ/ø 無しのケース）
  // フィンランド語
  if (/\b(kiitos|hyvää|hei|terve|päivää|huone|asunto|varaus|kiitoksia|anteeksi|huomenta)\b/i.test(s)) return "fi";
  // スウェーデン語
  if (/\b(hej|tack|och|inte|jag|för|varsågod|rum|bokning|hälsningar|tusen|igen)\b/i.test(s)) return "sv";
  // ノルウェー語
  if (/\b(hei|takk|jeg|ikke|være|værelse|bestilling|morgen)\b/i.test(s)) return "no";
  // デンマーク語
  if (/\b(hej|tak|jeg|ikke|være|værelse|reservation|morgen|godt)\b/i.test(s)) return "da";

  // ===== 西欧 =====
  // イタリア語
  if (/\b(ciao|grazie|prego|per favore|più|sono|siete|degli|delle|alla|allo|nella|prenotazione|camera|arrivo|partenza|buongiorno|buonasera|stanza)\b/i.test(s)) return "it";
  // スペイン語
  if (/[¿¡]/.test(s) || /\b(hola|gracias|por favor|reserva|habitación|también|dónde|cómo|cuándo|porque|muchas|buenos días|buenas noches)\b/i.test(s)) return "es";
  // フランス語
  if (/\b(bonjour|bonsoir|merci|réservation|chambre|appartement|comment|aujourd['’]hui|très|votre|nous|vous)\b/i.test(s) || /\bs['’]il vous plaît\b/i.test(s)) return "fr";
  // ドイツ語（ß はドイツ語/アルザス方言固有）
  if (/ß/u.test(s) || /\b(guten|danke|bitte|zimmer|wohnung|buchung|ankunft|abreise|ihnen|ihre|haben|sind|nicht)\b/i.test(s)) return "de";
  // ポルトガル語
  if (/\b(olá|obrigado|obrigada|você|voce|quarto|reserva|não|está|bom dia|boa noite|quando|onde)\b/i.test(s)) return "pt";
  // オランダ語
  if (/\b(hallo|bedankt|dank u|alstublieft|kamer|reservering|welkom|goedemorgen|goedenavond|vriendelijke|groeten)\b/i.test(s)) return "nl";
  // カタルーニャ語
  if (/\b(hola|gràcies|si us plau|habitació|reserva|benvingut|bon dia)\b/i.test(s)) return "ca";

  // ===== 東南アジア（ラテン表記）=====
  // インドネシア
  if (/\b(yang|dan|tidak|saya|anda|kamar|reservasi|terima kasih|selamat|pagi|malam)\b/i.test(s)) return "id";
  // マレー
  if (/\b(awak|bilik|tempahan|terima kasih|selamat|pagi|malam|selamat datang)\b/i.test(s)) return "ms";
  // タガログ（フィリピノ）
  if (/\b(salamat|kamusta|kumusta|ako|ikaw|kayo|naming|kwarto|reserba|magandang)\b/i.test(s)) return "tl";

  // ===== その他 =====
  // スワヒリ
  if (/\b(jambo|asante|habari|chumba|karibu)\b/i.test(s)) return "sw";

  // 英語は「全文が ASCII ＋ ラテン文字」のときのみ
  if (!/[^\x00-\x7F]/.test(s) && /[A-Za-z]/.test(s)) return "en";

  return "und";
}

/** LLM で言語コードを推定（JSON 返答を要求）。失敗時は "und"。 */
async function detectLanguageViaModel(text: string): Promise<string> {
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a language identification engine. Identify the primary natural language of the user's text. " +
          "Reply ONLY with JSON: {\"lang\":\"<code>\"}. " +
          "Use BCP-47 / ISO 639-1 codes. Examples of supported codes include but are not limited to: " +
          "en, es, pt, pt-BR, fr, de, it, nl, ca, sv, no, da, fi, is, pl, cs, sk, hu, ro, bg, hr, sr, sl, el, " +
          "ru, uk, be, lt, lv, et, tr, ar, he, fa, ur, ps, hi, bn, ta, te, kn, ml, pa, gu, mr, ne, si, " +
          "th, vi, id, ms, tl, my, lo, km, sw, am, az, uz, kk, ky, hy, ka, mn, af, zu, sq, eu, gl, cy, ga, mt, eo. " +
          "For Chinese, use 'zh-Hans' (Simplified) or 'zh-Hant' (Traditional). " +
          "If truly undetectable, reply {\"lang\":\"und\"}.",
      },
      { role: "user", content: text },
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
          "Translate the user's message into the requested target language (given as a BCP-47 / ISO 639-1 code). " +
          "Preserve meaning, keep URLs/numbers/dates as-is, avoid adding information. " +
          "If the target language code is unfamiliar, still translate as faithfully as possible into that language. " +
          "Reply ONLY with JSON: {\"translation\":\"...\"}.",
      },
      {
        role: "user",
        content:
          `Target language (BCP-47 code): ${targetLang}\n` +
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
