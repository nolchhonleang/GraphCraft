"""
GraphCraft graph data structures and JSON formatters.

Defines typed Node/Edge models and a builder that serializes
hierarchical dependency graphs for the WebSocket frontend.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class NodeKind(str, Enum):
    """Semantic category of a discovered codebase node."""

    FILE = "file"
    CLASS = "class"
    FUNCTION = "function"
    COMPONENT = "component"
    MODULE = "module"
    MODEL = "model"


class EdgeKind(str, Enum):
    """Semantic category of a dependency relationship."""

    IMPORT = "import"
    INHERIT = "inherit"
    CALL = "call"
    CONTAINS = "contains"
    EXPORT = "export"
    REFERENCE = "reference"


@dataclass
class Node:
    """
    A single abstract dependency node in the GraphCraft graph.

    Attributes:
        id: Stable unique identifier (usually path::symbol).
        label: Human-readable display name.
        kind: Semantic node category.
        path: Absolute or project-relative file path.
        language: Source language tag (python, typescript, javascript, etc.).
        line: 1-based start line when known.
        size_bytes: File size for file-level nodes.
        metadata: Extra structured attributes for the inspector panel.
        color_group: Visual group hint for the sidebar/canvas (backend|frontend).
    """

    id: str
    label: str
    kind: NodeKind
    path: str
    language: str = "unknown"
    line: Optional[int] = None
    size_bytes: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)
    color_group: str = "backend"

    def to_dict(self) -> Dict[str, Any]:
        """Serialize the node into a JSON-compatible dictionary."""
        payload = asdict(self)
        payload["kind"] = self.kind.value
        return payload


@dataclass
class Edge:
    """
    A directed relationship between two nodes.

    Attributes:
        id: Stable unique identifier.
        source: Source node id.
        target: Target node id.
        kind: Relationship category.
        label: Optional edge label for the inspector.
        metadata: Extra structured attributes.
    """

    id: str
    source: str
    target: str
    kind: EdgeKind
    label: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Serialize the edge into a JSON-compatible dictionary."""
        payload = asdict(self)
        payload["kind"] = self.kind.value
        return payload


@dataclass
class GraphPayload:
    """
    Complete graph document pushed to the frontend over WebSocket.

    Schema contract:
        {
          "nodes": [...],
          "edges": [...],
          "root_path": "...",
          "stats": {...}
        }
    """

    nodes: List[Node] = field(default_factory=list)
    edges: List[Edge] = field(default_factory=list)
    root_path: str = ""
    stats: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Serialize the full graph payload."""
        return {
            "nodes": [node.to_dict() for node in self.nodes],
            "edges": [edge.to_dict() for edge in self.edges],
            "root_path": self.root_path,
            "stats": self.stats,
        }


class GraphBuilder:
    """
    Accumulates nodes and edges with de-duplication and validation.

    The builder guarantees unique node/edge ids and produces a
    frontend-ready GraphPayload with aggregate statistics.
    """

    def __init__(self, root_path: str) -> None:
        """
        Initialize an empty graph builder.

        Args:
            root_path: Absolute path of the scanned repository root.
        """
        self.root_path = root_path
        self._nodes: Dict[str, Node] = {}
        self._edges: Dict[str, Edge] = {}

    def add_node(self, node: Node) -> Node:
        """
        Insert or merge a node by id.

        Existing metadata dictionaries are shallow-merged when the
        same id is registered more than once.

        Args:
            node: Node instance to register.

        Returns:
            The canonical Node stored in the builder.
        """
        existing = self._nodes.get(node.id)
        if existing is None:
            self._nodes[node.id] = node
            return node

        merged_meta = {**existing.metadata, **node.metadata}
        existing.metadata = merged_meta
        if node.size_bytes and not existing.size_bytes:
            existing.size_bytes = node.size_bytes
        if node.line is not None and existing.line is None:
            existing.line = node.line
        return existing

    def has_node(self, node_id: str) -> bool:
        """Return True when a node with the given id is already registered."""
        return node_id in self._nodes

    def add_edge(self, edge: Edge) -> Optional[Edge]:
        """
        Insert an edge when both endpoints exist (or will exist).

        Edges with identical ids are ignored. Missing endpoints are
        still stored so late-bound nodes can be attached; the frontend
        filters dangling edges.

        Args:
            edge: Edge instance to register.

        Returns:
            The stored Edge, or None if the edge id already exists.
        """
        if edge.id in self._edges:
            return None
        if edge.source == edge.target:
            return None
        self._edges[edge.id] = edge
        return edge

    def build(self) -> GraphPayload:
        """
        Produce a validated GraphPayload with stats.

        Returns:
            Complete graph document ready for JSON serialization.
        """
        nodes = list(self._nodes.values())
        edges = [
            edge
            for edge in self._edges.values()
            if edge.source in self._nodes and edge.target in self._nodes
        ]

        kind_counts: Dict[str, int] = {}
        language_counts: Dict[str, int] = {}
        for node in nodes:
            kind_counts[node.kind.value] = kind_counts.get(node.kind.value, 0) + 1
            language_counts[node.language] = language_counts.get(node.language, 0) + 1

        stats: Dict[str, Any] = {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "kinds": kind_counts,
            "languages": language_counts,
        }

        return GraphPayload(
            nodes=nodes,
            edges=edges,
            root_path=self.root_path,
            stats=stats,
        )
