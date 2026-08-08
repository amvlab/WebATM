# script/

Utility scripts for building, checking, running and releasing WebATM.

## Inventory

| Script | What it does |
| --- | --- |
| `run_webatm.sh` | Start the dev server (`python WebATM.py`) from the repo root. |
| `wsgi.py` | Gunicorn entry point; used by the Docker image and any production deploy. |
| `build_frontend.sh` | Production webpack build of `frontend/` → `WebATM/static/dist/` + vendored assets. Re-runs `npm ci` only when `package-lock.json` is newer than `node_modules/`. |
| `check_frontend.sh` | Mirror of the GitHub Actions frontend job: type-check, lint, unit tests. Shares the conditional-install guard. |
| `build_docker.sh` | Build the WebATM image locally (`webatm:latest`). |
| `build_release_tarball.sh` | Bundle `WebATM/static/{vendor,dist}` into `webatm-prebuilt-<version>.tar.gz` for a per-version GitHub release. Version comes from `pyproject.toml`. |
| `build_assets_tarball.sh` | Bundle `WebATM/static/{tiles,glyphs,navdata}` into `webatm-assets-<tag>.tar.gz` for the long-lived **assets** release. Tag comes from `.assets-version` at the repo root. |
| `navdata/` | OurAirports/OSM-based navdata tile pipeline. See `navdata/README.md`. |

## Common tasks

```bash
# Start the dev server
./run_webatm.sh

# Build the frontend bundle (skips install when up to date)
./build_frontend.sh

# Run the frontend checks (type-check + lint + tests)
./check_frontend.sh

# Build the Docker image locally
./build_docker.sh
```

## Release tarballs

WebATM ships two GitHub releases that the runtime depends on, kept on **separate
cadences**:

- **Per-version code release** (rebuilt each version bump). Contains the webpack
  bundle and vendored CSS/fonts.
  ```bash
  ./build_release_tarball.sh           # → webatm-prebuilt-<version>.tar.gz
  ```
- **Assets release** (rebuilt rarely — when tiles, glyphs or navdata change).
  Pinned via `.assets-version` at the repo root; the Docker publish workflow
  reads that file to hydrate static assets before building the image.
  ```bash
  ./build_assets_tarball.sh            # → webatm-assets-<tag>.tar.gz
  # bump .assets-version, then:
  # gh release create <tag> webatm-assets-<tag>.tar.gz
  ```

