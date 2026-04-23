import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { runFfmpeg } from "./ffmpeg.js";

export type TTSBackend =
  | { kind: "openai"; voice: string; model: string; apiKey: string }
  | { kind: "say"; voice: string }
  | null;

// OpenAI voices that pair well with the tech-bro demo tone — all clear,
// non-chirpy, with enough edge to land a punchline. We rotate through these so
// binge-watching the feed doesn't feel like one narrator doing every PR.
// The seed can be stable (runId) so a given video always uses the same voice,
// but varies across videos.
const VARIANT_VOICES = ["ash", "ballad", "coral", "verse", "onyx", "sage"];

function pickVoice(seed: string | undefined): string {
  if (!seed) return VARIANT_VOICES[Math.floor(Math.random() * VARIANT_VOICES.length)];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return VARIANT_VOICES[Math.abs(h) % VARIANT_VOICES.length];
}

export function resolveBackend(preferred: string | null | undefined, seed?: string): TTSBackend {
  if (preferred === null) return null;
  if (process.env.OPENAI_API_KEY) {
    // An explicit TIK_TTS_VOICE pins the voice; otherwise we vary per-video
    // using a hash of `seed` (runId, PR title, etc.) so the same PR always
    // reads in the same voice but the feed as a whole has variety.
    return {
      kind: "openai",
      voice: process.env.TIK_TTS_VOICE ?? pickVoice(seed),
      model: process.env.TIK_TTS_MODEL ?? "gpt-4o-mini-tts",
      apiKey: process.env.OPENAI_API_KEY,
    };
  }
  if (process.platform === "darwin") {
    return { kind: "say", voice: preferred ?? "Samantha" };
  }
  return null;
}

export function describeBackend(b: TTSBackend): string {
  if (!b) return "disabled";
  if (b.kind === "openai") return `OpenAI TTS (${b.model} · ${b.voice})`;
  return `macOS say (${b.voice})`;
}

export async function synth(backend: TTSBackend, text: string, outPath: string): Promise<void> {
  if (!backend) throw new Error("TTS disabled");
  if (backend.kind === "say") {
    return synthSay(backend.voice, text, outPath);
  }
  return synthOpenAI(backend, text, outPath);
}

function synthSay(voice: string, text: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("say", ["-v", voice, "-o", outPath, "--data-format=LEI16@22050", text], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`say exited ${code}: ${err}`))));
  });
}

async function synthOpenAI(b: Extract<TTSBackend, { kind: "openai" }>, text: string, outPath: string): Promise<void> {
  // Hit OpenAI's audio speech endpoint and store the MP3, then transcode to WAV for Remotion.
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${b.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: b.model,
      voice: b.voice,
      input: text,
      format: "mp3",
      speed: 1.35,
      instructions: [
        "You are a hyped tech-bro narrating a 30-second feature demo for TikTok.",
        "DELIVERY: rapid-fire, urgent, super high energy. Fast cadence. Clip your words.",
        "Lean into stressed syllables. Pauses are extremely brief. Never sing-song or measured.",
        "Casual slang is great ('alright', 'boom', 'yep, ships'). Short and punchy.",
        "Imagine you're excited and slightly out of breath showing your buddy something new.",
      ].join(" "),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI TTS failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const mp3Path = outPath.replace(/\.wav$/i, ".mp3");
  await writeFile(mp3Path, buf);
  // Transcode to WAV so Remotion + ffprobe stay happy.
  await runFfmpeg(["-i", mp3Path, "-ar", "44100", "-ac", "1", outPath]);
}
