import {
  type Editor,
  type MarkdownFileInfo,
  type MarkdownView,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  type App,
  type TFile,
} from "obsidian";

import { LearningService } from "./learning/service";
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
import {
  openReviewModal,
  requestCardInput,
  requestFile,
  requestText,
  requestTopicInput,
} from "./ui/learning-modals";
import { MobileSyncModal } from "./ui/mobile-sync-modal";

const PERIODIC_SYNC_MS = 5 * 60 * 1000;

export default class LearningLoopPlugin extends Plugin {
  private readonly settingsRepository = new SettingsRepository(this);
  private controller: SyncController | undefined;
  private learning: LearningService | undefined;
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
    this.registerLearningCommands();
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

  async initializeLearningVault(): Promise<void> {
    await this.runUserAction(
      () => required(this.learning).initializeVault(),
      "Learning Loop folders and templates are ready.",
    );
  }

  async createTopic(): Promise<void> {
    const input = await requestTopicInput(this.app);
    if (input === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const result = await required(this.learning).createTopic(
        input.title,
        input.outline,
      );
      await this.app.workspace.getLeaf(false).openFile(result.topic);
    }, "Learning topic created.");
  }

  async continueCurrentNode(): Promise<void> {
    await this.runUserAction(
      () => required(this.learning).continueCurrentNode().then(() => undefined),
      "Opened the current learning node.",
    );
  }

  async quickQuestion(): Promise<void> {
    const question = await requestText(
      this.app,
      "Quick question",
      "Question",
      "Adds an inline question to the current node.",
    );
    if (question === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const node = required(this.learning).currentNode();
      if (node === undefined) {
        throw new Error("no current learning node is selected");
      }
      await required(this.learning).addInlineQuestion(node, question);
    }, "Question recorded.");
  }

  async recordEnglishTerm(): Promise<void> {
    const term = await requestText(
      this.app,
      "Record English term",
      "Word or technical term",
      "Creates the full English template and an interval-review card.",
    );
    if (term === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const file = await required(this.learning).createEnglishTerm(term);
      await this.app.workspace.getLeaf(false).openFile(file);
    }, "English term and review card created.");
  }

  async addCurrentUnderstanding(): Promise<void> {
    const sentence = await requestText(
      this.app,
      "Update current understanding",
      "One sentence",
      "Appends one concise statement without replacing prior understanding.",
    );
    if (sentence === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.learning).updateCurrentUnderstanding(sentence),
      "Current understanding updated.",
    );
  }

  async openCurrentPath(): Promise<void> {
    await this.runUserAction(
      () => required(this.learning).openCurrentPathMap().then(() => undefined),
      "Opened the current topic path.",
    );
  }

  async openRunbook(): Promise<void> {
    await this.runUserAction(
      () => required(this.learning).openFirstRunbook().then(() => undefined),
      "Opened a runbook.",
    );
  }

  openReviews(): void {
    openReviewModal(this.app, required(this.learning));
  }

  private async importOutlineIntoActiveTopic(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (file === null) {
      new Notice("Open a Learning Loop topic first.");
      return;
    }
    const outline = await requestText(
      this.app,
      "Import Markdown outline",
      "Outline",
      "Headings and task lists become nodes.",
      true,
    );
    if (outline === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.learning).importOutline(file, outline).then(() => undefined),
      "Outline imported.",
    );
  }

  private async createNodeFromActiveContext(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active === null) {
      new Notice("Open a topic or parent node first.");
      return;
    }
    const title = await requestText(
      this.app,
      "Create knowledge node",
      "One clear question",
      "Each node should resolve one explicit question.",
    );
    if (title === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const learning = required(this.learning);
      const topic = learning.isType(active, "topic")
        ? active
        : learning.topicForNode(active);
      const parent = learning.isType(active, "node") ? active : undefined;
      const node = await learning.createNode(title, topic, parent);
      await this.app.workspace.getLeaf(false).openFile(node);
    }, "Knowledge node created.");
  }

  private async promoteSelection(
    editor: Editor,
    view: MarkdownView | MarkdownFileInfo,
  ): Promise<void> {
    const file = view.file;
    if (file === null) {
      return;
    }
    const selection = editor.getSelection();
    const cursor = editor.getCursor();
    const raw = selection.trim() === ""
      ? editor.getLine(cursor.line)
      : selection;
    const question = raw
      .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/u, "")
      .trim();
    if (question === "") {
      new Notice("Select a question or place the cursor on its line.");
      return;
    }
    await this.runUserAction(async () => {
      const child = await required(this.learning).promoteQuestion(file, question);
      const link = `- [[${withoutMarkdown(child.path)}|${child.basename}]]`;
      if (selection.trim() === "") {
        editor.setLine(cursor.line, link);
      } else {
        editor.replaceSelection(link);
      }
    }, "Question promoted to a child node.");
  }

  private async splitSelection(
    editor: Editor,
    view: MarkdownView | MarkdownFileInfo,
  ): Promise<void> {
    const selection = editor.getSelection().trim();
    const file = view.file;
    if (file === null || selection === "") {
      new Notice("Select the material to split into a child node.");
      return;
    }
    const title = await requestText(
      this.app,
      "Split node",
      "Child-node title",
      "The selected material is preserved in the new child.",
    );
    if (title === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const child = await required(this.learning).splitNode(
        file,
        title,
        selection,
      );
      editor.replaceSelection(
        `[[${withoutMarkdown(child.path)}|${child.basename}]]`,
      );
    }, "Selection split into a child node.");
  }

  private async moveActiveNode(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active === null) {
      new Notice("Open a Learning Loop node first.");
      return;
    }
    const target = await requestFile(
      this.app,
      "Choose the new parent node",
      required(this.learning).nodes().filter((file) => file.path !== active.path),
    );
    if (target === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.learning).moveNode(active, target),
      "Node moved.",
    );
  }

  private async mergeActiveNode(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active === null) {
      new Notice("Open the source node first.");
      return;
    }
    const target = await requestFile(
      this.app,
      "Choose the node that will receive the content",
      required(this.learning).nodes().filter((file) => file.path !== active.path),
    );
    if (target === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.learning).mergeNodes(active, target),
      "Nodes merged without deleting the source note.",
    );
  }

  private async relateActiveNode(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active === null) {
      new Notice("Open the first node.");
      return;
    }
    const target = await requestFile(
      this.app,
      "Choose a related node",
      required(this.learning).nodes().filter((file) => file.path !== active.path),
    );
    if (target === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.learning).relateNodes(active, target),
      "Related knowledge recorded on both nodes.",
    );
  }

  private async recordCorrection(): Promise<void> {
    const correction = await requestText(
      this.app,
      "Record correction",
      "Correction",
      "Appends a timestamped correction; prior understanding remains visible.",
    );
    if (correction === undefined) {
      return;
    }
    await this.withActiveFile(
      (file) => required(this.learning).recordCorrection(file, correction),
      "Correction recorded.",
    );
  }

  private async createPaper(): Promise<void> {
    const title = await requestText(
      this.app,
      "Create paper note",
      "Paper title",
      "Creates the complete paper-reading template.",
    );
    if (title === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const file = await required(this.learning).createPaper(title);
      await this.app.workspace.getLeaf(false).openFile(file);
    }, "Paper note created.");
  }

  private async createOperationsRecord(
    kind: "server" | "service" | "database" | "change" | "incident" | "runbook",
    label: string,
  ): Promise<void> {
    const title = await requestText(
      this.app,
      `Create ${label}`,
      "Title",
      "Never paste a password, private key, or token into Markdown.",
    );
    if (title === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const file = await required(this.learning).createOperationsRecord(kind, title);
      await this.app.workspace.getLeaf(false).openFile(file);
    }, `${label} created.`);
  }

  private async distillActiveFile(): Promise<void> {
    const source = this.app.workspace.getActiveFile();
    if (source === null) {
      new Notice("Open a paper, source, or incident first.");
      return;
    }
    const topic = await requestFile(
      this.app,
      "Choose the destination topic",
      required(this.learning).topics(),
    );
    if (topic === undefined) {
      return;
    }
    const title = await requestText(
      this.app,
      "Distill knowledge node",
      "Node title",
      "The new node keeps a link to the source record.",
    );
    if (title === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const node = await required(this.learning).extractToNode(
        source,
        topic,
        title,
      );
      await this.app.workspace.getLeaf(false).openFile(node);
    }, "Knowledge node distilled.");
  }

  private async createReviewCard(): Promise<void> {
    const input = await requestCardInput(this.app);
    if (input === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const card = await required(this.learning).createCard(
        input.title,
        input.type,
        input.prompt,
        input.answer,
        this.app.workspace.getActiveFile() ?? undefined,
      );
      await this.app.workspace.getLeaf(false).openFile(card);
    }, "Review card created.");
  }

  private async withActiveFile(
    action: (file: TFile) => Promise<void>,
    success: string,
  ): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (file === null) {
      new Notice("Open the relevant Learning Loop note first.");
      return;
    }
    await this.runUserAction(() => action(file), success);
  }

  private async initializeRuntime(): Promise<void> {
    this.learning = new LearningService(this.app);
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
      if (this.learning?.isDeletedAutoMap(file.path) === true) {
        this.registerInterval(window.setTimeout(() => {
          void this.learning?.generateAllMaps().catch(() => undefined);
        }, 500));
      }
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      this.learning?.metadataChanged(file);
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
    void this.learning.generateAllMaps().catch(() => {
      new Notice("Learning Loop automatic maps need attention.");
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
        reviewToday: () => {
          this.openReviews();
          return Promise.resolve();
        },
        continueNode: () => this.continueCurrentNode(),
        quickQuestion: () => this.quickQuestion(),
        recordTerm: () => this.recordEnglishTerm(),
        updateUnderstanding: () => this.addCurrentUnderstanding(),
        openCurrentPath: () => this.openCurrentPath(),
        openRunbook: () => this.openRunbook(),
      },
      this.controller?.status ?? "locked",
    );
    this.mobileSyncModal.open();
  }

  private registerLearningCommands(): void {
    this.addCommand({
      id: "initialize-learning-vault",
      name: "Initialize learning folders and templates",
      callback: () => {
        void this.initializeLearningVault();
      },
    });
    this.addCommand({
      id: "create-learning-topic",
      name: "Create topic from Markdown outline",
      callback: () => {
        void this.createTopic();
      },
    });
    this.addCommand({
      id: "import-outline-into-topic",
      name: "Import Markdown outline into active topic",
      callback: () => {
        void this.importOutlineIntoActiveTopic();
      },
    });
    this.addCommand({
      id: "create-knowledge-node",
      name: "Create node under active topic or node",
      callback: () => {
        void this.createNodeFromActiveContext();
      },
    });
    this.addCommand({
      id: "continue-current-node",
      name: "Continue current node",
      callback: () => {
        void this.continueCurrentNode();
      },
    });
    this.addCommand({
      id: "set-active-node-current",
      name: "Set active node as current",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).setCurrentNode(file),
          "Current node updated.",
        );
      },
    });
    this.addCommand({
      id: "add-inline-question",
      name: "Add question to current node",
      callback: () => {
        void this.quickQuestion();
      },
    });
    this.addCommand({
      id: "promote-selection-to-child-node",
      name: "Promote selected question to child node",
      editorCallback: (editor, view) => {
        void this.promoteSelection(editor, view);
      },
    });
    this.addCommand({
      id: "split-selection-into-child-node",
      name: "Split selection into child node",
      editorCallback: (editor, view) => {
        void this.splitSelection(editor, view);
      },
    });
    this.addCommand({
      id: "move-active-node-under-node",
      name: "Move active node under another node",
      callback: () => {
        void this.moveActiveNode();
      },
    });
    this.addCommand({
      id: "move-active-node-to-topic-root",
      name: "Move active node to topic root",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).moveNode(file),
          "Node moved to the topic root.",
        );
      },
    });
    this.addCommand({
      id: "merge-active-node",
      name: "Merge active node into another node",
      callback: () => {
        void this.mergeActiveNode();
      },
    });
    this.addCommand({
      id: "relate-active-node",
      name: "Relate active node to another node",
      callback: () => {
        void this.relateActiveNode();
      },
    });
    this.addCommand({
      id: "move-node-up",
      name: "Move active node up among siblings",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).reorderNode(file, -1),
          "Node reordered.",
        );
      },
    });
    this.addCommand({
      id: "move-node-down",
      name: "Move active node down among siblings",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).reorderNode(file, 1),
          "Node reordered.",
        );
      },
    });
    this.addCommand({
      id: "record-node-correction",
      name: "Record correction on active node",
      callback: () => {
        void this.recordCorrection();
      },
    });
    this.addCommand({
      id: "mark-node-to-verify",
      name: "Mark active node as needing verification",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).markNode(file, { verified: false }),
          "Node marked for verification.",
        );
      },
    });
    this.addCommand({
      id: "mark-node-verified",
      name: "Mark active node as verified",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).markNode(file, { verified: true }),
          "Node marked as verified.",
        );
      },
    });
    for (const confidence of ["low", "medium", "high"] as const) {
      this.addCommand({
        id: `set-node-confidence-${confidence}`,
        name: `Set active node confidence to ${confidence}`,
        callback: () => {
          void this.withActiveFile(
            (file) =>
              required(this.learning).markNode(file, { confidence }),
            `Node confidence set to ${confidence}.`,
          );
        },
      });
    }
    this.addCommand({
      id: "mark-node-mastered",
      name: "Mark active node as mastered",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).markNode(file, { mastered: true }),
          "Node marked as mastered.",
        );
      },
    });
    this.addCommand({
      id: "add-active-node-to-review",
      name: "Add active node to review",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).markNode(file, { review: true }),
          "Node marked for review.",
        );
      },
    });
    this.addCommand({
      id: "create-english-term",
      name: "Create English term and review card",
      callback: () => {
        void this.recordEnglishTerm();
      },
    });
    this.addCommand({
      id: "create-paper-note",
      name: "Create paper reading note",
      callback: () => {
        void this.createPaper();
      },
    });
    for (const [kind, label] of [
      ["server", "server asset"],
      ["service", "service asset"],
      ["database", "database asset"],
      ["change", "change record"],
      ["incident", "incident record"],
      ["runbook", "runbook"],
    ] as const) {
      this.addCommand({
        id: `create-${kind}`,
        name: `Create ${label}`,
        callback: () => {
          void this.createOperationsRecord(kind, label);
        },
      });
    }
    this.addCommand({
      id: "distill-active-source-to-node",
      name: "Distill active source or incident into a node",
      callback: () => {
        void this.distillActiveFile();
      },
    });
    this.addCommand({
      id: "create-review-card",
      name: "Create review card",
      callback: () => {
        void this.createReviewCard();
      },
    });
    this.addCommand({
      id: "review-today",
      name: "Review today's cards",
      callback: () => {
        this.openReviews();
      },
    });
    this.addCommand({
      id: "open-today-dashboard",
      name: "Open today's Learning Loop dashboard",
      callback: () => {
        void this.runUserAction(
          () => required(this.learning).openTodayDashboard().then(() => undefined),
          "Today's dashboard is ready.",
        );
      },
    });
    this.addCommand({
      id: "regenerate-topic-maps",
      name: "Regenerate all automatic topic maps",
      callback: () => {
        void this.runUserAction(
          () => required(this.learning).generateAllMaps(),
          "Automatic maps regenerated.",
        );
      },
    });
    this.addCommand({
      id: "open-current-topic-path",
      name: "Open current topic path",
      callback: () => {
        void this.openCurrentPath();
      },
    });
    this.addCommand({
      id: "open-runbook",
      name: "Open a runbook",
      callback: () => {
        void this.openRunbook();
      },
    });
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
    this.containerEl.createEl("h3", { text: "Learning workflows" });
    new Setting(this.containerEl)
      .setName("Initialize folders and templates")
      .setDesc("Creates only missing Markdown-first Learning Loop folders and templates.")
      .addButton((button) => {
        button.setButtonText("Initialize").onClick(() => {
          void this.learningLoop.initializeLearningVault();
        });
      });
    new Setting(this.containerEl)
      .setName("Create topic")
      .setDesc("Paste a Markdown outline to create a stable learning tree.")
      .addButton((button) => {
        button.setButtonText("Create topic").onClick(() => {
          void this.learningLoop.createTopic();
        });
      });
    new Setting(this.containerEl)
      .setName("Today's review")
      .setDesc("Uses the three grades: 不会, 模糊, 掌握.")
      .addButton((button) => {
        button.setButtonText("Review").setCta().onClick(() => {
          this.learningLoop.openReviews();
        });
      });
    new Setting(this.containerEl)
      .setName("Continue current node")
      .addButton((button) => {
        button.setButtonText("Continue").onClick(() => {
          void this.learningLoop.continueCurrentNode();
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

function withoutMarkdown(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function isFile(value: unknown): value is TFile {
  return value !== null
    && typeof value === "object"
    && "stat" in value
    && "extension" in value;
}
