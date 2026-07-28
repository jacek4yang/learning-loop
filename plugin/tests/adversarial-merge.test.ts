import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { conflictCopyPath, mergeText } from "../src/sync/merge";

describe("conflict merge fuzz properties", () => {
  it("is symmetric in whether edits conflict and in successful content", () => {
    fc.assert(fc.property(
      fc.string({ maxLength: 4096 }),
      fc.string({ maxLength: 4096 }),
      fc.string({ maxLength: 4096 }),
      (base, local, remote) => {
        const forward = mergeText(base, local, remote);
        const reverse = mergeText(base, remote, local);
        expect(forward.choice === "conflict")
          .toBe(reverse.choice === "conflict");
        if (forward.choice !== "conflict" && reverse.choice !== "conflict") {
          expect(forward.content).toBe(reverse.content);
        }
      },
    ), { numRuns: 1000 });
  });

  it("always selects the changed side when the other side equals base", () => {
    fc.assert(fc.property(
      fc.string({ maxLength: 8192 }),
      fc.string({ maxLength: 8192 }),
      (base, changed) => {
        expect(mergeText(base, base, changed).content).toBe(changed);
        expect(mergeText(base, changed, base).content).toBe(changed);
      },
    ), { numRuns: 1000 });
  });

  it("never injects Git conflict markers", () => {
    fc.assert(fc.property(
      fc.string({ maxLength: 2048 }),
      fc.string({ maxLength: 2048 }),
      fc.string({ maxLength: 2048 }),
      (base, local, remote) => {
        const result = mergeText(base, local, remote);
        if (
          result.content !== undefined
          &&
          !base.includes("<<<<<<<")
          && !local.includes("<<<<<<<")
          && !remote.includes("<<<<<<<")
        ) {
          expect(result.content).not.toContain("<<<<<<<");
        }
      },
    ), { numRuns: 1000 });
  });

  it("produces portable bounded conflict names for arbitrary device labels", () => {
    fc.assert(fc.property(
      fc.string({ maxLength: 256 }),
      (device) => {
        const path = conflictCopyPath(
          "多语言/many.parts.md",
          device,
          new Date("2026-07-28T12:34:56Z"),
        );
        const filename = path.slice(path.lastIndexOf("/") + 1);
        expect(new TextEncoder().encode(filename).length).toBeLessThanOrEqual(255);
        expect(filename).not.toMatch(/[<>:"/\\|?*\p{Cc}]/u);
        expect(filename).not.toMatch(/[ .]$/u);
      },
    ), { numRuns: 1000 });
  });
});

describe("concurrent edit matrix", () => {
  it.each([
    ["same paragraph", "base\n", "local\n", "remote\n", "conflict"],
    [
      "different paragraphs",
      "one\ntwo\nthree\n",
      "ONE\ntwo\nthree\n",
      "one\ntwo\nTHREE\n",
      "merged",
    ],
    ["delete versus modify", "one\n", "", "changed\n", "conflict"],
    ["identical create", "", "same\n", "same\n", "local"],
    ["different create at same path", "", "left\n", "right\n", "conflict"],
    [
      "independent insertions",
      "middle\n",
      "before\nmiddle\n",
      "middle\nafter\n",
      "merged",
    ],
  ])("%s is conservative", (_name, base, local, remote, choice) => {
    expect(mergeText(base, local, remote).choice).toBe(choice);
  });
});
