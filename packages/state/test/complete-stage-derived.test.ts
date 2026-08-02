/**
 * §16.6 step 6 ("release dependants") is DERIVED, never performed (design
 * D7; plan Task 4.6). There is no stage lifecycle to release into yet — this
 * package ships no dispatch/release call at all, so a later issue cannot
 * silently reintroduce a post-commit dispatcher without a visible new
 * export appearing here.
 *
 * Asserts against the actual runtime export surface (`Object.keys` of the
 * imported module namespace), not a source-text grep: a grep can be fooled
 * by a comment or a renamed local; a runtime export list cannot.
 */

import { describe, expect, it } from "vitest";
import * as completeStageModule from "../src/artifact/complete-stage.js";
import * as packageBarrel from "../src/index.js";

/** Matches any plausible "release/dispatch dependants" naming a future issue might reach for. */
const RELEASE_OR_DISPATCH_NAME_PATTERN = /release|dispatch|unblock|notify/i;

describe("§16.6 step 6 is derived, never performed (design D7, plan Task 4.6)", () => {
  it("artifact/complete-stage.ts exports exactly completeStage at runtime — no second, release-shaped export", () => {
    const runtimeExports = Object.keys(completeStageModule);
    expect(runtimeExports).toEqual(["completeStage"]);
  });

  it("no export anywhere in the package barrel is named like a release/dispatch call", () => {
    const suspicious = Object.keys(packageBarrel).filter((name) =>
      RELEASE_OR_DISPATCH_NAME_PATTERN.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  it("completeStage itself takes no callback/listener parameter a release call could be smuggled through", () => {
    // `completeStage(db, store, input)` — arity 3, no fourth "onReleased"-
    // shaped parameter. `Function.length` counts parameters up to the first
    // one with a default value, which none of these three has.
    expect(completeStageModule.completeStage.length).toBe(3);
  });
});
