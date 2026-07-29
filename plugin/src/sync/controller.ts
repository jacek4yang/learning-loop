import { Platform, type App } from "obsidian";

import { ObsidianVaultPort } from "../obsidian/vault-port";
import {
  type LearningLoopSettings,
  type ServerSettings,
  type SettingsRepository,
  strongClientPassword,
} from "../settings";
import type {
  ConnectionTestCredentials,
  SetupCredentials,
} from "../ui/credentials-modal";
import {
  WasmEncryptedCore,
  bytesToHex,
  hexToBytes,
  initializeCore,
} from "../wasm/runtime";
import {
  FixedRouteHttpTransport,
  TransportError,
} from "../transport/http";
import {
  AuthenticatedSession,
  EncryptedProtocolError,
} from "../transport/session";
import {
  IndexedDbCiphertextCache,
  type CiphertextCache,
} from "./cache";
import { EchoSuppressor } from "./echo";
import { SyncEngine } from "./engine";
import { PullEngine } from "./pull";
import {
  IndexedDbStateRepository,
  type StateRepository,
} from "./state";

const DEBOUNCE_MS = 2_000;

export type SyncStatus =
  | "unconfigured"
  | "locked"
  | "connecting"
  | "waiting"
  | "syncing"
  | "synced"
  | "error";

export class SyncController {
  private core: WasmEncryptedCore | undefined;
  private session: AuthenticatedSession | undefined;
  private states: StateRepository | undefined;
  private cache: CiphertextCache | undefined;
  private settings: LearningLoopSettings | undefined;
  private readonly vault: ObsidianVaultPort;
  private readonly echoes = new EchoSuppressor();
  private syncTail: Promise<void> = Promise.resolve();
  private debounceTimer: number | undefined;
  private currentStatus: SyncStatus = "locked";

  constructor(
    private readonly app: App,
    private readonly pluginId: string,
    private readonly repository: SettingsRepository,
    private readonly statusChanged: (status: SyncStatus, detail?: string) => void,
  ) {
    this.vault = new ObsidianVaultPort(app);
  }

  async initialize(): Promise<void> {
    await initializeCore(this.app, this.pluginId);
    this.settings = await this.repository.load();
    this.setStatus(this.configured ? "locked" : "unconfigured");
  }

  get status(): SyncStatus {
    return this.currentStatus;
  }

  get configured(): boolean {
    return this.settings?.server !== undefined && this.settings.vault !== undefined;
  }

  get unlocked(): boolean {
    return this.core !== undefined;
  }

  get server(): ServerSettings | undefined {
    return this.settings?.server;
  }

  get serverPasswordStored(): boolean {
    const secretId = this.settings?.serverPasswordSecretId;
    return secretId !== undefined
      && this.app.secretStorage.getSecret(secretId) !== null;
  }

  async testConnection(
    credentials: ConnectionTestCredentials,
  ): Promise<void> {
    const storedServerPassword = await this.repository.serverPassword();
    const serverPassword = credentials.serverPassword.length > 0
      ? credentials.serverPassword
      : storedServerPassword;
    if (serverPassword === undefined || serverPassword.length < 16) {
      throw new Error("server access password is unavailable");
    }
    let session: AuthenticatedSession | undefined;
    try {
      const connection = await AuthenticatedSession.connect(
        FixedRouteHttpTransport.fromHostAndPort(
          credentials.host,
          credentials.port,
        ),
        credentials.fingerprint,
        serverPassword,
      );
      session = connection.session;
    } catch (error) {
      throw new Error(userFacingErrorMessage(error), { cause: error });
    } finally {
      session?.close();
    }
  }

  async configure(credentials: SetupCredentials): Promise<void> {
    const storedServerPassword = await this.repository.serverPassword();
    const serverPassword = credentials.serverPassword.length > 0
      ? credentials.serverPassword
      : storedServerPassword;
    if (serverPassword === undefined || serverPassword.length < 16) {
      throw new Error("server access password is unavailable");
    }
    if (
      !strongClientPassword(credentials.clientPassword)
      || credentials.clientPassword === serverPassword
    ) {
      throw new Error(
        "client password must be strong and different from the server password",
      );
    }
    const server: ServerSettings = {
      host: credentials.host,
      port: credentials.port,
      fingerprint: credentials.fingerprint,
      deviceName: credentials.deviceName,
    };
    const current = this.settings ?? await this.repository.load();
    let draftSaved = false;
    if (current.vault === undefined) {
      this.settings = await this.repository.saveInitialSetupDraft(
        server,
        credentials.serverPassword.length > 0
          ? credentials.serverPassword
          : undefined,
      );
      draftSaved = true;
    }
    this.setStatus("connecting");
    const http = FixedRouteHttpTransport.fromHostAndPort(
      server.host,
      server.port,
    );
    let session: AuthenticatedSession | undefined;
    let core: WasmEncryptedCore | undefined;
    try {
      const connection = await AuthenticatedSession.connect(
        http,
        server.fingerprint,
        serverPassword,
      );
      session = connection.session;
      const existingEnvelope = await session.tryGetVaultKeyEnvelope();
      let encryptedDeviceIdentity: Uint8Array;
      let wrappedVaultKey: Uint8Array;
      if (existingEnvelope === undefined) {
        const created = WasmEncryptedCore.create(
          connection.vaultId,
          credentials.clientPassword,
          Platform.isAndroidApp,
        );
        core = created.core;
        wrappedVaultKey = created.wrappedVaultKey;
        encryptedDeviceIdentity = created.encryptedDeviceIdentity;
        await session.putVaultKeyEnvelope(wrappedVaultKey);
      } else {
        const created = WasmEncryptedCore.addDevice(
          connection.vaultId,
          credentials.clientPassword,
          existingEnvelope,
        );
        core = created.core;
        wrappedVaultKey = existingEnvelope;
        encryptedDeviceIdentity = created.encryptedDeviceIdentity;
      }
      await session.registerDevice(core, server.deviceName);
      const next = await this.repository.completeSetup(
        server,
        {
          vaultIdHex: connection.vaultId,
          wrappedVaultKeyHex: bytesToHex(wrappedVaultKey),
          encryptedDeviceIdentityHex: bytesToHex(encryptedDeviceIdentity),
        },
        serverPassword,
      );
      this.lock();
      this.settings = next;
      this.core = core;
      this.session = session;
      this.initializeLocalStores(connection.vaultId);
      core = undefined;
      session = undefined;
      await this.syncNow();
    } catch (error) {
      session?.close();
      core?.lock();
      const message = userFacingErrorMessage(error);
      this.setStatus("error", message);
      throw new Error(
        draftSaved
          ? `${message}。服务器配置与访问密码已保存；客户端加密密码未保存。`
          : message,
        { cause: error },
      );
    }
  }

  async unlock(clientPassword: string): Promise<void> {
    if (this.core !== undefined) {
      return;
    }
    const settings = this.settings ?? await this.repository.load();
    if (settings.server === undefined || settings.vault === undefined) {
      throw new Error("encrypted synchronization is not configured");
    }
    this.setStatus("connecting");
    let core: WasmEncryptedCore | undefined;
    let localUnlockComplete = false;
    try {
      core = WasmEncryptedCore.unlock(
        settings.vault.vaultIdHex,
        clientPassword,
        hexToBytes(settings.vault.wrappedVaultKeyHex),
        hexToBytes(settings.vault.encryptedDeviceIdentityHex),
      );
      localUnlockComplete = true;
      this.core = core;
      core = undefined;
      this.initializeLocalStores(settings.vault.vaultIdHex);
      await this.ensureSession();
      await this.syncNow();
    } catch (error) {
      core?.lock();
      this.lock();
      const message = localUnlockComplete
        ? userFacingErrorMessage(error)
        : "客户端加密密码不正确，请重新输入";
      this.setStatus("error", message);
      throw new Error(message, { cause: error });
    }
  }

  lock(): void {
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.session?.close();
    this.session = undefined;
    this.core?.lock();
    this.core = undefined;
    this.states = undefined;
    this.cache = undefined;
    this.setStatus(this.configured ? "locked" : "unconfigured");
  }

  syncNow(): Promise<void> {
    const run = this.syncTail.then(async () => {
      if (this.core === undefined) {
        throw new Error(
          this.configured
            ? "Learning Loop is locked"
            : "encrypted synchronization is not configured",
        );
      }
      this.setStatus(Platform.isMobile ? "waiting" : "syncing");
      let firstError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.runOnce();
          this.setStatus("synced");
          return;
        } catch (error) {
          firstError ??= error;
          this.session?.close();
          this.session = undefined;
        }
      }
      this.setStatus("error", userFacingErrorMessage(firstError));
      throw firstError;
    });
    this.syncTail = run.catch(() => undefined);
    return run;
  }

  async handleContentEvent(path: string): Promise<void> {
    if (this.core === undefined) {
      return;
    }
    try {
      const bytes = await this.vault.read(path);
      const canonical = isText(path)
        ? this.core.canonicalizeText(bytes)
        : bytes;
      if (this.echoes.consume(path, this.core.hash(canonical))) {
        return;
      }
    } catch {
      // Reconciliation will classify a racing delete or read failure safely.
    }
    this.scheduleSync();
  }

  handlePathEvent(...paths: readonly string[]): void {
    if (this.core === undefined) {
      return;
    }
    if (paths.some((path) => this.echoes.consumePath(path))) {
      return;
    }
    this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = undefined;
      void this.syncNow().catch(() => undefined);
    }, DEBOUNCE_MS);
    if (Platform.isMobile) {
      this.setStatus("waiting");
    }
  }

  private async runOnce(): Promise<void> {
    const core = required(this.core);
    const state = required(this.states);
    const cache = required(this.cache);
    const settings = required(this.settings);
    const server = required(settings.server);
    const vault = required(settings.vault);
    const session = await this.ensureSession();
    this.setStatus("syncing");
    await new PullEngine(
      vault.vaultIdHex,
      this.vault,
      core,
      session,
      state,
      this.echoes,
      server.deviceName,
    ).pull();
    const push = new SyncEngine(
      vault.vaultIdHex,
      this.vault,
      core,
      session,
      state,
      cache,
    );
    await push.reconcile();
    await push.push();
  }

  private async ensureSession(): Promise<AuthenticatedSession> {
    if (this.session !== undefined) {
      return this.session;
    }
    const core = required(this.core);
    const settings = required(this.settings);
    const server = required(settings.server);
    const vault = required(settings.vault);
    const serverPassword = this.app.secretStorage.getSecret(
      settings.serverPasswordSecretId,
    );
    if (serverPassword === null) {
      throw new Error("server password is absent from Obsidian SecretStorage");
    }
    const connection = await AuthenticatedSession.connect(
      FixedRouteHttpTransport.fromHostAndPort(server.host, server.port),
      server.fingerprint,
      serverPassword,
      core.transportIdentity(),
    );
    if (
      connection.vaultId !== vault.vaultIdHex
      || !connection.deviceAuthenticated
    ) {
      connection.session.close();
      throw new Error("server vault or device identity changed");
    }
    this.session = connection.session;
    return connection.session;
  }

  private initializeLocalStores(vaultId: string): void {
    this.states = new IndexedDbStateRepository(
      `learning-loop-state-${vaultId}`,
    );
    this.cache = new IndexedDbCiphertextCache(
      `learning-loop-ciphertext-${vaultId}`,
    );
  }

  private setStatus(status: SyncStatus, detail?: string): void {
    this.currentStatus = status;
    this.statusChanged(status, detail);
  }
}

export function userFacingErrorMessage(error: unknown): string {
  if (error instanceof EncryptedProtocolError) {
    if (error.code === 2) {
      return "服务器访问密码不正确，或该设备已失去授权";
    }
    if (error.code === 3) {
      return "这台设备尚未获得服务器授权";
    }
    if (error.code === 4) {
      return "服务器中找不到这台设备，请重新配置";
    }
    if (error.code === 5) {
      return "这台设备已被服务器撤销";
    }
    if (error.code === 12) {
      return "服务器存储空间不足，暂时无法同步";
    }
    if (error.code === 13) {
      return "服务器正在限流，请稍后重试";
    }
    return `服务器拒绝了本次安全操作（错误代码 ${error.code.toString()}）`;
  }
  if (error instanceof TransportError) {
    if (error.status === 0) {
      return "无法连接服务器。请检查 DDNS 解析、端口映射、防火墙和服务端监听地址";
    }
    if (error.status === 429) {
      return "服务器正在限流，请稍后重试";
    }
    return `服务器返回 HTTP ${error.status.toString()}，请核对服务器密码、版本和反向代理配置`;
  }
  const message = error instanceof Error
    ? error.message
    : "encrypted synchronization failed";
  const knownMessages: Record<string, string> = {
    "Learning Loop is locked": "Learning Loop 尚未解锁",
    "client password must be strong and different from the server password":
      "客户端密码强度不足，或与服务器访问密码相同",
    "encrypted synchronization is not configured": "尚未完成加密同步配置",
    "server access password is unavailable":
      "服务器访问密码尚未保存，请重新打开配置并填写",
    "server password is absent from Obsidian SecretStorage":
      "Obsidian SecretStorage 中缺少服务器访问密码，请重新配置",
    "server vault or device identity changed":
      "服务器 Vault 或设备身份发生变化；为防止错误信任，已停止同步",
    "vault is locked": "本机加密材料尚未解锁",
    "invalid Learning Loop connection settings":
      "服务器配置格式不正确，请重新检查",
    "invalid server host or port": "服务器主机名或端口不正确",
    "server bootstrap or fingerprint is invalid":
      "服务器指纹不匹配，请从服务端启动日志重新复制完整指纹",
    "stored device is not authorized": "这台设备尚未获得服务器授权",
    "Learning Loop runtime is not ready": "Learning Loop 仍在启动，请稍后重试",
    "plugin runtime is not ready": "Learning Loop 仍在启动，请稍后重试",
    "no current learning node is selected": "尚未选择当前学习节点",
    "synchronization is blocked by local path issues":
      "有文件名无法在不同设备间安全同步，请检查同名文件或特殊字符",
    "the outline contains no headings or task items":
      "大纲中没有可创建的标题或任务项",
    "outline exceeds the node limit": "大纲包含的节点过多，请拆分后再导入",
    "outline node title is empty": "大纲中有一个空标题，请补充后再导入",
    "parent node belongs to another topic": "父节点不属于当前学习主题",
    "new parent belongs to another topic": "新的父节点不属于当前学习主题",
    "moving the node would create a cycle": "不能这样移动节点，否则会形成循环",
    "nodes from different topics cannot be merged": "不同学习主题的节点不能合并",
    "a node cannot be merged into itself": "节点不能与自己合并",
    "related nodes must belong to the same topic": "只能关联同一主题中的节点",
    "a node cannot relate to itself": "节点不能关联自己",
    "no runbook exists": "尚未创建操作手册",
    "only a source or operations record can be distilled":
      "请打开资料、论文或运维记录后再提炼",
    "a folder blocks today's dashboard":
      "今日面板的目标位置被同名文件夹占用",
    "a file blocks a Learning Loop folder":
      "学习空间的目标位置被同名文件占用",
    "a folder blocks an automatic map":
      "知识图谱的目标位置被同名文件夹占用",
    "could not allocate a unique learning note path":
      "无法为新笔记生成不重复的文件名",
    "learning object ID is missing or duplicated":
      "学习笔记的内部标识缺失或重复，请从备份恢复后再同步",
    "learning note is missing": "找不到对应的学习笔记",
    "local vault has a portable path collision":
      "本机存在跨设备会重名的文件路径，请调整文件名后重试",
    "remote manifests contain a portable path collision":
      "服务器记录中存在跨设备会重名的文件路径，已停止同步以保护数据",
    "server returned a different ciphertext hash":
      "服务器返回的数据校验失败，已停止同步以保护笔记",
    "remote plaintext does not match the signed manifest":
      "远端数据签名校验失败，已停止同步以保护笔记",
    "the server has no active verification keys":
      "服务器没有可用的设备验证密钥，已停止同步",
    "synchronization cannot access Obsidian configuration files":
      "Learning Loop 不会同步 Obsidian 的内部配置文件",
  };
  const known = knownMessages[message];
  if (known !== undefined) {
    return known;
  }
  if (message.startsWith("possible password")) {
    return "内容看起来包含密码、私钥或令牌，已阻止写入笔记";
  }
  if (message.startsWith("active note is not a Learning Loop")) {
    return "当前笔记不是可执行此操作的 Learning Loop 笔记";
  }
  if (/\p{Script=Han}/u.test(message)) {
    return message;
  }
  return "操作没有完成，请检查当前笔记或服务器连接后重试";
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Learning Loop runtime is not ready");
  }
  return value;
}

function isText(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return new Set([
    "base",
    "canvas",
    "css",
    "csv",
    "js",
    "json",
    "md",
    "ts",
    "tsv",
    "txt",
    "yaml",
    "yml",
  ]).has(extension);
}
