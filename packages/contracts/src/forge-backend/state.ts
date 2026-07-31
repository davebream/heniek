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
