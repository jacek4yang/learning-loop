import {
  FuzzySuggestModal,
  Modal,
  Setting,
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
    this.setTitle(this.modalTitle);
    this.contentEl.addClass("learning-loop-mobile-panel");
    const setting = new Setting(this.contentEl)
      .setName(this.label)
      .setDesc(this.description);
    if (this.multiline) {
      setting.addTextArea((text) => {
        text.inputEl.rows = 10;
        text.onChange((value) => {
          this.value = value;
        });
      });
    } else {
      setting.addText((text) => {
        text.onChange((value) => {
          this.value = value;
        });
      });
    }
    new Setting(this.contentEl)
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
    this.setTitle("创建学习主题");
    this.contentEl.addClass("learning-loop-mobile-panel");
    new Setting(this.contentEl)
      .setName("主题名称")
      .addText((text) => {
        text.onChange((value) => {
          this.title = value;
        });
      });
    new Setting(this.contentEl)
      .setName("Markdown 大纲")
      .setDesc("可选；标题和任务列表会转换成清晰、稳定的学习路径。")
      .addTextArea((text) => {
        text.inputEl.rows = 12;
        text.onChange((value) => {
          this.outline = value;
        });
      });
    new Setting(this.contentEl)
      .addButton((button) => {
        button.setButtonText("创建").setCta().onClick(() => {
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
    this.setTitle("创建回顾卡片");
    this.contentEl.addClass("learning-loop-mobile-panel");
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
    new Setting(this.contentEl)
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
      text.onChange(update);
    });
  }

  private addArea(label: string, update: (value: string) => void): void {
    new Setting(this.contentEl).setName(label).addTextArea((text) => {
      text.inputEl.rows = 5;
      text.onChange(update);
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
    this.contentEl.addClass("learning-loop-review-panel");
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

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("回顾面板尚未准备好");
  }
  return value;
}
