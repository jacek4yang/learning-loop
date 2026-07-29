import {
  FuzzySuggestModal,
  Modal,
  Setting,
  setIcon,
  type App,
  type DropdownComponent,
  type TFile,
} from "obsidian";

import type { LearningService } from "../learning/service";
import { sectionContent } from "../learning/markdown";
import {
  CARD_TYPES,
  type CardType,
  type ReviewGrade,
} from "../learning/schema";

export interface TopicInput {
  readonly title: string;
  readonly outline: string;
}

export interface CardInput {
  readonly title: string;
  readonly type: CardType;
  readonly prompt: string;
  readonly answer: string;
}

export type OperationsKind =
  | "server"
  | "service"
  | "database"
  | "change"
  | "incident"
  | "runbook";

export interface OperationsInput {
  readonly kind: OperationsKind;
  readonly title: string;
}

export function requestText(
  app: App,
  title: string,
  label: string,
  description: string,
  multiline = false,
): Promise<string | undefined> {
  return new TextPromptModal(
    app,
    title,
    label,
    description,
    multiline,
  ).result();
}

export function requestTopicInput(app: App): Promise<TopicInput | undefined> {
  return new TopicModal(app).result();
}

export function requestCardInput(app: App): Promise<CardInput | undefined> {
  return new CardModal(app).result();
}

export function requestOperationsInput(
  app: App,
): Promise<OperationsInput | undefined> {
  return new OperationsModal(app).result();
}

export function requestFile(
  app: App,
  title: string,
  files: readonly TFile[],
): Promise<TFile | undefined> {
  return new FileModal(app, title, files).result();
}

export function openReviewModal(app: App, service: LearningService): void {
  new ReviewModal(app, service).open();
}

abstract class ResultModal<T> extends Modal {
  private readonly completion: Promise<T | undefined>;
  private resolve!: (value: T | undefined) => void;
  private settled = false;

  constructor(app: App) {
    super(app);
    this.completion = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  result(): Promise<T | undefined> {
    this.open();
    return this.completion;
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve(undefined);
    }
  }

  protected finish(value: T): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve(value);
    this.close();
  }

  protected prepare(
    title: string,
    eyebrow: string,
    description: string,
    iconName: string,
  ): void {
    this.setTitle(title);
    this.modalEl.addClass("learning-loop-form-modal");
    this.contentEl.addClass("learning-loop-form-panel");
    const hero = this.contentEl.createDiv({
      cls: "learning-loop-modal-hero",
    });
    const icon = hero.createDiv({ cls: "learning-loop-modal-hero-icon" });
    setIcon(icon, iconName);
    const copy = hero.createDiv();
    copy.createEl("span", {
      cls: "learning-loop-modal-eyebrow",
      text: eyebrow,
    });
    copy.createEl("h3", { text: title });
    copy.createEl("p", { text: description });
  }

  protected actionSetting(): Setting {
    const actions = new Setting(this.contentEl);
    actions.settingEl.addClass("learning-loop-form-actions");
    return actions;
  }
}

class TextPromptModal extends ResultModal<string> {
  private value = "";

  constructor(
    app: App,
    private readonly modalTitle: string,
    private readonly label: string,
    private readonly description: string,
    private readonly multiline: boolean,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.prepare(
      this.modalTitle,
      "一步只处理一件事",
      this.description,
      this.multiline ? "notebook-pen" : "message-square-plus",
    );
    const setting = new Setting(this.contentEl)
      .setName(this.label)
      .setDesc(this.description);
    if (this.multiline) {
      setting.addTextArea((text) => {
        text.inputEl.rows = 10;
        text.inputEl.placeholder = "在这里粘贴或输入内容…";
        text.onChange((value) => {
          this.value = value;
        });
      });
    } else {
      setting.addText((text) => {
        text.inputEl.placeholder = "输入清晰、具体的内容";
        text.onChange((value) => {
          this.value = value;
        });
      });
    }
    this.actionSetting()
      .addButton((button) => {
        button.setButtonText("保存").setCta().onClick(() => {
          if (this.value.trim() !== "") {
            this.finish(this.value.trim());
          }
        });
      })
      .addButton((button) => {
        button.setButtonText("取消").onClick(() => {
          this.close();
        });
      });
  }
}

class TopicModal extends ResultModal<TopicInput> {
  private title = "";
  private outline = "";

  override onOpen(): void {
    this.prepare(
      "创建学习主题",
      "从目标生成可执行的知识树",
      "输入主题名称；如果已经有计划，可以直接粘贴 Markdown 大纲。",
      "network",
    );
    new Setting(this.contentEl)
      .setName("主题名称")
      .setDesc("用你最终想回答的问题或掌握的能力命名。")
      .addText((text) => {
        text.inputEl.placeholder = "例如：从零实现一个可靠的 Web API";
        text.onChange((value) => {
          this.title = value;
        });
      });
    new Setting(this.contentEl)
      .setName("Markdown 大纲")
      .setDesc("可选；标题和任务列表会转换成清晰、稳定的学习路径。")
      .addTextArea((text) => {
        text.inputEl.rows = 12;
        text.inputEl.placeholder = [
          "## 基础概念",
          "- [ ] 理解请求与响应",
          "- [ ] 完成最小示例",
          "## 可靠性",
          "- [ ] 验证错误处理",
        ].join("\n");
        text.onChange((value) => {
          this.outline = value;
        });
      });
    this.contentEl.createEl("p", {
      cls: "learning-loop-form-tip",
      text: "提示：勾选的任务会标记为已掌握，未勾选的第一项会成为当前节点。",
    });
    this.actionSetting()
      .addButton((button) => {
        button.setButtonText("创建知识树").setCta().onClick(() => {
          if (this.title.trim() !== "") {
            this.finish({
              title: this.title.trim(),
              outline: this.outline,
            });
          }
        });
      })
      .addButton((button) => {
        button.setButtonText("取消").onClick(() => {
          this.close();
        });
      });
  }
}

class CardModal extends ResultModal<CardInput> {
  private title = "";
  private type: CardType = CARD_TYPES[0];
  private prompt = "";
  private answer = "";

  override onOpen(): void {
    this.prepare(
      "创建回顾卡片",
      "用主动回忆替代重复阅读",
      "正面只放一个可以明确作答的问题，背面给出最小且准确的答案。",
      "gallery-horizontal-end",
    );
    this.addText("标题", (value) => {
      this.title = value;
    });
    new Setting(this.contentEl)
      .setName("卡片类型")
      .addDropdown((dropdown) => {
        this.configureTypes(dropdown);
      });
    this.addArea("提示", (value) => {
      this.prompt = value;
    });
    this.addArea("答案", (value) => {
      this.answer = value;
    });
    this.actionSetting()
      .addButton((button) => {
        button.setButtonText("创建").setCta().onClick(() => {
          if (
            this.title.trim() !== ""
            && this.prompt.trim() !== ""
            && this.answer.trim() !== ""
          ) {
            this.finish({
              title: this.title.trim(),
              type: this.type,
              prompt: this.prompt.trim(),
              answer: this.answer.trim(),
            });
          }
        });
      })
      .addButton((button) => {
        button.setButtonText("取消").onClick(() => {
          this.close();
        });
      });
  }

  private configureTypes(dropdown: DropdownComponent): void {
    for (const type of CARD_TYPES) {
      dropdown.addOption(type, type);
    }
    dropdown.setValue(this.type).onChange((value) => {
      if (isCardType(value)) {
        this.type = value;
      }
    });
  }

  private addText(label: string, update: (value: string) => void): void {
    new Setting(this.contentEl).setName(label).addText((text) => {
      text.inputEl.placeholder = "便于以后搜索的简短名称";
      text.onChange(update);
    });
  }

  private addArea(label: string, update: (value: string) => void): void {
    new Setting(this.contentEl).setName(label).addTextArea((text) => {
      text.inputEl.rows = 5;
      text.inputEl.placeholder = label === "提示"
        ? "不看答案时，你需要回答什么？"
        : "可以核对对错的准确答案";
      text.onChange(update);
    });
  }
}

class OperationsModal extends ResultModal<OperationsInput> {
  private kind: OperationsKind = "runbook";
  private title = "";

  override onOpen(): void {
    this.prepare(
      "创建技术运行记录",
      "把实际操作转成可复用知识",
      "选择记录类型，只写公开说明和密码管理器引用，不要把密码、私钥或令牌写进笔记。",
      "server-cog",
    );
    new Setting(this.contentEl)
      .setName("记录类型")
      .setDesc("不同类型会生成对应的检查、验证和回滚结构。")
      .addDropdown((dropdown) => {
        for (const [kind, label] of OPERATIONS_LABELS) {
          dropdown.addOption(kind, label);
        }
        dropdown.setValue(this.kind).onChange((value) => {
          if (isOperationsKind(value)) {
            this.kind = value;
          }
        });
      });
    new Setting(this.contentEl)
      .setName("名称")
      .setDesc("说明对象或目标，不要包含任何凭据。")
      .addText((text) => {
        text.inputEl.placeholder = "例如：学习服务器备份与恢复";
        text.onChange((value) => {
          this.title = value;
        });
      });
    this.actionSetting()
      .addButton((button) => {
        button.setButtonText("创建记录").setCta().onClick(() => {
          if (this.title.trim() !== "") {
            this.finish({
              kind: this.kind,
              title: this.title.trim(),
            });
          }
        });
      })
      .addButton((button) => {
        button.setButtonText("取消").onClick(() => {
          this.close();
        });
      });
  }
}

class FileModal extends FuzzySuggestModal<TFile> {
  private readonly completion: Promise<TFile | undefined>;
  private resolve!: (value: TFile | undefined) => void;
  private settled = false;

  constructor(
    app: App,
    title: string,
    private readonly files: readonly TFile[],
  ) {
    super(app);
    this.setPlaceholder(title);
    this.completion = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  result(): Promise<TFile | undefined> {
    this.open();
    return this.completion;
  }

  getItems(): TFile[] {
    return [...this.files];
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.settled = true;
    this.resolve(item);
  }

  override onClose(): void {
    super.onClose();
    if (!this.settled) {
      this.settled = true;
      this.resolve(undefined);
    }
  }
}

class ReviewModal extends Modal {
  private cards: TFile[] = [];
  private index = 0;
  private promptElement: HTMLElement | undefined;
  private answerElement: HTMLElement | undefined;
  private titleElement: HTMLElement | undefined;
  private actionsElement: HTMLElement | undefined;

  constructor(app: App, private readonly service: LearningService) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    this.setTitle("今日回顾");
    this.modalEl.addClass("learning-loop-form-modal");
    this.contentEl.addClass("learning-loop-review-panel");
    const hero = this.contentEl.createDiv({
      cls: "learning-loop-modal-hero",
    });
    const icon = hero.createDiv({ cls: "learning-loop-modal-hero-icon" });
    setIcon(icon, "calendar-check-2");
    const copy = hero.createDiv();
    copy.createEl("span", {
      cls: "learning-loop-modal-eyebrow",
      text: "先回忆，再核对",
    });
    copy.createEl("h3", { text: "今日回顾" });
    copy.createEl("p", {
      text: "根据真实回忆难度选择“不会、模糊、掌握”，系统会安排下一次复习。",
    });
    this.titleElement = this.contentEl.createEl("h3");
    this.promptElement = this.contentEl.createDiv({
      cls: "learning-loop-review-prompt",
    });
    this.answerElement = this.contentEl.createDiv({
      cls: "learning-loop-review-answer",
    });
    this.actionsElement = this.contentEl.createDiv({
      cls: "learning-loop-review-actions",
    });
    this.cards = this.service.dueCards();
    await this.renderCard();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async renderCard(): Promise<void> {
    const title = required(this.titleElement);
    const prompt = required(this.promptElement);
    const answer = required(this.answerElement);
    const actions = required(this.actionsElement);
    title.empty();
    prompt.empty();
    answer.empty();
    actions.empty();
    const card = this.cards[this.index];
    if (card === undefined) {
      title.setText("今天的回顾已完成");
      prompt.setText("当前没有到期卡片。");
      return;
    }
    title.setText(`${(this.index + 1).toString()} / ${this.cards.length.toString()} · ${card.basename}`);
    const content = await this.app.vault.read(card);
    prompt.setText(sectionContent(content, "提示"));
    answer.setText(sectionContent(content, "答案"));
    answer.hide();
    new Setting(actions).addButton((button) => {
      button.setButtonText("显示答案").setCta().onClick(() => {
        answer.show();
        actions.empty();
        this.addGradeButtons(actions, card);
      });
    });
  }

  private addGradeButtons(container: HTMLElement, card: TFile): void {
    const setting = new Setting(container);
    for (const grade of ["不会", "模糊", "掌握"] as const) {
      setting.addButton((button) => {
        button.setButtonText(grade).onClick(() => {
          void this.rate(card, grade);
        });
      });
    }
  }

  private async rate(card: TFile, grade: ReviewGrade): Promise<void> {
    await this.service.rateCard(card, grade);
    this.index += 1;
    await this.renderCard();
  }
}

function isCardType(value: string): value is CardType {
  return CARD_TYPES.some((type) => type === value);
}

const OPERATIONS_LABELS: readonly (readonly [OperationsKind, string])[] = [
  ["server", "服务器"],
  ["service", "服务"],
  ["database", "数据库"],
  ["change", "变更"],
  ["incident", "故障"],
  ["runbook", "操作手册"],
];

function isOperationsKind(value: string): value is OperationsKind {
  return OPERATIONS_LABELS.some(([kind]) => kind === value);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("回顾面板尚未准备好");
  }
  return value;
}
