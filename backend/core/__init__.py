"""
GraphCraft core package.

Local-first lexical engine and graph data structures.
No external AI or telemetry dependencies.
"""

from .graph import Edge, GraphPayload, GraphBuilder, Node
from .parser import CodebaseParser

__all__ = [
    "CodebaseParser",
    "Edge",
    "GraphBuilder",
    "GraphPayload",
    "Node",
]

__version__ = "1.0.0"
