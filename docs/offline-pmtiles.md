# Offline Use with PMTiles

WebATM supports fully offline operation using
[PMTiles](https://protomaps.com/docs/pmtiles) — a single-file,
cloud-optimized map archive format. Once set up, WebATM makes no CDN calls
during page load and no remote tile requests, so it works in air-gapped
environments, aircraft, ships, field deployments, and other networks without
reliable internet.

![Live traffic rendered on the offline PMTiles basemap](screenshots/a380-pair-coastline.png)

## Why PMTiles?

- **Single file deployment** — one `.pmtiles` archive replaces an entire tile
  server. No tile cache, no tile seeding scripts, no background jobs.
- **No server software required** — PMTiles is read client-side via HTTP
  `Range` requests, which Flask's default static handler already supports.
- **Portable** — drop the file onto a USB stick, ship it with a Docker image,
  or host it on any static file server.

## Setup

1. **Build with internet available.** `script/build_frontend.sh` (or
   `npm run build` in `frontend/`) triggers a prebuild step that copies
   MapLibre GL CSS and Font Awesome assets from `node_modules` into
   `WebATM/static/vendor/`, and webpack bundles MapLibre GL JS and
   `socket.io-client` into the app bundles. After this step the page loads
   every library locally.

2. **Drop in an offline basemap.** Download a PMTiles archive (e.g. the
   [Protomaps worldwide basemap](https://maps.protomaps.com/builds/)) and
   save it to:

    ```
    WebATM/static/tiles/world.pmtiles
    ```

    The offline style at `WebATM/static/map/offline-style.json` expects that
    exact path.

    !!! warning "Reverse proxies"
        Make sure `.pmtiles` files are **not** gzip-encoded — PMTiles relies
        on HTTP `Range` requests, which Flask's default static handler
        supports out of the box.

3. **Select the offline map.** Open Settings → Map Display Configuration and
   choose **Offline (Local PMTiles)**. The app also auto-falls-back to the
   offline style if it detects that the configured online style can't be
   reached (e.g. no DNS, captive portal, blocked outbound) — including when
   the request hangs without ever failing: a reachability probe with a short
   timeout swaps to the offline basemap within a few seconds of first load.

The offline style is a minimal dark Protomaps schema with no text labels, so
no glyph PBFs or sprite sheets need to be bundled — only the `.pmtiles` file.

## Generating a custom regional archive

The worldwide Protomaps build is ~110 GB. For a specific region (e.g. a
single FIR or training area), the
[`pmtiles` CLI](https://github.com/protomaps/go-pmtiles) can extract a
bounding-box subset from the global archive, bringing the file size down to a
few MB–GB depending on coverage and max zoom:

```bash
pmtiles extract https://build.protomaps.com/<build>.pmtiles region.pmtiles \
  --bbox=<minLon>,<minLat>,<maxLon>,<maxLat> \
  --maxzoom=12
```

Copy the resulting `region.pmtiles` to `WebATM/static/tiles/world.pmtiles`
(the filename the offline style expects) and you're done.
