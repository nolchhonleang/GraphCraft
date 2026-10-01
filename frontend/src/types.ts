/**
 * Shared GraphCraft frontend type contracts.
 * Mirrors the JSON schema emitted by backend/core/graph.py.
 */

export type NodeKind =
  | "file"
  | "class"
  | "function"
  | "component"
  | "module"
  | "model";

export type EdgeKind =
  | "import"
  | "inherit"
  | "call"
  | "contains"
  | "export"
  | "reference";

export type ColorGroup = "backend" | "frontend" | string;

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  path: string;
  language: string;
  line?: number | null;
  size_bytes: number;
  metadata: Record<string, unknown>;
  color_group: ColorGroup;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label: string;
  metadata: Record<string, unknown>;
}

export interface GraphStats {
  node_count: number;
  edge_count: number;
  kinds?: Record<string, number>;
  languages?: Record<string, number>;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  root_path: string;
  stats: GraphStats;
}

export interface LayoutNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ConnectionStatus = "connecting" | "open" | "closed" | "error";

export interface WebSocketEnvelope {
  type: string;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  root_path?: string;
  stats?: GraphStats;
  message?: string;
  offline?: boolean;
}
