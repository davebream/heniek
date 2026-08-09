/** Operator-facing failure message hygiene — truncate, never dump env. */

const MAX_MESSAGE = 512;

const ENV_DUMP_PATTERN = /\b(?:PATH|HOME|TOKEN|SECRET|PASSWORD|API[_-]?KEY)\s*=/i;

export function redactFailureMessage(message: string): string {
  let text = message.replace(/\r\n/g, "\n").trim();
  if (ENV_DUMP_PATTERN.test(text)) {
    text = "command failed (environment details redacted)";
  }
  if (text.length === 0) text = "stage failed";
  if (text.length > MAX_MESSAGE) text = `${text.slice(0, MAX_MESSAGE - 1)}…`;
  return text;
}
