import { defineStates } from "../kernel/index.js";

export const PullRequestState = defineStates({
  nonTerminal: ["open"],
  terminal: ["closed", "merged"],
});
export type PullRequestState = (typeof PullRequestState)["values"][number];

export const CheckState = defineStates({
  nonTerminal: ["queued", "in_progress"],
  terminal: ["succeeded", "failed", "skipped"],
});
export type CheckState = (typeof CheckState)["values"][number];

export const ForgeIssueState = defineStates({
  nonTerminal: ["open"],
  terminal: ["closed"],
});
export type ForgeIssueState = (typeof ForgeIssueState)["values"][number];

export const ForgeMutationDisposition = defineStates({
  nonTerminal: ["created", "adopted", "updated"],
  terminal: ["unchanged"],
});
export type ForgeMutationDisposition = (typeof ForgeMutationDisposition)["values"][number];

export const PullRequestMergeability = defineStates({
  nonTerminal: ["unknown"],
  terminal: ["mergeable", "conflicting"],
});
export type PullRequestMergeability = (typeof PullRequestMergeability)["values"][number];

export const PullRequestMergeState = defineStates({
  nonTerminal: ["unknown", "behind", "blocked", "draft", "unstable", "has_hooks"],
  terminal: ["clean", "dirty"],
});
export type PullRequestMergeState = (typeof PullRequestMergeState)["values"][number];
