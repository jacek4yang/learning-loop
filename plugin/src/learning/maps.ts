import type { LearningNode } from "./schema";

export interface CanvasDocument {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
}

type CanvasNode = FileCanvasNode | TextCanvasNode;

interface FileCanvasNode {
  readonly id: string;
  readonly type: "file";
  readonly file: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color?: string;
}

interface TextCanvasNode {
  readonly id: string;
  readonly type: "text";
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color?: string;
}

interface CanvasEdge {
  readonly id: string;
  readonly fromNode: string;
  readonly fromSide: "right";
  readonly toNode: string;
  readonly toSide: "left";
}

export interface MapOptions {
  readonly mobile: boolean;
  readonly focusId?: string;
  readonly maximumNodes?: number;
}

export function buildStructureMap(
  input: readonly LearningNode[],
  options: MapOptions,
): CanvasDocument {
  const all = stableNodes(input);
  const byId = new Map(all.map((node) => [node.id, node]));
  const visible = options.mobile
    ? mobileNeighborhood(all, byId, options.focusId)
    : boundedDesktopNodes(all, options.maximumNodes ?? 500);
  const visibleIds = new Set(visible.map((node) => node.id));
  const ordered = layoutOrder(visible);
  const depth = depths(visible, visibleIds);
  const nodes: CanvasNode[] = ordered.map((node, index) => ({
    id: canvasId("node", node.id),
    type: "file",
    file: node.path,
    x: (depth.get(node.id) ?? 0) * 360,
    y: index * 150,
    width: 300,
    height: 100,
    ...(node.current ? { color: "4" } : {}),
  }));
  const edges: CanvasEdge[] = [];
  for (const node of ordered) {
    if (node.parent === undefined || !visibleIds.has(node.parent)) {
      continue;
    }
    edges.push(edge(node.parent, node.id));
  }
  const omitted = all.length - visible.length;
  if (omitted > 0) {
    nodes.push({
      id: canvasId("collapsed", omitted.toString()),
      type: "text",
      text: `${omitted.toString()} nodes collapsed. Focus a branch to expand lazily.`,
      x: 0,
      y: ordered.length * 150,
      width: 420,
      height: 100,
      color: "3",
    });
  }
  return {
    nodes,
    edges: edges.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function buildRelationMap(
  input: readonly LearningNode[],
  maximumNodes = 500,
): CanvasDocument {
  const nodes = boundedDesktopNodes(stableNodes(input), maximumNodes);
  const ids = new Set(nodes.map((node) => node.id));
  const canvasNodes: CanvasNode[] = nodes.map((node, index) => {
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    return {
      id: canvasId("node", node.id),
      type: "file",
      file: node.path,
      x: (index % columns) * 340,
      y: Math.floor(index / columns) * 150,
      width: 280,
      height: 100,
      ...(node.current ? { color: "4" } : {}),
    };
  });
  const edges = new Map<string, CanvasEdge>();
  for (const node of nodes) {
    for (const related of [...node.related].sort()) {
      if (!ids.has(related) || related === node.id) {
        continue;
      }
      const pair = [node.id, related].sort();
      const id = canvasId("relation", `${pair[0] ?? ""}:${pair[1] ?? ""}`);
      edges.set(id, {
        id,
        fromNode: canvasId("node", pair[0] ?? ""),
        fromSide: "right",
        toNode: canvasId("node", pair[1] ?? ""),
        toSide: "left",
      });
    }
  }
  return {
    nodes: canvasNodes,
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function encodeCanvas(document: CanvasDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function mobileNeighborhood(
  all: readonly LearningNode[],
  byId: Map<string, LearningNode>,
  requestedFocus: string | undefined,
): LearningNode[] {
  const focus = requestedFocus === undefined
    ? all.find((node) => node.current)
    : byId.get(requestedFocus);
  if (focus === undefined) {
    return all.slice(0, 50);
  }
  const visible = new Set<string>([focus.id]);
  let cursor: LearningNode | undefined = focus;
  while (cursor?.parent !== undefined) {
    visible.add(cursor.parent);
    cursor = byId.get(cursor.parent);
  }
  for (const node of all) {
    if (node.parent === focus.id || node.parent === focus.parent) {
      visible.add(node.id);
    }
  }
  return all.filter((node) => visible.has(node.id));
}

function boundedDesktopNodes(
  all: readonly LearningNode[],
  maximum: number,
): LearningNode[] {
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new Error("map node limit must be positive");
  }
  if (all.length <= maximum) {
    return [...all];
  }
  const current = all.find((node) => node.current);
  const prioritized = [
    ...(current === undefined ? [] : [current]),
    ...all,
  ];
  const selected = new Map<string, LearningNode>();
  for (const node of prioritized) {
    selected.set(node.id, node);
    if (selected.size >= maximum) {
      break;
    }
  }
  return stableNodes([...selected.values()]);
}

function layoutOrder(nodes: readonly LearningNode[]): LearningNode[] {
  const byParent = new Map<string | undefined, LearningNode[]>();
  for (const node of nodes) {
    const children = byParent.get(node.parent) ?? [];
    children.push(node);
    byParent.set(node.parent, children);
  }
  for (const children of byParent.values()) {
    children.sort(compareNode);
  }
  const output: LearningNode[] = [];
  const visited = new Set<string>();
  const visit = (node: LearningNode): void => {
    if (visited.has(node.id)) {
      return;
    }
    visited.add(node.id);
    output.push(node);
    for (const child of byParent.get(node.id) ?? []) {
      visit(child);
    }
  };
  for (const root of byParent.get(undefined) ?? []) {
    visit(root);
  }
  for (const node of stableNodes(nodes)) {
    visit(node);
  }
  return output;
}

function depths(
  nodes: readonly LearningNode[],
  visible: ReadonlySet<string>,
): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result = new Map<string, number>();
  const depth = (node: LearningNode, trail: Set<string>): number => {
    const cached = result.get(node.id);
    if (cached !== undefined) {
      return cached;
    }
    if (
      node.parent === undefined
      || !visible.has(node.parent)
      || trail.has(node.id)
    ) {
      result.set(node.id, 0);
      return 0;
    }
    trail.add(node.id);
    const parent = byId.get(node.parent);
    const value = parent === undefined ? 0 : depth(parent, trail) + 1;
    trail.delete(node.id);
    result.set(node.id, value);
    return value;
  };
  for (const node of nodes) {
    depth(node, new Set());
  }
  return result;
}

function stableNodes(nodes: readonly LearningNode[]): LearningNode[] {
  return [...nodes].sort(compareNode);
}

function compareNode(left: LearningNode, right: LearningNode): number {
  return left.order - right.order
    || left.title.localeCompare(right.title, "und")
    || left.id.localeCompare(right.id);
}

function edge(parent: string, child: string): CanvasEdge {
  return {
    id: canvasId("edge", `${parent}:${child}`),
    fromNode: canvasId("node", parent),
    fromSide: "right",
    toNode: canvasId("node", child),
    toSide: "left",
  };
}

function canvasId(domain: string, value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of `${domain}:${value}`) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${domain}-${hash.toString(16).padStart(16, "0")}`;
}
