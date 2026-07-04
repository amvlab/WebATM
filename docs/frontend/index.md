# Frontend (TypeScript)

The WebATM frontend is a TypeScript application bundled with webpack that
renders live simulation data with MapLibre GL. The source lives in
`frontend/src/` and is organized into:

- **`core/`** — the application controller (`App`), socket management, state
  management, and the connection status service.
- **`data/`** — command handling, data processing, aircraft metadata, and
  shared type definitions.
- **`ui/`** — user-interface components: the map (2D/3D aircraft renderers,
  shapes, routes), panels, controls, console, and modals.
- **`utils/`** — logging, storage, and theming helpers.
- **`integrated/`** — components only loaded in the
  [integrated build](../integrated-build.md) (server controls, live log
  stream), behind a compile-time flag.

## API Reference

The **[API Reference](api/index.md)** in this section is generated with
[TypeDoc](https://typedoc.org/) (via
[`typedoc-plugin-markdown`](https://typedoc-plugin-markdown.org/)) directly
from the TypeScript source and its
[TSDoc](https://tsdoc.org/) comments, and folded into this same site. Because
the codebase is fully typed and `any`-free, every class, method, and
interface carries real type signatures even where prose comments are sparse.

To regenerate it locally:

```bash
cd frontend/
npm run docs:api      # writes Markdown into ../docs/frontend/api/
```

That step runs automatically as part of the full docs build (see
[Development Workflow](../development.md#building-this-documentation)).
