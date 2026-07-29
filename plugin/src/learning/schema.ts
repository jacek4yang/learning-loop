export const LEARNING_FOLDERS = [
  "00-Inbox",
  "00-Inbox/Sync Conflicts",
  "10-Topics",
  "20-Nodes",
  "30-Sources",
  "30-Sources/Papers",
  "30-Sources/Books",
  "30-Sources/Documents",
  "40-Records",
  "40-Records/Experiments",
  "40-Records/Changes",
  "40-Records/Incidents",
  "50-Assets",
  "50-Assets/Servers",
  "50-Assets/Services",
  "50-Assets/Databases",
  "60-Cards",
  "70-Maps",
  "80-Daily",
  "90-Templates",
  "99-Attachments",
] as const;

export type LearningObjectType =
  | "topic"
  | "node"
  | "source"
  | "record"
  | "asset"
  | "card";

export const NODE_TEMPLATE = [
  "## 当前理解",
  "",
  "## 为什么",
  "",
  "## 边界条件",
  "",
  "## 示例",
  "",
  "## 实验或证据",
  "",
  "## 容易混淆",
  "",
  "## 待探索",
  "",
  "## 相关知识",
  "",
  "## 来源",
  "",
  "## 修正记录",
  "",
].join("\n");

export const ENGLISH_TEMPLATE = [
  "## 单词或术语",
  "",
  "## 技术含义",
  "",
  "## 多领域含义",
  "",
  "## 原句",
  "",
  "## 原句挖空",
  "",
  "## 例句",
  "",
  "## 自己造句",
  "",
  "## 易混词",
  "",
].join("\n");

export const PAPER_TEMPLATE = [
  "## 论文元数据",
  "",
  "## 研究问题",
  "",
  "## 方法",
  "",
  "## 实验",
  "",
  "## 结果",
  "",
  "## 作者断言",
  "",
  "## 局限",
  "",
  "## 原文",
  "",
  "## 翻译",
  "",
  "## 用户理解",
  "",
  "## 质疑",
  "",
  "## 提炼的知识节点",
  "",
].join("\n");

export const OPERATIONS_TEMPLATES = {
  server: [
    "## 角色",
    "",
    "## 连接方式",
    "",
    "> [!warning] 仅记录 SecretStorage、密码管理器或密钥条目的引用，不记录秘密本身。",
    "",
    "## 验证",
    "",
  ].join("\n"),
  service: [
    "## 服务目标",
    "",
    "## 依赖",
    "",
    "## 健康检查",
    "",
    "## 运行手册",
    "",
    "## 回滚",
    "",
  ].join("\n"),
  database: [
    "## 数据职责",
    "",
    "## 备份",
    "",
    "## 恢复验证",
    "",
    "## 运行手册",
    "",
  ].join("\n"),
  change: [
    "## 变更目标",
    "",
    "## 前置检查",
    "",
    "## 执行步骤",
    "",
    "## 回滚步骤",
    "",
    "## 验证结果",
    "",
  ].join("\n"),
  incident: [
    "## 影响",
    "",
    "## 时间线",
    "",
    "## 诊断",
    "",
    "## 根因",
    "",
    "## 恢复",
    "",
    "## 后续行动",
    "",
    "## 提炼的知识节点",
    "",
  ].join("\n"),
  runbook: [
    "## 适用条件",
    "",
    "## 前置检查",
    "",
    "## 操作步骤",
    "",
    "## 回滚步骤",
    "",
    "## 验证结果",
    "",
  ].join("\n"),
} as const;

export const CARD_TYPES = [
  "定义",
  "原理",
  "比较",
  "步骤",
  "诊断",
  "代码预测",
  "英文术语",
  "论文结论",
] as const;

export type CardType = typeof CARD_TYPES[number];
export type ReviewGrade = "不会" | "模糊" | "掌握";

export interface LearningNode {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly topic: string;
  readonly parent?: string;
  readonly order: number;
  readonly status: string;
  readonly current: boolean;
  readonly confidence: string;
  readonly verified: boolean;
  readonly mastered: boolean;
  readonly related: readonly string[];
}

export interface LearningTreeNode {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly status: string;
  readonly current: boolean;
  readonly confidence: string;
  readonly verified: boolean;
  readonly mastered: boolean;
  readonly children: readonly LearningTreeNode[];
}

export interface LearningTreeTopic {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly mastered: number;
  readonly total: number;
  readonly roots: readonly LearningTreeNode[];
}
