"use server";

import { submitReview, submitMerge } from "@/lib/github";

export async function submitReviewAction(input: {
  owner: string; repo: string; number: number;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
}) {
  return submitReview(input);
}

export async function submitMergeAction(input: {
  owner: string; repo: string; number: number;
  expectedHeadSha?: string;
  method?: "merge" | "squash" | "rebase";
}) {
  return submitMerge(input);
}
