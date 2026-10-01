import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { GraphEdge, GraphNode, LayoutNode } from "../types";
import {
  computeLayout,
  hitTestNode,
  NODE_HEIGHT,
  NODE_WIDTH,
  nodeFill,
  nodeStroke,
  screenToWorld,
} from "../layout";

export interface CanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  focusNonce: number;
  onSelect: (node: GraphNode | null) => void;
  online: boolean;
  isScanning: boolean;
  onOpenHelp: () => void;
}

interface DragState {
  mode: "pan" | "node";
  pointerId: number;
  originX: number;
  originY: number;
  startPanX: number;
  startPanY: number;
  nodeId?: string;
  nodeStartX?: number;
  nodeStartY?: number;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 2.8;

/**
 * Pure math-driven HTML Canvas graph renderer with zoom/fit controls.
 */
export function Canvas({
  nodes,
  edges,
  selectedId,
  focusNonce,
  onSelect,
  online,
  isScanning,
  onOpenHelp,
}: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [scale, setScale] = useState(1);
  const [layout, setLayout] = useState<LayoutNode[]>([]);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [showHints, setShowHints] = useState(true);
  const dragRef = useRef<DragState | null>(null);

  const nodesKey = useMemo(() => nodes.map((n) => n.id).sort().join("|"), [nodes]);

  useEffect(() => {
    const next = computeLayout(nodes);
    setLayout(next);
    if (next.length > 0) {
      // Defer fit until size is known via effect below
      setShowHints(true);
    }
  }, [nodes, nodesKey]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const { width, height } = entry.contentRect;
      setSize({
        width: Math.max(1, Math.floor(width)),
        height: Math.max(1, Math.floor(height)),
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layoutById = useMemo(() => {
    const map = new Map<string, LayoutNode>();
    for (const node of layout) {
      map.set(node.id, node);
    }
    return map;
  }, [layout]);

  const fitToView = useCallback(
    (targetLayout: LayoutNode[] = layout) => {
      if (targetLayout.length === 0 || size.width < 40 || size.height < 40) {
        setPan({ x: 40, y: 40 });
        setScale(1);
        return;
      }

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const node of targetLayout) {
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + node.width);
        maxY = Math.max(maxY, node.y + node.height);
      }

      const padding = 64;
      const contentW = Math.max(maxX - minX, 1);
      const contentH = Math.max(maxY - minY, 1);
      const nextScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, Math.min((size.width - padding * 2) / contentW, (size.height - padding * 2) / contentH)),
      );
      const worldCenterX = (minX + maxX) / 2;
      const worldCenterY = (minY + maxY) / 2;
      setScale(nextScale);
      setPan({
        x: size.width / 2 - worldCenterX * nextScale,
        y: size.height / 2 - worldCenterY * nextScale,
      });
    },
    [layout, size.height, size.width],
  );

  // Auto-fit when graph first loads / size becomes available
  const didAutoFit = useRef(false);
  useEffect(() => {
    if (layout.length === 0) {
      didAutoFit.current = false;
      return;
    }
    if (!didAutoFit.current && size.width > 100) {
      fitToView(layout);
      didAutoFit.current = true;
    }
  }, [fitToView, layout, size.width]);

  // Focus selected node when chosen from tree/inspector
  useEffect(() => {
    if (!selectedId || focusNonce === 0) {
      return;
    }
    const node = layoutById.get(selectedId);
    if (!node) {
      return;
    }
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    setPan({
      x: size.width / 2 - cx * scale,
      y: size.height / 2 - cy * scale,
    });
  }, [focusNonce, layoutById, scale, selectedId, size.height, size.width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, size.width, size.height);
    drawGrid(ctx, size.width, size.height, pan.x, pan.y, scale);

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(scale, scale);

    for (const edge of edges) {
      const source = layoutById.get(edge.source);
      const target = layoutById.get(edge.target);
      if (!source || !target) {
        continue;
      }
      const highlighted =
        selectedId !== null &&
        (edge.source === selectedId || edge.target === selectedId);
      drawEdge(ctx, source, target, edge.kind, highlighted);
    }

    for (const node of layout) {
      drawNode(ctx, node, node.id === selectedId);
    }

    ctx.restore();
  }, [edges, layout, layoutById, pan.x, pan.y, scale, selectedId, size.height, size.width]);

  const zoomBy = useCallback(
    (factor: number) => {
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
      const ratio = nextScale / scale;
      const cx = size.width / 2;
      const cy = size.height / 2;
      setPan({
        x: cx - (cx - pan.x) * ratio,
        y: cy - (cy - pan.y) * ratio,
      });
      setScale(nextScale);
    },
    [pan.x, pan.y, scale, size.height, size.width],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const world = screenToWorld(screenX, screenY, pan.x, pan.y, scale);
      const hit = hitTestNode(layout, world.x, world.y);

      canvas.setPointerCapture(event.pointerId);
      setShowHints(false);

      if (hit) {
        onSelect(hit);
        dragRef.current = {
          mode: "node",
          pointerId: event.pointerId,
          originX: screenX,
          originY: screenY,
          startPanX: pan.x,
          startPanY: pan.y,
          nodeId: hit.id,
          nodeStartX: hit.x,
          nodeStartY: hit.y,
        };
      } else {
        onSelect(null);
        dragRef.current = {
          mode: "pan",
          pointerId: event.pointerId,
          originX: screenX,
          originY: screenY,
          startPanX: pan.x,
          startPanY: pan.y,
        };
      }
    },
    [layout, onSelect, pan.x, pan.y, scale],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const dx = screenX - drag.originX;
      const dy = screenY - drag.originY;

      if (drag.mode === "pan") {
        setPan({
          x: drag.startPanX + dx,
          y: drag.startPanY + dy,
        });
        return;
      }

      if (
        drag.mode === "node" &&
        drag.nodeId &&
        drag.nodeStartX !== undefined &&
        drag.nodeStartY !== undefined
      ) {
        const worldDx = dx / scale;
        const worldDy = dy / scale;
        setLayout((prev) =>
          prev.map((node) =>
            node.id === drag.nodeId
              ? {
                  ...node,
                  x: drag.nodeStartX! + worldDx,
                  y: drag.nodeStartY! + worldDy,
                }
              : node,
          ),
        );
      }
    },
    [scale],
  );

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  }, []);

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;

      const delta = event.deltaY > 0 ? 0.9 : 1.1;
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * delta));
      const ratio = nextScale / scale;

      setPan({
        x: screenX - (screenX - pan.x) * ratio,
        y: screenY - (screenY - pan.y) * ratio,
      });
      setScale(nextScale);
      setShowHints(false);
    },
    [pan.x, pan.y, scale],
  );

  const resetLayout = () => {
    const next = computeLayout(nodes);
    setLayout(next);
    fitToView(next);
  };

  return (
    <div className="canvas-studio" ref={containerRef}>
      <div className="canvas-toolbar">
        <div className="canvas-toolbar-left">
          <span className="canvas-title">Dependency map</span>
          <span className="canvas-meta">
            {(scale * 100).toFixed(0)}% · {nodes.length} parts · {edges.length} connections
          </span>
        </div>
        <div className="canvas-toolbar-right">
          <button type="button" className="ghost-btn tiny" onClick={() => zoomBy(0.85)} title="Zoom out">
            −
          </button>
          <button type="button" className="ghost-btn tiny" onClick={() => zoomBy(1.15)} title="Zoom in">
            +
          </button>
          <button type="button" className="ghost-btn tiny" onClick={() => fitToView()} title="Fit graph in view">
            Fit
          </button>
          <button type="button" className="ghost-btn tiny" onClick={resetLayout} title="Reset layout">
            Reset
          </button>
        </div>
      </div>

      <div className="canvas-stage">
        <canvas
          ref={canvasRef}
          className="graph-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        />

        {isScanning ? (
          <div className="canvas-overlay">
            <div className="overlay-card">
              <div className="spinner" aria-hidden />
              <p>Reading your project and building the map…</p>
            </div>
          </div>
        ) : null}

        {!isScanning && nodes.length === 0 ? (
          <div className="canvas-overlay">
            <div className="overlay-card overlay-card-wide">
              <p className="help-kicker">Center stage</p>
              <h3>{online ? "Your project map will appear here" : "Start the local engine first"}</h3>
              <p>
                {online
                  ? "GraphCraft turns folders into an interactive diagram: boxes are code parts, lines are dependencies. Paste a project path above and click Map project."
                  : "GraphCraft needs the Python engine running locally so your private code never leaves this computer."}
              </p>
              <ul className="overlay-bullets">
                <li>Understand unfamiliar repositories faster</li>
                <li>See what breaks if you change a module</li>
                <li>Keep company code offline — nothing is uploaded</li>
              </ul>
              <button type="button" className="ghost-btn" onClick={onOpenHelp}>
                What is GraphCraft for?
              </button>
            </div>
          </div>
        ) : null}

        {showHints && nodes.length > 0 && !isScanning ? (
          <div className="canvas-hints">
            <span>Boxes = code parts</span>
            <span>Lines = dependencies</span>
            <span>Click a box to explain it</span>
            <button type="button" className="hint-dismiss" onClick={() => setShowHints(false)}>
              Hide
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  panX: number,
  panY: number,
  scale: number,
): void {
  // Soft blueprint paper
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#f3f8fa");
  gradient.addColorStop(1, "#e6eef2");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const major = 72 * scale;
  const offsetX = ((panX % major) + major) % major;
  const offsetY = ((panY % major) + major) % major;

  ctx.strokeStyle = "rgba(16, 42, 46, 0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = offsetX; x < width; x += major) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = offsetY; y < height; y += major) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  source: LayoutNode,
  target: LayoutNode,
  kind: string,
  highlighted: boolean,
): void {
  const x1 = source.x + source.width / 2;
  const y1 = source.y + source.height / 2;
  const x2 = target.x + target.width / 2;
  const y2 = target.y + target.height / 2;

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  const cx = (x1 + x2) / 2;
  ctx.bezierCurveTo(cx, y1, cx, y2, x2, y2);

  if (highlighted) {
    ctx.strokeStyle = "#0f5b63";
    ctx.lineWidth = 2.4;
  } else if (kind === "inherit") {
    ctx.strokeStyle = "rgba(20, 114, 124, 0.55)";
    ctx.lineWidth = 1.5;
  } else if (kind === "import") {
    ctx.strokeStyle = "rgba(181, 106, 26, 0.45)";
    ctx.lineWidth = 1.25;
  } else {
    ctx.strokeStyle = "rgba(16, 42, 46, 0.18)";
    ctx.lineWidth = 1;
  }
  ctx.stroke();

  const angle = Math.atan2(y2 - y1, x2 - x1);
  const ah = 8;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - ah * Math.cos(angle - 0.4), y2 - ah * Math.sin(angle - 0.4));
  ctx.lineTo(x2 - ah * Math.cos(angle + 0.4), y2 - ah * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fillStyle = highlighted ? "#0f5b63" : "rgba(16, 42, 46, 0.35)";
  ctx.fill();
}

function drawNode(ctx: CanvasRenderingContext2D, node: LayoutNode, selected: boolean): void {
  const r = 10;

  // Soft drop shadow
  ctx.save();
  ctx.fillStyle = "rgba(16, 42, 46, 0.1)";
  roundRect(ctx, node.x + 1.5, node.y + 2.5, node.width, node.height, r);
  ctx.fill();
  ctx.restore();

  roundRect(ctx, node.x, node.y, node.width, node.height, r);
  ctx.fillStyle = nodeFill(node, selected);
  ctx.fill();
  ctx.strokeStyle = nodeStroke(selected);
  ctx.lineWidth = selected ? 2.25 : 1;
  ctx.stroke();

  if (selected) {
    ctx.strokeStyle = "rgba(16, 42, 46, 0.35)";
    ctx.lineWidth = 1;
    roundRect(ctx, node.x - 4, node.y - 4, node.width + 8, node.height + 8, 12);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
  ctx.fillRect(node.x, node.y, node.width, 16);
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.font = "10px Cascadia Mono, Consolas, ui-monospace, monospace";
  ctx.textBaseline = "middle";
  ctx.fillText(node.kind.toUpperCase(), node.x + 8, node.y + 8);

  ctx.fillStyle = "#ffffff";
  ctx.font = "650 13px Bahnschrift, Segoe UI, sans-serif";
  const label = truncate(ctx, node.label, NODE_WIDTH - 16);
  ctx.fillText(label, node.x + 8, node.y + 30);

  ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
  ctx.font = "10px Cascadia Mono, Consolas, ui-monospace, monospace";
  const pathHint = truncate(ctx, node.path || node.language, NODE_WIDTH - 16);
  ctx.fillText(pathHint, node.x + 8, node.y + NODE_HEIGHT - 10);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let truncated = text;
  while (truncated.length > 0 && ctx.measureText(`${truncated}…`).width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

export default Canvas;
