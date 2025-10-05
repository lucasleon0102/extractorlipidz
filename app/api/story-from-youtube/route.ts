import { NextResponse } from "next/server";
import ytdl from "@distube/ytdl-core";

export const runtime = "nodejs";
export const maxDuration = 600;

// Se precisar CORS (front ≠ API), troque "*" pelo seu domínio
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const AAI_KEY = process.env.ASSEMBLYAI_API_KEY || "";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// GET de saúde (para abrir no navegador)
export async function GET() {
  return NextResponse.json(
    { ok: true, tip: "Use POST com { youtubeId }" },
    { status: 200, headers: corsHeaders }
  );
}

export async function POST(req: Request) {
  try {
    const { youtubeId } = await req.json();
    if (!youtubeId) {
      return NextResponse.json({ error: "youtubeId ausente" }, { status: 400, headers: corsHeaders });
    }
    if (!AAI_KEY) {
      return NextResponse.json({ error: "ASSEMBLYAI_API_KEY ausente" }, { status: 500, headers: corsHeaders });
    }

    // 1) Baixa áudio do YouTube
    const url = `https://www.youtube.com/watch?v=${youtubeId}`;
    const stream = ytdl(url, { quality: "highestaudio", filter: "audioonly", dlChunkSize: 0 });

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const buf = Buffer.concat(chunks);

    // 2) Sobe para AssemblyAI (usar Blob/ArrayBuffer, não Buffer)
    const upRes = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: {
        authorization: AAI_KEY,
        "content-type": "application/octet-stream",
      },
      body: new Blob([buf]),
    });
    const upData = await upRes.json();
    if (!upRes.ok) throw new Error(`Upload falhou: ${JSON.stringify(upData)}`);
    const uploadUrl = upData.upload_url as string;

    // 3) Cria transcrição
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
    if (!trRes.ok) throw new Error(`Transcrição falhou: ${JSON.stringify(trData)}`);
    const transcriptId = trData.id as string;

    // 4) Poll até concluir
    let text = "";
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: AAI_KEY },
      });
      const resData = await poll.json();
      if (resData.status === "completed") { text = resData.text as string; break; }
      if (resData.status === "error") throw new Error("Erro na AssemblyAI: " + resData.error);
    }
    if (!text) throw new Error("Falha aguardando transcrição (tempo limite).");

    // 5) Retorna a transcrição (o front monta beats/roteiro Lipidz)
    return NextResponse.json({ text }, { status: 200, headers: corsHeaders });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[story-from-youtube] erro:", msg);
    return NextResponse.json({ error: msg }, { status: 500, headers: corsHeaders });
  }
}
