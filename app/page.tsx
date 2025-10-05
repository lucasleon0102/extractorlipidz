"use client";
import { useState } from "react";

export default function Page() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // troque este ID pelo do vídeo que você quer testar
  const youtubeId = "K9fs9HpBUpQ";

  async function gerar() {
    try {
      setLoading(true);
      setData(null);

      const res = await fetch("/api/story-from-youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtubeId }),
      });

      const json = await res.json();
      setData(json);
    } catch (e: any) {
      setData({ error: e.message || "erro" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        padding: 20,
        fontFamily: "Inter, system-ui, Arial",
        background: "#0b1118",
        color: "#e9f3ff",
        minHeight: "100vh",
      }}
    >
      <h1>🎬 Criar história semelhante (Lipidz)</h1>

      <button
        onClick={gerar}
        disabled={loading}
        style={{
          padding: "10px 16px",
          borderRadius: "10px",
          border: "1px solid #1b2836",
          background: "#0e1a29",
          color: "#e9f3ff",
          fontWeight: 700,
          cursor: "pointer",
          marginBottom: 20,
        }}
      >
        {loading ? "Gerando..." : "📖 Criar história semelhante"}
      </button>

      {data?.error && <p style={{ color: "red" }}>Erro: {data.error}</p>}

      {data?.text && (
        <>
          <h3>🗣️ Transcrição (legenda do vídeo)</h3>
          <p style={{ whiteSpace: "pre-wrap" }}>{data.text}</p>
        </>
      )}

      {data?.beats && (
        <>
          <h3>🧩 Story Beats</h3>
          <ul>
            {data.beats.map((b: string, i: number) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </>
      )}

      {data?.script && (
        <>
          <h3>📜 Roteiro Lipidz (30 segundos)</h3>
          <pre style={{ whiteSpace: "pre-wrap" }}>{data.script}</pre>
        </>
      )}
    </main>
  );
}
