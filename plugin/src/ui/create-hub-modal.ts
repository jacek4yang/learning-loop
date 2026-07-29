import {
  Modal,
  setIcon,
  type App,
} from "obsidian";

export interface CreateHubActions {
  createTopic(): Promise<void>;
  createNode(): Promise<void>;
  createCard(): Promise<void>;
  createEnglishTerm(): Promise<void>;
  createPaper(): Promise<void>;
  createOperationsRecord(): Promise<void>;
}

export function openCreateHub(
  app: App,
  actions: CreateHubActions,
): void {
  new CreateHubModal(app, actions).open();
}

class CreateHubModal extends Modal {
  constructor(
    app: App,
    private readonly actions: CreateHubActions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("创建学习内容");
    this.modalEl.addClass("learning-loop-form-modal");
    this.contentEl.addClass("learning-loop-create-hub");

    const hero = this.contentEl.createDiv({
      cls: "learning-loop-modal-hero",
    });
    const icon = hero.createDiv({ cls: "learning-loop-modal-hero-icon" });
    setIcon(icon, "sparkles");
    const copy = hero.createDiv();
    copy.createEl("span", {
      cls: "learning-loop-modal-eyebrow",
      text: "从你现在拥有的材料开始",
    });
    copy.createEl("h3", { text: "今天要创建什么？" });
    copy.createEl("p", {
      text: "每种内容都有固定结构，创建后会自动进入知识树与加密同步。",
    });

    const grid = this.contentEl.createDiv({
      cls: "learning-loop-create-grid",
    });
    this.addAction(
      grid,
      "学习主题",
      "用一个目标组织完整知识树",
      "network",
      "紫色",
      () => this.actions.createTopic(),
    );
    this.addAction(
      grid,
      "知识节点",
      "只解决一个清晰的问题",
      "git-branch-plus",
      "蓝色",
      () => this.actions.createNode(),
    );
    this.addAction(
      grid,
      "复习卡",
      "把关键知识转成主动回忆",
      "gallery-horizontal-end",
      "绿色",
      () => this.actions.createCard(),
    );
    this.addAction(
      grid,
      "英文词汇",
      "记录语境、含义与挖空练习",
      "languages",
      "橙色",
      () => this.actions.createEnglishTerm(),
    );
    this.addAction(
      grid,
      "论文笔记",
      "拆解问题、方法、实验与局限",
      "file-search-2",
      "青色",
      () => this.actions.createPaper(),
    );
    this.addAction(
      grid,
      "技术运行记录",
      "记录服务、变更、故障和操作步骤",
      "server-cog",
      "红色",
      () => this.actions.createOperationsRecord(),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private addAction(
    container: HTMLElement,
    title: string,
    description: string,
    iconName: string,
    accentLabel: string,
    action: () => Promise<void>,
  ): void {
    const button = container.createEl("button", {
      cls: "learning-loop-create-card",
      attr: {
        type: "button",
        "aria-label": `${title}，${description}，${accentLabel}分类`,
      },
    });
    const icon = button.createSpan({
      cls: "learning-loop-create-card-icon",
    });
    setIcon(icon, iconName);
    const copy = button.createSpan({
      cls: "learning-loop-create-card-copy",
    });
    copy.createEl("strong", { text: title });
    copy.createEl("small", { text: description });
    const arrow = button.createSpan({
      cls: "learning-loop-create-card-arrow",
    });
    setIcon(arrow, "arrow-right");
    button.addEventListener("click", () => {
      this.close();
      globalThis.setTimeout(() => {
        void action();
      }, 0);
    });
  }
}
