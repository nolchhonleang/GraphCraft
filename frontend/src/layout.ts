/**
 * Pure TypeScript layout math for GraphCraft canvas.
 * No external graph / plotting libraries.
 */

import type { GraphEdge, GraphNode, LayoutNode } from "./types";

export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 52;
export const H_GAP = 48;
export const V_GAP = 36;
export const COLUMN_WIDTH = NODE_WIDTH + H_GAP;

const BACKEND_KINDS = new Set(["class", "function", "model", "module"]);

/**
 * Compute a deterministic layered grid layout.
 *
 * Backend-colored nodes occupy left columns; frontend nodes occupy right
 * columns. Within each group, nodes are sorted by path then label for
 * stable visual identity across rescans.
 */
export function computeLayout(nodes: GraphNode[]): LayoutNode[] {
  if (nodes.length === 0) {
    return [];
  }

  const backend = nodes
    .filter((n) => n.color_group === "backend" || (n.color_group !== "frontend" && BACKEND_KINDS.has(n.kind)))
    .sort(compareNodes);
  const frontend = nodes
    .filter((n) => !backend.includes(n))
    .sort(compareNodes);

  const layout: LayoutNode[] = [];
  placeGroup(backend, layout, 0);
  const backendCols = Math.max(1, Math.ceil(Math.sqrt(backend.length || 1)));
  placeGroup(frontend, layout, backendCols + 1);

  return layout;
}

function placeGroup(group: GraphNode[], out: LayoutNode[], startCol: number): void {
  if (group.length === 0) {
    return;
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(group.length)));
  group.forEach((node, index) => {
    const col = startCol + (index % cols);
    const row = Math.floor(index / cols);
    out.push({
      ...node,
      x: 64 + col * COLUMN_WIDTH,
      y: 64 + row * (NODE_HEIGHT + V_GAP),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  });
}

function compareNodes(a: GraphNode, b: GraphNode): number {
  const pathCmp = a.path.localeCompare(b.path);
  if (pathCmp !== 0) {
    return pathCmp;
  }
  return a.label.localeCompare(b.label);
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Hit-test a world-space point against laid-out nodes (top-most first).
 */
export function hitTestNode(layout: LayoutNode[], worldX: number, worldY: number): LayoutNode | null {
  for (let i = layout.length - 1; i >= 0; i -= 1) {
    const node = layout[i];
    if (!node) {
      continue;
    }
    if (
      worldX >= node.x &&
      worldX <= node.x + node.width &&
      worldY >= node.y &&
      worldY <= node.y + node.height
    ) {
      return node;
    }
  }
  return null;
}

/**
 * Screen → world coordinate transform given pan/zoom.
 */
export function screenToWorld(
  screenX: number,
  screenY: number,
  panX: number,
  panY: number,
  scale: number,
): Point {
  return {
    x: (screenX - panX) / scale,
    y: (screenY - panY) / scale,
  };
}

/**
 * Collect incoming and outgoing edges for a selected node.
 */
export function relatedEdges(edges: GraphEdge[], nodeId: string): {
  incoming: GraphEdge[];
  outgoing: GraphEdge[];
} {
  const incoming: GraphEdge[] = [];
  const outgoing: GraphEdge[] = [];
  for (const edge of edges) {
    if (edge.target === nodeId) {
      incoming.push(edge);
    }
    if (edge.source === nodeId) {
      outgoing.push(edge);
    }
  }
  return { incoming, outgoing };
}

/**
 * Fill color for a node based on color_group / kind.
 * Palette matches the blueprint-workshop UI theme.
 */
export function nodeFill(node: GraphNode, selected: boolean): string {
  if (selected) {
    return node.color_group === "frontend" ? "#c77716" : "#0f5b63";
  }
  if (node.color_group === "frontend") {
    return "#b56a1a";
  }
  if (node.kind === "model") {
    return "#0d4f56";
  }
  return "#14727c";
}

export function nodeStroke(selected: boolean): string {
  return selected ? "#102a2e" : "rgba(16, 42, 46, 0.28)";
}
