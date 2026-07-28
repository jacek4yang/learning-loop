import {
  Modal,
  Setting,
  type App,
} from "obsidian";

import type { SyncStatus } from "../sync/controller";

export interface MobileSyncActions {
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
    this.setTitle("Learning Loop sync");
    this.contentEl.addClass("learning-loop-mobile-panel");
    this.statusElement = this.contentEl.createDiv({
      cls: "learning-loop-mobile-status",
      attr: {
        role: "status",
        "aria-live": "polite",
      },
    });
    this.renderStatus();
    this.addAction("Unlock", "Unlock keys in memory for this foreground session.", () =>
      this.actions.unlock());
    this.addAction("Sync now", "Run pull, merge, reconciliation, and resumable upload.", () =>
      this.actions.syncNow(), true);
    this.addAction("Lock", "Clear in-memory keys and stop synchronization.", () => {
      this.actions.lock();
      return Promise.resolve();
    });
    new Setting(this.contentEl).addButton((button) => {
      button.setButtonText("Close").onClick(() => {
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
      locked: "Locked",
      connecting: "Connecting",
      waiting: "Waiting to sync",
      syncing: "Syncing now",
      synced: "Synced",
      error: "Needs attention",
    }[this.status];
    this.statusElement.dataset.syncState = this.status;
    this.statusElement.setText(
      this.detail === undefined ? label : `${label}: ${this.detail}`,
    );
  }
}
