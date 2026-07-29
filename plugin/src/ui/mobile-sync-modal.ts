import {
  Modal,
  Setting,
  type App,
} from "obsidian";

import type { SyncStatus } from "../sync/controller";

export interface MobileSyncActions {
  configure(): Promise<void>;
  reviewToday(): Promise<void>;
  continueNode(): Promise<void>;
  quickQuestion(): Promise<void>;
  recordTerm(): Promise<void>;
  updateUnderstanding(): Promise<void>;
  openCurrentPath(): Promise<void>;
  openRunbook(): Promise<void>;
  unlock(): Promise<void>;
  syncNow(): Promise<void>;
  lock(): void;
}

export class MobileSyncModal extends Modal {
  private statusElement: HTMLElement | undefined;
  private status: SyncStatus;
  private detail: string | undefined;

  constructor(
    app: App,
    private readonly actions: MobileSyncActions,
    initialStatus: SyncStatus,
  ) {
    super(app);
    this.status = initialStatus;
  }

  override onOpen(): void {
    this.setTitle("Learning Loop 快捷面板");
    this.contentEl.addClass("learning-loop-mobile-panel");
    this.statusElement = this.contentEl.createDiv({
      cls: "learning-loop-mobile-status",
      attr: {
        role: "status",
        "aria-live": "polite",
      },
    });
    this.renderStatus();
    this.addAction("今日回顾", "复习今天到期的卡片。", () =>
      this.actions.reviewToday(), true);
    this.addAction("继续当前节点", "回到正在推进的学习问题。", () =>
      this.actions.continueNode());
    this.addAction("快速记录问题", "不离开当前路径，记录一个新疑问。", () =>
      this.actions.quickQuestion());
    this.addAction("记录术语", "创建英语术语和回顾卡片。", () =>
      this.actions.recordTerm());
    this.addAction("补充当前理解", "向当前节点追加一句理解。", () =>
      this.actions.updateUnderstanding());
    this.addAction("当前主题路径", "仅打开当前路径和相邻一层。", () =>
      this.actions.openCurrentPath());
    this.addAction("打开运行手册", "打开一个运维运行手册。", () =>
      this.actions.openRunbook());
    this.addAction("配置同步", "保存服务器信息并建立首次连接。", () =>
      this.actions.configure());
    this.addAction("解锁", "在当前会话内解锁本机密钥。", () =>
      this.actions.unlock());
    this.addAction("立即同步", "执行拉取、合并、协调和断点续传。", () =>
      this.actions.syncNow());
    this.addAction("锁定", "清除内存密钥并停止同步。", () => {
      this.actions.lock();
      return Promise.resolve();
    });
    new Setting(this.contentEl).addButton((button) => {
      button.setButtonText("关闭").onClick(() => {
        this.close();
      });
    });
  }

  override onClose(): void {
    this.statusElement = undefined;
    this.contentEl.empty();
  }

  update(status: SyncStatus, detail?: string): void {
    this.status = status;
    this.detail = detail;
    this.renderStatus();
  }

  private addAction(
    name: string,
    description: string,
    action: () => Promise<void>,
    primary = false,
  ): void {
    new Setting(this.contentEl)
      .setName(name)
      .setDesc(description)
      .addButton((button) => {
        button.setButtonText(name);
        if (primary) {
          button.setCta();
        }
        button.onClick(() => {
          void action();
        });
      });
  }

  private renderStatus(): void {
    if (this.statusElement === undefined) {
      return;
    }
    const label = {
      unconfigured: "尚未配置",
      locked: "已锁定",
      connecting: "正在连接",
      waiting: "等待同步",
      syncing: "正在同步",
      synced: "同步完成",
      error: "需要处理",
    }[this.status];
    this.statusElement.dataset.syncState = this.status;
    this.statusElement.setText(
      this.detail === undefined ? label : `${label}: ${this.detail}`,
    );
  }
}
