import {
  Platform,
  TFile,
  TFolder,
  normalizePath,
  type App,
} from "obsidian";

import {
  buildRelationMap,
  buildStructureMap,
  encodeCanvas,
} from "./maps";
import { appendToSection, replaceSection } from "./markdown";
import { flattenOutline, parseMarkdownOutline } from "./outline";
import {
  initialReviewState,
  isDue,
  scheduleReview,
  type ReviewState,
} from "./review";
import {
  CARD_TYPES,
  ENGLISH_TEMPLATE,
  LEARNING_FOLDERS,
  NODE_TEMPLATE,
  OPERATIONS_TEMPLATES,
  PAPER_TEMPLATE,
  type CardType,
  type LearningNode,
  type LearningObjectType,
  type ReviewGrade,
} from "./schema";
import { rejectLikelySecrets } from "./secrets";

const AUTO_MAP_SUFFIXES = [
  " - Structure.canvas",
  " - Relations.canvas",
  " - Mobile Path.canvas",
  " - Focus.canvas",
] as const;

type Properties = Record<string, unknown>;
type OperationsKind = keyof typeof OPERATIONS_TEMPLATES;

export interface TopicCreationResult {
  readonly topic: TFile;
  readonly nodes: readonly TFile[];
}

export class LearningService {
  private readonly propertyOverrides = new Map<string, Properties>();

  constructor(
    private readonly app: App,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initializeVault(): Promise<void> {
    for (const folder of LEARNING_FOLDERS) {
      await this.ensureFolder(folder);
    }
    await this.ensureTemplate("Knowledge Node.md", NODE_TEMPLATE);
    await this.ensureTemplate("English Term.md", ENGLISH_TEMPLATE);
    await this.ensureTemplate("Paper.md", PAPER_TEMPLATE);
    await this.applyDisplayDefaults();
  }

  metadataChanged(file: TFile): void {
    this.propertyOverrides.delete(file.path);
  }

  async createTopic(
    title: string,
    markdownOutline = "",
  ): Promise<TopicCreationResult> {
    await this.initializeVault();
    const topicId = randomId();
    const topic = await this.createMarkdown(
      "10-Topics",
      title,
      "topic",
      [
        `# ${cleanTitle(title)}`,
        "",
        "## 学习目标",
        "",
        "## 学习树",
        "",
        "## 当前节点",
        "",
      ].join("\n"),
      {
        ll_id: topicId,
        ll_status: "active",
      },
    );
    const nodes = markdownOutline.trim() === ""
      ? []
      : await this.importOutline(topic, markdownOutline);
    await this.generateTopicMaps(topic);
    return { topic, nodes };
  }

  async importOutline(
    topic: TFile,
    markdown: string,
  ): Promise<readonly TFile[]> {
    const topicProperties = this.requireType(topic, "topic");
    const topicId = propertyString(topicProperties, "ll_id");
    const flattened = flattenOutline(parseMarkdownOutline(markdown));
    if (flattened.length === 0) {
      throw new Error("the outline contains no headings or task items");
    }
    const created: TFile[] = [];
    const ids: string[] = [];
    for (const item of flattened) {
      const id = randomId();
      ids.push(id);
      const parentId = item.parentIndex === undefined
        ? undefined
        : ids[item.parentIndex];
      const node = await this.createMarkdown(
        "20-Nodes",
        item.node.title,
        "node",
        NODE_TEMPLATE,
        {
          ll_id: id,
          ll_topic: topicId,
          ...(parentId === undefined ? {} : { ll_parent: parentId }),
          ll_order: item.order,
          ll_status: item.node.completed ? "mastered" : "learning",
          ll_confidence: item.node.completed ? "high" : "medium",
          ll_verified: item.node.completed,
          ll_review: false,
          ll_mastered: item.node.completed,
        },
      );
      created.push(node);
    }
    const currentIndex = flattened.findIndex((item) => !item.node.completed);
    const current = created[currentIndex < 0 ? 0 : currentIndex];
    if (current !== undefined) {
      await this.setCurrentNode(current);
    }
    const tree = outlineLinks(flattened, created);
    await this.app.vault.process(topic, (content) =>
      replaceSection(content, "学习树", tree));
    await this.generateTopicMaps(topic);
    return created;
  }

  async createNode(
    title: string,
    topic: TFile,
    parent?: TFile,
    initialContent = "",
  ): Promise<TFile> {
    const topicId = propertyString(this.requireType(topic, "topic"), "ll_id");
    const parentId = parent === undefined
      ? undefined
      : propertyString(this.requireType(parent, "node"), "ll_id");
    if (
      parent !== undefined
      && propertyString(this.properties(parent), "ll_topic") !== topicId
    ) {
      throw new Error("parent node belongs to another topic");
    }
    const node = await this.createMarkdown(
      "20-Nodes",
      title,
      "node",
      initialContent.trim() === ""
        ? NODE_TEMPLATE
        : `${NODE_TEMPLATE}\n## 初始材料\n\n${initialContent.trim()}\n`,
      {
        ll_id: randomId(),
        ll_topic: topicId,
        ...(parentId === undefined ? {} : { ll_parent: parentId }),
        ll_order: this.nextSiblingOrder(topicId, parentId),
        ll_status: "learning",
        ll_confidence: "medium",
        ll_verified: false,
        ll_review: false,
        ll_mastered: false,
      },
    );
    await this.refreshTopicTree(topic);
    await this.generateTopicMaps(topic);
    return node;
  }

  async setCurrentNode(node: TFile): Promise<void> {
    const properties = this.requireType(node, "node");
    const topicId = propertyString(properties, "ll_topic");
    const nodeId = propertyString(properties, "ll_id");
    for (const candidate of this.filesByType("node")) {
      const candidateProperties = this.properties(candidate);
      if (propertyStringOptional(candidateProperties, "ll_topic") === topicId) {
        await this.updateProperties(candidate, {
          ll_current: propertyStringOptional(candidateProperties, "ll_id") === nodeId,
        });
      }
    }
    const topic = this.findById(topicId, "topic");
    await this.updateProperties(topic, { ll_current_node: nodeId });
    await this.app.vault.process(topic, (content) =>
      replaceSection(
        content,
        "当前节点",
        `[[${withoutMarkdown(node.path)}|${node.basename}]]`,
      ));
    await this.generateTopicMaps(topic);
  }

  currentNode(): TFile | undefined {
    return this.filesByType("node").find(
      (file) => this.properties(file).ll_current === true,
    );
  }

  async continueCurrentNode(): Promise<TFile> {
    const current = this.currentNode();
    if (current === undefined) {
      throw new Error("no current learning node is selected");
    }
    await this.app.workspace.getLeaf(false).openFile(current);
    return current;
  }

  async addInlineQuestion(node: TFile, question: string): Promise<void> {
    this.requireType(node, "node");
    rejectLikelySecrets(question);
    await this.app.vault.process(node, (content) =>
      appendToSection(content, "待探索", `- [ ] ${cleanInline(question)}`));
  }

  async promoteQuestion(
    node: TFile,
    question: string,
  ): Promise<TFile> {
    const properties = this.requireType(node, "node");
    const topic = this.findById(
      propertyString(properties, "ll_topic"),
      "topic",
    );
    const child = await this.createNode(question, topic, node);
    await this.app.vault.process(node, (content) =>
      appendToSection(
        content,
        "待探索",
        `- [[${withoutMarkdown(child.path)}|${child.basename}]]`,
      ));
    return child;
  }

  async moveNode(node: TFile, newParent?: TFile): Promise<void> {
    const nodeProperties = this.requireType(node, "node");
    const topicId = propertyString(nodeProperties, "ll_topic");
    const nodeId = propertyString(nodeProperties, "ll_id");
    let parentId: string | undefined;
    if (newParent !== undefined) {
      const parentProperties = this.requireType(newParent, "node");
      if (propertyString(parentProperties, "ll_topic") !== topicId) {
        throw new Error("new parent belongs to another topic");
      }
      parentId = propertyString(parentProperties, "ll_id");
      if (parentId === nodeId || this.isDescendant(parentId, nodeId)) {
        throw new Error("moving the node would create a cycle");
      }
    }
    await this.updateProperties(node, {
      ll_parent: parentId ?? null,
      ll_order: this.nextSiblingOrder(topicId, parentId),
    });
    const topic = this.findById(topicId, "topic");
    await this.refreshTopicTree(topic);
    await this.generateTopicMaps(topic);
  }

  async reorderNode(node: TFile, direction: -1 | 1): Promise<void> {
    const properties = this.requireType(node, "node");
    const topicId = propertyString(properties, "ll_topic");
    const parentId = propertyStringOptional(properties, "ll_parent");
    const siblings = this.learningNodes(topicId)
      .filter((candidate) => candidate.parent === parentId)
      .sort(compareLearningNode);
    const nodeId = propertyString(properties, "ll_id");
    const index = siblings.findIndex((candidate) => candidate.id === nodeId);
    const other = siblings[index + direction];
    if (index < 0 || other === undefined) {
      return;
    }
    const nodeOrder = siblings[index]?.order ?? index;
    await this.updateProperties(node, { ll_order: other.order });
    await this.updateProperties(this.requireFile(other.path), {
      ll_order: nodeOrder,
    });
    const topic = this.findById(topicId, "topic");
    await this.refreshTopicTree(topic);
    await this.generateTopicMaps(topic);
  }

  async mergeNodes(source: TFile, target: TFile): Promise<void> {
    const sourceProperties = this.requireType(source, "node");
    const targetProperties = this.requireType(target, "node");
    const topicId = propertyString(sourceProperties, "ll_topic");
    if (propertyString(targetProperties, "ll_topic") !== topicId) {
      throw new Error("nodes from different topics cannot be merged");
    }
    const sourceId = propertyString(sourceProperties, "ll_id");
    const targetId = propertyString(targetProperties, "ll_id");
    if (sourceId === targetId) {
      throw new Error("a node cannot be merged into itself");
    }
    const sourceContent = await this.app.vault.read(source);
    rejectLikelySecrets(sourceContent);
    await this.app.vault.process(target, (content) =>
      appendToSection(
        content,
        "修正记录",
        [
          `### ${this.now().toISOString()} 合并自 [[${withoutMarkdown(source.path)}]]`,
          "",
          sourceContent,
        ].join("\n"),
      ));
    for (const child of this.filesByType("node")) {
      if (propertyStringOptional(this.properties(child), "ll_parent") === sourceId) {
        await this.updateProperties(child, { ll_parent: targetId });
      }
    }
    await this.updateProperties(source, {
      ll_status: "merged",
      ll_merged_into: targetId,
      ll_current: false,
    });
    const topic = this.findById(topicId, "topic");
    await this.refreshTopicTree(topic);
    await this.generateTopicMaps(topic);
  }

  async splitNode(
    source: TFile,
    title: string,
    selectedContent: string,
  ): Promise<TFile> {
    rejectLikelySecrets(selectedContent);
    const properties = this.requireType(source, "node");
    const topic = this.findById(
      propertyString(properties, "ll_topic"),
      "topic",
    );
    const child = await this.createNode(title, topic, source, selectedContent);
    await this.app.vault.process(source, (content) =>
      appendToSection(
        content,
        "相关知识",
        `- [[${withoutMarkdown(child.path)}|${child.basename}]]`,
      ));
    return child;
  }

  async relateNodes(left: TFile, right: TFile): Promise<void> {
    const leftProperties = this.requireType(left, "node");
    const rightProperties = this.requireType(right, "node");
    const topicId = propertyString(leftProperties, "ll_topic");
    if (propertyString(rightProperties, "ll_topic") !== topicId) {
      throw new Error("related nodes must belong to the same topic");
    }
    const leftId = propertyString(leftProperties, "ll_id");
    const rightId = propertyString(rightProperties, "ll_id");
    if (leftId === rightId) {
      throw new Error("a node cannot relate to itself");
    }
    await this.updateProperties(left, {
      ll_related: uniqueStrings([
        ...propertyStringArray(leftProperties, "ll_related"),
        rightId,
      ]),
    });
    await this.updateProperties(right, {
      ll_related: uniqueStrings([
        ...propertyStringArray(rightProperties, "ll_related"),
        leftId,
      ]),
    });
    await this.app.vault.process(left, (content) =>
      appendToSection(
        content,
        "相关知识",
        `- [[${withoutMarkdown(right.path)}|${right.basename}]]`,
      ));
    await this.app.vault.process(right, (content) =>
      appendToSection(
        content,
        "相关知识",
        `- [[${withoutMarkdown(left.path)}|${left.basename}]]`,
      ));
    await this.generateTopicMaps(this.findById(topicId, "topic"));
  }

  async recordCorrection(node: TFile, correction: string): Promise<void> {
    this.requireType(node, "node");
    rejectLikelySecrets(correction);
    await this.app.vault.process(node, (content) =>
      appendToSection(
        content,
        "修正记录",
        `- ${this.now().toISOString()}: ${cleanInline(correction)}`,
      ));
  }

  async markNode(
    node: TFile,
    change: {
      readonly verified?: boolean;
      readonly confidence?: "low" | "medium" | "high";
      readonly review?: boolean;
      readonly mastered?: boolean;
    },
  ): Promise<void> {
    this.requireType(node, "node");
    await this.updateProperties(node, {
      ...(change.verified === undefined ? {} : { ll_verified: change.verified }),
      ...(change.confidence === undefined
        ? {}
        : { ll_confidence: change.confidence }),
      ...(change.review === undefined ? {} : { ll_review: change.review }),
      ...(change.mastered === undefined
        ? {}
        : {
          ll_mastered: change.mastered,
          ll_status: change.mastered ? "mastered" : "learning",
        }),
    });
    if (change.review === true) {
      const source = withoutMarkdown(node.path);
      const existing = this.filesByType("card").some(
        (card) =>
          propertyStringOptional(this.properties(card), "ll_source") === source,
      );
      if (!existing) {
        const title = propertyStringOptional(
          this.properties(node),
          "ll_title",
        ) ?? node.basename;
        await this.createCard(
          `${title} · 原理`,
          "原理",
          `解释 “${title}” 的原理、边界和一个例子。`,
          `参见 [[${source}|${node.basename}]]`,
          node,
        );
      }
    }
    if (change.mastered !== undefined) {
      const topic = this.topicForNode(node);
      await this.refreshTopicTree(topic);
      await this.generateTopicMaps(topic);
    }
  }

  async createEnglishTerm(title: string): Promise<TFile> {
    const term = await this.createMarkdown(
      "20-Nodes",
      title,
      "node",
      ENGLISH_TEMPLATE,
      {
        ll_id: randomId(),
        ll_domain: "english",
        ll_status: "learning",
        ll_review: true,
      },
    );
    await this.createCard(
      `${title} · 英文术语`,
      "英文术语",
      `解释术语 “${cleanTitle(title)}”，并给出自己的例句。`,
      `参见 [[${withoutMarkdown(term.path)}|${term.basename}]]`,
      term,
    );
    return term;
  }

  createPaper(title: string): Promise<TFile> {
    return this.createMarkdown(
      "30-Sources/Papers",
      title,
      "source",
      PAPER_TEMPLATE,
      {
        ll_id: randomId(),
        ll_source_kind: "paper",
        ll_status: "reading",
      },
    );
  }

  createOperationsRecord(
    kind: OperationsKind,
    title: string,
  ): Promise<TFile> {
    rejectLikelySecrets(title);
    const folder = {
      server: "50-Assets/Servers",
      service: "50-Assets/Services",
      database: "50-Assets/Databases",
      change: "40-Records/Changes",
      incident: "40-Records/Incidents",
      runbook: "40-Records",
    }[kind];
    const objectType: LearningObjectType =
      kind === "server" || kind === "service" || kind === "database"
        ? "asset"
        : "record";
    return this.createMarkdown(
      folder,
      title,
      objectType,
      OPERATIONS_TEMPLATES[kind],
      {
        ll_id: randomId(),
        ll_record_kind: kind,
        ll_status: "active",
      },
    );
  }

  async createCard(
    title: string,
    cardType: CardType,
    prompt: string,
    answer: string,
    source?: TFile,
  ): Promise<TFile> {
    if (!CARD_TYPES.includes(cardType)) {
      throw new Error("unsupported review card type");
    }
    rejectLikelySecrets(`${prompt}\n${answer}`);
    const today = localDate(this.now());
    const review = initialReviewState(today);
    return this.createMarkdown(
      "60-Cards",
      title,
      "card",
      [
        "## 提示",
        "",
        prompt.trim(),
        "",
        "## 答案",
        "",
        answer.trim(),
        "",
      ].join("\n"),
      {
        ll_id: randomId(),
        ll_card_type: cardType,
        ...(source === undefined
          ? {}
          : { ll_source: withoutMarkdown(source.path) }),
        ll_due: review.due,
        ll_interval: review.intervalDays,
        ll_ease: review.easePermille,
        ll_repetitions: review.repetitions,
      },
    );
  }

  dueCards(date = localDate(this.now())): TFile[] {
    return this.filesByType("card")
      .filter((file) => isDue(reviewState(this.properties(file), date), date))
      .sort((left, right) => left.path.localeCompare(right.path, "und"));
  }

  async rateCard(card: TFile, grade: ReviewGrade): Promise<ReviewState> {
    this.requireType(card, "card");
    const today = localDate(this.now());
    const next = scheduleReview(reviewState(this.properties(card), today), grade, today);
    await this.updateProperties(card, {
      ll_due: next.due,
      ll_interval: next.intervalDays,
      ll_ease: next.easePermille,
      ll_repetitions: next.repetitions,
      ll_last_reviewed: next.lastReviewed,
      ll_last_grade: grade,
    });
    return next;
  }

  async openTodayDashboard(): Promise<TFile> {
    await this.ensureFolder("80-Daily");
    const today = localDate(this.now());
    const due = this.dueCards(today);
    const current = this.currentNode();
    const body = [
      `# Learning Loop · ${today}`,
      "",
      "## 当前节点",
      "",
      current === undefined
        ? "尚未设置当前节点。"
        : `- [[${withoutMarkdown(current.path)}|${current.basename}]]`,
      "",
      "## 今日复习",
      "",
      ...(due.length === 0
        ? ["没有到期卡片。"]
        : due.map((file) => `- [ ] [[${withoutMarkdown(file.path)}|${file.basename}]]`)),
      "",
      "## 快速问题",
      "",
      "- ",
      "",
    ].join("\n");
    const path = normalizePath(`80-Daily/${today} Learning Loop.md`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    let file: TFile;
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => body);
      file = existing;
    } else if (existing === null) {
      file = await this.app.vault.create(path, body);
      await this.updateProperties(file, {
        ll_id: randomId(),
        ll_type: "record",
        ll_record_kind: "daily",
        ll_created: this.now().toISOString(),
      });
    } else {
      throw new Error("a folder blocks today's dashboard");
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    return file;
  }

  topics(): TFile[] {
    return this.filesByType("topic")
      .sort((left, right) => left.path.localeCompare(right.path, "und"));
  }

  nodes(): TFile[] {
    return this.filesByType("node")
      .sort((left, right) => left.path.localeCompare(right.path, "und"));
  }

  topicForNode(node: TFile): TFile {
    return this.findById(
      propertyString(this.requireType(node, "node"), "ll_topic"),
      "topic",
    );
  }

  isType(file: TFile, type: LearningObjectType): boolean {
    return this.properties(file).ll_type === type;
  }

  async updateCurrentUnderstanding(sentence: string): Promise<void> {
    const current = this.currentNode();
    if (current === undefined) {
      throw new Error("no current learning node is selected");
    }
    rejectLikelySecrets(sentence);
    await this.app.vault.process(current, (content) =>
      appendToSection(
        content,
        "当前理解",
        `- ${cleanInline(sentence)}`,
      ));
  }

  async extractToNode(
    source: TFile,
    topic: TFile,
    title: string,
    selectedContent = "",
  ): Promise<TFile> {
    const sourceType = this.properties(source).ll_type;
    if (sourceType !== "source" && sourceType !== "record") {
      throw new Error("only a source or operations record can be distilled");
    }
    const material = selectedContent.trim() === ""
      ? `来源：[[${withoutMarkdown(source.path)}|${source.basename}]]`
      : [
        selectedContent.trim(),
        "",
        `来源：[[${withoutMarkdown(source.path)}|${source.basename}]]`,
      ].join("\n");
    return this.createNode(title, topic, undefined, material);
  }

  async openCurrentPathMap(): Promise<TFile> {
    const current = this.currentNode();
    if (current === undefined) {
      throw new Error("no current learning node is selected");
    }
    const topic = this.findById(
      propertyString(this.properties(current), "ll_topic"),
      "topic",
    );
    await this.generateTopicMaps(topic);
    const suffix = Platform.isMobile
      ? " - Mobile Path.canvas"
      : " - Structure.canvas";
    const path = normalizePath(`70-Maps/${safeFilename(topic.basename)}${suffix}`);
    const map = this.requireFile(path);
    await this.app.workspace.getLeaf(false).openFile(map);
    return map;
  }

  async openFirstRunbook(): Promise<TFile> {
    const runbook = this.filesByType("record")
      .filter((file) => this.properties(file).ll_record_kind === "runbook")
      .sort((left, right) => left.path.localeCompare(right.path, "und"))[0];
    if (runbook === undefined) {
      throw new Error("no runbook exists");
    }
    await this.app.workspace.getLeaf(false).openFile(runbook);
    return runbook;
  }

  async generateAllMaps(): Promise<void> {
    await this.applyDisplayDefaults();
    for (const topic of this.filesByType("topic")) {
      await this.generateTopicMaps(topic);
    }
  }

  async generateTopicMaps(topic: TFile): Promise<void> {
    await this.ensureFolder("70-Maps");
    const topicId = propertyString(this.requireType(topic, "topic"), "ll_id");
    const nodes = this.learningNodes(topicId);
    const stem = safeFilename(topic.basename);
    await this.writeAutoCanvas(
      `70-Maps/${stem} - Structure.canvas`,
      encodeCanvas(buildStructureMap(nodes, { mobile: false })),
    );
    await this.writeAutoCanvas(
      `70-Maps/${stem} - Relations.canvas`,
      encodeCanvas(buildRelationMap(nodes)),
    );
    const focusId = this.currentNodeId(nodes);
    await this.writeAutoCanvas(
      `70-Maps/${stem} - Mobile Path.canvas`,
      encodeCanvas(buildStructureMap(nodes, {
        mobile: true,
        ...(focusId === undefined
          ? {}
          : { focusId }),
      })),
    );
    if (focusId !== undefined) {
      await this.writeAutoCanvas(
        `70-Maps/${stem} - Focus.canvas`,
        encodeCanvas(buildStructureMap(nodes, {
          mobile: true,
          focusId,
          maximumNodes: 100,
        })),
      );
    }
    const thinkingPath = normalizePath(`70-Maps/${stem} - Thinking.canvas`);
    if (this.app.vault.getAbstractFileByPath(thinkingPath) === null) {
      await this.app.vault.create(
        thinkingPath,
        encodeCanvas({ nodes: [], edges: [] }),
      );
    }
  }

  isDeletedAutoMap(path: string): boolean {
    return path.startsWith("70-Maps/")
      && AUTO_MAP_SUFFIXES.some((suffix) => path.endsWith(suffix));
  }

  private currentNodeId(nodes: readonly LearningNode[]): string | undefined {
    return nodes.find((node) => node.current)?.id;
  }

  private async refreshTopicTree(topic: TFile): Promise<void> {
    const topicId = propertyString(this.requireType(topic, "topic"), "ll_id");
    const nodes = this.learningNodes(topicId);
    const byParent = new Map<string | undefined, LearningNode[]>();
    for (const node of nodes) {
      const group = byParent.get(node.parent) ?? [];
      group.push(node);
      byParent.set(node.parent, group);
    }
    for (const group of byParent.values()) {
      group.sort(compareLearningNode);
    }
    const lines: string[] = [];
    const visited = new Set<string>();
    const render = (node: LearningNode, depth: number): void => {
      if (visited.has(node.id)) {
        return;
      }
      visited.add(node.id);
      const marker = node.status === "mastered" ? "x" : " ";
      lines.push(
        `${"  ".repeat(depth)}- [${marker}] [[${withoutMarkdown(node.path)}|${
          node.title
        }]]`,
      );
      for (const child of byParent.get(node.id) ?? []) {
        render(child, depth + 1);
      }
    };
    for (const root of byParent.get(undefined) ?? []) {
      render(root, 0);
    }
    for (const node of nodes) {
      render(node, 0);
    }
    await this.app.vault.process(topic, (content) =>
      replaceSection(
        content,
        "学习树",
        lines.length === 0 ? "尚未创建节点。" : lines.join("\n"),
      ));
  }

  private learningNodes(topicId: string): LearningNode[] {
    return this.filesByType("node")
      .map((file) => {
        const properties = this.properties(file);
        return {
          id: propertyString(properties, "ll_id"),
          path: file.path,
          title: propertyStringOptional(properties, "ll_title") ?? file.basename,
          topic: propertyStringOptional(properties, "ll_topic") ?? "",
          ...(propertyStringOptional(properties, "ll_parent") === undefined
            ? {}
            : { parent: propertyString(properties, "ll_parent") }),
          order: propertyNumber(properties, "ll_order", 0),
          status: propertyStringOptional(properties, "ll_status") ?? "learning",
          current: properties.ll_current === true,
          related: propertyStringArray(properties, "ll_related"),
        };
      })
      .filter((node) => node.topic === topicId)
      .sort(compareLearningNode);
  }

  private nextSiblingOrder(
    topicId: string,
    parentId: string | undefined,
  ): number {
    const siblings = this.learningNodes(topicId).filter(
      (node) => node.parent === parentId,
    );
    return siblings.reduce((maximum, node) => Math.max(maximum, node.order), -1) + 1;
  }

  private isDescendant(candidateId: string, ancestorId: string): boolean {
    const nodes = new Map(
      this.filesByType("node").map((file) => {
        const properties = this.properties(file);
        return [
          propertyString(properties, "ll_id"),
          propertyStringOptional(properties, "ll_parent"),
        ];
      }),
    );
    let cursor: string | undefined = candidateId;
    const visited = new Set<string>();
    while (cursor !== undefined && !visited.has(cursor)) {
      if (cursor === ancestorId) {
        return true;
      }
      visited.add(cursor);
      cursor = nodes.get(cursor);
    }
    return false;
  }

  private async createMarkdown(
    folder: string,
    title: string,
    type: LearningObjectType,
    body: string,
    properties: Properties,
  ): Promise<TFile> {
    rejectLikelySecrets(`${title}\n${body}`);
    await this.ensureFolder(folder);
    const path = this.uniqueMarkdownPath(folder, title);
    const file = await this.app.vault.create(path, `${body.trimEnd()}\n`);
    try {
      await this.updateProperties(file, {
        cssclasses: ["learning-loop-note"],
        ll_type: type,
        ll_title: cleanTitle(title),
        ll_created: this.now().toISOString(),
        ...properties,
      });
      return file;
    } catch (error) {
      await this.app.vault.delete(file);
      throw error;
    }
  }

  private async ensureTemplate(name: string, content: string): Promise<void> {
    const path = normalizePath(`90-Templates/${name}`);
    if (this.app.vault.getAbstractFileByPath(path) === null) {
      await this.app.vault.create(path, `${content.trimEnd()}\n`);
    }
  }

  private async applyDisplayDefaults(): Promise<void> {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const properties = this.properties(file);
      if (
        !isLearningObjectType(properties.ll_type)
        || cssClasses(properties.cssclasses).includes("learning-loop-note")
      ) {
        continue;
      }
      await this.updateProperties(file, {
        cssclasses: [
          ...cssClasses(properties.cssclasses),
          "learning-loop-note",
        ],
      });
    }
  }

  private async writeAutoCanvas(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => content);
    } else if (existing === null) {
      await this.app.vault.create(normalized, content);
    } else {
      throw new Error("a folder blocks an automatic map");
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const components = normalized.split("/");
    let current = "";
    for (const component of components) {
      current = current === "" ? component : `${current}/${component}`;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing === null) {
        await this.app.vault.createFolder(current);
      } else if (!(existing instanceof TFolder)) {
        throw new Error("a file blocks a Learning Loop folder");
      }
    }
  }

  private uniqueMarkdownPath(folder: string, title: string): string {
    const stem = safeFilename(title);
    let path = normalizePath(`${folder}/${stem}.md`);
    if (this.app.vault.getAbstractFileByPath(path) === null) {
      return path;
    }
    const suffix = randomId().slice(0, 8);
    path = normalizePath(`${folder}/${stem} -- ${suffix}.md`);
    if (this.app.vault.getAbstractFileByPath(path) !== null) {
      throw new Error("could not allocate a unique learning note path");
    }
    return path;
  }

  private filesByType(type: LearningObjectType): TFile[] {
    return this.app.vault.getMarkdownFiles().filter(
      (file) => this.properties(file).ll_type === type,
    );
  }

  private findById(id: string, type: LearningObjectType): TFile {
    const matches = this.filesByType(type).filter(
      (file) => propertyStringOptional(this.properties(file), "ll_id") === id,
    );
    if (matches.length !== 1) {
      throw new Error("learning object ID is missing or duplicated");
    }
    return required(matches[0]);
  }

  private requireFile(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      throw new Error("learning note is missing");
    }
    return file;
  }

  private properties(file: TFile): Properties {
    return {
      ...(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}),
      ...(this.propertyOverrides.get(file.path) ?? {}),
    };
  }

  private requireType(file: TFile, type: LearningObjectType): Properties {
    const properties = this.properties(file);
    if (properties.ll_type !== type) {
      throw new Error(`active note is not a Learning Loop ${type}`);
    }
    return properties;
  }

  private updateProperties(file: TFile, change: Properties): Promise<void> {
    const previous = this.propertyOverrides.get(file.path);
    const next = { ...this.properties(file) };
    applyPropertyChange(next, change);
    this.propertyOverrides.set(file.path, next);
    return this.app.fileManager.processFrontMatter(
      file,
      (frontmatter: Properties) => {
        applyPropertyChange(frontmatter, change);
      },
    ).catch((error: unknown) => {
      if (previous === undefined) {
        this.propertyOverrides.delete(file.path);
      } else {
        this.propertyOverrides.set(file.path, previous);
      }
      throw error;
    });
  }
}

function applyPropertyChange(
  properties: Properties,
  change: Properties,
): void {
  for (const [key, value] of Object.entries(change)) {
    if (value === null || value === undefined) {
      delete properties[key];
    } else {
      properties[key] = value;
    }
  }
}

function cssClasses(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string =>
      typeof entry === "string" && entry.trim() !== ""
    );
  }
  return typeof value === "string" && value.trim() !== ""
    ? value.split(/\s+/u)
    : [];
}

function isLearningObjectType(value: unknown): value is LearningObjectType {
  return [
    "topic",
    "node",
    "source",
    "record",
    "asset",
    "card",
  ].includes(value as LearningObjectType);
}

function outlineLinks(
  items: ReturnType<typeof flattenOutline>,
  files: readonly TFile[],
): string {
  return items.map((item, index) => {
    const file = required(files[index]);
    const depth = ancestorsOf(index, items);
    const marker = item.node.completed ? "x" : " ";
    return `${"  ".repeat(depth)}- [${marker}] [[${withoutMarkdown(file.path)}|${
      item.node.title
    }]]`;
  }).join("\n");
}

function ancestorsOf(
  index: number,
  items: ReturnType<typeof flattenOutline>,
): number {
  let depth = 0;
  let parent = items[index]?.parentIndex;
  const visited = new Set<number>();
  while (parent !== undefined && !visited.has(parent)) {
    visited.add(parent);
    depth += 1;
    parent = items[parent]?.parentIndex;
  }
  return depth;
}

function reviewState(properties: Properties, today: string): ReviewState {
  const configuredDue = propertyStringOptional(properties, "ll_due");
  const due = configuredDue !== undefined && isDate(configuredDue)
    ? configuredDue
    : today;
  return {
    due,
    intervalDays: boundedInteger(
      propertyNumber(properties, "ll_interval", 0),
      0,
      3_650,
    ),
    easePermille: boundedInteger(
      propertyNumber(properties, "ll_ease", 2_300),
      1_300,
      3_000,
    ),
    repetitions: boundedInteger(
      propertyNumber(properties, "ll_repetitions", 0),
      0,
      1_000_000,
    ),
    ...(propertyStringOptional(properties, "ll_last_reviewed") === undefined
      ? {}
      : { lastReviewed: propertyString(properties, "ll_last_reviewed") }),
  };
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

function propertyString(properties: Properties, key: string): string {
  const value = propertyStringOptional(properties, key);
  if (value === undefined) {
    throw new Error(`required property ${key} is missing`);
  }
  return value;
}

function propertyStringOptional(
  properties: Properties,
  key: string,
): string | undefined {
  const value = properties[key];
  return typeof value === "string" && value.trim() !== ""
    ? value
    : undefined;
}

function propertyNumber(
  properties: Properties,
  key: string,
  fallback: number,
): number {
  const value = properties[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function propertyStringArray(properties: Properties, key: string): string[] {
  const value = properties[key];
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function compareLearningNode(left: LearningNode, right: LearningNode): number {
  return left.order - right.order
    || left.title.localeCompare(right.title, "und")
    || left.id.localeCompare(right.id);
}

function safeFilename(value: string): string {
  const normalized = cleanTitle(value)
    .replaceAll(/[<>:"/\\|?*\p{Cc}]/gu, "_")
    .replaceAll(/[ .]+$/gu, "")
    .slice(0, 120);
  if (
    normalized === ""
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(normalized)
  ) {
    return `Learning Note ${randomId().slice(0, 8)}`;
  }
  return normalized;
}

function cleanTitle(value: string): string {
  const title = value.normalize("NFC").trim().replaceAll(/\s+/gu, " ").slice(0, 200);
  if (title === "") {
    throw new Error("title is empty");
  }
  return title;
}

function cleanInline(value: string): string {
  return cleanTitle(value).replaceAll(/[\r\n]+/gu, " ");
}

function withoutMarkdown(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function localDate(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function randomId(): string {
  return crypto.randomUUID();
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("required learning object is absent");
  }
  return value;
}
