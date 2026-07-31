import type { Static } from "@sinclair/typebox";
import type { TaskContextV1 } from "./schemas.js";

/** §13.1, verbatim. */
export interface TaskSource {
  load(input: unknown): Promise<Static<typeof TaskContextV1>>;
}
