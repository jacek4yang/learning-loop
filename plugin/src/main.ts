import {
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  type App,
  type TFile,
} from "obsidian";

import {
  SettingsRepository,
  type ServerSettings,
} from "./settings";
import {
  SyncController,
  type SyncStatus,
} from "./sync/controller";
import {
  requestClientPassword,
  requestSetupCredentials,
} from "./ui/credentials-modal";
import { MobileSyncModal } from "./ui/mobile-sync-modal";

const PERIODIC_SYNC_MS = 5 * 60 * 1000;

export default class LearningLoopPlugin extends Plugin {
  private readonly settingsRepository = new SettingsRepository(this);
  private controller: SyncController | undefined;
  private statusText = "Locked";
  private statusElement: HTMLElement | undefined;
  private mobileSyncModal: MobileSyncModal | undefined;

  override onload(): void {
    this.addRibbonIcon("refresh-cw", "Learning Loop", () => {
      if (Platform.isMobile) {
        this.openMobileSyncPanel();
      } else {
        void this.syncNow();
      }
    });
    this.addCommand({
      id: "configure-encrypted-sync",
      name: "Configure encrypted synchronization",
      callback: () => {
        void this.configure();
      },
    });
    this.addCommand({
      id: "unlock",
      name: "Unlock",
      callback: () => {
        void this.unlock();
      },
    });
    this.addCommand({
      id: "lock",
      name: "Lock",
      callback: () => {
        this.controller?.lock();
      },
    });
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.syncNow();
      },
    });
    this.addCommand({
      id: "open-mobile-sync-panel",
      name: "Open foreground sync panel",
      callback: () => {
        this.openMobileSyncPanel();
      },
    });
    this.addSettingTab(new LearningLoopSettingTab(this.app, this));
    if (Platform.isDesktopApp) {
      this.statusElement = this.addStatusBarItem();
      this.statusElement.setText("Learning Loop: Locked");
    }

    this.app.workspace.onLayoutReady(() => {
      void this.initializeRuntime();
    });
  }

  override onunload(): void {
    this.controller?.lock();
  }

  get statusLabel(): string {
    return this.statusText;
  }

  async currentServer(): Promise<ServerSettings | undefined> {
    return (await this.settingsRepository.load()).server;
  }

  async configure(): Promise<void> {
    const credentials = await requestSetupCredentials(
      this.app,
      await this.currentServer(),
    );
    if (credentials === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.controller).configure(credentials),
      "Encrypted synchronization configured.",
    );
  }

  async unlock(): Promise<void> {
    const password = await requestClientPassword(this.app);
    if (password === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.controller).unlock(password),
      "Learning Loop unlocked.",
    );
  }

  async syncNow(): Promise<void> {
    await this.runUserAction(
      () => required(this.controller).syncNow(),
      "Synchronization complete.",
    );
  }

  lock(): void {
    this.controller?.lock();
  }

  private async initializeRuntime(): Promise<void> {
    this.controller = new SyncController(
      this.app,
      this.manifest.id,
      this.settingsRepository,
      (status, detail) => {
        this.updateStatus(status, detail);
      },
    );
    try {
      await this.controller.initialize();
    } catch {
      this.updateStatus("error", "WASM core could not be loaded");
      new Notice("Learning Loop could not load its cryptographic core.");
      return;
    }
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (isFile(file)) {
        void this.controller?.handleContentEvent(file.path);
      }
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      void this.controller?.handleContentEvent(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.controller?.handlePathEvent(oldPath, file.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.controller?.handlePathEvent(file.path);
    }));
    this.registerInterval(window.setInterval(() => {
      if (
        this.controller?.status !== "locked"
        && this.controller?.status !== "connecting"
        && this.controller?.status !== "syncing"
      ) {
        void this.controller?.syncNow().catch(() => undefined);
      }
    }, PERIODIC_SYNC_MS));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (
        document.visibilityState === "visible"
        && this.controller?.status !== "locked"
        && this.controller?.status !== "connecting"
        && this.controller?.status !== "syncing"
      ) {
        void this.controller?.syncNow().catch(() => undefined);
      }
    });
  }

  private updateStatus(status: SyncStatus, detail?: string): void {
    const label = {
      locked: "Locked",
      connecting: "Connecting",
      waiting: "Waiting to sync",
      syncing: "Syncing",
      synced: "Synced",
      error: "Needs attention",
    }[status];
    this.statusText = detail === undefined ? label : `${label}: ${detail}`;
    this.statusElement?.setText(`Learning Loop: ${this.statusText}`);
    this.mobileSyncModal?.update(status, detail);
  }

  private openMobileSyncPanel(): void {
    if (this.mobileSyncModal !== undefined) {
      this.mobileSyncModal.close();
    }
    this.mobileSyncModal = new MobileSyncModal(
      this.app,
      {
        unlock: () => this.unlock(),
        syncNow: () => this.syncNow(),
        lock: () => {
          this.lock();
        },
      },
      this.controller?.status ?? "locked",
    );
    this.mobileSyncModal.open();
  }

  private async runUserAction(
    action: () => Promise<void>,
    success: string,
  ): Promise<void> {
    try {
      await action();
      new Notice(success);
    } catch (error) {
      new Notice(
        error instanceof Error
          ? `Learning Loop: ${error.message}`
          : "Learning Loop operation failed.",
      );
    }
  }
}

class LearningLoopSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly learningLoop: LearningLoopPlugin) {
    super(app, learningLoop);
  }

  override display(): void {
    this.containerEl.empty();
    this.containerEl.addClass("learning-loop-settings");
    this.containerEl.createEl("h2", { text: "Learning Loop" });
    new Setting(this.containerEl)
      .setName("Synchronization status")
      .setDesc(this.learningLoop.statusLabel);
    new Setting(this.containerEl)
      .setName("Configure this device")
      .setDesc(
        "Enter the DDNS hostname, port, pinned fingerprint, two passwords, and device name.",
      )
      .addButton((button) => {
        button
          .setButtonText("Configure")
          .setCta()
          .onClick(() => {
            void this.learningLoop.configure().then(() => {
              this.display();
            });
          });
      });
    new Setting(this.containerEl)
      .setName("Unlock")
      .setDesc("The client encryption password is never persisted.")
      .addButton((button) => {
        button.setButtonText("Unlock").onClick(() => {
          void this.learningLoop.unlock().then(() => {
            this.display();
          });
        });
      });
    new Setting(this.containerEl)
      .setName("Sync now")
      .setDesc("Runs in the foreground on Android and resumes persisted uploads.")
      .addButton((button) => {
        button.setButtonText("Sync now").onClick(() => {
          void this.learningLoop.syncNow().then(() => {
            this.display();
          });
        });
      });
    new Setting(this.containerEl)
      .setName("Lock")
      .setDesc("Clears in-memory keys and stops synchronization.")
      .addButton((button) => {
        button.setButtonText("Lock").setWarning().onClick(() => {
          this.learningLoop.lock();
          this.display();
        });
      });
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("plugin runtime is not ready");
  }
  return value;
}

function isFile(value: unknown): value is TFile {
  return value !== null
    && typeof value === "object"
    && "stat" in value
    && "extension" in value;
}
