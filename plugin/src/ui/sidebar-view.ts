import {
  ItemView,
  setIcon,
  type WorkspaceLeaf,
} from "obsidian";

import type { SyncStatus } from "../sync/controller";

export const LEARNING_LOOP_SIDEBAR_VIEW = "learning-loop-sidebar";

export interface SidebarState {
  readonly status: SyncStatus;
  readonly statusText: string;
  readonly configured: boolean;
  readonly unlocked: boolean;
  readonly serverSummary: string;
  readonly currentNode: string;
  readonly topicCount: number;
  readonly nodeCount: number;
  readonly masteredCount: number;
}

export interface SidebarActions {
  configure(): Promise<void>;
  unlock(): Promise<void>;
  syncNow(): Promise<void>;
  lock(): void;
  initializeVault(): Promise<void>;
  createTopic(): Promise<void>;
  continueNode(): Promise<void>;
  quickQuestion(): Promise<void>;
  reviewToday(): void;
  searchLearning(): Promise<void>;
  openTree(): Promise<void>;
  openCurrentMap(): Promise<void>;
  openToday(): Promise<void>;
  openCreateHub(): void;
  copyAiContext(): Promise<void>;
}

export class LearningLoopSidebarView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly actions: SidebarActions,
    private readonly state: () => SidebarState,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return LEARNING_LOOP_SIDEBAR_VIEW;
  }

  getDisplayText(): string {
    return "Learning Loop";
  }

  override getIcon(): string {
    return "brain-circuit";
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
    const state = this.state();
    this.contentEl.empty();
    this.contentEl.addClass("learning-loop-sidebar");

    const hero = this.contentEl.createDiv({
      cls: "learning-loop-sidebar-hero",
    });
    const icon = hero.createDiv({
      cls: "learning-loop-sidebar-logo",
    });
    setIcon(icon, "brain-circuit");
    const title = hero.createDiv();
    title.createEl("h2", { text: "Learning Loop" });
    title.createEl("p", { text: "从一个问题出发，持续学习、验证和回顾。" });

    const status = this.contentEl.createDiv({
      cls: "learning-loop-sidebar-status",
      attr: {
        role: "status",
        "aria-live": "polite",
      },
    });
    status.dataset.syncState = state.status;
    status.createEl("strong", { text: "同步状态" });
    status.createEl("span", { text: state.statusText });

    const connection = this.contentEl.createDiv({
      cls: "learning-loop-sidebar-connection",
    });
    connection.createEl("span", {
      cls: "learning-loop-sidebar-eyebrow",
      text: state.configured ? "当前设备" : "首次使用",
    });
    connection.createEl("p", { text: state.serverSummary });

    const current = this.contentEl.createDiv({
      cls: "learning-loop-sidebar-current",
    });
    current.createEl("span", {
      cls: "learning-loop-sidebar-eyebrow",
      text: "现在做什么",
    });
    current.createEl("strong", {
      text: state.currentNode,
    });
    current.createEl("small", {
      text: `${state.topicCount.toString()} 个主题 · ${
        state.nodeCount.toString()
      } 个节点 · ${state.masteredCount.toString()} 个已掌握`,
    });

    this.addSectionTitle("学习工作台");
    const tools = this.contentEl.createDiv({
      cls: "learning-loop-sidebar-tools",
    });
    this.addToolAction(tools, "搜索", "search", () => this.actions.searchLearning());
    this.addToolAction(tools, "知识树", "waypoints", () => this.actions.openTree());
    this.addToolAction(tools, "白板", "layout-dashboard", () =>
      this.actions.openCurrentMap());
    this.addToolAction(tools, "今日", "calendar-days", () => this.actions.openToday());
    this.addToolAction(tools, "新建", "square-plus", () => {
      this.actions.openCreateHub();
      return Promise.resolve();
    }, true);
    this.addToolAction(tools, "复制给 AI", "copy", () =>
      this.actions.copyAiContext());

    this.addSectionTitle("下一步");
    const learningActions = this.contentEl.createDiv({
      cls: "learning-loop-sidebar-actions",
    });
    this.addQuickAction(
      learningActions,
      "继续当前节点",
      "回到上次正在推进的问题",
      "route",
      () => this.actions.continueNode(),
      true,
    );
    this.addQuickAction(
      learningActions,
      "快速记录问题",
      "把疑问追加到当前学习节点",
      "circle-help",
      () => this.actions.quickQuestion(),
    );
    this.addQuickAction(
      learningActions,
      "创建学习主题",
      "从标题或 Markdown 大纲开始",
      "network",
      () => this.actions.createTopic(),
    );
    this.addQuickAction(
      learningActions,
      "今日回顾",
      "复习今天到期的卡片",
      "calendar-check-2",
      () => {
        this.actions.reviewToday();
        return Promise.resolve();
      },
    );
    this.addQuickAction(
      learningActions,
      "初始化学习空间",
      "仅创建缺失的文件夹和模板",
      "folder-plus",
      () => this.actions.initializeVault(),
    );

    const syncPanel = this.contentEl.createEl("details", {
      cls: "learning-loop-sidebar-sync-panel",
      attr: state.status === "error" || !state.unlocked
        ? { open: "true" }
        : {},
    });
    const syncSummary = syncPanel.createEl("summary");
    const syncSummaryIcon = syncSummary.createSpan();
    setIcon(syncSummaryIcon, "shield-check");
    syncSummary.createSpan({ text: "同步与安全" });
    const syncActions = syncPanel.createDiv({
      cls: "learning-loop-sidebar-actions",
    });
    this.addQuickAction(
      syncActions,
      state.configured ? "修改配置" : "开始配置",
      state.configured ? "查看已保存的服务器信息" : "连接你的 Learning Loop 服务器",
      "settings-2",
      () => this.actions.configure(),
      !state.configured,
    );
    this.addQuickAction(
      syncActions,
      "解锁",
      "输入客户端密码并立即同步",
      "key-round",
      () => this.actions.unlock(),
      state.configured && !state.unlocked,
      !state.configured || state.unlocked,
    );
    this.addQuickAction(
      syncActions,
      "立即同步",
      state.unlocked ? "拉取、合并并上传更改" : "将先引导配置或解锁",
      "refresh-cw",
      () => this.actions.syncNow(),
      state.unlocked,
    );
    this.addQuickAction(
      syncActions,
      "锁定",
      "清除内存中的本机密钥",
      "lock-keyhole",
      () => {
        this.actions.lock();
        return Promise.resolve();
      },
      false,
      !state.unlocked,
    );

    this.contentEl.createEl("p", {
      cls: "learning-loop-sidebar-hotkey-hint",
      text: "提示：在 Obsidian → 快捷键中搜索“Learning Loop”，可为所有操作绑定自己习惯的按键。",
    });
  }

  private addSectionTitle(title: string): void {
    this.contentEl.createEl("h3", {
      cls: "learning-loop-sidebar-section-title",
      text: title,
    });
  }

  private addQuickAction(
    container: HTMLElement,
    name: string,
    description: string,
    iconName: string,
    action: () => Promise<void>,
    primary = false,
    disabled = false,
  ): void {
    const button = container.createEl("button", {
      cls: [
        "learning-loop-sidebar-action",
        ...(primary ? ["is-primary"] : []),
      ],
      attr: {
        type: "button",
        ...(disabled ? { disabled: "true" } : {}),
      },
    });
    const icon = button.createSpan({
      cls: "learning-loop-sidebar-action-icon",
    });
    setIcon(icon, iconName);
    const copy = button.createSpan({
      cls: "learning-loop-sidebar-action-copy",
    });
    copy.createEl("strong", { text: name });
    copy.createEl("small", { text: description });
    button.addEventListener("click", () => {
      button.disabled = true;
      void action().finally(() => {
        this.render();
      });
    });
  }

  private addToolAction(
    container: HTMLElement,
    name: string,
    iconName: string,
    action: () => Promise<void>,
    primary = false,
  ): void {
    const button = container.createEl("button", {
      cls: [
        "learning-loop-sidebar-tool",
        ...(primary ? ["is-primary"] : []),
      ],
      attr: {
        type: "button",
        "aria-label": name,
      },
    });
    const icon = button.createSpan();
    setIcon(icon, iconName);
    button.createSpan({ text: name });
    button.addEventListener("click", () => {
      button.disabled = true;
      void action().finally(() => {
        button.disabled = false;
      });
    });
  }
}
