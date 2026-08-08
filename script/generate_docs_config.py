#!/usr/bin/env python3
"""Generate the derived docs config consumed by Zensical.

Zensical does not (yet) implement mkdocs-literate-nav's directory-tree
inference, which this project used to build the sidebar for the TypeDoc
generated frontend API reference. This script provides the same behavior at
build time: it reads the hand-maintained ``mkdocs.yml``, expands every nav
entry whose target is a directory reference (a string ending in ``/``, e.g.
``frontend/api/``) into an explicit nav tree walked from ``docs/<dir>``, and
writes the result to ``mkdocs.generated.yml`` (git-ignored) for
``zensical build -f`` / ``zensical serve -f``.

Like literate-nav's inference, the expansion lists ``index.md`` first, then
files and subdirectories interleaved in case-insensitive name order, so new
or renamed TypeDoc modules keep needing no ``mkdocs.yml`` edits.

Usage: uv run --group docs python script/generate_docs_config.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_CONFIG = REPO_ROOT / "mkdocs.yml"
GENERATED_CONFIG = REPO_ROOT / "mkdocs.generated.yml"
DOCS_DIR = REPO_ROOT / "docs"

GENERATED_HEADER = (
    "# GENERATED FILE - DO NOT EDIT.\n"
    "# Produced by script/generate_docs_config.py from mkdocs.yml, with\n"
    "# directory nav entries (e.g. `frontend/api/`) expanded into explicit\n"
    "# trees. Edit mkdocs.yml instead and rebuild.\n"
)

# mkdocs.yml uses the MkDocs-specific `!!python/name:` tag (e.g. for the
# pymdownx.superfences mermaid custom fence). Plain safe_load rejects it, so
# round-trip it through a str subclass that remembers the dotted name and is
# dumped back with the same tag.
_PYTHON_NAME_TAG = "tag:yaml.org,2002:python/name:"


class _PythonName(str):
    """A `!!python/name:<dotted.name>` scalar, preserved verbatim."""


class _ConfigLoader(yaml.SafeLoader):
    pass


class _ConfigDumper(yaml.SafeDumper):
    pass


_ConfigLoader.add_multi_constructor(
    _PYTHON_NAME_TAG, lambda loader, suffix, node: _PythonName(suffix)
)
_ConfigDumper.add_representer(
    _PythonName,
    lambda dumper, value: dumper.represent_scalar(_PYTHON_NAME_TAG + str(value), ""),
)


def infer_nav_tree(directory: Path) -> list:
    """Build a nav list for ``directory``, mirroring literate-nav inference.

    ``index.md`` comes first, remaining files and subdirectories follow in
    case-insensitive name order. Page entries are bare paths so the title is
    taken from each page's first heading; subdirectories become sections
    named after the directory.
    """
    entries: list = []
    index = directory / "index.md"
    if index.is_file():
        entries.append(str(index.relative_to(DOCS_DIR)))

    children = sorted(directory.iterdir(), key=lambda p: (p.name.lower(), p.name))
    for child in children:
        if child == index:
            continue
        if child.is_dir():
            subtree = infer_nav_tree(child)
            if subtree:
                entries.append({child.name: subtree})
        elif child.suffix == ".md":
            entries.append(str(child.relative_to(DOCS_DIR)))
    return entries


def expand_nav(node):
    """Recursively expand directory references in a nav structure."""
    if isinstance(node, list):
        return [expand_nav(item) for item in node]
    if isinstance(node, dict):
        return {title: expand_nav(value) for title, value in node.items()}
    if isinstance(node, str) and node.endswith("/"):
        directory = DOCS_DIR / node.rstrip("/")
        if not directory.is_dir():
            sys.exit(
                f"error: nav entry '{node}' refers to missing directory "
                f"{directory}.\nGenerated API pages must exist first - run "
                "`npm run docs:api` in frontend/ (or script/build_docs.sh)."
            )
        tree = infer_nav_tree(directory)
        if not tree:
            sys.exit(f"error: nav entry '{node}' matched no pages in {directory}.")
        return tree
    return node


def main() -> None:
    config = yaml.load(SOURCE_CONFIG.read_text(encoding="utf-8"), Loader=_ConfigLoader)
    config["nav"] = expand_nav(config.get("nav", []))

    body = yaml.dump(
        config,
        Dumper=_ConfigDumper,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
    )
    # PyYAML renders the empty scalar of a `!!python/name:` node as an
    # explicit '' — strip it back to the bare-tag form MkDocs documents.
    body = re.sub(r"^(\s*.*!!python/name:\S+) ''$", r"\1", body, flags=re.MULTILINE)
    GENERATED_CONFIG.write_text(GENERATED_HEADER + body, encoding="utf-8")
    print(f"wrote {GENERATED_CONFIG.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
