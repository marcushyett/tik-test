import type { PlanStep, StepEvent, EventOutcome } from "./types.js";

export interface NarrationInput {
  step: PlanStep;
  outcome: EventOutcome;
  error?: string;
  notes?: string;
  index: number;
  total: number;
  startUrl: string;
}

export interface NarrationOutput {
  voiceLine: string;       // what the narrator speaks (natural sentence)
  captionText: string;     // on-screen word-by-word caption (3–10 words, sentence-case)
  titleSlideLabel: string; // tiny label on the step intro card ("Tap submit")
  titleSlideText: string;  // big headline on the step intro card
}

function domainOf(url?: string): string {
  if (!url) return "the app";
  try { return new URL(url).host; } catch { return url; }
}

function readableTarget(target?: string): string {
  if (!target) return "it";
  const t = target.trim();
  const testid = /\[data-testid=['"]?([^'"\]]+)['"]?\]/.exec(t);
  if (testid) return prettifyName(testid[1]);
  const filter = /\[data-filter=['"]?([^'"\]]+)['"]?\]/.exec(t);
  if (filter) return `the ${filter[1]} filter`;
  if (t.startsWith("text=")) return `"${t.slice(5)}"`;
  if (t.includes("role=button[name=")) {
    const m = /name=["']([^"']+)["']/.exec(t);
    if (m) return `the "${m[1]}" button`;
  }
  return "that control";
}

function prettifyName(s: string): string {
  const words = s.split(/[-_\s]+/).filter(Boolean);
  const lower = words.join(" ");
  if (lower.endsWith("input") || lower.endsWith("field")) return `the ${lower} field`;
  if (lower.startsWith("del")) return `the delete button`;
  if (lower.startsWith("toggle")) return `the checkbox`;
  return `the ${lower}`;
}

function shortSubject(target?: string, fallback = "this control"): string {
  if (!target) return fallback;
  const t = readableTarget(target);
  // Trim leading articles for the intro slide label — shorter hits harder.
  return t.replace(/^the\s+/i, "");
}

export function narrate(input: NarrationInput): NarrationOutput {
  const { step, outcome, error, startUrl } = input;
  if (outcome === "failure") {
    return {
      voiceLine: `Hold up — ${step.description}. It failed. ${error ? "Error: " + error : ""}`.trim(),
      captionText: `Hold up. ${step.description} failed.`,
      titleSlideLabel: "Failure",
      titleSlideText: `${step.description} failed`,
    };
  }

  switch (step.kind) {
    case "navigate": {
      const host = domainOf(step.target ?? startUrl);
      return {
        voiceLine: `First, we open ${host}.`,
        captionText: `Open ${host}`,
        titleSlideLabel: "Open",
        titleSlideText: `Open ${host}`,
      };
    }
    case "click": {
      const name = readableTarget(step.target);
      const subj = shortSubject(step.target, "submit");
      if (step.importance === "critical") {
        return {
          voiceLine: `Here's the moment of truth. We click ${name}.`,
          captionText: `Click ${subj}. Watch the result.`,
          titleSlideLabel: "Click",
          titleSlideText: `Click ${subj}`,
        };
      }
      return {
        voiceLine: `Now we click ${name}.`,
        captionText: `Click ${subj}.`,
        titleSlideLabel: "Click",
        titleSlideText: `Click ${subj}`,
      };
    }
    case "fill": {
      const val = step.value ?? "";
      return {
        voiceLine: `We type "${val}" into ${readableTarget(step.target)}.`,
        captionText: `Type "${val}"`,
        titleSlideLabel: "Type",
        titleSlideText: `Type "${val}"`,
      };
    }
    case "press": {
      const key = step.value ?? step.target ?? "Enter";
      return {
        voiceLine: `Then we press ${key}.`,
        captionText: `Press ${key}`,
        titleSlideLabel: "Press",
        titleSlideText: `Press ${key}`,
      };
    }
    case "hover": {
      const name = readableTarget(step.target);
      return {
        voiceLine: `Hover over ${name} to reveal it.`,
        captionText: `Hover ${shortSubject(step.target)}`,
        titleSlideLabel: "Hover",
        titleSlideText: `Hover ${shortSubject(step.target)}`,
      };
    }
    case "wait": {
      return {
        voiceLine: `Give it a beat to settle.`,
        captionText: `Wait for it...`,
        titleSlideLabel: "Wait",
        titleSlideText: `Let it settle`,
      };
    }
    case "assert-visible": {
      return {
        voiceLine: `And there it is. ${step.description}.`,
        captionText: `${step.description}`,
        titleSlideLabel: "Verify",
        titleSlideText: step.description,
      };
    }
    case "assert-text": {
      return {
        voiceLine: `The text "${step.value}" shows up, right on cue.`,
        captionText: `Contains "${step.value}"`,
        titleSlideLabel: "Verify",
        titleSlideText: step.description,
      };
    }
    case "screenshot": {
      return {
        voiceLine: `Snap — saving a screenshot.`,
        captionText: `Snap ✓`,
        titleSlideLabel: "Snapshot",
        titleSlideText: step.description,
      };
    }
    case "script": {
      return {
        voiceLine: `We nudge the UI under the hood.`,
        captionText: step.description,
        titleSlideLabel: "Setup",
        titleSlideText: step.description,
      };
    }
  }
}

export function narrateAll(
  events: StepEvent[],
  stepsById: Map<string, PlanStep>,
  startUrl: string,
): NarrationOutput[] {
  return events.map((ev, i) =>
    narrate({
      step: stepsById.get(ev.stepId) ?? ({ id: ev.stepId, kind: ev.kind, description: ev.description } as PlanStep),
      outcome: ev.outcome,
      error: ev.error,
      notes: ev.notes,
      index: i,
      total: events.length,
      startUrl,
    }),
  );
}
