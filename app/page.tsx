"use client";

import { useState } from "react";

type Tone = "neutral" | "formal" | "casual";

const LOCALES = [
  { code: "en-US-west", label: "English — US West Coast" },
  { code: "en-US-east", label: "English — US East Coast" },
  { code: "en-AU", label: "English — Australia" },
  { code: "en-NZ", label: "English — New Zealand" },
  { code: "de-DE", label: "Deutsch (DE)" },
  { code: "de-CH", label: "Schweizer Hochdeutsch (CH)" },
  { code: "fr-FR", label: "Français" },
  { code: "it-IT", label: "Italiano" },
  { code: "es-ES", label: "Español" },
  { code: "zh-Hant", label: "繁體中文" },
  { code: "zh-Hans", label: "简体中文" },
  { code: "ko-KR", label: "한국어" },
];

export default function Home() {
  const [guestMsg, setGuestMsg] = useState("");
  const [guestMsgJa, setGuestMsgJa] = useState("");
  const [hostReplyJa, setHostReplyJa] = useState("");
  const [tone, setTone] = useState<Tone>("neutral");
  const [target, setTarget] = useState(LOCALES[0].code);
  const [translatedOut, setTranslatedOut] = useState("");
  const [busy, setBusy] = useState(false);

  async function toJapanese() {
    if (!guestMsg.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "to_ja",
          text: guestMsg,
        }),
      });
      const data = await res.json();
      setGuestMsgJa(data.text || "");
    } finally {
      setBusy(false);
    }
  }

  async function fromJapanese() {
    if (!hostReplyJa.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "from_ja",
          text: hostReplyJa,
          tone,
          targetLocale: target,
        }),
      });
      const data = await res.json();
      setTranslatedOut(data.text || "");
    } finally {
      setBusy(false);
    }
  }

  function copyOut() {
    navigator.clipboard.writeText(translatedOut);
  }

  return (
    <main className="min-h-screen p-6 max-w-4xl mx-auto space-y-8">
      <h1 className="text-2xl font-semibold">Airbnb ホスト向け 翻訳アシスタント</h1>

      {/* ① ゲスト原文 → 日本語 */}
      <section className="space-y-3">
        <h2 className="font-medium">① ゲストの質問（原文）</h2>
        <textarea
          className="w-full min-h-[120px] rounded-2xl border p-4"
          placeholder="例: Tomorrow is it possible for me to request laundry service?"
          value={guestMsg}
          onChange={(e) => setGuestMsg(e.target.value)}
        />
        <button
          onClick={toJapanese}
          disabled={busy}
          className="px-4 py-2 rounded-xl border shadow"
        >
          日本語に翻訳
        </button>

        <textarea
          className="w-full min-h-[100px] rounded-2xl border p-4"
          placeholder="（ここに日本語訳）"
          value={guestMsgJa}
          onChange={(e) => setGuestMsgJa(e.target.value)}
        />
      </section>

      {/* ② ホスト日本語入力 → 指定言語 */}
      <section className="space-y-3">
        <h2 className="font-medium">② あなたの返答（日本語で入力）</h2>

        {/* トーン */}
        <div className="flex items-center gap-6">
          <span>トーン：</span>
          {[
            { v: "neutral", label: "ニュートラル" },
            { v: "formal", label: "フォーマル" },
            { v: "casual", label: "カジュアル" },
          ].map((t) => (
            <label key={t.v} className="flex items-center gap-2">
              <input
                type="radio"
                name="tone"
                checked={tone === (t.v as Tone)}
                onChange={() => setTone(t.v as Tone)}
              />
              {t.label}
            </label>
          ))}

          <div className="ml-auto flex items-center gap-2">
            <span>ゲストの言語：</span>
            <select
              className="border rounded-xl px-3 py-2"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {LOCALES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <textarea
          className="w-full min-h-[120px] rounded-2xl border p-4"
          placeholder="例: もちろんです。お出かけ前に、茶色のランドリーバスケットに…"
          value={hostReplyJa}
          onChange={(e) => setHostReplyJa(e.target.value)}
        />

        <button
          type="button" // ← これを追加
          onClick={toJapanese}
          disabled={busy}
          className="px-4 py-2 rounded-xl border shadow">
          日本語に翻訳
        </button>


        <textarea
          className="w-full min-h-[120px] rounded-2xl border p-4"
          placeholder="（ここにゲスト言語での返答）"
          value={translatedOut}
          readOnly
        />

        <div>
          <button onClick={copyOut} className="px-4 py-2 rounded-xl border shadow">
            Copy
          </button>
        </div>
      </section>
    </main>
  );
}
