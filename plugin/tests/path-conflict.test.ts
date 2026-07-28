import { describe, expect, it } from "vitest";

import {
  portablePathConflictGroups,
  portablePathsConflict,
} from "../src/sync/paths";

const core = {
  collisionKey(path: string): string {
    return path.normalize("NFC").toLocaleLowerCase("und");
  },
};

describe("portable path tree conflicts", () => {
  it("detects exact, case, normalization, and file/directory aliases", () => {
    expect(
      portablePathConflictGroups([
        "Note.md",
        "note.md",
        "é.md",
        "e\u{301}.md",
        "folder",
        "folder/child.md",
      ], core),
    ).toEqual([
      ["e\u{301}.md", "é.md"],
      ["folder", "folder/child.md"],
      ["Note.md", "note.md"],
    ]);
  });

  it("does not confuse lexical prefixes with directory prefixes", () => {
    expect(portablePathsConflict("topic", "topic-note.md", core)).toBe(false);
    expect(portablePathsConflict("topic", "topic/note.md", core)).toBe(true);
  });

  it("consolidates descendants under the conflicting file prefix", () => {
    expect(
      portablePathConflictGroups(
        ["folder", "folder/a.md", "folder/deep/b.md"],
        core,
      ),
    ).toEqual([["folder", "folder/a.md", "folder/deep/b.md"]]);
  });
});
