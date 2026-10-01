import { useMemo, useState } from "react";
import type { GraphEdge, GraphNode } from "../types";
import { relatedEdges } from "../layout";

export interface InspectorProps {
  node: GraphNode | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  onSelectId: (id: string) => void;
  onClear: () => void;
}

/**
 * Dependency Inspector — incoming/outgoing links and file metadata.
 */
export function Inspector({ node, nodes, edges, onSelectId, onClear }: InspectorProps) {
  const [copied, setCopied] = useState(false);

  const nodeIndex = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const n of nodes) {
      map.set(n.id, n);
    }
    return map;
  }, [nodes]);

  const relations = useMemo(() => {
    if (!node) {
      return { incoming: [] as GraphEdge[], outgoing: [] as GraphEdge[] };
    }
    return relatedEdges(edges, node.id);
  }, [edges, node]);

  const copyPath = async () => {
    if (!node?.path) {
      return;
    }
    try {
      await navigator.clipboard.writeText(node.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  if (!node) {
    return (
      <aside className="inspector">
        <header className="inspector-header">
          <h2>Explain</h2>
        </header>
        <div className="inspector-empty">
          <div className="empty-steps">
            <p className="empty-title">This panel answers: “what is connected?”</p>
            <p>
              Select any box on the map or item in the catalog to see:
            </p>
            <ul className="purpose-list">
              <li>where the code lives on disk</li>
              <li>what it depends on</li>
              <li>what else depends on it</li>
            </ul>
            <p className="muted">Use this when you need to understand impact before changing code.</p>
          </div>
        </div>
      </aside>
    );
  }

  const sizeLabel =
    node.size_bytes > 0
      ? node.size_bytes < 1024
        ? `${node.size_bytes} B`
        : `${(node.size_bytes / 1024).toFixed(1)} KB`
      : "—";

  return (
    <aside className="inspector">
        <header className="inspector-header">
          <h2>Explain</h2>
          <div className="inspector-header-actions">
            <span className={`pill pill-${node.color_group === "frontend" ? "frontend" : "backend"}`}>
              {node.color_group === "frontend" ? "Frontend / UI" : "Backend / Python"}
            </span>
            <button type="button" className="ghost-btn tiny" onClick={onClear} title="Clear selection">
              Clear
            </button>
          </div>
        </header>

      <div className="inspector-body">
        <section className="inspector-section">
          <h3>{node.label}</h3>
          <p className="inspector-kind-line">
            <span className={`kind-badge kind-${node.kind}`}>{node.kind}</span>
            <span className="muted">{node.language}</span>
          </p>

          <dl className="meta-grid">
            <div>
              <dt>Path</dt>
              <dd className="mono path-row" title={node.path}>
                <span>{node.path || "—"}</span>
                {node.path ? (
                  <button type="button" className="ghost-btn tiny" onClick={copyPath}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Line</dt>
              <dd>{node.line ?? "—"}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{sizeLabel}</dd>
            </div>
          </dl>
        </section>

        <section className="inspector-section">
          <h4>This depends on · {relations.outgoing.length}</h4>
          <EdgeList
            edges={relations.outgoing}
            direction="out"
            nodeIndex={nodeIndex}
            onSelectId={onSelectId}
          />
        </section>

        <section className="inspector-section">
          <h4>Other code that uses this · {relations.incoming.length}</h4>
          <EdgeList
            edges={relations.incoming}
            direction="in"
            nodeIndex={nodeIndex}
            onSelectId={onSelectId}
          />
        </section>

        {Object.keys(node.metadata || {}).length > 0 ? (
          <section className="inspector-section">
            <h4>Extra metadata</h4>
            <ul className="meta-list">
              {Object.entries(node.metadata).map(([key, value]) => (
                <li key={key}>
                  <span className="meta-key">{key}</span>
                  <span className="meta-val mono">{formatValue(value)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </aside>
  );
}

interface EdgeListProps {
  edges: GraphEdge[];
  direction: "in" | "out";
  nodeIndex: Map<string, GraphNode>;
  onSelectId: (id: string) => void;
}

function EdgeList({ edges, direction, nodeIndex, onSelectId }: EdgeListProps) {
  if (edges.length === 0) {
    return <p className="muted">None found</p>;
  }

  return (
    <ul className="edge-list">
      {edges.map((edge) => {
        const otherId = direction === "out" ? edge.target : edge.source;
        const other = nodeIndex.get(otherId);
        return (
          <li key={edge.id}>
            <button type="button" className="edge-item" onClick={() => onSelectId(otherId)}>
              <span className="edge-kind">{edge.kind}</span>
              <span className="edge-label">{other?.label ?? otherId}</span>
              {edge.label ? <span className="edge-ref mono">{edge.label}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default Inspector;
