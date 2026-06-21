"""Root pytest configuration: one entry point for both test suites.

The repository contains two independent Python test suites:

* ``tests/``                    — the core ``webatm`` package
* ``WebATM-integrated/tests/``  — the optional ``webatm_integrated`` package

Both are collected by a plain ``uv run pytest`` (see ``testpaths`` in
``pyproject.toml``). Every test is auto-marked by its location so you can choose
which suite to run without editing individual test files:

    uv run pytest                # everything (core + integrated)
    uv run pytest -m core        # core webatm package only
    uv run pytest -m integrated  # optional webatm_integrated package only

The ``WebATM-integrated`` package is not installed into the environment; its own
``WebATM-integrated/conftest.py`` puts the package on ``sys.path`` during
collection, so the integrated tests import cleanly here too.
"""

from pathlib import Path

_INTEGRATED_ROOT = (Path(__file__).parent / "WebATM-integrated").resolve()


def pytest_collection_modifyitems(config, items):
    """Tag each collected test ``core`` or ``integrated`` based on its path."""
    for item in items:
        item_path = Path(str(item.fspath)).resolve()
        if _INTEGRATED_ROOT == item_path or _INTEGRATED_ROOT in item_path.parents:
            item.add_marker("integrated")
        else:
            item.add_marker("core")
