"""
GraphCraft lexical parser.

Recursively scans a local folder path and maps source dependencies into
a JSON schema containing ``nodes`` and ``edges``.

Parsing strategy (100% offline, no AI):
  * Python  — ``ast`` module for classes, methods, imports, and Odoo ``_inherit``
  * TypeScript / JavaScript / TSX / JSX — compiled ``re`` patterns for ESM
    import/export statements and React component declarations
"""

from __future__ import annotations

import ast
import logging
import os
import re
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

from .graph import (
    Edge,
    EdgeKind,
    GraphBuilder,
    GraphPayload,
    Node,
    NodeKind,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Compiled regular expressions (TypeScript / JavaScript / React)
# ---------------------------------------------------------------------------

RE_ESM_IMPORT = re.compile(
    r"""^\s*import\s+(?:type\s+)?(?:"""
    r"""(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*"""
    r"""(?:\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]"""
    r"""|^\s*import\s*['"]([^'"]+)['"]""",
    re.MULTILINE,
)

RE_ESM_EXPORT_FROM = re.compile(
    r"""^\s*export\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s*['"]([^'"]+)['"]""",
    re.MULTILINE,
)

RE_REQUIRE = re.compile(
    r"""require\s*\(\s*['"]([^'"]+)['"]\s*\)""",
)

RE_REACT_FUNCTION_COMPONENT = re.compile(
    r"""(?:export\s+)?(?:default\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9_]*)\s*"""
    r"""(?:=\s*(?:React\.)?(?:memo\()?|(?:\())""",
)

RE_REACT_CLASS_COMPONENT = re.compile(
    r"""(?:export\s+)?(?:default\s+)?class\s+([A-Z][A-Za-z0-9_]*)\s+"""
    r"""extends\s+(?:React\.)?(?:Pure)?Component""",
)

RE_TS_CLASS = re.compile(
    r"""(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)""",
)

RE_TS_FUNCTION = re.compile(
    r"""(?:export\s+)?(?:async\s+)?function\s+([a-z_][A-Za-z0-9_]*)\s*\(""",
)

# Extensions considered source files
PYTHON_EXTENSIONS: Set[str] = {".py"}
TYPESCRIPT_EXTENSIONS: Set[str] = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
SKIP_DIR_NAMES: Set[str] = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    "dist",
    "build",
    ".next",
    ".turbo",
    "coverage",
    ".idea",
    ".vscode",
}


class CodebaseParser:
    """
    Recursively scan a directory and produce a GraphCraft graph payload.

    The parser never leaves the local filesystem and never contacts
    external services. All lexical work uses Python's ``ast`` module and
    compiled regular expressions.
    """

    def __init__(
        self,
        root_path: str,
        *,
        max_file_bytes: int = 2_000_000,
        follow_symlinks: bool = False,
    ) -> None:
        """
        Create a parser bound to a repository root.

        Args:
            root_path: Absolute or relative path to scan.
            max_file_bytes: Skip files larger than this size (safety).
            follow_symlinks: Whether to follow directory symlinks.
        """
        resolved = Path(root_path).expanduser().resolve()
        if not resolved.exists():
            raise FileNotFoundError(f"Root path does not exist: {resolved}")
        if not resolved.is_dir():
            raise NotADirectoryError(f"Root path is not a directory: {resolved}")

        self.root_path = resolved
        self.max_file_bytes = max_file_bytes
        self.follow_symlinks = follow_symlinks
        self._builder = GraphBuilder(str(self.root_path))

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def parse(self) -> GraphPayload:
        """
        Scan the entire tree and return a complete graph payload.

        Returns:
            GraphPayload with nodes, edges, root_path, and stats.
        """
        self._builder = GraphBuilder(str(self.root_path))
        try:
            for file_path in self._iter_source_files():
                try:
                    self._parse_file(file_path)
                except Exception as exc:  # noqa: BLE001 — keep scanning
                    logger.warning("Failed to parse %s: %s", file_path, exc)
        except Exception as exc:
            logger.error("Fatal scan error under %s: %s", self.root_path, exc)
            raise

        return self._builder.build()

    def parse_to_dict(self) -> Dict[str, object]:
        """Parse and return a plain JSON-serializable dictionary."""
        return self.parse().to_dict()

    # ------------------------------------------------------------------
    # Filesystem walk
    # ------------------------------------------------------------------

    def _iter_source_files(self) -> Iterable[Path]:
        """Yield source files under ``root_path``, skipping junk directories."""
        for dirpath, dirnames, filenames in os.walk(
            self.root_path,
            followlinks=self.follow_symlinks,
        ):
            # Prune skipped directories in-place
            dirnames[:] = [
                name
                for name in dirnames
                if name not in SKIP_DIR_NAMES and not name.startswith(".")
            ]

            for filename in filenames:
                path = Path(dirpath) / filename
                suffix = path.suffix.lower()
                if suffix not in PYTHON_EXTENSIONS and suffix not in TYPESCRIPT_EXTENSIONS:
                    continue
                try:
                    if path.stat().st_size > self.max_file_bytes:
                        logger.info("Skipping oversized file: %s", path)
                        continue
                except OSError as exc:
                    logger.warning("Cannot stat %s: %s", path, exc)
                    continue
                yield path

    def _rel(self, path: Path) -> str:
        """Return a portable project-relative path string."""
        try:
            return path.resolve().relative_to(self.root_path).as_posix()
        except ValueError:
            return path.resolve().as_posix()

    def _file_node_id(self, path: Path) -> str:
        return f"file::{self._rel(path)}"

    def _symbol_node_id(self, path: Path, symbol: str) -> str:
        return f"symbol::{self._rel(path)}::{symbol}"

    # ------------------------------------------------------------------
    # File dispatch
    # ------------------------------------------------------------------

    def _parse_file(self, path: Path) -> None:
        """Read a single file and dispatch to the language-specific parser."""
        suffix = path.suffix.lower()
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            logger.warning("Cannot read %s: %s", path, exc)
            return

        size = 0
        try:
            size = path.stat().st_size
        except OSError:
            size = len(text.encode("utf-8", errors="replace"))

        color_group = "backend" if suffix in PYTHON_EXTENSIONS else "frontend"
        language = self._language_for_suffix(suffix)

        file_node = Node(
            id=self._file_node_id(path),
            label=path.name,
            kind=NodeKind.FILE,
            path=self._rel(path),
            language=language,
            line=1,
            size_bytes=size,
            metadata={"absolute_path": str(path.resolve())},
            color_group=color_group,
        )
        self._builder.add_node(file_node)

        if suffix in PYTHON_EXTENSIONS:
            self._parse_python(path, text, file_node)
        else:
            self._parse_typescript(path, text, file_node)

    @staticmethod
    def _language_for_suffix(suffix: str) -> str:
        mapping = {
            ".py": "python",
            ".ts": "typescript",
            ".tsx": "tsx",
            ".js": "javascript",
            ".jsx": "jsx",
            ".mjs": "javascript",
            ".cjs": "javascript",
        }
        return mapping.get(suffix, "unknown")

    # ------------------------------------------------------------------
    # Python AST parsing
    # ------------------------------------------------------------------

    def _parse_python(self, path: Path, text: str, file_node: Node) -> None:
        """
        Parse Python source with ``ast``.

        Extracts:
          * import / from-import dependencies
          * class definitions and inheritance trees
          * Odoo-style ``_inherit`` / ``_name`` model markers
          * top-level and method-level function definitions
        """
        try:
            tree = ast.parse(text, filename=str(path))
        except SyntaxError as exc:
            logger.warning("Python syntax error in %s: %s", path, exc)
            file_node.metadata["parse_error"] = str(exc)
            return

        for node in tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                self._handle_python_import(path, file_node, node)
            elif isinstance(node, ast.ClassDef):
                self._handle_python_class(path, file_node, node)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._handle_python_function(path, file_node, node)

    def _handle_python_import(
        self,
        path: Path,
        file_node: Node,
        node: ast.AST,
    ) -> None:
        """Map ``import`` / ``from … import`` statements into edges."""
        modules: List[str] = []

        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name:
                    modules.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level and node.level > 0:
                # Relative import — resolve against current package
                package_parts = list(Path(self._rel(path)).parent.parts)
                level = node.level
                if package_parts and package_parts[-1] == "__init__":
                    package_parts = package_parts[:-1]
                # Pop one fewer than level because the file sits inside its package
                trim = max(level - 1, 0)
                if trim:
                    package_parts = package_parts[: max(len(package_parts) - trim, 0)]
                prefix = ".".join(package_parts)
                base = f"{prefix}.{base}" if base else prefix
            if base:
                modules.append(base)
            for alias in node.names:
                if alias.name and alias.name != "*":
                    modules.append(f"{base}.{alias.name}" if base else alias.name)

        for module_name in modules:
            target_id = f"module::{module_name}"
            self._builder.add_node(
                Node(
                    id=target_id,
                    label=module_name,
                    kind=NodeKind.MODULE,
                    path=module_name.replace(".", "/") + ".py",
                    language="python",
                    metadata={"external_or_unresolved": True},
                    color_group="backend",
                )
            )
            edge_id = f"import::{file_node.id}->{target_id}"
            self._builder.add_edge(
                Edge(
                    id=edge_id,
                    source=file_node.id,
                    target=target_id,
                    kind=EdgeKind.IMPORT,
                    label=module_name,
                )
            )

    def _handle_python_class(
        self,
        path: Path,
        file_node: Node,
        node: ast.ClassDef,
    ) -> None:
        """Extract class nodes, inheritance edges, and Odoo model markers."""
        class_id = self._symbol_node_id(path, node.name)
        bases = [self._expr_to_name(base) for base in node.bases]
        bases = [b for b in bases if b]

        odoo_inherit = self._extract_odoo_string_attr(node, "_inherit")
        odoo_name = self._extract_odoo_string_attr(node, "_name")
        is_model = bool(odoo_inherit or odoo_name)

        class_node = Node(
            id=class_id,
            label=node.name,
            kind=NodeKind.MODEL if is_model else NodeKind.CLASS,
            path=self._rel(path),
            language="python",
            line=getattr(node, "lineno", None),
            metadata={
                "bases": bases,
                "odoo_inherit": odoo_inherit,
                "odoo_name": odoo_name,
                "decorators": [self._expr_to_name(d) for d in node.decorator_list],
            },
            color_group="backend",
        )
        self._builder.add_node(class_node)

        # File contains class
        self._builder.add_edge(
            Edge(
                id=f"contains::{file_node.id}->{class_id}",
                source=file_node.id,
                target=class_id,
                kind=EdgeKind.CONTAINS,
                label="defines",
            )
        )

        # Standard inheritance
        for base_name in bases:
            base_id = f"symbol_ref::{base_name}"
            self._builder.add_node(
                Node(
                    id=base_id,
                    label=base_name,
                    kind=NodeKind.CLASS,
                    path="",
                    language="python",
                    metadata={"unresolved_base": True},
                    color_group="backend",
                )
            )
            self._builder.add_edge(
                Edge(
                    id=f"inherit::{class_id}->{base_id}",
                    source=class_id,
                    target=base_id,
                    kind=EdgeKind.INHERIT,
                    label=base_name,
                )
            )

        # Odoo _inherit (string or list of strings)
        for inherited in odoo_inherit:
            inherit_id = f"odoo_model::{inherited}"
            self._builder.add_node(
                Node(
                    id=inherit_id,
                    label=inherited,
                    kind=NodeKind.MODEL,
                    path="",
                    language="python",
                    metadata={"odoo_model": True},
                    color_group="backend",
                )
            )
            self._builder.add_edge(
                Edge(
                    id=f"odoo_inherit::{class_id}->{inherit_id}",
                    source=class_id,
                    target=inherit_id,
                    kind=EdgeKind.INHERIT,
                    label=f"_inherit:{inherited}",
                )
            )

        # Methods inside the class
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._handle_python_function(path, class_node, child, parent_is_class=True)

    def _handle_python_function(
        self,
        path: Path,
        parent: Node,
        node: ast.FunctionDef | ast.AsyncFunctionDef,
        *,
        parent_is_class: bool = False,
    ) -> None:
        """Extract a function or method node and a contains edge."""
        qual = f"{parent.label}.{node.name}" if parent_is_class else node.name
        func_id = self._symbol_node_id(path, qual)
        func_node = Node(
            id=func_id,
            label=node.name,
            kind=NodeKind.FUNCTION,
            path=self._rel(path),
            language="python",
            line=getattr(node, "lineno", None),
            metadata={
                "async": isinstance(node, ast.AsyncFunctionDef),
                "is_method": parent_is_class,
                "args": [arg.arg for arg in node.args.args],
            },
            color_group="backend",
        )
        self._builder.add_node(func_node)
        self._builder.add_edge(
            Edge(
                id=f"contains::{parent.id}->{func_id}",
                source=parent.id,
                target=func_id,
                kind=EdgeKind.CONTAINS,
                label="defines",
            )
        )

        # Simple call-graph: look for Name/Attribute calls inside the body
        for call_target in self._collect_call_names(node):
            target_id = f"call_ref::{call_target}"
            self._builder.add_node(
                Node(
                    id=target_id,
                    label=call_target,
                    kind=NodeKind.FUNCTION,
                    path="",
                    language="python",
                    metadata={"unresolved_call": True},
                    color_group="backend",
                )
            )
            self._builder.add_edge(
                Edge(
                    id=f"call::{func_id}->{target_id}",
                    source=func_id,
                    target=target_id,
                    kind=EdgeKind.CALL,
                    label=call_target,
                )
            )

    def _collect_call_names(
        self,
        node: ast.AST,
        *,
        limit: int = 40,
    ) -> List[str]:
        """Collect a bounded list of call target names from a function body."""
        names: List[str] = []
        seen: Set[str] = set()
        for child in ast.walk(node):
            if not isinstance(child, ast.Call):
                continue
            name = self._expr_to_name(child.func)
            if not name or name in seen:
                continue
            seen.add(name)
            names.append(name)
            if len(names) >= limit:
                break
        return names

    @staticmethod
    def _expr_to_name(expr: ast.AST) -> str:
        """Best-effort dotted name extraction from an AST expression."""
        if isinstance(expr, ast.Name):
            return expr.id
        if isinstance(expr, ast.Attribute):
            base = CodebaseParser._expr_to_name(expr.value)
            return f"{base}.{expr.attr}" if base else expr.attr
        if isinstance(expr, ast.Call):
            return CodebaseParser._expr_to_name(expr.func)
        if isinstance(expr, ast.Subscript):
            return CodebaseParser._expr_to_name(expr.value)
        if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
            return expr.value
        return ""

    @staticmethod
    def _extract_odoo_string_attr(class_node: ast.ClassDef, attr: str) -> List[str]:
        """
        Extract Odoo ``_inherit`` / ``_name`` string values from a class body.

        Supports both string literals and lists/tuples of strings.
        """
        values: List[str] = []
        for stmt in class_node.body:
            if not isinstance(stmt, ast.Assign):
                continue
            target_names = [
                t.id for t in stmt.targets if isinstance(t, ast.Name)
            ]
            if attr not in target_names:
                continue
            value = stmt.value
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                values.append(value.value)
            elif isinstance(value, (ast.List, ast.Tuple)):
                for elt in value.elts:
                    if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                        values.append(elt.value)
        return values

    # ------------------------------------------------------------------
    # TypeScript / React regex parsing
    # ------------------------------------------------------------------

    def _parse_typescript(self, path: Path, text: str, file_node: Node) -> None:
        """
        Parse TS/JS/TSX/JSX with compiled regular expressions.

        Extracts ESM import/export paths, React components, classes,
        and top-level functions.
        """
        self._handle_ts_imports(path, file_node, text)
        self._handle_ts_components(path, file_node, text)
        self._handle_ts_classes(path, file_node, text)
        self._handle_ts_functions(path, file_node, text)

    def _handle_ts_imports(self, path: Path, file_node: Node, text: str) -> None:
        """Map ESM import / export-from / require() references to edges."""
        import_targets: Set[str] = set()

        for match in RE_ESM_IMPORT.finditer(text):
            target = match.group(1) or match.group(2)
            if target:
                import_targets.add(target)

        for match in RE_ESM_EXPORT_FROM.finditer(text):
            target = match.group(1)
            if target:
                import_targets.add(target)

        for match in RE_REQUIRE.finditer(text):
            target = match.group(1)
            if target:
                import_targets.add(target)

        for spec in import_targets:
            resolved = self._resolve_ts_specifier(path, spec)
            if resolved is not None:
                target_id = self._file_node_id(resolved)
                # Ensure target file node exists even if not yet walked
                if not self._builder.has_node(target_id):
                    self._builder.add_node(
                        Node(
                            id=target_id,
                            label=resolved.name,
                            kind=NodeKind.FILE,
                            path=self._rel(resolved),
                            language=self._language_for_suffix(resolved.suffix.lower()),
                            color_group="frontend",
                            metadata={"referenced_before_scan": True},
                        )
                    )
            else:
                target_id = f"module::{spec}"
                self._builder.add_node(
                    Node(
                        id=target_id,
                        label=spec,
                        kind=NodeKind.MODULE,
                        path=spec,
                        language="typescript",
                        metadata={"external_package": not spec.startswith(".")},
                        color_group="frontend",
                    )
                )

            self._builder.add_edge(
                Edge(
                    id=f"import::{file_node.id}->{target_id}::{spec}",
                    source=file_node.id,
                    target=target_id,
                    kind=EdgeKind.IMPORT,
                    label=spec,
                )
            )

    def _resolve_ts_specifier(self, from_path: Path, spec: str) -> Optional[Path]:
        """
        Resolve a relative ESM specifier against the importing file.

        Absolute / bare package imports return None (treated as modules).
        """
        if not (spec.startswith("./") or spec.startswith("../") or spec.startswith("/")):
            return None

        base = (from_path.parent / spec).resolve()
        candidates: List[Path] = [
            base,
            Path(str(base) + ".ts"),
            Path(str(base) + ".tsx"),
            Path(str(base) + ".js"),
            Path(str(base) + ".jsx"),
            base / "index.ts",
            base / "index.tsx",
            base / "index.js",
            base / "index.jsx",
        ]
        for candidate in candidates:
            try:
                if candidate.is_file():
                    return candidate
            except OSError:
                continue
        return None

    def _handle_ts_components(self, path: Path, file_node: Node, text: str) -> None:
        """Detect React function and class components."""
        found: Set[str] = set()

        for pattern in (RE_REACT_FUNCTION_COMPONENT, RE_REACT_CLASS_COMPONENT):
            for match in pattern.finditer(text):
                name = match.group(1)
                if not name or name in found:
                    continue
                found.add(name)
                line = text[: match.start()].count("\n") + 1
                comp_id = self._symbol_node_id(path, name)
                self._builder.add_node(
                    Node(
                        id=comp_id,
                        label=name,
                        kind=NodeKind.COMPONENT,
                        path=self._rel(path),
                        language=file_node.language,
                        line=line,
                        metadata={"react_component": True},
                        color_group="frontend",
                    )
                )
                self._builder.add_edge(
                    Edge(
                        id=f"contains::{file_node.id}->{comp_id}",
                        source=file_node.id,
                        target=comp_id,
                        kind=EdgeKind.CONTAINS,
                        label="defines",
                    )
                )

    def _handle_ts_classes(self, path: Path, file_node: Node, text: str) -> None:
        """Detect TypeScript/JavaScript class declarations."""
        for match in RE_TS_CLASS.finditer(text):
            name = match.group(1)
            # Skip if already registered as a React class component
            comp_id = self._symbol_node_id(path, name)
            if self._builder.has_node(comp_id):
                continue
            line = text[: match.start()].count("\n") + 1
            self._builder.add_node(
                Node(
                    id=comp_id,
                    label=name,
                    kind=NodeKind.CLASS,
                    path=self._rel(path),
                    language=file_node.language,
                    line=line,
                    color_group="frontend",
                )
            )
            self._builder.add_edge(
                Edge(
                    id=f"contains::{file_node.id}->{comp_id}",
                    source=file_node.id,
                    target=comp_id,
                    kind=EdgeKind.CONTAINS,
                    label="defines",
                )
            )

    def _handle_ts_functions(self, path: Path, file_node: Node, text: str) -> None:
        """Detect top-level exported/non-exported functions."""
        for match in RE_TS_FUNCTION.finditer(text):
            name = match.group(1)
            func_id = self._symbol_node_id(path, name)
            if self._builder.has_node(func_id):
                continue
            line = text[: match.start()].count("\n") + 1
            self._builder.add_node(
                Node(
                    id=func_id,
                    label=name,
                    kind=NodeKind.FUNCTION,
                    path=self._rel(path),
                    language=file_node.language,
                    line=line,
                    color_group="frontend",
                )
            )
            self._builder.add_edge(
                Edge(
                    id=f"contains::{file_node.id}->{func_id}",
                    source=file_node.id,
                    target=func_id,
                    kind=EdgeKind.CONTAINS,
                    label="defines",
                )
            )
