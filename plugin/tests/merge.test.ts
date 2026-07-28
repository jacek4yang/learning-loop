import { describe, expect, it } from "vitest";

import {
  conflictCopyPath,
  conflictRecord,
  mergeText,
} from "../src/sync/merge";

describe("three-way text merge", () => {
  it("merges independent same-length line edits", () => {
    const base = "one\ntwo\nthree\n";
    expect(mergeText(base, "ONE\ntwo\nthree\n", "one\ntwo\nTHREE\n")).toEqual({
      choice: "merged",
      content: "ONE\ntwo\nTHREE\n",
    });
  });

  it("merges disjoint insertion and replacement ranges", () => {
    const base = "one\ntwo\nthree\n";
    expect(
      mergeText(base, "zero\none\ntwo\nthree\n", "one\ntwo\nTHREE\n"),
    ).toEqual({
      choice: "merged",
      content: "zero\none\ntwo\nTHREE\n",
    });
  });

  it("refuses overlapping edits without conflict markers", () => {
    const result = mergeText("one\n", "local\n", "remote\n");
    expect(result).toEqual({ choice: "conflict" });
    expect(result.content).toBeUndefined();
  });
});

describe("conflict artifacts", () => {
  it("uses a portable UTC conflict-copy name and inbox record", () => {
    const at = new Date("2026-07-28T12:34:56.000Z");
    const copy = conflictCopyPath("Notes/Topic.md", "Desk:One", at);
    expect(copy).toBe(
      "Notes/Topic (conflict-Desk_One-20260728T123456Z).md",
    );
    const record = conflictRecord("Notes/Topic.md", copy, "overlapping edit", at);
    expect(record.path).toBe("00-Inbox/Sync Conflicts/2026-07-28-20260728T123456000Z.md");
    expect(record.content).not.toContain("<<<<<<<");
  });
});
