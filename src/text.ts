/**
 * Word-boundary length clip. Cut at the last space before `max`. If the
 * last space is too far back (>40% of the target length lost), hard-cut
 * — better a truncated long word than an unreadable empty headline.
 *
 * Used everywhere a label / heading / note is shown to the reviewer:
 * outro checklist rows, PR comment goal headings, video stamps. The
 * raw `slice(0, N).trim()` we used before kept producing visible
 * mid-word breaks like "pin it usin" — particularly painful on goal
 * headings where every truncated headline reads as broken software.
 */
export function clipToWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace < max * 0.6) return cut.trimEnd();
  return cut.slice(0, lastSpace).trimEnd() + "…";
}
