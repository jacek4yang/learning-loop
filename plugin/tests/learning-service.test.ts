import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";

import { LearningService } from "../src/learning/service";

const FileConstructor = TFile as unknown as new (path: string) => TFile;
const FolderConstructor = TFolder as unknown as new (path: string) => TFolder;

class MemoryLearningApp {
  readonly files = new Map<string, TFile | TFolder>();
  readonly contents = new Map<string, string>();
  readonly frontmatters = new Map<string, Record<string, unknown>>();
  opened: string | undefined;

  readonly vault = {
    getAbstractFileByPath: (path: string): TFile | TFolder | null =>
      this.files.get(normalizePath(path)) ?? null,
    createFolder: (path: string): Promise<TFolder> => {
      const folder = new FolderConstructor(normalizePath(path));
      this.files.set(folder.path, folder);
      return Promise.resolve(folder);
    },
    create: (path: string, content: string): Promise<TFile> => {
      const normalized = normalizePath(path);
      if (this.files.has(normalized)) {
        return Promise.reject(new Error("exists"));
      }
      const file = new FileConstructor(normalized);
      this.files.set(normalized, file);
      this.contents.set(normalized, content);
      return Promise.resolve(file);
    },
    delete: (file: TFile | TFolder): Promise<void> => {
      this.files.delete(file.path);
      this.contents.delete(file.path);
      this.frontmatters.delete(file.path);
      return Promise.resolve();
    },
    read: (file: TFile): Promise<string> =>
      Promise.resolve(this.contents.get(file.path) ?? ""),
    process: (
      file: TFile,
      update: (content: string) => string,
    ): Promise<string> => {
      const next = update(this.contents.get(file.path) ?? "");
      this.contents.set(file.path, next);
      return Promise.resolve(next);
    },
    getMarkdownFiles: (): TFile[] =>
      [...this.files.values()].filter(
        (file): file is TFile =>
          file instanceof TFile && file.extension === "md",
      ),
  };

  readonly fileManager = {
    processFrontMatter: (
      file: TFile,
      update: (properties: Record<string, unknown>) => void,
    ): Promise<void> => {
      const properties = {
        ...(this.frontmatters.get(file.path) ?? {}),
      };
      update(properties);
      this.frontmatters.set(file.path, properties);
      return Promise.resolve();
    },
  };

  readonly metadataCache = {
    getFileCache: (file: TFile): {
      readonly frontmatter: Record<string, unknown>;
    } | null => {
      const frontmatter = this.frontmatters.get(file.path);
      return frontmatter === undefined ? null : { frontmatter };
    },
  };

  readonly workspace = {
    getLeaf: (): {
      readonly openFile: (file: TFile) => Promise<void>;
    } => ({
      openFile: (file: TFile): Promise<void> => {
        this.opened = file.path;
        return Promise.resolve();
      },
    }),
  };

  asApp(): App {
    return this as unknown as App;
  }
}

describe("LearningService Markdown-first integration", () => {
  it("creates a topic tree and rebuildable maps without overwriting thought maps", async () => {
    const app = new MemoryLearningApp();
    const service = new LearningService(
      app.asApp(),
      () => new Date("2026-07-28T01:02:03Z"),
    );
    const result = await service.createTopic(
      "Distributed Systems",
      "# Replication\n- [ ] Quorums\n- [x] Logs",
    );

    expect(result.nodes).toHaveLength(3);
    expect(app.frontmatters.get(result.topic.path)).toMatchObject({
      cssclasses: ["learning-loop-note"],
      ll_type: "topic",
      ll_status: "active",
    });
    expect(result.nodes.map((file) =>
      app.frontmatters.get(file.path)?.ll_type
    )).toEqual(["node", "node", "node"]);
    await service.relateNodes(result.nodes[1]!, result.nodes[2]!);
    const structure = "70-Maps/Distributed Systems - Structure.canvas";
    const thinking = "70-Maps/Distributed Systems - Thinking.canvas";
    expect(app.contents.has(structure)).toBe(true);
    expect(
      app.contents.get("70-Maps/Distributed Systems - Relations.canvas"),
    ).toContain("\"edges\": [\n    {");
    app.contents.set(thinking, "{\"manual\":true}\n");
    const structureFile = app.files.get(structure);
    if (!(structureFile instanceof TFile)) {
      throw new Error("missing generated structure map");
    }
    await app.vault.delete(structureFile);
    await service.generateAllMaps();
    expect(app.contents.has(structure)).toBe(true);
    expect(app.contents.get(thinking)).toBe("{\"manual\":true}\n");
  });

  it("stores deterministic review metadata in card Properties", async () => {
    const app = new MemoryLearningApp();
    const service = new LearningService(
      app.asApp(),
      () => new Date("2026-07-28T01:02:03Z"),
    );
    const card = await service.createCard(
      "Quorum definition",
      "定义",
      "What is a quorum?",
      "An intersecting voting set.",
    );
    expect(app.frontmatters.get(card.path)).toMatchObject({
      ll_type: "card",
      ll_due: "2026-07-28",
      ll_interval: 0,
      ll_ease: 2300,
    });
    await service.rateCard(card, "掌握");
    expect(app.frontmatters.get(card.path)).toMatchObject({
      ll_due: "2026-07-31",
      ll_interval: 3,
      ll_repetitions: 1,
      ll_last_grade: "掌握",
    });
  });

  it("hides implementation metadata on existing notes without removing user styles", async () => {
    const app = new MemoryLearningApp();
    const existing = await app.vault.create(
      "10-Topics/Existing topic.md",
      "# Existing topic\n",
    );
    app.frontmatters.set(existing.path, {
      ll_type: "topic",
      ll_id: "existing-topic",
      cssclasses: ["wide-page"],
    });
    const service = new LearningService(app.asApp());

    await service.initializeVault();

    expect(app.frontmatters.get(existing.path)).toMatchObject({
      cssclasses: ["wide-page", "learning-loop-note"],
      ll_type: "topic",
      ll_id: "existing-topic",
    });
  });

  it("refuses likely credentials in operations titles", () => {
    const service = new LearningService(new MemoryLearningApp().asApp());
    expect(() =>
      service.createOperationsRecord(
        "server",
        "password = should-never-live-here",
      ),
    ).toThrow("possible password");
  });
});
