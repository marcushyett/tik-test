"use server";

import { submitReview } from "@/lib/github";

export async function submitReviewAction(input: {
  owner: string; repo: string; number: number;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
}) {
  return submitReview(input);
}
