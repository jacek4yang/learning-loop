import {
  ItemView,
  setIcon,
  type WorkspaceLeaf,
} from "obsidian";

import type {
  LearningTreeNode,
  LearningTreeTopic,
} from "../learning/schema";

export const LEARNING_LOOP_TREE_VIEW = "learning-loop-tree";

export interface TreeViewActions {
  openFile(path: string): Promise<void>;
  createTopic(): Promise<void>;
  copyAiContext(): Promise<void>;
}

export class LearningTreeView extends ItemView {
  private query = "";

  constructor(
    leaf: WorkspaceLeaf,
    private readonly snapshot: () => readonly LearningTreeTopic[],
    private readonly actions: TreeViewActions,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return LEARNING_LOOP_TREE_VIEW;
  }

  getDisplayText(): string {
    return "知识学习树";
  }

  override getIcon(): string {
    return "waypoints";
  }

  override onOpen(): Promise<void> {
    this.render();
    return Promise.resolve();
  }

  update(): void {
    if (this.contentEl.isConnected) {
      this.render();
    }
  }

  private render(): void {
    const topics = this.snapshot();
    this.contentEl.empty();
    this.contentEl.addClass("learning-loop-tree-view");

    const hero = this.contentEl.createDiv({
      cls: "learning-loop-tree-hero",
    });
    const icon = hero.createDiv({ cls: "learning-loop-tree-hero-icon" });
    setIcon(icon, "waypoints");
    const copy = hero.createDiv();
    copy.createEl("span", {
      cls: "learning-loop-tree-eyebrow",
      text: "可视化学习路径",
    });
    copy.createEl("h2", { text: "知识学习树" });
    copy.createEl("p", {
      text: "从问题到证据，再到掌握。点击任意节点即可继续学习。",
    });

    const statistics = treeStatistics(topics);
    const statGrid = this.contentEl.createDiv({
      cls: "learning-loop-tree-statistics",
    });
    this.addStatistic(statGrid, "主题", statistics.topics, "network");
    this.addStatistic(statGrid, "节点", statistics.nodes, "git-branch");
    this.addStatistic(statGrid, "已掌握", statistics.mastered, "badge-check");

    const toolbar = this.contentEl.createDiv({
      cls: "learning-loop-tree-toolbar",
    });
    const search = toolbar.createEl("input", {
      cls: "learning-loop-tree-search",
      attr: {
        type: "search",
        placeholder: "搜索主题或节点…",
        "aria-label": "搜索知识学习树",
      },
    });
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderTopics(topicContainer, topics);
    });
    const copyButton = toolbar.createEl("button", {
      cls: "learning-loop-tree-toolbar-button",
      attr: {
        type: "button",
        "aria-label": "复制当前学习上下文给 AI",
      },
    });
    setIcon(copyButton, "copy");
    copyButton.createSpan({ text: "复制给 AI" });
    copyButton.addEventListener("click", () => {
      void this.actions.copyAiContext();
    });

    const topicContainer = this.contentEl.createDiv({
      cls: "learning-loop-tree-topics",
    });
    this.renderTopics(topicContainer, topics);
  }

  private renderTopics(
    container: HTMLElement,
    topics: readonly LearningTreeTopic[],
  ): void {
    container.empty();
    const query = this.query.trim().toLocaleLowerCase("zh-Hans-CN");
    const filtered = topics
      .map((topic) => filterTopic(topic, query))
      .filter((topic): topic is LearningTreeTopic => topic !== undefined);
    if (filtered.length === 0) {
      const empty = container.createDiv({
        cls: "learning-loop-tree-empty",
      });
      const icon = empty.createDiv();
      setIcon(icon, topics.length === 0 ? "sprout" : "search-x");
      empty.createEl("h3", {
        text: topics.length === 0 ? "从第一个问题开始" : "没有匹配的学习节点",
      });
      empty.createEl("p", {
        text: topics.length === 0
          ? "创建主题并粘贴 Markdown 大纲，Learning Loop 会自动生成这棵树。"
          : "换一个关键词，或清空搜索框查看完整知识树。",
      });
      if (topics.length === 0) {
        const create = empty.createEl("button", {
          cls: "mod-cta",
          text: "创建学习主题",
          attr: { type: "button" },
        });
        create.addEventListener("click", () => {
          void this.actions.createTopic();
        });
      }
      return;
    }
    for (const topic of filtered) {
      this.renderTopic(container, topic);
    }
  }

  private renderTopic(
    container: HTMLElement,
    topic: LearningTreeTopic,
  ): void {
    const card = container.createEl("details", {
      cls: "learning-loop-tree-topic",
      attr: { open: "true" },
    });
    const summary = card.createEl("summary", {
      cls: "learning-loop-tree-topic-summary",
    });
    const titleBlock = summary.createDiv({
      cls: "learning-loop-tree-topic-title",
    });
    titleBlock.createEl("strong", { text: topic.title });
    const percentage = topic.total === 0
      ? 0
      : Math.round(topic.mastered / topic.total * 100);
    titleBlock.createEl("small", {
      text: `${topic.mastered.toString()} / ${topic.total.toString()} 已掌握`,
    });
    const progress = summary.createEl("span", {
      cls: "learning-loop-tree-progress",
      attr: {
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": percentage.toString(),
      },
    });
    progress.createSpan({
      attr: { style: `width: ${percentage.toString()}%` },
    });
    const openTopic = summary.createEl("button", {
      cls: "learning-loop-tree-open",
      attr: {
        type: "button",
        "aria-label": `打开主题 ${topic.title}`,
      },
    });
    setIcon(openTopic, "arrow-up-right");
    openTopic.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.actions.openFile(topic.path);
    });

    const body = card.createDiv({ cls: "learning-loop-tree-topic-body" });
    if (topic.roots.length === 0) {
      body.createEl("p", {
        cls: "learning-loop-tree-topic-empty",
        text: "这个主题还没有节点。打开主题后可以导入 Markdown 大纲。",
      });
      return;
    }
    const list = body.createEl("ul", { cls: "learning-loop-tree-list" });
    for (const node of topic.roots) {
      this.renderNode(list, node);
    }
  }

  private renderNode(container: HTMLElement, node: LearningTreeNode): void {
    const item = container.createEl("li", {
      cls: [
        "learning-loop-tree-node",
        ...(node.current ? ["is-current"] : []),
        ...(node.mastered ? ["is-mastered"] : []),
      ],
    });
    const button = item.createEl("button", {
      cls: "learning-loop-tree-node-button",
      attr: {
        type: "button",
        title: node.current ? "当前正在学习" : "打开学习节点",
      },
    });
    button.createSpan({ cls: "learning-loop-tree-node-dot" });
    const copy = button.createSpan({ cls: "learning-loop-tree-node-copy" });
    copy.createEl("strong", { text: node.title });
    const badges = copy.createSpan({ cls: "learning-loop-tree-node-badges" });
    if (node.current) {
      badges.createSpan({ text: "当前" });
    }
    badges.createSpan({ text: node.verified ? "已核实" : "待核实" });
    badges.createSpan({ text: confidenceLabel(node.confidence) });
    button.addEventListener("click", () => {
      void this.actions.openFile(node.path);
    });
    if (node.children.length > 0) {
      const children = item.createEl("ul", {
        cls: "learning-loop-tree-list",
      });
      for (const child of node.children) {
        this.renderNode(children, child);
      }
    }
  }

  private addStatistic(
    container: HTMLElement,
    label: string,
    value: number,
    iconName: string,
  ): void {
    const card = container.createDiv({
      cls: "learning-loop-tree-statistic",
    });
    const icon = card.createSpan();
    setIcon(icon, iconName);
    const copy = card.createSpan();
    copy.createEl("strong", { text: value.toString() });
    copy.createEl("small", { text: label });
  }
}

function treeStatistics(topics: readonly LearningTreeTopic[]): {
  readonly topics: number;
  readonly nodes: number;
  readonly mastered: number;
} {
  return {
    topics: topics.length,
    nodes: topics.reduce((sum, topic) => sum + topic.total, 0),
    mastered: topics.reduce((sum, topic) => sum + topic.mastered, 0),
  };
}

function filterTopic(
  topic: LearningTreeTopic,
  query: string,
): LearningTreeTopic | undefined {
  if (query === "" || topic.title.toLocaleLowerCase("zh-Hans-CN").includes(query)) {
    return topic;
  }
  const roots = topic.roots
    .map((node) => filterNode(node, query))
    .filter((node): node is LearningTreeNode => node !== undefined);
  return roots.length === 0 ? undefined : { ...topic, roots };
}

function filterNode(
  node: LearningTreeNode,
  query: string,
): LearningTreeNode | undefined {
  const children = node.children
    .map((child) => filterNode(child, query))
    .filter((child): child is LearningTreeNode => child !== undefined);
  return node.title.toLocaleLowerCase("zh-Hans-CN").includes(query)
      || children.length > 0
    ? { ...node, children }
    : undefined;
}

function confidenceLabel(confidence: string): string {
  switch (confidence) {
    case "high":
      return "确信度高";
    case "low":
      return "确信度低";
    default:
      return "确信度中";
  }
}
