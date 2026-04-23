"use client";

import { useState, useTransition } from "react";
import { Check, X, MessageSquare, SkipForward, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Pill } from "./ui/pill";
import { submitReviewAction } from "@/app/actions";

const PILLS = ["LGTM", "YOLO", "Ship it!", "Nit", "Hmm...", "Blocker"];

interface Props {
  repo: { owner: string; name: string };
  prNumber: number;
  prTitle: string;
  onDone: () => void;
  onSkip: () => void;
}

export function DecisionForm({ repo, prNumber, prTitle, onDone, onSkip }: Props) {
  const [verdict, setVerdict] = useState<"approve" | "changes" | "comment" | null>(null);
  const [selectedPills, setSelectedPills] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const togglePill = (p: string) =>
    setSelectedPills((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]);

  const canSubmit = !!verdict;

  const submit = () => {
    if (!verdict) return;
    const text = [...selectedPills, body.trim()].filter(Boolean).join("\n\n");
    const finalBody = text || (verdict === "approve" ? "LGTM" : verdict === "changes" ? "Needs changes." : "Comment.");
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
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-xs uppercase tracking-widest text-muted-foreground">Your review</div>
        <div className="mt-1 text-lg font-medium">How does {prTitle} land?</div>
      </div>

      <div className="flex gap-2">
        <Button
          onClick={() => setVerdict("approve")}
          variant={verdict === "approve" ? "default" : "outline"}
          className="flex-1"
          size="lg"
        >
          <Check className="h-5 w-5" /> Approve
        </Button>
        <Button
          onClick={() => setVerdict("changes")}
          variant={verdict === "changes" ? "destructive" : "outline"}
          className="flex-1"
          size="lg"
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

      <div>
        <div className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Quick take</div>
        <div className="flex flex-wrap gap-2">
          {PILLS.map((p) => (
            <Pill key={p} selected={selectedPills.includes(p)} onClick={() => togglePill(p)}>
              {p}
            </Pill>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">More detail (optional)</div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Specific feedback, a rogue nit, or a bug you spotted…"
          className="min-h-[84px] w-full resize-y rounded-xl border border-border bg-muted/30 p-3 text-sm placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
        />
      </div>

      {error && <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive-foreground">{error}</div>}

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={onSkip} disabled={pending}>
          <SkipForward className="h-4 w-4" /> Skip
        </Button>
        <Button onClick={submit} disabled={!canSubmit || pending} size="lg" variant={verdict === "changes" ? "destructive" : "default"}>
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Posting…</> : "Post review →"}
        </Button>
      </div>
    </div>
  );
}
