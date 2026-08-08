import { describe, expect, it } from "vitest";
import { sampleProcessSnapshot } from "../src/smoke/claudexor/process-snapshot.js";

describe("sampleProcessSnapshot", () => {
  it("counts descendants without retaining ps output", async () => {
    const snapshot = await sampleProcessSnapshot({
      rootPid: 10,
      run: async () => ({
        stdout: "  11    10\n  12    11\n  20     1\n",
        stderr: "",
      }),
    });
    expect(snapshot).toEqual({ instrument: "ps", rootPid: 10, descendantCount: 2 });
    expect(snapshot).not.toHaveProperty("output");
  });
});
