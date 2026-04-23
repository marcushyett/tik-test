export const FPS = 30;
export const OUT_W = 1080;
export const OUT_H = 1920;

export interface ReelBBox {
  x: number; y: number; width: number; height: number;
  viewportWidth: number; viewportHeight: number;
}

export interface ReelStep {
  id: string;
  kind: string;
  importance: "low" | "normal" | "high" | "critical";
  outcome: "success" | "failure" | "skipped";
  description: string;

  // Narration text — shown as word-by-word captions AND spoken via the audio file.
  caption: string;
  titleSlideLabel: string;    // small label ("CHECK · step 3")
  titleSlideText: string;     // big headline ("Toast confirms add")

  // Pre-sliced clip for this step, served as a static file.
  clipSrc: string;
  clipDurS: number;
  playbackRate: number;       // clip plays this fast in the composition
  stepDurFrames: number;      // how long the step plays in the final reel (excl. intro slide)
  introDurFrames: number;     // length of the tiny step intro card before the clip

  // Cursor path: previous target center → this step's target center, in viewport coords.
  prevCursor?: { x: number; y: number };
  targetCursor?: { x: number; y: number };
  clickFrame?: number;        // frame within stepDurFrames where a click flash fires
  isClick: boolean;

  bbox?: ReelBBox;
  voiceSrc?: string;          // staticFile filename (relative to publicDir) of the narration audio
  voiceDurS?: number;
  error?: string;
}

export interface ReelInput {
  title: string;
  summary: string;
  viewport: { width: number; height: number };
  steps: ReelStep[];
  introDurFrames: number;
  outroDurFrames: number;
  stats: { passed: number; failed: number; skipped: number; total: number; durS: number };
  introVoiceSrc?: string;
  introVoiceDurS?: number;
  outroVoiceSrc?: string;
  outroVoiceDurS?: number;
}

export function computeTotalDuration(input: ReelInput): number {
  return (
    input.introDurFrames +
    input.steps.reduce((acc, s) => acc + s.introDurFrames + s.stepDurFrames, 0) +
    input.outroDurFrames
  );
}
