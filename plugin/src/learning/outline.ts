export interface OutlineNode {
  readonly title: string;
  readonly completed: boolean;
  readonly children: readonly OutlineNode[];
}

interface MutableNode {
  title: string;
  completed: boolean;
  children: MutableNode[];
}

export function parseMarkdownOutline(markdown: string): OutlineNode[] {
  const roots: MutableNode[] = [];
  const headingStack: { readonly depth: number; readonly node: MutableNode }[] = [];
  let inFence = false;
  let nodeCount = 0;
  const createNode = (title: string): MutableNode => {
    nodeCount += 1;
    if (nodeCount > 10_000) {
      throw new Error("outline exceeds the node limit");
    }
    return mutable(title);
  };
  for (const rawLine of markdown.replaceAll(/\r\n?/gu, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.trim() === "") {
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading !== null) {
      const depth = heading[1]?.length ?? 1;
      const node = createNode(cleanTitle(heading[2] ?? ""));
      while (
        headingStack.length > 0
        && (headingStack.at(-1)?.depth ?? 0) >= depth
      ) {
        headingStack.pop();
      }
      append(
        headingStack.at(-1)?.node.children ?? roots,
        node,
      );
      headingStack.push({ depth, node });
      continue;
    }
    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/u.exec(line);
    if (task !== null) {
      const node = createNode(cleanTitle(task[2] ?? ""));
      node.completed = (task[1] ?? "").toLowerCase() === "x";
      append(headingStack.at(-1)?.node.children ?? roots, node);
    }
  }
  return roots.map(freezeNode);
}

export function flattenOutline(
  roots: readonly OutlineNode[],
): readonly {
  readonly node: OutlineNode;
  readonly parentIndex?: number;
  readonly order: number;
}[] {
  const output: {
    readonly node: OutlineNode;
    readonly parentIndex?: number;
    readonly order: number;
  }[] = [];
  const visit = (
    nodes: readonly OutlineNode[],
    parentIndex: number | undefined,
  ): void => {
    nodes.forEach((node, order) => {
      const index = output.length;
      output.push({
        node,
        ...(parentIndex === undefined ? {} : { parentIndex }),
        order,
      });
      visit(node.children, index);
    });
  };
  visit(roots, undefined);
  return output;
}

function mutable(title: string): MutableNode {
  if (title.length === 0) {
    throw new Error("outline node title is empty");
  }
  return { title, completed: false, children: [] };
}

function append(target: MutableNode[], node: MutableNode): void {
  target.push(node);
}

function cleanTitle(value: string): string {
  return value
    .replaceAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/gu, "$1")
    .replaceAll(/[*_`~]/gu, "")
    .trim()
    .slice(0, 200);
}

function freezeNode(node: MutableNode): OutlineNode {
  return {
    title: node.title,
    completed: node.completed,
    children: node.children.map(freezeNode),
  };
}
