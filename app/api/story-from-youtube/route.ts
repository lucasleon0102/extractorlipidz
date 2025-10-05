// app/api/story-from-youtube/route.ts
export const runtime = "nodejs";
export const maxDuration = 600; // vídeos > 5min podem demorar

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

const API_KEY = process.env.ASSEMBLYAI_API_KEY!;
const BASE = "https://api.assemblyai.com/v2";
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";

/* =============== Helpers =============== */
function assertEnv() {
  if (!API_KEY) throw new Error("ASSEMBLYAI_API_KEY ausente (.env.local).");
  if (!YTDLP) throw new Error("YTDLP_PATH ausente (.env.local).");
}

async function spawnToBuffer(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let errTxt = "";
    child.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
    child.stderr.on("data", (d) => (errTxt += d.toString()));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(chunks));
      reject(new Error(`yt-dlp falhou (code ${code}): ${errTxt.trim()}`));
    });
  });
}

/** Baixa ÁUDIO como bytes usando yt-dlp (robusto contra 403/decipher) */
async function downloadAudioWithYtDlp(youtubeId: string): Promise<Buffer> {
  const url = `https://www.youtube.com/watch?v=${youtubeId}`;
  // -f bestaudio: melhor faixa de áudio disponível
  // -o - : escreve no stdout (vamos ler os bytes direto)
  // --no-playlist: garante 1 vídeo
  // --no-progress: não polui stdout
  // --user-agent + --add-header: ajuda em alguns bloqueios
  const args = [
    "-f",
    "bestaudio",
    "--no-playlist",
    "--no-progress",
    "-o",
    "-",
    "--user-agent",
    "Mozilla/5.0",
    "--add-header",
    "Accept-Language: pt-BR,pt;q=0.9,en-US;q=0.8",
    url,
  ];
  return await spawnToBuffer(YTDLP, args);
}

/** Upload do buffer p/ AssemblyAI (com Content-Length) */
async function uploadToAssemblyAI(buf: Buffer): Promise<string> {
  if (!buf?.length) throw new Error("Buffer de áudio vazio.");
  const res = await fetch(`${BASE}/upload`, {
    method: "POST",
    headers: {
      authorization: API_KEY,
      "content-type": "application/octet-stream",
      "content-length": String(buf.length),
    },
    body: buf,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Upload falhou: ${JSON.stringify(data)}`);
  return data.upload_url as string;
}

/** Cria transcript a partir da URL interna retornada pelo upload */
async function createTranscript(audio_url: string): Promise<string> {
  const res = await fetch(`${BASE}/transcript`, {
    method: "POST",
    headers: { authorization: API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      audio_url,
      language_code: "pt",
      punctuate: true,
      format_text: true,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Falha ao criar transcript: ${JSON.stringify(data)}`);
  return data.id as string;
}

/** Polling até concluir */
async function waitTranscript(id: string) {
  for (let i = 0; i < 80; i++) {
    const r = await fetch(`${BASE}/transcript/${id}`, {
      headers: { authorization: API_KEY },
    });
    const d = await r.json();
    if (d.status === "completed") return d;
    if (d.status === "error") throw new Error(d.error);
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error("Tempo excedido aguardando transcrição");
}

/** Roteiro Lipidz (30s) */
function buildLipidz(text: string) {
  const frases = (text || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).slice(0, 6);
  return {
    beats: [
      `Hook: ${frases[0] || "Frase de impacto adaptada para Lipidz"}`,
      `Problema: ${frases[1] || "Problema central do vídeo"}`,
      `Solução: ${frases[2] || "Use Lipidz — filme orodispersível aplicado na língua"}`,
      `Prova: ${frases[3] || "Resultados citados"}`,
      `Transformação: ${frases[4] || "Mudança ou lifestyle"}`,
      `CTA: ${frases[5] || "Desafio 21 dias | link na bio"}`,
    ],
    script: `[00-03] Hook: ${frases[0] || ""}
[03-06] Problema: ${frases[1] || ""}
[06-10] Solução (Lipidz): ${frases[2] || ""}
[10-18] Prova: ${frases[3] || ""}
[18-27] Transformação: ${frases[4] || ""}
[27-30] CTA: ${frases[5] || ""}`,
  };
}

/* =============== Endpoint =============== */
export async function POST(req: NextRequest) {
  try {
    assertEnv();
    const { youtubeId } = await req.json();
    if (!youtubeId) return NextResponse.json({ error: "youtubeId obrigatório" }, { status: 400 });

    // 1) baixar áudio com yt-dlp (robusto contra 403)
    let audioBuf: Buffer;
    try {
      audioBuf = await downloadAudioWithYtDlp(youtubeId);
    } catch (e: any) {
      return NextResponse.json(
        { error: "Falha ao baixar áudio (yt-dlp): " + (e?.message || e) },
        { status: 500 }
      );
    }

    // 2) upload p/ AssemblyAI
    let uploadUrl: string;
    try {
      uploadUrl = await uploadToAssemblyAI(audioBuf);
    } catch (e: any) {
      return NextResponse.json(
        { error: "Falha no upload p/ AssemblyAI: " + (e?.message || e) },
        { status: 500 }
      );
    }

    // 3) criar transcript e aguardar
    let transcriptId: string;
    try {
      transcriptId = await createTranscript(uploadUrl);
    } catch (e: any) {
      return NextResponse.json(
        { error: "Falha ao criar transcript: " + (e?.message || e) },
        { status: 500 }
      );
    }

    let done: any;
    try {
      done = await waitTranscript(transcriptId);
    } catch (e: any) {
      return NextResponse.json(
        { error: "Falha aguardando transcrição: " + (e?.message || e) },
        { status: 500 }
      );
    }

    // 4) roteiro Lipidz
    const roteiro = buildLipidz(done.text || "");
    return NextResponse.json({
      text: done.text || "",
      beats: roteiro.beats,
      script: roteiro.script,
      vttId: transcriptId,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "erro interno" }, { status: 500 });
  }
}

/* GET de teste */
export async function GET() {
  return new Response(JSON.stringify({ ok: true, tip: "Use POST com { youtubeId }" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
