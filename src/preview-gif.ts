import { rm } from "node:fs/promises";
import { runFfmpeg, ffprobeDuration } from "./ffmpeg.js";

/**
 * Render a small looping GIF preview from the highlight MP4. Used as the
 * inline image in PR comments — GitHub auto-loads GIFs but blocks `<video>`
 * autoplay, so the GIF is what reviewers see at-a-glance before clicking
 * through to the full MP4.
 *
 * Pacing rules (legibility > brevity):
 *   - Cap the speed-up at MAX_SPEED so captions and tool overlays stay
 *     readable. Earlier versions divided "any duration" by a 22s target,
 *     which for a 3-min video meant 8x — a cartoon flicker no human
 *     could follow. A 3x ceiling keeps motion comprehensible at the cost
 *     of a longer (~50s) loop on long runs; that's the right trade for
 *     a preview people actually parse.
 *   - 12 fps balances smoothness against file size — under ~6MB per
 *     preview at 420px wide.
 */
const TARGET_SECONDS = 22;
const MAX_SPEED = 1.5;
const FPS = 12;

export async function renderPreviewGif(mp4Path: string, gifPath: string): Promise<void> {
  const probeDur = await ffprobeDuration(mp4Path);
  const rawSpeed = probeDur > TARGET_SECONDS ? probeDur / TARGET_SECONDS : 1;
  const speedMultiplier = Math.min(rawSpeed, MAX_SPEED);
  const palettePath = gifPath.replace(/\.gif$/i, ".palette.png");
  const vf = `setpts=${(1 / speedMultiplier).toFixed(4)}*PTS,fps=${FPS},scale=420:-2:flags=lanczos`;
  await runFfmpeg([
    "-i", mp4Path,
    "-vf", `${vf},palettegen=stats_mode=diff:max_colors=128`,
    "-y", palettePath,
  ]);
  await runFfmpeg([
    "-i", mp4Path,
    "-i", palettePath,
    "-lavfi", `${vf} [x]; [x][1:v] paletteuse=dither=sierra2_4a`,
    "-y", gifPath,
  ]);
  await rm(palettePath, { force: true });
}
