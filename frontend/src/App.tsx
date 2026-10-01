import { useCallback, useEffect, useMemo, useState } from "react";
import Canvas from "./components/Canvas";
import Inspector from "./components/Inspector";
import Sidebar from "./components/Sidebar";
import { useWebSocket } from "./hooks/useWebSocket";
import type { GraphNode } from "./types";

const EMPTY_NODES: GraphNode[] = [];
const WELCOME_KEY = "graphcraft.welcome.dismissed";

/**
 * GraphCraft layout controller and WebSocket live-state hub.
 */
export default function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scanPath, setScanPath] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showWelcome, setShowWelcome] = useState(() => {
    try {
      return localStorage.getItem(WELCOME_KEY) !== "1";
    } catch {
      return true;
    }
  });
  const [showSidebar, setShowSidebar] = useState(true);
  const [showInspector, setShowInspector] = useState(true);
  const [focusNonce, setFocusNonce] = useState(0);

  const { status, lastError, graph, requestScan, connect } = useWebSocket({
    url: "ws://127.0.0.1:8000",
    autoConnect: true,
  });

  const nodes = graph?.nodes ?? EMPTY_NODES;
  const edges = graph?.edges ?? [];
  const rootPath = graph?.root_path ?? "";
  const stats = graph?.stats;
  const online = status === "open";
  const hasGraph = nodes.length > 0;

  useEffect(() => {
    if (rootPath && !scanPath) {
      setScanPath(rootPath);
    }
  }, [rootPath, scanPath]);

  useEffect(() => {
    if (graph) {
      setIsScanning(false);
    }
  }, [graph]);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  const visibleError = lastError && lastError !== dismissedError ? lastError : null;

  const dismissWelcome = useCallback(() => {
    setShowWelcome(false);
    try {
      localStorage.setItem(WELCOME_KEY, "1");
    } catch {
      // ignore private-mode storage failures
    }
  }, []);

  const handleSelect = useCallback((node: GraphNode | null) => {
    setSelectedId(node ? node.id : null);
    if (node) {
      setFocusNonce((n) => n + 1);
      setShowInspector(true);
    }
  }, []);

  const handleSelectId = useCallback((id: string) => {
    setSelectedId(id);
    setFocusNonce((n) => n + 1);
    setShowInspector(true);
  }, []);

  const handleScan = useCallback(() => {
    if (!online) {
      connect();
      return;
    }
    const trimmed = scanPath.trim();
    setIsScanning(true);
    setDismissedError(null);
    dismissWelcome();
    const ok = requestScan(trimmed || undefined);
    if (!ok) {
      setIsScanning(false);
    }
  }, [connect, dismissWelcome, online, requestScan, scanPath]);

  const workspaceClass = [
    "workspace",
    showSidebar ? "" : "workspace-no-sidebar",
    showInspector ? "" : "workspace-no-inspector",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <h1>GraphCraft</h1>
            <p>See how your project files connect</p>
          </div>
        </div>

        <form
          className="scan-bar"
          onSubmit={(e) => {
            e.preventDefault();
            handleScan();
          }}
        >
          <label className="scan-label" htmlFor="scan-path">
            Step 1 — Project folder on this computer
          </label>
          <div className="scan-row">
            <input
              id="scan-path"
              className="path-input"
              type="text"
              placeholder="Paste a path, e.g. D:\work\my-app"
              value={scanPath}
              onChange={(e) => setScanPath(e.target.value)}
              disabled={isScanning}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              className="primary-btn"
              disabled={isScanning}
              title={online ? "Build a dependency map of this folder" : "Connect to engine first"}
            >
              {isScanning ? "Mapping…" : online ? "Map project" : "Connect & map"}
            </button>
          </div>
        </form>

        <div className="topbar-actions">
          <button
            type="button"
            className={`panel-toggle ${showSidebar ? "active" : ""}`}
            onClick={() => setShowSidebar((v) => !v)}
            aria-pressed={showSidebar}
            title="List of discovered files and symbols"
          >
            Catalog
          </button>
          <button
            type="button"
            className={`panel-toggle ${showInspector ? "active" : ""}`}
            onClick={() => setShowInspector((v) => !v)}
            aria-pressed={showInspector}
            title="Details for the selected item"
          >
            Explain
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              setShowHelp(true);
              setShowWelcome(true);
            }}
          >
            What is this?
          </button>
          <div className={`status-chip status-${status}`} title={status}>
            <span className="status-dot" />
            <span>{statusLabel(status)}</span>
            {stats ? (
              <span className="status-stats">
                {stats.node_count} parts · {stats.edge_count} links
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <section className="purpose-strip" aria-label="What GraphCraft is for">
        <p>
          <strong>What this tool is for:</strong> GraphCraft reads a local codebase and draws a
          live map of files, classes, UI components, and how they depend on each other — so you
          can understand a big project faster. Everything stays on your machine.
        </p>
        <div className="purpose-legend" aria-hidden>
          <span>
            <i className="legend-swatch legend-backend" /> Backend / Python
          </span>
          <span>
            <i className="legend-swatch legend-frontend" /> Frontend / UI
          </span>
          <span>
            <i className="legend-line" /> Line = dependency
          </span>
        </div>
      </section>

      {visibleError ? (
        <div className="banner-error" role="alert">
          <div>
            <strong>Can’t reach the local mapping engine</strong>
            <p>{visibleError}</p>
            <p className="banner-hint">
              In a terminal, run <code>python main.py --path ..</code> inside the{" "}
              <code>backend/</code> folder, then click Reconnect.
            </p>
          </div>
          <div className="banner-actions">
            <button type="button" className="primary-btn" onClick={connect}>
              Reconnect
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setDismissedError(lastError)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {showHelp || (showWelcome && !hasGraph) ? (
        <div className="help-banner purpose-help">
          <div>
            <p className="help-kicker">Quick start</p>
            <h2 className="help-title">Turn a messy repo into a readable map</h2>
            <ol>
              <li>
                <strong>Map a folder</strong> — paste the project path above and click{" "}
                <em>Map project</em>.
              </li>
              <li>
                <strong>Browse the catalog</strong> (left) — every discovered file/class/component.
              </li>
              <li>
                <strong>Explore the map</strong> (center) — boxes are parts of your code; lines show
                imports and relationships.
              </li>
              <li>
                <strong>Read the explain panel</strong> (right) — what something depends on, and what
                depends on it.
              </li>
            </ol>
            <p className="muted help-note">
              Useful when joining a new repo, spotting tight coupling, or reviewing module structure —
              all on your own machine.
            </p>
          </div>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              setShowHelp(false);
              dismissWelcome();
            }}
          >
            Start mapping
          </button>
        </div>
      ) : null}

      <main className={workspaceClass}>
        {showSidebar ? (
          <Sidebar
            nodes={nodes}
            selectedId={selectedId}
            rootPath={rootPath}
            onSelect={handleSelect}
            online={online}
          />
        ) : null}

        <Canvas
          nodes={nodes}
          edges={edges}
          selectedId={selectedId}
          focusNonce={focusNonce}
          onSelect={handleSelect}
          online={online}
          isScanning={isScanning}
          onOpenHelp={() => {
            setShowHelp(true);
            setShowWelcome(true);
          }}
        />

        {showInspector ? (
          <Inspector
            node={selectedNode}
            nodes={nodes}
            edges={edges}
            onSelectId={handleSelectId}
            onClear={() => setSelectedId(null)}
          />
        ) : null}
      </main>

      <footer className="footer-bar">
        <span>Built by Nol Chhonleang · private localhost tool</span>
        <span>
          {rootPath
            ? `Mapped: ${shortenPath(rootPath)}`
            : "No project mapped yet — paste a folder path above"}
        </span>
      </footer>
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Engine ready";
    case "connecting":
      return "Connecting";
    case "error":
      return "Engine error";
    default:
      return "Engine offline";
  }
}

function shortenPath(path: string): string {
  if (path.length <= 64) {
    return path;
  }
  return `…${path.slice(-60)}`;
}
