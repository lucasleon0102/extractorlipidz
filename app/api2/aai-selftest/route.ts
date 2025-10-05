export const runtime = "nodejs";

import { NextResponse } from "next/server";

// usa um áudio público só pro teste
const TEST_AUDIO = "https://github.com/AssemblyAI-Examples/audio-examples/raw/main/assemblyai-tests/harvard-sentences-1.wav";
const BASE = "https://api.assemblyai.com/v2";

export async function GET() {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) {
    return NextResponse.json({ ok: false, where: "env", error: "ASSEM NBLYAI_API_KEY ausente no ambiente" }, { status: 500 });
  }

  // tenta criar um transcript (se a chave for válida, retorna id; se inválida, 401/403)
  const r = await fetch(`${BASE}/transcript`, {
    method: "POST",
    headers: { authorization: key, "content-type": "application/json" },
    body: JSON.stringify({ audio_url: TEST_AUDIO, language_code: "en", punctuate: true })
  });

  const text = await r.text();
  return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
}
