// /app/page.tsx
"use client";

import { useState, useMemo } from "react";
import type { ChangeEvent } from "react";

type Tone = "neutral" | "formal" | "casual";

// 右→左言語（表示方向に使う）
const RTL = new Set(["he", "ar", "fa", "ur", "ps"]);

// 手動指定ドロップダウン
const LANG_OPTIONS: { code: string; label: string }[] = [
  { code: "auto", label: "自動判定" },
  { code: "zh-Hans", label: "中国語（簡体）" },
  { code: "zh-Hant", label: "中国語（繁体）" },
  { code: "en", label: "英語" },
  { code: "he", label: "ヘブライ語" },
  { code: "ar", label: "アラビア語" },
  { code: "fa", label: "ペルシア語" },
  { code: "ur", label: "ウルドゥー語" },
  { code: "ps", label: "パシュトゥー語" },
  { code: "ru", label: "ロシア語" },
  { code: "uk", label: "ウクライナ語" },
  { code: "tr", label: "トルコ語" },
  { code: "it", label: "イタリア語" },
  { code: "ro", label: "ルーマニア語" },
  { code: "ta", label: "タミル語" },
  { code: "te", label: "テルグ語" },
  { code: "bn", label: "ベンガル語" },
  { code: "kn", label: "カンナダ語" },
  { code: "ml", label: "マラヤーラム語" },
  { code: "pa", label: "パンジャーブ語" },
  { code: "th", label: "タイ語" },
  { code: "vi", label: "ベトナム語" },
  { code: "id", label: "インドネシア語" },
  { code: "my", label: "ミャンマー語" },
  { code: "lo", label: "ラオス語" },
];

// API レスポンス型
type ApiOk = {
  ok: true;
  translation: string;
  sourceLang?: string; // サーバが返す場合に拾う（to_ja）
  targetLang?: string; // サーバが返す場合に拾う（to_guest）
};
type ApiErr = { ok: false; error: string };
type ApiResp = ApiOk | ApiErr;

export default function Page() {
  // 上段：ゲスト原文 → 日本語
  const [guestOriginal, setGuestOriginal] = useState<string>("");
  const [guestJa, setGuestJa] = useState<string>("");

  // 下段：自分の返答（日本語入力） → ゲスト言語
  const [tone, setTone] = useState<Tone>("neutral");
  const [myReplyJa, setMyReplyJa] = useState<string>("");
  const [myReplyGuest, setMyReplyGuest] = useState<string>("");

  // 言語：手動選択（UI用）と自動判定（表示用）を完全分離
  const [selectedGuestLang, setSelectedGuestLang] = useState<string>("auto"); // UIで選んだ値
  const [detectedGuestLang, setDetectedGuestLang] = useState<string>("und");   // 自動判定の結果/最終ターゲット表示

  // ローディング
  const [loadingTop, setLoadingTop] = useState<boolean>(false);
  const [loadingBottom, setLoadingBottom] = useState<boolean>(false);

  const canTranslateToGuest = useMemo(
    () => myReplyJa.trim().length > 0 && guestOriginal.trim().length > 0,
    [myReplyJa, guestOriginal]
  );

  // ① 原文 → 日本語
  async function translateToJa() {
    setLoadingTop(true);
    setGuestJa("");
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "to_ja",
          text: guestOriginal,
          // ユーザーが手動で言語指定していればヒントとして渡す
          overrideLang: selectedGuestLang !== "auto" ? selectedGuestLang : undefined,
        }),
      });
      const data: ApiResp = await res.json();
      if (data.ok) {
        setGuestJa(data.translation);
        // サーバが推定した言語を検出結果として表示側に保持
        if (data.sourceLang) setDetectedGuestLang(data.sourceLang);
      } else {
        alert(`翻訳エラー: ${data.error}`);
      }
    } catch {
      alert("翻訳リクエストに失敗しました。");
    } finally {
      setLoadingTop(false);
    }
  }

  // ② 日本語の返答 → ゲスト言語
  async function translateToGuest() {
    if (!canTranslateToGuest) return;
    setLoadingBottom(true);
    setMyReplyGuest("");
    try {
      const payload = {
        action: "to_guest",
        text: myReplyJa,
        guestSource: guestOriginal,                 // 検出の手がかり
        tone,
        // ★ここが肝：送るのは“手動選択値”のみ。検出値は絶対に上書きしない
        guestLang: selectedGuestLang !== "auto" ? selectedGuestLang : undefined,
      };
      // console.log("to_guest payload:", payload);

      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: ApiResp = await res.json();
      if (data.ok) {
        setMyReplyGuest(data.translation);
        // サーバが実際に使ったターゲット言語を表示用に反映
        if (data.targetLang) setDetectedGuestLang(data.targetLang);
      } else {
        alert(`翻訳エラー: ${data.error}`);
      }
    } catch {
      alert("翻訳リクエストに失敗しました。");
    } finally {
      setLoadingBottom(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 失敗しても沈黙
    }
  }

  // 返信欄の表示方向は、手動選択があればそれを、なければ検出結果で決める
  const dirLang = selectedGuestLang !== "auto" ? selectedGuestLang : detectedGuestLang;

  return (
    <main className="mx-auto max-w-4xl p-6 space-y-8">
      {/* ① ゲストの質問（原文） */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">① ゲストの質問（原文）</h2>
        <p className="text-sm text-gray-500">
          主要100+言語に自動対応。判別が難しい文はワンタップで言語指定。
        </p>

        {/* 原文入力（貼り付け用） */}
        <textarea
          className="w-full min-h-[120px] rounded border p-3"
          placeholder="ゲストから届いた原文をそのまま貼り付け"
          value={guestOriginal}
          onChange={(e) => setGuestOriginal(e.target.value)}
          dir="auto"
        />

        {/* 原文→日本語 */}
        <div className="flex items-center gap-2">
          <button
            onClick={translateToJa}
            disabled={loadingTop || guestOriginal.trim().length === 0}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {loadingTop ? "翻訳中…" : "日本語に翻訳"}
          </button>
          <button
            onClick={() => copy(guestJa)}
            disabled={!guestJa}
            className="rounded border px-3 py-2 disabled:opacity-50"
          >
            Copy
          </button>
        </div>

        {/* 日本語訳の表示 */}
        <textarea
          className="w-full min-h-[120px] rounded border p-3"
          placeholder="（ここに日本語訳が表示）"
          value={guestJa}
          onChange={(e) => setGuestJa(e.target.value)}
        />

        {/* 言語の手動指定＆自動判定表示 */}
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-600">ゲストの言語:</label>
          <select
            className="rounded border px-2 py-1"
            value={selectedGuestLang}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              setSelectedGuestLang(e.target.value)
            }
          >
            {LANG_OPTIONS.map((opt) => (
              <option key={opt.code} value={opt.code}>
                {opt.label}
              </option>
            ))}
          </select>

          <span className="text-xs text-gray-500">
            判定:{" "}
            <span className="rounded bg-gray-100 px-2 py-0.5">{detectedGuestLang}</span>
          </span>
        </div>
      </section>

      <hr className="my-6" />

      {/* ② あなたの返答（日本語で入力） */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">② あなたの返答（日本語で入力）</h2>

        {/* トーン選択 */}
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2" htmlFor="tone-neutral">
            <input
              id="tone-neutral"
              type="radio"
              name="tone"
              checked={tone === "neutral"}
              onChange={() => setTone("neutral")}
            />
            ニュートラル
          </label>
          <label className="flex items-center gap-2" htmlFor="tone-formal">
            <input
              id="tone-formal"
              type="radio"
              name="tone"
              checked={tone === "formal"}
              onChange={() => setTone("formal")}
            />
            フォーマル
          </label>
          <label className="flex items-center gap-2" htmlFor="tone-casual">
            <input
              id="tone-casual"
              type="radio"
              name="tone"
              checked={tone === "casual"}
              onChange={() => setTone("casual")}
            />
            カジュアル
          </label>
        </div>

        {/* 日本語で返答を書く */}
        <textarea
          className="w-full min-h-[120px] rounded border p-3"
          placeholder="ここに日本語で返答文を入力"
          value={myReplyJa}
          onChange={(e) => setMyReplyJa(e.target.value)}
        />

        {/* 日本語→ゲスト言語 */}
        <div className="flex items-center gap-2">
          <button
            onClick={translateToGuest}
            disabled={loadingBottom || !canTranslateToGuest}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {loadingBottom ? "翻訳中…" : "ゲストの言語に翻訳"}
          </button>
          <button
            onClick={() => copy(myReplyGuest)}
            disabled={!myReplyGuest}
            className="rounded border px-3 py-2 disabled:opacity-50"
          >
            Copy
          </button>
        </div>

        {/* ゲスト言語での返答（RTL対応） */}
        <textarea
          className="w-full min-h-[140px] rounded border p-3"
          placeholder="（ここにゲスト言語での返答が表示）"
          value={myReplyGuest}
          onChange={(e) => setMyReplyGuest(e.target.value)}
          dir={RTL.has(dirLang) ? "rtl" : "ltr"}
        />
      </section>
    </main>
  );
}
