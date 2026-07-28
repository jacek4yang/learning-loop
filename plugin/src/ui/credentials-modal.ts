import {
  Modal,
  Setting,
  type App,
} from "obsidian";

import type { ServerSettings } from "../settings";

export interface SetupCredentials extends ServerSettings {
  readonly serverPassword: string;
  readonly clientPassword: string;
}

export function requestSetupCredentials(
  app: App,
  existing?: ServerSettings,
): Promise<SetupCredentials | undefined> {
  return new SetupModal(app, existing).result();
}

export function requestClientPassword(
  app: App,
): Promise<string | undefined> {
  return new PasswordModal(app).result();
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

  constructor(app: App, existing?: ServerSettings) {
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
    this.setTitle("Configure encrypted synchronization");
    this.contentEl.addClass("learning-loop-mobile-panel");
    const error = this.contentEl.createDiv({
      cls: "learning-loop-form-error",
      attr: { role: "alert" },
    });
    this.addText("DDNS hostname", "notes.example.net", this.host, (value) => {
      this.host = value;
    });
    this.addText("TCP port", "48632", this.port, (value) => {
      this.port = value;
    });
    this.addText(
      "Server fingerprint",
      "SHA256:…",
      this.fingerprint,
      (value) => {
        this.fingerprint = value;
      },
    );
    this.addPassword(
      "Server access password",
      "Stored only in Obsidian SecretStorage.",
      (value) => {
        this.serverPassword = value;
      },
    );
    this.addPassword(
      "Client encryption password",
      "Never stored or uploaded. Losing it makes recovery impossible.",
      (value) => {
        this.clientPassword = value;
      },
    );
    this.addText("Device name", "My laptop", this.deviceName, (value) => {
      this.deviceName = value;
    });
    new Setting(this.contentEl)
      .addButton((button) => {
        button
          .setButtonText("Connect and configure")
          .setCta()
          .onClick(() => {
            const port = Number(this.port);
            if (
              !Number.isInteger(port)
              || port < 1
              || port > 65_535
              || this.host.trim() === ""
              || this.fingerprint.trim() === ""
              || this.deviceName.trim() === ""
              || this.serverPassword.length === 0
              || this.clientPassword.length === 0
            ) {
              error.setText("Complete every field with a valid value.");
              return;
            }
            this.finish({
              host: this.host,
              port,
              fingerprint: this.fingerprint,
              deviceName: this.deviceName,
              serverPassword: this.serverPassword,
              clientPassword: this.clientPassword,
            });
          });
      })
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
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

  private addText(
    name: string,
    placeholder: string,
    value: string,
    update: (value: string) => void,
  ): void {
    new Setting(this.contentEl)
      .setName(name)
      .addText((text) => {
        text
          .setPlaceholder(placeholder)
          .setValue(value)
          .onChange(update);
      });
  }

  private addPassword(
    name: string,
    description: string,
    update: (value: string) => void,
  ): void {
    new Setting(this.contentEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "new-password";
        text.onChange(update);
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

  constructor(app: App) {
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
    this.setTitle("Unlock Learning Loop");
    this.contentEl.addClass("learning-loop-mobile-panel");
    new Setting(this.contentEl)
      .setName("Client encryption password")
      .setDesc("This password remains in memory only while the plugin is unlocked.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "current-password";
        text.onChange((value) => {
          this.password = value;
        });
      });
    new Setting(this.contentEl)
      .addButton((button) => {
        button
          .setButtonText("Unlock")
          .setCta()
          .onClick(() => {
            if (this.password.length > 0) {
              this.finish(this.password);
            }
          });
      })
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
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

  private finish(value: string): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve(value);
    this.close();
  }
}
