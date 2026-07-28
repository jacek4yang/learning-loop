import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  type App,
} from "obsidian";

import { runTransportCheck } from "./spikes/transport";

interface LearningLoopSettings {
  transportSpikeEndpoint: string;
}

const DEFAULT_SETTINGS: LearningLoopSettings = {
  transportSpikeEndpoint: "http://127.0.0.1:48633/v1/transport-spike",
};

export default class LearningLoopPlugin extends Plugin {
  private pluginSettings: LearningLoopSettings = DEFAULT_SETTINGS;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new LearningLoopSettingTab(this.app, this));
    this.addCommand({
      id: "run-transport-compatibility-check",
      name: "Run transport compatibility check",
      callback: () => {
        void this.runTransportCheck();
      },
    });

    this.app.workspace.onLayoutReady(() => {
      // Runtime services are deliberately deferred until the workspace is ready.
    });
  }

  async updateTransportSpikeEndpoint(endpoint: string): Promise<void> {
    this.pluginSettings = {
      ...this.pluginSettings,
      transportSpikeEndpoint: endpoint.trim(),
    };
    await this.saveData(this.pluginSettings);
  }

  get transportSpikeEndpoint(): string {
    return this.pluginSettings.transportSpikeEndpoint;
  }

  private async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<LearningLoopSettings> | null;
    this.pluginSettings = {
      ...DEFAULT_SETTINGS,
      ...stored,
    };
  }

  private async runTransportCheck(): Promise<void> {
    try {
      const result = await runTransportCheck(
        this.pluginSettings.transportSpikeEndpoint,
      );
      const summary = result.ok ? "Transport check passed" : "Transport check failed";
      new Notice(`${summary}: HTTP ${result.status}, ${result.bytes} bytes. ${result.detail}`);
    } catch {
      new Notice("Transport check failed before receiving a response.");
    }
  }
}

class LearningLoopSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LearningLoopPlugin) {
    super(app, plugin);
  }

  override display(): void {
    this.containerEl.empty();

    new Setting(this.containerEl)
      .setName("Transport test endpoint")
      .setDesc("Local Phase 0 endpoint. Do not enter a password or token.")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.transportSpikeEndpoint)
          .setValue(this.plugin.transportSpikeEndpoint)
          .onChange(async (value) => {
            await this.plugin.updateTransportSpikeEndpoint(value);
          });
      });
  }
}
