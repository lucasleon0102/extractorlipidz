import { NextResponse } from "next/server";
import ytdl from "@distube/ytdl-core";

const AAI_KEY = process.env.ASSEMBLYAI_API_KEY || "COLE_SUA_KEY_AQUI";

export async function POST(req: Request) {
  try {
    const { youtubeId } = await req.json();
    if (!youtubeId) {
      return NextResponse.json({ error: "youtubeId ausente" }, { status: 400 });
    }

    // ===== 1️⃣ Baixa áudio do YouTube =====
    const url = `https://www.youtube.com/watch?v=${youtubeId}`;
    const stream = ytdl(url, { quality: "highestaudio" });

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);

    // ===== 2️⃣ Upload para AssemblyAI =====
    const res = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: {
        authorization: AAI_KEY,
        "content-type": "application/octet-stream",
      },
      // ✅ CORRIGIDO: Body agora é Blob (funciona no Node moderno e no Vercel)
      body: new Blob([buf]),
    });

    const data = await res.json();
    if (!res.ok)
      throw new Error(`Upload falhou: ${JSON.stringify(data)}`);

    const uploadUrl = data.upload_url;

    // ===== 3️⃣ Cria transcrição =====
    const trRes = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: {
        authorization: AAI_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        audio_url: uploadUrl,
        punctuate: true,
        format_text: true,
        language_code: "pt",
      }),
    });

    const trData = await trRes.json();
    if (!trRes.ok)
      throw new Error(`Transcrição falhou: ${JSON.stringify(trData)}`);

    const transcriptId = trData.id;

    // ===== 4️⃣ Acompanha status =====
    let text = "";
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 4000));

      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: AAI_KEY },
      });

      const resData = await poll.json();

      if (resData.status === "completed") {
        text = resData.text;
        break;
      }

      if (resData.status === "error") {
        throw new Error("Erro na AssemblyAI: " + resData.error);
      }
    }

    if (!text) {
      throw new Error("Falha aguardando transcrição (tempo limite).");
    }

    // ===== ✅ Retorna o texto =====
    return NextResponse.json({ text });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Erro:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
