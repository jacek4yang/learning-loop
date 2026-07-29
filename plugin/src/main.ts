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
  userFacingErrorMessage,
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
import {
  LEARNING_LOOP_SIDEBAR_VIEW,
  LearningLoopSidebarView,
  type SidebarState,
} from "./ui/sidebar-view";

const PERIODIC_SYNC_MS = 5 * 60 * 1000;

export default class LearningLoopPlugin extends Plugin {
  private readonly settingsRepository = new SettingsRepository(this);
  private controller: SyncController | undefined;
  private learning: LearningService | undefined;
  private statusText = "尚未配置";
  private statusElement: HTMLElement | undefined;
  private mobileSyncModal: MobileSyncModal | undefined;
  private configureTask: Promise<void> | undefined;
  private unlockTask: Promise<void> | undefined;
  private syncTask: Promise<void> | undefined;
  private lastNoticeMessage = "";
  private lastNoticeAt = 0;

  override onload(): void {
    this.registerView(
      LEARNING_LOOP_SIDEBAR_VIEW,
      (leaf) => new LearningLoopSidebarView(
        leaf,
        {
          configure: () => this.configure(),
          unlock: () => this.unlock(),
          syncNow: () => this.syncNow(),
          lock: () => {
            this.lock();
          },
          initializeVault: () => this.initializeLearningVault(),
          createTopic: () => this.createTopic(),
          continueNode: () => this.continueCurrentNode(),
          quickQuestion: () => this.quickQuestion(),
          reviewToday: () => {
            this.openReviews();
          },
        },
        () => this.sidebarState(),
      ),
    );
    this.addRibbonIcon("brain-circuit", "打开 Learning Loop", () => {
      if (Platform.isMobile) {
        this.openMobileSyncPanel();
      } else {
        void this.openSidebar();
      }
    });
    this.addCommand({
      id: "configure-encrypted-sync",
      name: "配置加密同步",
      callback: () => {
        void this.configure();
      },
    });
    this.addCommand({
      id: "unlock",
      name: "解锁并同步",
      callback: () => {
        void this.unlock();
      },
    });
    this.addCommand({
      id: "lock",
      name: "锁定并清除内存密钥",
      callback: () => {
        this.controller?.lock();
      },
    });
    this.addCommand({
      id: "sync-now",
      name: "立即同步",
      callback: () => {
        void this.syncNow();
      },
    });
    this.addCommand({
      id: "open-mobile-sync-panel",
      name: "打开快捷操作面板",
      callback: () => {
        this.openMobileSyncPanel();
      },
    });
    this.addCommand({
      id: "open-sidebar",
      name: "打开右侧快捷栏",
      callback: () => {
        void this.openSidebar();
      },
    });
    this.registerLearningCommands();
    this.addSettingTab(new LearningLoopSettingTab(this.app, this));
    if (Platform.isDesktopApp) {
      this.statusElement = this.addStatusBarItem();
      this.statusElement.setText("Learning Loop：尚未配置");
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

  get synchronizationConfigured(): boolean {
    return this.controller?.configured ?? false;
  }

  get synchronizationUnlocked(): boolean {
    return this.controller?.unlocked ?? false;
  }

  get serverPasswordStored(): boolean {
    return this.controller?.serverPasswordStored ?? false;
  }

  get connectionSummary(): string {
    return this.sidebarState().serverSummary;
  }

  async currentServer(): Promise<ServerSettings | undefined> {
    return (await this.settingsRepository.load()).server;
  }

  configure(): Promise<void> {
    this.configureTask ??= this.configureOnce().finally(() => {
      this.configureTask = undefined;
      this.updateSidebar();
    });
    return this.configureTask;
  }

  unlock(): Promise<void> {
    this.unlockTask ??= this.unlockOnce().finally(() => {
      this.unlockTask = undefined;
      this.updateSidebar();
    });
    return this.unlockTask;
  }

  syncNow(): Promise<void> {
    this.syncTask ??= this.syncOnce().finally(() => {
      this.syncTask = undefined;
      this.updateSidebar();
    });
    return this.syncTask;
  }

  lock(): void {
    this.controller?.lock();
    this.updateSidebar();
  }

  async openSidebar(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(
      LEARNING_LOOP_SIDEBAR_VIEW,
    )[0];
    if (leaf === undefined) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      if (leaf === undefined) {
        this.notify("无法打开右侧栏，请检查当前 Obsidian 布局。");
        return;
      }
      await leaf.setViewState({
        type: LEARNING_LOOP_SIDEBAR_VIEW,
        active: true,
      });
    }
    await this.app.workspace.revealLeaf(leaf);
    this.updateSidebar();
  }

  private async configureOnce(): Promise<void> {
    const credentials = await requestSetupCredentials(
      this.app,
      await this.currentServer(),
      await this.settingsRepository.hasServerPassword(),
      (credentials) =>
        required(this.controller).testConnection(credentials),
    );
    if (credentials === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.controller).configure(credentials),
      "加密同步已配置并完成首次同步。",
    );
  }

  private async unlockOnce(): Promise<void> {
    const controller = required(this.controller);
    if (!controller.configured) {
      await this.configure();
      return;
    }
    if (controller.unlocked) {
      this.notify("Learning Loop 已经解锁。");
      return;
    }
    const password = await requestClientPassword(
      this.app,
      await this.currentServer(),
    );
    if (password === undefined) {
      return;
    }
    await this.runUserAction(
      () => controller.unlock(password),
      "Learning Loop 已解锁并完成同步。",
    );
  }

  private async syncOnce(): Promise<void> {
    const controller = required(this.controller);
    if (!controller.configured) {
      await this.configure();
      return;
    }
    if (!controller.unlocked) {
      await this.unlock();
      return;
    }
    await this.runUserAction(
      () => controller.syncNow(),
      "同步完成。",
    );
  }

  async initializeLearningVault(): Promise<void> {
    await this.runUserAction(
      () => required(this.learning).initializeVault(),
      "学习空间和模板已准备好。",
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
    }, "学习主题已创建。");
  }

  async continueCurrentNode(): Promise<void> {
    await this.runUserAction(
      () => required(this.learning).continueCurrentNode().then(() => undefined),
      "已打开当前学习节点。",
    );
  }

  async quickQuestion(): Promise<void> {
    const question = await requestText(
      this.app,
      "记录一个问题",
      "想弄清楚什么？",
      "问题会添加到当前学习节点中，之后可以继续展开。",
    );
    if (question === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const node = required(this.learning).currentNode();
      if (node === undefined) {
        throw new Error("尚未选择当前学习节点");
      }
      await required(this.learning).addInlineQuestion(node, question);
    }, "问题已记录。");
  }

  async recordEnglishTerm(): Promise<void> {
    const term = await requestText(
      this.app,
      "记录英语词汇",
      "单词或专业术语",
      "自动创建简洁的词汇笔记和间隔复习卡。",
    );
    if (term === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const file = await required(this.learning).createEnglishTerm(term);
      await this.app.workspace.getLeaf(false).openFile(file);
    }, "词汇笔记和复习卡已创建。");
  }

  async addCurrentUnderstanding(): Promise<void> {
    const sentence = await requestText(
      this.app,
      "补充当前理解",
      "用一句话写下新的理解",
      "新内容会追加保存，不会覆盖之前的理解。",
    );
    if (sentence === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.learning).updateCurrentUnderstanding(sentence),
      "当前理解已更新。",
    );
  }

  async openCurrentPath(): Promise<void> {
    await this.runUserAction(
      () => required(this.learning).openCurrentPathMap().then(() => undefined),
      "已打开当前主题路径。",
    );
  }

  async openRunbook(): Promise<void> {
    await this.runUserAction(
      () => required(this.learning).openFirstRunbook().then(() => undefined),
      "已打开操作手册。",
    );
  }

  openReviews(): void {
    openReviewModal(this.app, required(this.learning));
  }

  private async importOutlineIntoActiveTopic(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (file === null) {
      this.notify("请先打开一个 Learning Loop 学习主题。");
      return;
    }
    const outline = await requestText(
      this.app,
      "导入 Markdown 大纲",
      "学习大纲",
      "标题和任务列表会自动转换成学习节点。",
      true,
    );
    if (outline === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.learning).importOutline(file, outline).then(() => undefined),
      "学习大纲已导入。",
    );
  }

  private async createNodeFromActiveContext(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active === null) {
      this.notify("请先打开一个学习主题或父节点。");
      return;
    }
    const title = await requestText(
      this.app,
      "创建学习节点",
      "一个明确的问题",
      "一个节点只解决一个具体问题，会更容易学习和回顾。",
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
    }, "学习节点已创建。");
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
      this.notify("请选中一个问题，或把光标放到问题所在行。");
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
    }, "问题已转换为子节点。");
  }

  private async splitSelection(
    editor: Editor,
    view: MarkdownView | MarkdownFileInfo,
  ): Promise<void> {
    const selection = editor.getSelection().trim();
    const file = view.file;
    if (file === null || selection === "") {
      this.notify("请先选中要拆分为子节点的内容。");
      return;
    }
    const title = await requestText(
      this.app,
      "拆分为子节点",
      "子节点标题",
      "选中的内容会完整保留在新节点中。",
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
    }, "选中内容已拆分为子节点。");
  }

  private async moveActiveNode(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active === null) {
      this.notify("请先打开一个 Learning Loop 学习节点。");
      return;
    }
    const target = await requestFile(
      this.app,
      "选择新的父节点",
      required(this.learning).nodes().filter((file) => file.path !== active.path),
    );
    if (target === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.learning).moveNode(active, target),
      "节点已移动。",
    );
  }

  private async mergeActiveNode(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active === null) {
      this.notify("请先打开要合并的源节点。");
      return;
    }
    const target = await requestFile(
      this.app,
      "选择接收内容的目标节点",
      required(this.learning).nodes().filter((file) => file.path !== active.path),
    );
    if (target === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.learning).mergeNodes(active, target),
      "节点内容已合并，源笔记仍然保留。",
    );
  }

  private async relateActiveNode(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active === null) {
      this.notify("请先打开第一个学习节点。");
      return;
    }
    const target = await requestFile(
      this.app,
      "选择一个相关节点",
      required(this.learning).nodes().filter((file) => file.path !== active.path),
    );
    if (target === undefined) {
      return;
    }
    await this.runUserAction(
      () => required(this.learning).relateNodes(active, target),
      "两个节点之间的关联已记录。",
    );
  }

  private async recordCorrection(): Promise<void> {
    const correction = await requestText(
      this.app,
      "记录纠正",
      "新的正确理解",
      "会追加一条带时间的纠正记录，之前的理解仍然可见。",
    );
    if (correction === undefined) {
      return;
    }
    await this.withActiveFile(
      (file) => required(this.learning).recordCorrection(file, correction),
      "纠正记录已保存。",
    );
  }

  private async createPaper(): Promise<void> {
    const title = await requestText(
      this.app,
      "创建论文阅读笔记",
      "论文标题",
      "自动创建结构清晰的论文阅读模板。",
    );
    if (title === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const file = await required(this.learning).createPaper(title);
      await this.app.workspace.getLeaf(false).openFile(file);
    }, "论文阅读笔记已创建。");
  }

  private async createOperationsRecord(
    kind: "server" | "service" | "database" | "change" | "incident" | "runbook",
    label: string,
  ): Promise<void> {
    const title = await requestText(
      this.app,
      `创建${label}`,
      "名称",
      "请勿把密码、私钥或访问令牌写入 Markdown 笔记。",
    );
    if (title === undefined) {
      return;
    }
    await this.runUserAction(async () => {
      const file = await required(this.learning).createOperationsRecord(kind, title);
      await this.app.workspace.getLeaf(false).openFile(file);
    }, `${label}已创建。`);
  }

  private async distillActiveFile(): Promise<void> {
    const source = this.app.workspace.getActiveFile();
    if (source === null) {
      this.notify("请先打开论文、资料或故障记录。");
      return;
    }
    const topic = await requestFile(
      this.app,
      "选择要归入的学习主题",
      required(this.learning).topics(),
    );
    if (topic === undefined) {
      return;
    }
    const title = await requestText(
      this.app,
      "提炼为学习节点",
      "节点标题",
      "新节点会保留指向原始资料的链接。",
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
    }, "知识已提炼为学习节点。");
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
    }, "复习卡已创建。");
  }

  private async withActiveFile(
    action: (file: TFile) => Promise<void>,
    success: string,
  ): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (file === null) {
      this.notify("请先打开相关的 Learning Loop 笔记。");
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
      this.updateStatus("error", "无法加载本机加密核心");
      this.notify("Learning Loop 无法加载本机加密核心，请重新安装插件。");
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
        this.controller?.unlocked === true
        && this.controller?.status !== "connecting"
        && this.controller?.status !== "syncing"
      ) {
        void this.controller?.syncNow().catch(() => undefined);
      }
    }, PERIODIC_SYNC_MS));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (
        document.visibilityState === "visible"
        && this.controller?.unlocked === true
        && this.controller?.status !== "connecting"
        && this.controller?.status !== "syncing"
      ) {
        void this.controller?.syncNow().catch(() => undefined);
      }
    });
    void this.learning.generateAllMaps().catch(() => {
      this.notify("Learning Loop 自动知识图谱需要处理。");
    });
    this.registerInterval(window.setTimeout(() => {
      if (Platform.isDesktopApp) {
        void this.openSidebar();
      }
      if (this.controller?.configured === true) {
        void this.unlock();
      } else {
        void this.configure();
      }
    }, 350));
  }

  private updateStatus(status: SyncStatus, detail?: string): void {
    const label = {
      unconfigured: "尚未配置",
      locked: "已锁定",
      connecting: "正在连接",
      waiting: "等待同步",
      syncing: "正在同步",
      synced: "同步完成",
      error: "需要处理",
    }[status];
    this.statusText = detail === undefined ? label : `${label}: ${detail}`;
    this.statusElement?.setText(`Learning Loop：${this.statusText}`);
    this.mobileSyncModal?.update(status, detail);
    this.updateSidebar();
  }

  private openMobileSyncPanel(): void {
    if (this.mobileSyncModal !== undefined) {
      this.mobileSyncModal.close();
    }
    this.mobileSyncModal = new MobileSyncModal(
      this.app,
      {
        configure: () => this.configure(),
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

  private sidebarState(): SidebarState {
    const controller = this.controller;
    const server = controller?.server;
    const configured = controller?.configured ?? false;
    return {
      status: controller?.status ?? "unconfigured",
      statusText: this.statusText,
      configured,
      unlocked: controller?.unlocked ?? false,
      serverSummary: server === undefined
        ? "尚未保存服务器配置。点击“开始配置”完成首次连接。"
        : configured
        ? `${server.deviceName} · ${server.host}:${server.port.toString()}`
        : `${server.host}:${server.port.toString()} 已保存，等待完成首次安全连接。`,
    };
  }

  private updateSidebar(): void {
    for (
      const leaf of this.app.workspace.getLeavesOfType(
        LEARNING_LOOP_SIDEBAR_VIEW,
      )
    ) {
      if (leaf.view instanceof LearningLoopSidebarView) {
        leaf.view.update();
      }
    }
  }

  private notify(message: string): void {
    const now = Date.now();
    if (
      message === this.lastNoticeMessage
      && now - this.lastNoticeAt < 3_000
    ) {
      return;
    }
    this.lastNoticeMessage = message;
    this.lastNoticeAt = now;
    new Notice(message);
  }

  private registerLearningCommands(): void {
    this.addCommand({
      id: "initialize-learning-vault",
      name: "初始化学习空间和模板",
      callback: () => {
        void this.initializeLearningVault();
      },
    });
    this.addCommand({
      id: "create-learning-topic",
      name: "从 Markdown 大纲创建学习主题",
      callback: () => {
        void this.createTopic();
      },
    });
    this.addCommand({
      id: "import-outline-into-topic",
      name: "把 Markdown 大纲导入当前主题",
      callback: () => {
        void this.importOutlineIntoActiveTopic();
      },
    });
    this.addCommand({
      id: "create-knowledge-node",
      name: "在当前主题或节点下创建子节点",
      callback: () => {
        void this.createNodeFromActiveContext();
      },
    });
    this.addCommand({
      id: "continue-current-node",
      name: "继续当前学习节点",
      callback: () => {
        void this.continueCurrentNode();
      },
    });
    this.addCommand({
      id: "set-active-node-current",
      name: "把当前打开的节点设为正在学习",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).setCurrentNode(file),
          "已更新正在学习的节点。",
        );
      },
    });
    this.addCommand({
      id: "add-inline-question",
      name: "向当前节点添加问题",
      callback: () => {
        void this.quickQuestion();
      },
    });
    this.addCommand({
      id: "promote-selection-to-child-node",
      name: "把选中的问题转换为子节点",
      editorCallback: (editor, view) => {
        void this.promoteSelection(editor, view);
      },
    });
    this.addCommand({
      id: "split-selection-into-child-node",
      name: "把选中内容拆分为子节点",
      editorCallback: (editor, view) => {
        void this.splitSelection(editor, view);
      },
    });
    this.addCommand({
      id: "move-active-node-under-node",
      name: "把当前节点移动到另一个节点下",
      callback: () => {
        void this.moveActiveNode();
      },
    });
    this.addCommand({
      id: "move-active-node-to-topic-root",
      name: "把当前节点移动到主题根目录",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).moveNode(file),
          "节点已移动到主题根目录。",
        );
      },
    });
    this.addCommand({
      id: "merge-active-node",
      name: "把当前节点合并到另一个节点",
      callback: () => {
        void this.mergeActiveNode();
      },
    });
    this.addCommand({
      id: "relate-active-node",
      name: "把当前节点与另一个节点关联",
      callback: () => {
        void this.relateActiveNode();
      },
    });
    this.addCommand({
      id: "move-node-up",
      name: "在同级节点中上移当前节点",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).reorderNode(file, -1),
          "节点顺序已更新。",
        );
      },
    });
    this.addCommand({
      id: "move-node-down",
      name: "在同级节点中下移当前节点",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).reorderNode(file, 1),
          "节点顺序已更新。",
        );
      },
    });
    this.addCommand({
      id: "record-node-correction",
      name: "在当前节点记录纠正",
      callback: () => {
        void this.recordCorrection();
      },
    });
    this.addCommand({
      id: "mark-node-to-verify",
      name: "把当前节点标记为待核实",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).markNode(file, { verified: false }),
          "节点已标记为待核实。",
        );
      },
    });
    this.addCommand({
      id: "mark-node-verified",
      name: "把当前节点标记为已核实",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).markNode(file, { verified: true }),
          "节点已标记为已核实。",
        );
      },
    });
    for (const [confidence, label] of [
      ["low", "低"],
      ["medium", "中"],
      ["high", "高"],
    ] as const) {
      this.addCommand({
        id: `set-node-confidence-${confidence}`,
        name: `把当前节点的确信度设为${label}`,
        callback: () => {
          void this.withActiveFile(
            (file) =>
              required(this.learning).markNode(file, { confidence }),
            `节点确信度已设为${label}。`,
          );
        },
      });
    }
    this.addCommand({
      id: "mark-node-mastered",
      name: "把当前节点标记为已掌握",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).markNode(file, { mastered: true }),
          "节点已标记为已掌握。",
        );
      },
    });
    this.addCommand({
      id: "add-active-node-to-review",
      name: "把当前节点加入复习",
      callback: () => {
        void this.withActiveFile(
          (file) => required(this.learning).markNode(file, { review: true }),
          "节点已加入复习。",
        );
      },
    });
    this.addCommand({
      id: "create-english-term",
      name: "创建英语词汇笔记和复习卡",
      callback: () => {
        void this.recordEnglishTerm();
      },
    });
    this.addCommand({
      id: "create-paper-note",
      name: "创建论文阅读笔记",
      callback: () => {
        void this.createPaper();
      },
    });
    for (const [kind, label] of [
      ["server", "服务器记录"],
      ["service", "服务记录"],
      ["database", "数据库记录"],
      ["change", "变更记录"],
      ["incident", "故障记录"],
      ["runbook", "操作手册"],
    ] as const) {
      this.addCommand({
        id: `create-${kind}`,
        name: `创建${label}`,
        callback: () => {
          void this.createOperationsRecord(kind, label);
        },
      });
    }
    this.addCommand({
      id: "distill-active-source-to-node",
      name: "把当前资料或故障记录提炼为学习节点",
      callback: () => {
        void this.distillActiveFile();
      },
    });
    this.addCommand({
      id: "create-review-card",
      name: "创建复习卡",
      callback: () => {
        void this.createReviewCard();
      },
    });
    this.addCommand({
      id: "review-today",
      name: "回顾今天到期的复习卡",
      callback: () => {
        this.openReviews();
      },
    });
    this.addCommand({
      id: "open-today-dashboard",
      name: "打开今天的 Learning Loop 面板",
      callback: () => {
        void this.runUserAction(
          () => required(this.learning).openTodayDashboard().then(() => undefined),
          "今天的学习面板已准备好。",
        );
      },
    });
    this.addCommand({
      id: "regenerate-topic-maps",
      name: "重新生成所有主题知识图谱",
      callback: () => {
        void this.runUserAction(
          () => required(this.learning).generateAllMaps(),
          "主题知识图谱已重新生成。",
        );
      },
    });
    this.addCommand({
      id: "open-current-topic-path",
      name: "打开当前主题路径",
      callback: () => {
        void this.openCurrentPath();
      },
    });
    this.addCommand({
      id: "open-runbook",
      name: "打开操作手册",
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
      this.notify(success);
    } catch (error) {
      this.notify(`Learning Loop：${userFacingErrorMessage(error)}`);
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
    this.containerEl.createEl("p", {
      cls: "learning-loop-settings-intro",
      text: "服务器信息会持久化保存；客户端加密密码只用于当前会话解锁，关闭 Obsidian 后自动从内存清除。",
    });
    new Setting(this.containerEl)
      .setName("同步状态")
      .setDesc(this.learningLoop.statusLabel);
    this.containerEl.createEl("h3", { text: "连接与安全" });
    new Setting(this.containerEl)
      .setName("已保存的设备配置")
      .setDesc(this.learningLoop.connectionSummary);
    new Setting(this.containerEl)
      .setName("服务器访问密码")
      .setDesc(
        this.learningLoop.serverPasswordStored
          ? "已安全保存到 Obsidian SecretStorage。"
          : "尚未保存；首次配置时会写入 Obsidian SecretStorage。",
      );
    new Setting(this.containerEl)
      .setName("右侧快捷栏")
      .setDesc("集中使用配置、解锁、同步和常用学习操作。")
      .addButton((button) => {
        button.setButtonText("打开快捷栏").setCta().onClick(() => {
          void this.learningLoop.openSidebar();
        });
      });
    new Setting(this.containerEl)
      .setName("配置这台设备")
      .setDesc("保存服务器地址、端口、指纹、服务器密码和设备名称。")
      .addButton((button) => {
        button
          .setButtonText(
            this.learningLoop.synchronizationConfigured ? "修改配置" : "开始配置",
          )
          .onClick(() => {
            void this.learningLoop.configure().then(() => {
              this.display();
            });
          });
      });
    new Setting(this.containerEl)
      .setName("解锁")
      .setDesc(
        this.learningLoop.synchronizationConfigured
          ? "每次启动 Obsidian 时输入客户端密码，解锁后会自动同步。"
          : "请先完成首次服务器配置。",
      )
      .addButton((button) => {
        button
          .setButtonText(
            this.learningLoop.synchronizationUnlocked ? "已解锁" : "解锁并同步",
          )
          .setDisabled(
            !this.learningLoop.synchronizationConfigured
            || this.learningLoop.synchronizationUnlocked,
          )
          .onClick(() => {
            void this.learningLoop.unlock().then(() => {
              this.display();
            });
          });
      });
    new Setting(this.containerEl)
      .setName("立即同步")
      .setDesc(
        this.learningLoop.synchronizationUnlocked
          ? "拉取、合并并上传更改；未完成的上传会自动续传。"
          : "如果尚未配置或解锁，会先自动打开对应窗口。",
      )
      .addButton((button) => {
        button.setButtonText("立即同步").onClick(() => {
          void this.learningLoop.syncNow().then(() => {
            this.display();
          });
        });
      });
    new Setting(this.containerEl)
      .setName("锁定")
      .setDesc("清除内存密钥并暂停同步，不会删除已保存的服务器配置。")
      .addButton((button) => {
        button
          .setButtonText("锁定")
          .setWarning()
          .setDisabled(!this.learningLoop.synchronizationUnlocked)
          .onClick(() => {
            this.learningLoop.lock();
            this.display();
          });
      });
    this.containerEl.createEl("h3", { text: "学习快捷操作" });
    new Setting(this.containerEl)
      .setName("初始化学习空间")
      .setDesc("仅创建缺失的文件夹和模板，不覆盖现有笔记。")
      .addButton((button) => {
        button.setButtonText("初始化").onClick(() => {
          void this.learningLoop.initializeLearningVault();
        });
      });
    new Setting(this.containerEl)
      .setName("创建学习主题")
      .setDesc("输入标题，也可以粘贴 Markdown 大纲生成稳定的学习树。")
      .addButton((button) => {
        button.setButtonText("创建主题").onClick(() => {
          void this.learningLoop.createTopic();
        });
      });
    new Setting(this.containerEl)
      .setName("今日回顾")
      .setDesc("使用“不会、模糊、掌握”三个等级安排后续复习。")
      .addButton((button) => {
        button.setButtonText("开始回顾").setCta().onClick(() => {
          this.learningLoop.openReviews();
        });
      });
    new Setting(this.containerEl)
      .setName("继续当前节点")
      .setDesc("回到上次正在推进的学习问题。")
      .addButton((button) => {
        button.setButtonText("继续学习").onClick(() => {
          void this.learningLoop.continueCurrentNode();
        });
      });
    new Setting(this.containerEl)
      .setName("自定义快捷键")
      .setDesc(
        "打开 Obsidian → 快捷键，搜索“Learning Loop”，即可为配置、解锁、同步、创建主题、继续节点等操作绑定按键。",
      );
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
