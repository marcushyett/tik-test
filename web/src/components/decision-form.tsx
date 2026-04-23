"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, MessageSquare, SkipForward, X } from "lucide-react";
import { Button } from "./ui/button";
import { Pill } from "./ui/pill";
import { submitReviewAction } from "@/app/actions";

const POSITIVE_PILLS = ["LGTM", "Ship it", "Clean", "Nice"];
const NEUTRAL_PILLS = ["Question", "Nit", "Typo", "Hmm..."];
const NEGATIVE_PILLS = ["Blocker", "Rework", "Out of scope", "Regression"];

interface Props {
  repo: { owner: string; name: string };
  prNumber: number;
  prTitle: string;
  onDone: () => void;
  onSkip: () => void;
}

/**
 * Post-video review card. The verdict (approve / request-changes / comment)
 * picks the event for the GitHub Reviews API; the pills are stapled into the
 * body along with the free-text note. Submit posts `pulls.createReview` as
 * the signed-in user.
 */
export function DecisionForm({ repo, prNumber, prTitle, onDone, onSkip }: Props) {
  const [verdict, setVerdict] = useState<"approve" | "changes" | "comment" | null>(null);
  const [selectedPills, setSelectedPills] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const togglePill = (p: string) =>
    setSelectedPills((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const canSubmit = !!verdict;

  const submit = () => {
    if (!verdict) return;
    const joined = [...selectedPills, body.trim()].filter(Boolean).join("\n\n");
    const finalBody = joined || (verdict === "approve" ? "LGTM" : verdict === "changes" ? "Needs changes." : "");
    setError(null);
    startTransition(async () => {
      const res = await submitReviewAction({
        owner: repo.owner,
        repo: repo.name,
        number: prNumber,
        event: verdict === "approve" ? "APPROVE" : verdict === "changes" ? "REQUEST_CHANGES" : "COMMENT",
        body: finalBody,
      });
      if (res.ok) onDone();
      else setError(res.error);
    });
  };

  return (
    <div className="fade-up glass rounded-2xl p-5">
      <div className="mb-4">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">your review</div>
        <div className="mt-1 text-[17px] font-medium leading-snug tracking-tight">
          How does {pickShort(prTitle)} land?
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          onClick={() => setVerdict("approve")}
          variant={verdict === "approve" ? "default" : "outline"}
          size="lg"
          className="flex-1"
        >
          <Check className="h-5 w-5" /> Approve
        </Button>
        <Button
          onClick={() => setVerdict("changes")}
          variant={verdict === "changes" ? "destructive" : "outline"}
          size="lg"
          className="flex-1"
        >
          <X className="h-5 w-5" /> Request changes
        </Button>
        <Button
          onClick={() => setVerdict("comment")}
          variant={verdict === "comment" ? "accent" : "outline"}
          size="lg"
          aria-label="Comment only"
        >
          <MessageSquare className="h-5 w-5" />
        </Button>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {POSITIVE_PILLS.map((p) => (
          <Pill key={p} tone="positive" selected={selectedPills.includes(p)} onClick={() => togglePill(p)}>
            {p}
          </Pill>
        ))}
        <div className="mx-1 w-px self-stretch bg-border" />
        {NEUTRAL_PILLS.map((p) => (
          <Pill key={p} tone="warn" selected={selectedPills.includes(p)} onClick={() => togglePill(p)}>
            {p}
          </Pill>
        ))}
        <div className="mx-1 w-px self-stretch bg-border" />
        {NEGATIVE_PILLS.map((p) => (
          <Pill key={p} tone="negative" selected={selectedPills.includes(p)} onClick={() => togglePill(p)}>
            {p}
          </Pill>
        ))}
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Anything specific? A nit, a rogue edge-case, the reason you're requesting changes."
        className="mt-4 min-h-[84px] w-full resize-y rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
      />

      {error && (
        <div className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="mt-5 flex items-center justify-between">
        <Button variant="ghost" onClick={onSkip} disabled={pending}>
          <SkipForward className="h-4 w-4" /> Skip
        </Button>
        <Button
          onClick={submit}
          disabled={!canSubmit || pending}
          size="lg"
          variant={verdict === "changes" ? "destructive" : verdict === "comment" ? "accent" : "default"}
        >
          {pending ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Posting…</>
          ) : (
            "Post review"
          )}
        </Button>
      </div>
    </div>
  );
}

/** Crop a long PR title so the decision heading stays snappy. */
function pickShort(title: string): string {
  if (title.length <= 64) return title;
  return title.slice(0, 62).trimEnd() + "…";
}
