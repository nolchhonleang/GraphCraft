"""
GraphCraft backend entry point.

Initializes the lexical engine, filesystem watcher, and an asyncio
WebSocket server bound exclusively to localhost:8000.

Strict offline constraint: no external AI calls, no telemetry APIs.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Set

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

try:
    from websockets.asyncio.server import ServerConnection, serve
except ImportError:  # websockets < 13 fallback
    from websockets.server import serve  # type: ignore[no-redef]
    from websockets.legacy.server import WebSocketServerProtocol as ServerConnection  # type: ignore[assignment]

from core.parser import CodebaseParser

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("graphcraft")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
RESCAN_DEBOUNCE_SECONDS = 0.75
SOURCE_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}


class GraphCraftServer:
    """
    Asynchronous GraphCraft coordination hub.

    Responsibilities:
      * Parse a local repository into a nodes/edges graph
      * Push JSON payloads to all connected WebSocket clients
      * Re-scan when watchdog detects relevant file modifications
    """

    def __init__(
        self,
        root_path: Path,
        *,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
    ) -> None:
        """
        Create the server bound to a repository root.

        Args:
            root_path: Directory to scan and watch.
            host: Loopback bind address (must stay local).
            port: WebSocket listen port.
        """
        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError(
                f"Refusing non-loopback bind address '{host}'. "
                "GraphCraft is local-first and only binds to localhost."
            )

        self.root_path = root_path.resolve()
        self.host = host
        self.port = port
        self.clients: Set[Any] = set()
        self._latest_payload: Dict[str, Any] = {
            "nodes": [],
            "edges": [],
            "root_path": str(self.root_path),
            "stats": {},
        }
        self._rescan_lock = asyncio.Lock()
        self._rescan_event = asyncio.Event()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._observer: Optional[Observer] = None
        self._running = False

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------

    def scan_sync(self) -> Dict[str, Any]:
        """Synchronously parse the repository and cache the payload."""
        logger.info("Scanning repository: %s", self.root_path)
        try:
            parser = CodebaseParser(str(self.root_path))
            payload = parser.parse_to_dict()
            self._latest_payload = payload
            stats = payload.get("stats", {})
            logger.info(
                "Scan complete — %s nodes, %s edges",
                stats.get("node_count", 0),
                stats.get("edge_count", 0),
            )
            return payload
        except Exception as exc:
            logger.exception("Scan failed: %s", exc)
            error_payload: Dict[str, Any] = {
                "type": "error",
                "message": str(exc),
                "nodes": self._latest_payload.get("nodes", []),
                "edges": self._latest_payload.get("edges", []),
                "root_path": str(self.root_path),
                "stats": self._latest_payload.get("stats", {}),
            }
            return error_payload

    async def rescan_and_broadcast(self) -> None:
        """Re-parse on a worker thread and push results to all clients."""
        async with self._rescan_lock:
            payload = await asyncio.to_thread(self.scan_sync)
            message = self._encode_message("graph", payload)
            await self._broadcast(message)

    # ------------------------------------------------------------------
    # WebSocket handlers
    # ------------------------------------------------------------------

    async def handler(self, websocket: ServerConnection) -> None:
        """
        Per-connection lifecycle handler.

        On connect: send the latest graph snapshot.
        On message: accept ``{"type":"scan","path":"..."``} rescan requests.
        """
        self.clients.add(websocket)
        peer = getattr(websocket, "remote_address", None)
        logger.info("Client connected: %s (total=%s)", peer, len(self.clients))

        try:
            hello = self._encode_message(
                "hello",
                {
                    "message": "GraphCraft local engine online",
                    "root_path": str(self.root_path),
                    "offline": True,
                },
            )
            await websocket.send(hello)
            await websocket.send(self._encode_message("graph", self._latest_payload))

            async for raw in websocket:
                await self._handle_client_message(websocket, raw)
        except Exception as exc:
            logger.warning("Client handler error: %s", exc)
        finally:
            self.clients.discard(websocket)
            logger.info("Client disconnected: %s (total=%s)", peer, len(self.clients))

    async def _handle_client_message(
        self,
        websocket: ServerConnection,
        raw: str | bytes,
    ) -> None:
        """Parse and dispatch a client control message."""
        try:
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="replace")
            data = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            await websocket.send(
                self._encode_message("error", {"message": f"Invalid JSON: {exc}"})
            )
            return

        msg_type = data.get("type")
        if msg_type == "ping":
            await websocket.send(self._encode_message("pong", {}))
            return

        if msg_type == "scan":
            new_path = data.get("path")
            if new_path:
                candidate = Path(new_path).expanduser().resolve()
                if not candidate.is_dir():
                    await websocket.send(
                        self._encode_message(
                            "error",
                            {"message": f"Not a directory: {candidate}"},
                        )
                    )
                    return
                self.root_path = candidate
                self._restart_watcher()
            await self.rescan_and_broadcast()
            return

        if msg_type == "get_graph":
            await websocket.send(self._encode_message("graph", self._latest_payload))
            return

        await websocket.send(
            self._encode_message(
                "error",
                {"message": f"Unknown message type: {msg_type}"},
            )
        )

    async def _broadcast(self, message: str) -> None:
        """Send a message to every connected client, dropping dead sockets."""
        if not self.clients:
            return
        stale: Set[Any] = set()
        for client in list(self.clients):
            try:
                await client.send(message)
            except Exception:
                stale.add(client)
        self.clients -= stale

    @staticmethod
    def _encode_message(msg_type: str, payload: Dict[str, Any]) -> str:
        """Wrap a payload in the GraphCraft message envelope."""
        envelope = {"type": msg_type, **payload}
        return json.dumps(envelope, ensure_ascii=False, default=str)

    # ------------------------------------------------------------------
    # Filesystem watcher
    # ------------------------------------------------------------------

    def _restart_watcher(self) -> None:
        """Stop and restart the watchdog observer on the current root."""
        if self._observer is not None:
            try:
                self._observer.stop()
                self._observer.join(timeout=2.0)
            except Exception as exc:
                logger.warning("Watcher stop error: %s", exc)
            self._observer = None
        self._start_watcher()

    def _start_watcher(self) -> None:
        """Start watching ``root_path`` for source-file mutations."""
        if self._loop is None:
            return

        handler = _DebouncedHandler(self)
        observer = Observer()
        observer.schedule(handler, str(self.root_path), recursive=True)
        observer.start()
        self._observer = observer
        logger.info("Watching for changes under %s", self.root_path)

    def schedule_rescan(self) -> None:
        """Thread-safe signal that a rescan should run soon."""
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(self._rescan_event.set)

    async def _debounce_loop(self) -> None:
        """Coalesce rapid filesystem events into a single rescan."""
        while self._running:
            await self._rescan_event.wait()
            self._rescan_event.clear()
            await asyncio.sleep(RESCAN_DEBOUNCE_SECONDS)
            # Collapse any events that arrived during the debounce window
            if self._rescan_event.is_set():
                continue
            try:
                await self.rescan_and_broadcast()
            except Exception as exc:
                logger.exception("Debounced rescan failed: %s", exc)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Start the WebSocket server, watcher, and initial scan."""
        self._loop = asyncio.get_running_loop()
        self._running = True

        # Initial scan before accepting connections
        await asyncio.to_thread(self.scan_sync)
        self._start_watcher()

        debounce_task = asyncio.create_task(self._debounce_loop())

        logger.info(
            "GraphCraft WebSocket listening on ws://%s:%s (OFFLINE mode)",
            self.host,
            self.port,
        )

        try:
            async with serve(self.handler, self.host, self.port):
                await asyncio.Future()  # run forever
        finally:
            self._running = False
            debounce_task.cancel()
            try:
                await debounce_task
            except asyncio.CancelledError:
                pass
            if self._observer is not None:
                self._observer.stop()
                self._observer.join(timeout=2.0)


class _DebouncedHandler(FileSystemEventHandler):
    """Watchdog handler that filters to source files and schedules rescans."""

    def __init__(self, server: GraphCraftServer) -> None:
        super().__init__()
        self._server = server

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        src = getattr(event, "src_path", "") or ""
        dest = getattr(event, "dest_path", "") or ""
        if not self._is_source(src) and not self._is_source(dest):
            return
        # Ignore our own venv / node_modules noise if nested inside root
        lowered = src.replace("\\", "/").lower()
        for skip in ("/node_modules/", "/.venv/", "/venv/", "/__pycache__/"):
            if skip in lowered:
                return
        self._server.schedule_rescan()

    @staticmethod
    def _is_source(path: str) -> bool:
        if not path:
            return False
        return Path(path).suffix.lower() in SOURCE_SUFFIXES


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    """CLI argument parser for the GraphCraft backend."""
    parser = argparse.ArgumentParser(
        prog="graphcraft",
        description="GraphCraft local lexical engine (100% offline)",
    )
    parser.add_argument(
        "--path",
        "-p",
        type=str,
        default=".",
        help="Repository root to scan (default: current directory)",
    )
    parser.add_argument(
        "--host",
        type=str,
        default=DEFAULT_HOST,
        help="Loopback bind host (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help="WebSocket port (default: 8000)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Scan once, print JSON to stdout, and exit (no WebSocket)",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    """Process entry point. Returns a shell exit code."""
    args = parse_args(argv)
    root = Path(args.path).expanduser().resolve()

    if not root.is_dir():
        logger.error("Path is not a directory: %s", root)
        return 1

    if args.once:
        try:
            parser = CodebaseParser(str(root))
            print(json.dumps(parser.parse_to_dict(), indent=2, ensure_ascii=False))
            return 0
        except Exception as exc:
            logger.exception("One-shot scan failed: %s", exc)
            return 1

    server = GraphCraftServer(root, host=args.host, port=args.port)

    def _shutdown(signum: int, _frame: object) -> None:
        logger.info("Received signal %s — shutting down", signum)
        sys.exit(0)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _shutdown)
        except (ValueError, OSError):
            # Signals unavailable on some Windows embed contexts
            pass

    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        logger.info("Interrupted — goodbye")
    except Exception as exc:
        logger.exception("Server crashed: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
