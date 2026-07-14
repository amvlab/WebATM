# Development Workflow

## Python environment (uv)

Dependencies are declared in `pyproject.toml` and pinned in `uv.lock` — the
single source of truth (there are no `requirements*.txt` files):

```bash
uv sync                    # create/refresh .venv with runtime + dev deps
uv sync --extra prod       # include the production-only extra (gunicorn)
uv run python WebATM.py    # run a command inside the managed environment
uv add <package>           # add a runtime dependency
uv add --dev <package>     # add a dev dependency
uv lock                    # re-resolve and update uv.lock
```

## Code quality

**Python** (configured in `pyproject.toml`):

```bash
uv run ruff check .        # lint
uv run ruff format .       # auto-format
uv run mypy WebATM/        # type checking
uv run pytest              # test suite
```

**TypeScript**:

```bash
cd frontend/
npm run type-check         # type checking only
npm run lint               # ESLint (flat config in eslint.config.mjs)
npm test                   # unit tests (Vitest)
```

## Testing

One pytest entry point covers both the core `webatm` package (`tests/`) and
the optional `webatm_integrated` package (`WebATM-integrated/tests/`). Tests
are auto-marked by location:

```bash
uv run pytest                # everything (core + integrated)
uv run pytest -m core        # core webatm package only
uv run pytest -m integrated  # optional webatm_integrated package only
uv run pytest -m core --cov=WebATM --cov-report=term-missing
```

Frontend unit tests use Vitest and live next to the code they cover as
`*.test.ts`. The default test environment is node; DOM-dependent tests opt
in per-file with `// @vitest-environment happy-dom`. CI runs type-check,
lint, tests, and the webpack build on every push/PR.

## API documentation comments

This is one site with two generated API references, each read straight from
the source:

- **Python** follows the
  [Google style](https://google.github.io/styleguide/pyguide.html#38-comments-and-docstrings):
  a one-line imperative summary, an optional extended description, then
  `Args:` / `Returns:` / `Raises:` sections. Rendered by
  [mkdocstrings](https://mkdocstrings.github.io/).
- **Frontend (TypeScript)** uses [TSDoc](https://tsdoc.org/) comments
  (`@param`, `@returns`, `@remarks`) plus the types themselves. Rendered by
  [TypeDoc](https://typedoc.org/) via
  [`typedoc-plugin-markdown`](https://typedoc-plugin-markdown.org/) into
  `docs/frontend/api/`, with the sidebar inferred from that directory tree by
  [`mkdocs-literate-nav`](https://oprypin.github.io/mkdocs-literate-nav/).

## Building this documentation

The docs are built with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/);
the tooling lives in the `docs` dependency group (opt-in, not installed by a
bare `uv sync`). Use the helper, which regenerates the git-ignored frontend
API reference with TypeDoc before running MkDocs:

```bash
script/build_docs.sh            # TypeDoc + mkdocs build --strict → site/
script/build_docs.sh --serve    # live-reload preview at http://127.0.0.1:8000
```

For Python/Markdown-only changes you can skip TypeDoc and run MkDocs directly:

```bash
uv run --group docs mkdocs serve            # or: mkdocs build --strict
```

## Extension guidelines

**Backend:**

- Routes → `WebATM/server/routes.py`
- Proxy handlers → `WebATM/proxy/handlers/` (by functionality), registered
  in `WebATM/proxy/subscribers.py`
- Proxy managers → `WebATM/proxy/managers/`
- Network features → `WebATM/bluesky_client.py`

**Frontend:**

- UI components → follow the patterns in `frontend/src/ui/`
- Map features → `frontend/src/ui/map/`
- Data processing → extend `frontend/src/data/types.ts` and
  `DataProcessor.ts`

**Best practices:** follow the modular composition pattern, keep modules
under 500 lines, and run the linting tools before committing.
