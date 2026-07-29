import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  buildRelationMap,
  buildStructureMap,
  encodeCanvas,
} from "../src/learning/maps";
import {
  flattenOutline,
  parseMarkdownOutline,
} from "../src/learning/outline";
import {
  initialReviewState,
  scheduleReview,
} from "../src/learning/review";
import {
  appendToSection,
  replaceSection,
} from "../src/learning/markdown";
import type { LearningNode } from "../src/learning/schema";
import { rejectLikelySecrets } from "../src/learning/secrets";

describe("learning outline", () => {
  it("parses headings and task lists into a stable learning tree", () => {
    const parsed = parseMarkdownOutline([
      "# Networking",
      "- [x] TCP",
      "## Security",
      "- [ ] Noise",
      "```md",
      "# ignored",
      "```",
    ].join("\n"));
    expect(parsed).toEqual([{
      title: "Networking",
      completed: false,
      children: [
        { title: "TCP", completed: true, children: [] },
        {
          title: "Security",
          completed: false,
          children: [{ title: "Noise", completed: false, children: [] }],
        },
      ],
    }]);
    expect(flattenOutline(parsed).map((item) => item.parentIndex)).toEqual([
      undefined,
      0,
      0,
      2,
    ]);
  });
});

describe("review scheduling", () => {
  it("uses only the three specified grades with deterministic UTC dates", () => {
    const initial = initialReviewState("2026-07-28");
    expect(scheduleReview(initial, "不会", "2026-07-28")).toMatchObject({
      due: "2026-07-29",
      intervalDays: 1,
      repetitions: 0,
    });
    expect(scheduleReview(initial, "模糊", "2026-07-28")).toMatchObject({
      due: "2026-07-30",
      intervalDays: 2,
      repetitions: 1,
    });
    expect(scheduleReview(initial, "掌握", "2026-07-28")).toMatchObject({
      due: "2026-07-31",
      intervalDays: 3,
      repetitions: 1,
    });
  });

  it("keeps intervals and ease bounded for arbitrary grade histories", () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom("不会", "模糊", "掌握"), {
        minLength: 1,
        maxLength: 200,
      }),
      (grades) => {
        let state = initialReviewState("2026-01-01");
        for (const grade of grades) {
          state = scheduleReview(state, grade, "2026-01-01");
          expect(state.intervalDays).toBeGreaterThanOrEqual(1);
          expect(state.easePermille).toBeGreaterThanOrEqual(1_300);
          expect(state.easePermille).toBeLessThanOrEqual(3_000);
        }
      },
    ));
  });
});

describe("deterministic maps", () => {
  const nodes: LearningNode[] = [
    {
      id: "child-b",
      path: "20-Nodes/B.md",
      title: "B",
      topic: "topic",
      parent: "root",
      order: 1,
      status: "learning",
      current: false,
      confidence: "medium",
      verified: false,
      mastered: false,
      related: ["child-a"],
    },
    {
      id: "root",
      path: "20-Nodes/Root.md",
      title: "Root",
      topic: "topic",
      order: 0,
      status: "learning",
      current: false,
      confidence: "medium",
      verified: false,
      mastered: false,
      related: [],
    },
    {
      id: "child-a",
      path: "20-Nodes/A.md",
      title: "A",
      topic: "topic",
      parent: "root",
      order: 0,
      status: "learning",
      current: true,
      confidence: "high",
      verified: true,
      mastered: false,
      related: ["child-b"],
    },
  ];

  it("is stable regardless of input ordering and highlights the current node", () => {
    const forward = encodeCanvas(buildStructureMap(nodes, { mobile: false }));
    const reverse = encodeCanvas(
      buildStructureMap([...nodes].reverse(), { mobile: false }),
    );
    expect(reverse).toBe(forward);
    expect(forward).toContain("\"file\": \"20-Nodes/A.md\"");
    expect(forward).toContain("\"color\": \"4\"");
  });

  it("deduplicates undirected relation edges", () => {
    expect(buildRelationMap(nodes).edges).toHaveLength(1);
  });
});

describe("operations secret guard", () => {
  it("rejects obvious credentials and accepts secret-manager references", () => {
    expect(() => {
      rejectLikelySecrets("token = abcdefghijklmnopqrstuvwxyz");
    }).toThrow("possible password");
    expect(() => {
      rejectLikelySecrets("Credential reference: Bitwarden item ops/prod-db");
    }).not.toThrow();
  });
});

describe("Markdown section updates", () => {
  const note = [
    "## 当前理解",
    "",
    "old",
    "",
    "## 为什么",
    "",
    "reason",
    "",
  ].join("\n");

  it("replaces only the selected section", () => {
    expect(replaceSection(note, "当前理解", "new")).toBe([
      "## 当前理解",
      "",
      "new",
      "",
      "## 为什么",
      "",
      "reason",
      "",
    ].join("\n"));
  });

  it("appends without consuming the following heading", () => {
    const updated = appendToSection(note, "当前理解", "- added");
    expect(updated).toContain("old\n- added");
    expect(updated).toContain("## 为什么\n\nreason");
  });
});
