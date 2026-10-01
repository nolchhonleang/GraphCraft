import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphNode, NodeKind } from "../types";

export interface SidebarProps {
  nodes: GraphNode[];
  selectedId: string | null;
  rootPath: string;
  onSelect: (node: GraphNode) => void;
  online: boolean;
}

type KindFilter = "all" | NodeKind;

const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "file", label: "Files" },
  { id: "class", label: "Classes" },
  { id: "model", label: "Models" },
  { id: "component", label: "UI" },
  { id: "function", label: "Fns" },
  { id: "module", label: "Mods" },
];

/**
 * Segmented workspace repository tree with kind filters.
 */
export function Sidebar({ nodes, selectedId, rootPath, onSelect, online }: SidebarProps) {
  const [filter, setFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return nodes.filter((node) => {
      if (kindFilter !== "all" && node.kind !== kindFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        node.label.toLowerCase().includes(query) ||
        node.path.toLowerCase().includes(query) ||
        node.kind.toLowerCase().includes(query)
      );
    });
  }, [filter, kindFilter, nodes]);

  const groups = useMemo(() => {
    const backend = filtered
      .filter((n) => n.color_group !== "frontend")
      .sort((a, b) => a.path.localeCompare(b.path) || a.label.localeCompare(b.label));
    const frontend = filtered
      .filter((n) => n.color_group === "frontend")
      .sort((a, b) => a.path.localeCompare(b.path) || a.label.localeCompare(b.label));
    return [
      { key: "backend", title: "Backend (Python)", tone: "backend" as const, nodes: backend },
      { key: "frontend", title: "Frontend (UI)", tone: "frontend" as const, nodes: frontend },
    ];
  }, [filtered]);

  const toggle = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <div className="panel-title-row">
          <h2>Catalog</h2>
          <span className="panel-count">{filtered.length}</span>
        </div>
        <p className="panel-purpose">
          Everything GraphCraft found in your project. Click an item to highlight it on the map.
        </p>
        <p className="sidebar-root" title={rootPath || "No repository scanned"}>
          {rootPath ? shorten(rootPath) : online ? "Waiting for a folder to map…" : "Engine offline"}
        </p>
        <input
          className="sidebar-filter"
          type="search"
          placeholder="Search name, path, kind…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter workspace nodes"
        />
        <div className="kind-filters" role="toolbar" aria-label="Filter by kind">
          {KIND_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`kind-chip ${kindFilter === item.id ? "active" : ""}`}
              onClick={() => setKindFilter(item.id)}
              aria-pressed={kindFilter === item.id}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <div className="sidebar-groups">
        {nodes.length === 0 ? (
          <div className="panel-empty">
            <p className="empty-title">No code mapped yet</p>
            <p>
              {online
                ? "Use the top bar to choose a project folder, then click Map project."
                : "Start the local engine first, then map a folder."}
            </p>
            <p className="muted">
              Tip: map the repo you want to understand — GraphCraft will list files, classes, and UI
              pieces here.
            </p>
          </div>
        ) : (
          groups.map((group) => {
            const isCollapsed = Boolean(collapsed[group.key]);
            return (
              <section key={group.key} className={`tree-group tone-${group.tone}`}>
                <button
                  type="button"
                  className="tree-group-toggle"
                  onClick={() => toggle(group.key)}
                  aria-expanded={!isCollapsed}
                >
                  <span className={`swatch swatch-${group.tone}`} aria-hidden />
                  <span>{group.title}</span>
                  <span className="count">{group.nodes.length}</span>
                </button>

                {!isCollapsed && (
                  <ul className="tree-list">
                    {group.nodes.length === 0 ? (
                      <li className="tree-empty">Nothing in this filter</li>
                    ) : (
                      group.nodes.map((node) => {
                        const selected = selectedId === node.id;
                        return (
                          <li key={node.id}>
                            <button
                              type="button"
                              ref={selected ? selectedRef : undefined}
                              className={`tree-item ${selected ? "selected" : ""}`}
                              onClick={() => onSelect(node)}
                              title={node.path}
                            >
                              <span className={`tree-kind kind-${node.kind}`}>{node.kind}</span>
                              <span className="tree-label">{node.label}</span>
                              <span className="tree-path">{node.path || node.language}</span>
                            </button>
                          </li>
                        );
                      })
                    )}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>
    </aside>
  );
}

function shorten(path: string): string {
  if (path.length <= 48) {
    return path;
  }
  return `…${path.slice(-44)}`;
}

export default Sidebar;
