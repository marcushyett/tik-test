import { rm } from "node:fs/promises";
import { runFfmpeg, ffprobeDuration } from "./ffmpeg.js";

/**
 * Render a small looping GIF preview from the highlight MP4. Used as the
 * inline image in PR comments — GitHub auto-loads GIFs but blocks `<video>`
 * autoplay, so the GIF is what reviewers see at-a-glance before clicking
 * through to the full MP4.
 *
 * Long videos get sped up so the preview stays under ~22s of looped motion.
 */
export async function renderPreviewGif(mp4Path: string, gifPath: string): Promise<void> {
  const probeDur = await ffprobeDuration(mp4Path);
  const speedMultiplier = probeDur > 26 ? probeDur / 22 : 1;
  const palettePath = gifPath.replace(/\.gif$/i, ".palette.png");
  const vf = `setpts=${(1 / speedMultiplier).toFixed(4)}*PTS,fps=10,scale=420:-2:flags=lanczos`;
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
