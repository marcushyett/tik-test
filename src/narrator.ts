import type { PlanStep, StepEvent, EventOutcome } from "./types.js";

const INTROS = [
  "Okay, first up —",
  "Here we go —",
  "Watch this —",
  "Now —",
  "Next —",
  "Alright —",
  "Let's see —",
];

function pickIntro(seed: number): string {
  return INTROS[seed % INTROS.length];
}

function domainOf(url?: string): string {
  if (!url) return "the app";
  try { return new URL(url).host; } catch { return url; }
}

export interface NarrationInput {
  step: PlanStep;
  outcome: EventOutcome;
  error?: string;
  notes?: string;
  seed: number;
  total: number;
  index: number;
  startUrl: string;
}

export interface NarrationOutput {
  line: string;        // what gets spoken
  caption: string;     // what appears on screen (may differ — more punchy)
  heading: string;     // short top-strip chip, e.g. "CLICK" / "HIGH PRIORITY"
}

function critBadge(step: PlanStep): string {
  if (step.importance === "critical") return "CRITICAL BEAT";
  if (step.importance === "high") return "IMPORTANT";
  return "";
}

export function narrate(input: NarrationInput): NarrationOutput {
  const { step, outcome, error, seed, index, total, startUrl } = input;
  const intro = pickIntro(seed);
  const badge = critBadge(step);
  const position = `${index + 1}/${total}`;
  const mk = (label: string) => badge ? `${badge}  ·  ${position}` : `${label}  ·  ${position}`;

  if (outcome === "failure") {
    return {
      line: `Hold up — ${step.description}. It failed. ${error ? "The error was: " + error : ""}`,
      caption: `FAILED\n${step.description}${error ? "\n" + error : ""}`,
      heading: `FAIL  ·  ${position}`,
    };
  }

  switch (step.kind) {
    case "navigate": {
      return {
        line: `${intro} we land on ${domainOf(step.target ?? startUrl)}.`,
        caption: `Opening\n${domainOf(step.target ?? startUrl)}`,
        heading: mk("OPEN"),
      };
    }
    case "click": {
      const name = readableTarget(step.target);
      const base = step.importance === "critical"
        ? `${intro} this is the moment — we tap ${name}.`
        : step.importance === "high"
          ? `${intro} tap ${name} and see what happens.`
          : `${intro} tap ${name}.`;
      return {
        line: base,
        caption: step.description,
        heading: mk("TAP"),
      };
    }
    case "fill": {
      const val = step.value ?? "";
      return {
        line: `${intro} type "${val}" into ${readableTarget(step.target)}.`,
        caption: `Type: "${val}"`,
        heading: mk("TYPE"),
      };
    }
    case "press": {
      return {
        line: `${intro} hit ${step.value ?? step.target ?? "Enter"}.`,
        caption: step.description,
        heading: mk("KEY"),
      };
    }
    case "hover": {
      return {
        line: `${intro} hover over ${readableTarget(step.target)} to reveal it.`,
        caption: step.description,
        heading: mk("HOVER"),
      };
    }
    case "wait": {
      return {
        line: `Give it a beat to settle.`,
        caption: `Waiting…`,
        heading: `WAIT  ·  ${position}`,
      };
    }
    case "assert-visible": {
      return {
        line: `And there it is — ${step.description.toLowerCase()}.`,
        caption: step.description,
        heading: mk("CHECK"),
      };
    }
    case "assert-text": {
      return {
        line: `Look at that — the text "${step.value}" shows up, just like we wanted.`,
        caption: `Contains "${step.value}"`,
        heading: mk("MATCH"),
      };
    }
    case "screenshot": {
      return {
        line: `Snap — saving a screenshot for the record.`,
        caption: step.description,
        heading: `SNAP  ·  ${position}`,
      };
    }
    case "script": {
      return {
        line: `${intro} nudge the UI under the hood.`,
        caption: step.description,
        heading: mk("NUDGE"),
      };
    }
  }
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
  if (lower.includes("button") || lower.includes("btn")) return `the ${lower}`;
  return `the ${lower}`;
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
      seed: i,
      index: i,
      total: events.length,
      startUrl,
    }),
  );
}
