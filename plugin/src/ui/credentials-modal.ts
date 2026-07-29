import {
  Modal,
  Setting,
  type App,
} from "obsidian";

import {
  type ServerSettings,
  normalizeServerSettings,
  strongClientPassword,
} from "../settings";

export interface SetupCredentials extends ServerSettings {
  readonly serverPassword: string;
  readonly clientPassword: string;
}

export function requestSetupCredentials(
  app: App,
  existing?: ServerSettings,
  hasStoredServerPassword = false,
): Promise<SetupCredentials | undefined> {
  return new SetupModal(
    app,
    existing,
    hasStoredServerPassword,
  ).result();
}

export function requestClientPassword(
  app: App,
  server?: ServerSettings,
): Promise<string | undefined> {
  return new PasswordModal(app, server).result();
}

class SetupModal extends Modal {
  private readonly completion: Promise<SetupCredentials | undefined>;
  private resolve!: (value: SetupCredentials | undefined) => void;
  private settled = false;
  private host: string;
  private port: string;
  private fingerprint: string;
  private serverPassword = "";
  private clientPassword = "";
  private deviceName: string;

  constructor(
    app: App,
    existing: ServerSettings | undefined,
    private readonly hasStoredServerPassword: boolean,
  ) {
    super(app);
    this.host = existing?.host ?? "";
    this.port = existing?.port.toString() ?? "48632";
    this.fingerprint = existing?.fingerprint ?? "";
    this.deviceName = existing?.deviceName ?? "";
    this.completion = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  result(): Promise<SetupCredentials | undefined> {
    this.open();
    return this.completion;
  }

  override onOpen(): void {
    this.setTitle("配置加密同步");
    this.modalEl.addClass("learning-loop-config-modal");
    this.contentEl.addClass("learning-loop-mobile-panel");
    this.contentEl.createDiv({
      cls: "learning-loop-config-intro",
      text: this.hasStoredServerPassword
        ? "已载入保存的服务器配置。服务器密码留空即可继续使用 SecretStorage 中的值。"
        : "首次连接会先在本机保存服务器配置，再尝试安全握手；即使服务器暂时不可达，填写内容也不会丢失。",
    });
    const error = this.contentEl.createDiv({
      cls: "learning-loop-form-error",
      attr: { role: "alert", "aria-live": "assertive" },
    });

    const serverSection = this.addSection(
      "服务器",
      "填写服务端启动日志中的地址、端口与 SHA-256 指纹。",
    );
    this.addText(
      serverSection,
      "DDNS 主机名",
      "例如 sync.example.net；不要填写 http://、路径或端口。",
      "sync.example.net",
      this.host,
      (value) => {
        this.host = value;
      },
    );
    this.addText(
      serverSection,
      "TCP 端口",
      "必须与服务端 config.toml 的 listen 端口一致。",
      "48632",
      this.port,
      (value) => {
        this.port = value;
      },
    );
    this.addText(
      serverSection,
      "服务器指纹",
      "从服务端首次启动日志复制完整的 SHA256:… 字符串。",
      "SHA256:…",
      this.fingerprint,
      (value) => {
        this.fingerprint = value;
      },
    );

    const securitySection = this.addSection(
      "安全与设备",
      "服务器密码持久化到 Obsidian SecretStorage；客户端密码永远不保存。",
    );
    this.addPassword(
      securitySection,
      "服务器访问密码",
      this.hasStoredServerPassword
        ? "已安全保存。留空则继续使用原密码；输入新值会在连接成功后更新。"
        : "将保存到 Obsidian SecretStorage，长度至少 16 个字符。",
      this.hasStoredServerPassword
        ? "已保存，留空继续使用"
        : "输入服务器访问密码",
      this.hasStoredServerPassword,
      (value) => {
        this.serverPassword = value;
      },
    );
    this.addPassword(
      securitySection,
      "客户端加密密码",
      "仅用于本次解锁，绝不保存或上传。请立即存入密码管理器，遗失后无法恢复。",
      "输入客户端加密密码",
      false,
      (value) => {
        this.clientPassword = value;
      },
    );
    this.addText(
      securitySection,
      "设备名称",
      "用于在服务器设备列表中识别这台设备。",
      "例如：主力笔记本",
      this.deviceName,
      (value) => {
        this.deviceName = value;
      },
    );

    const actions = this.contentEl.createDiv({
      cls: "learning-loop-config-actions",
    });
    new Setting(actions)
      .addButton((button) => {
        button
          .setButtonText("保存并连接")
          .setCta()
          .onClick(() => {
            const port = Number(this.port);
            let server: ServerSettings;
            try {
              server = normalizeServerSettings({
                host: this.host,
                port,
                fingerprint: this.fingerprint,
                deviceName: this.deviceName,
              });
            } catch {
              error.setText(
                "请检查主机名、1–65535 端口、完整服务器指纹和设备名称。",
              );
              return;
            }
            if (
              !this.hasStoredServerPassword
              && this.serverPassword.length < 16
            ) {
              error.setText("服务器访问密码至少需要 16 个字符。");
              return;
            }
            if (
              this.serverPassword.length > 0
              && this.serverPassword.length < 16
            ) {
              error.setText("新的服务器访问密码至少需要 16 个字符。");
              return;
            }
            if (!strongClientPassword(this.clientPassword)) {
              error.setText(
                "客户端密码至少 14 个字符，并应包含大小写字母、数字、符号或非 ASCII 字符中的至少三类。",
              );
              return;
            }
            if (
              this.serverPassword.length > 0
              && this.clientPassword === this.serverPassword
            ) {
              error.setText("客户端密码必须与服务器访问密码不同。");
              return;
            }
            this.finish({
              ...server,
              serverPassword: this.serverPassword,
              clientPassword: this.clientPassword,
            });
          });
      })
      .addButton((button) => {
        button.setButtonText("取消").onClick(() => {
          this.close();
        });
      });
  }

  override onClose(): void {
    this.serverPassword = "";
    this.clientPassword = "";
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve(undefined);
    }
  }

  private addSection(title: string, description: string): HTMLElement {
    const section = this.contentEl.createDiv({
      cls: "learning-loop-config-section",
    });
    section.createEl("h3", { text: title });
    section.createEl("p", {
      cls: "learning-loop-config-section-description",
      text: description,
    });
    return section;
  }

  private addText(
    container: HTMLElement,
    name: string,
    description: string,
    placeholder: string,
    value: string,
    update: (value: string) => void,
  ): void {
    new Setting(container)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        text
          .setPlaceholder(placeholder)
          .setValue(value)
          .onChange(update);
      });
  }

  private addPassword(
    container: HTMLElement,
    name: string,
    description: string,
    placeholder: string,
    hasExistingValue: boolean,
    update: (value: string) => void,
  ): void {
    new Setting(container)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = hasExistingValue
          ? "current-password"
          : "new-password";
        text
          .setPlaceholder(placeholder)
          .onChange(update);
      });
  }

  private finish(value: SetupCredentials): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve(value);
    this.close();
  }
}

class PasswordModal extends Modal {
  private readonly completion: Promise<string | undefined>;
  private resolve!: (value: string | undefined) => void;
  private settled = false;
  private password = "";

  constructor(app: App, private readonly server?: ServerSettings) {
    super(app);
    this.completion = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  result(): Promise<string | undefined> {
    this.open();
    return this.completion;
  }

  override onOpen(): void {
    this.setTitle("解锁 Learning Loop");
    this.modalEl.addClass("learning-loop-unlock-modal");
    this.contentEl.addClass("learning-loop-mobile-panel");
    this.contentEl.createDiv({
      cls: "learning-loop-unlock-hero",
      text: this.server === undefined
        ? "输入客户端加密密码以解锁本机密钥。"
        : `将解锁 ${this.server.host}:${this.server.port.toString()} 上的同步配置。`,
    });
    const error = this.contentEl.createDiv({
      cls: "learning-loop-form-error",
      attr: { role: "alert", "aria-live": "assertive" },
    });
    new Setting(this.contentEl)
      .setName("客户端加密密码")
      .setDesc("密码仅保留在当前进程内存中，关闭 Obsidian 后自动清除。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "current-password";
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit(error);
          }
        });
        text.onChange((value) => {
          this.password = value;
          error.empty();
        });
        window.setTimeout(() => {
          text.inputEl.focus();
        });
      });
    new Setting(this.contentEl)
      .addButton((button) => {
        button
          .setButtonText("解锁并同步")
          .setCta()
          .onClick(() => {
            this.submit(error);
          });
      })
      .addButton((button) => {
        button.setButtonText("稍后").onClick(() => {
          this.close();
        });
      });
  }

  override onClose(): void {
    this.password = "";
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve(undefined);
    }
  }

  private submit(error: HTMLElement): void {
    if (this.password.length === 0) {
      error.setText("请输入客户端加密密码。");
      return;
    }
    this.finish(this.password);
  }

  private finish(value: string): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve(value);
    this.close();
  }
}
