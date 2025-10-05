import { NextResponse } from "next/server";
import ytdl from "@distube/ytdl-core";
import { spawn } from "node:child_process";

export const runtime = "nodejs";
export const maxDuration = 600;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const AAI_KEY = process.env.ASSEMBLYAI_API_KEY || "";
const YTDLP_PATH = process.env.YTDLP_PATH || ""; // opcional (fallback via binário)

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

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
      return NextResponse.json({ error: "ASSEMBLYAI_API_KEY ausente (.env.local)" }, { status: 500, headers: corsHeaders });
    }

    const url = `https://www.youtube.com/watch?v=${youtubeId}`;

    // 1) Baixar áudio do YouTube (tenta ytdl-core com headers; cai para yt-dlp se precisar)
    let audioBuf: Buffer | null = null;
    try {
      const stream = ytdl(url, {
        filter: "audioonly",
        quality: "highestaudio",
        dlChunkSize: 0,
        requestOptions: {
          headers: {
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
            cookie: "CONSENT=YES+1",
            referer: "https://www.youtube.com/",
            origin: "https://www.youtube.com"
          }
        }
      });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      audioBuf = Buffer.concat(chunks);
      if (!audioBuf?.length) throw new Error("Buffer vazio do ytdl-core.");
    } catch (e) {
      console.warn("[ytdl-core] falhou, tentando yt-dlp...", e instanceof Error ? e.message : e);
    }

    if (!audioBuf && YTDLP_PATH) {
      audioBuf = await downloadWithYtDlp(url, YTDLP_PATH);
    }
    if (!audioBuf) {
      throw new Error("Falha ao baixar o áudio do YouTube. (Tente configurar YTDLP_PATH e subir o binário yt-dlp)");
    }

    // 2) Upload para AssemblyAI
    const upRes = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: { authorization: AAI_KEY, "content-type": "application/octet-stream" },
      body: new Blob([audioBuf])
    });
    const upJson = await upRes.json();
    if (!upRes.ok) throw new Error("Upload falhou: " + JSON.stringify(upJson));
    const uploadUrl: string = upJson.upload_url;

    // 3) Criar transcrição
    const trRes = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: { authorization: AAI_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        audio_url: uploadUrl,
        punctuate: true,
        format_text: true,
        language_code: "pt"
      })
    });
    const trJson = await trRes.json();
    if (!trRes.ok) throw new Error("Transcrição falhou: " + JSON.stringify(trJson));
    const transcriptId: string = trJson.id;

    // 4) Poll até concluir
    let transcript = "";
    for (let i = 0; i < 30; i++) {
      await wait(4000);
      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: AAI_KEY }
      });
      const pollJson = await poll.json();
      if (pollJson.status === "completed") { transcript = String(pollJson.text || ""); break; }
      if (pollJson.status === "error") throw new Error("Erro na AssemblyAI: " + pollJson.error);
    }
    if (!transcript) throw new Error("Falha aguardando transcrição (tempo limite).");

    // 5) Análise + Roteiro adaptado para Lipidz (no servidor)
    const { beats, script, prompt } = buildLipidzPack(transcript);

    // 6) Retorna tudo
    return NextResponse.json(
      { text: transcript, beats, script, prompt },
      { status: 200, headers: corsHeaders }
    );

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[story-from-youtube] erro:", msg);
    return NextResponse.json({ error: msg }, { status: 500, headers: corsHeaders });
  }
}

/* ---------------- helpers ---------------- */

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadWithYtDlp(ytUrl: string, ytDlpPath: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const args = ["-f", "bestaudio/best", "--no-playlist", "-o", "-", ytUrl];
    const child = spawn(ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errs: string[] = [];

    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errs.push(d.toString()));

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        const buf = Buffer.concat(chunks);
        if (!buf.length) return reject(new Error("yt-dlp retornou buffer vazio."));
        resolve(buf);
      } else {
        reject(new Error(`yt-dlp falhou (code ${code}). stderr: ${errs.join("")}`));
      }
    });
  });
}

/** Gera Story Beats + Roteiro (30s, 9:16) para Lipidz a partir da transcrição */
function buildLipidzPack(raw: string) {
  const txt = (raw || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
  const parts = txt.split(/(?<=[\.\!\?])\s+/).filter(Boolean);
  const scored = parts
    .map((s) => ({
      s,
      score:
        (s.match(/\b(\d+|%|dia|seman|antes|depois|resultado|prova|avali|link|bio|uso|modo)\b/gi) || []).length +
        Math.min(s.length / 80, 3)
    }))
    .sort((a, b) => b.score - a.score);

  const picks = scored.slice(0, 12).map((o) => o.s);

  const lip = (s: string) =>
    s
      .replace(/slim\s*caps/gi, "Lipidz")
      .replace(/(cápsul[ao]s?|pílulas?|gummies?|chá|shake)/gi, "filme orodispersível")
      .replace(/\b(produto|suplemento|marca)\b/gi, "Lipidz")
      .replace(/(\buse|usar|uso\b)[^\.!?]{0,30}/gi, (m) => m.replace(/(\buse|usar|uso\b)/i, "Use Lipidz"));

  const adapted = picks.map(lip);

  const beats = [
    `Hook (0–3s): ${adapted[0] || "Abra com a frase mais forte do original (adaptada para Lipidz)."}`,
    `Problema (3–6s): ${adapted[1] || "Resuma a dor principal citada."}`,
    `Solução/Modo de uso (6–10s): ${adapted[2] || "Mostre Lipidz e como aplicar o filme na língua."}`,
    `Prova/Social (10–18s): ${adapted[3] || "Use o trecho de prova/resultado citado."}`,
    `Transformação (18–27s): ${adapted[4] || "Descreva a mudança/rotina citada."}`,
    `CTA (27–30s): ${adapted[5] || "“Desafio 21 dias | link na bio” (igual ao original, com Lipidz)."}`
  ];

  const script =
`[00-03] HOOK: ${adapted[0] || "Texto forte do original (adaptado)"} 
[03-06] PROBLEMA: ${adapted[1] || "Dor principal do original"} 
[06-10] SOLUÇÃO (Lipidz): ${adapted[2] || "Como usar o filme orodispersível"} 
[10-18] PROVA/SOCIAL: ${adapted[3] || "Prova/avaliações mencionadas"} 
[18-27] TRANSFORMAÇÃO: ${adapted[4] || "Antes/Depois seguro ou rotina citada"} 
[27-30] CTA: ${adapted[5] || "Chamada final igual ao original, adaptando o nome para Lipidz"}`;

  const prompt =
`Com base EXCLUSIVAMENTE no texto a seguir (conteúdo do vídeo original), gere um roteiro em até 30s (9:16) ADAPTADO para "Lipidz" (filme orodispersível), mantendo a sequência de ideias, sem inventar elementos novos.

=== TEXTO-FONTE (reduzido) ===
${picks.join(" ")}

=== REGRAS ===
- Mantenha a ordem e sentido do conteúdo original.
- Substitua referências de produto por "Lipidz" e "filme orodispersível".
- Preserve claims de forma equivalente; não adicione benefícios não citados.
- Estruture em: Hook (0–3s), Problema, Solução/Modo de uso, Prova/Social, Transformação, CTA (link na bio / desafio 21 dias).`;

  return { beats, script, prompt };
}
