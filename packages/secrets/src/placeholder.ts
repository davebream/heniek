/**
 * The literal string every credential-shaped value renders as instead of its
 * real value. Authored in exactly one place so `SensitiveValue`
 * (`sensitive-value.ts`) and the redaction helpers (`redaction.ts`) can
 * never drift out of sync with each other by editing one copy and missing
 * the other.
 */
export const REDACTION_PLACEHOLDER = "[redacted]";
