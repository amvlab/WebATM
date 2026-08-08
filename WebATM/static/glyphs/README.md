# Map glyphs (SDF fonts for labels)

MapLibre needs **glyph PBFs** to render any `text-field` layer (airport /
waypoint labels, shape labels, aircraft labels). They are referenced at the
*style* level via the `glyphs` URL template — see `glyphs` in
`WebATM/static/map/offline-style.json`:

```json
"glyphs": "/static/glyphs/{fontstack}/{range}.pbf"
```

Flask serves `/static/` (with HTTP range support), so once the PBFs are in
place under this folder no extra route is needed.

> The hosted basemaps (e.g. the default CARTO style) ship their own glyphs, so
> labels already render there. These self-hosted glyphs are what let labels
> render on the **offline** style, which is otherwise fully local.

## What to put here

WebATM's overlay label layers request the **`Open Sans Regular`** fontstack
(see `NavdataRenderer.ts`). So this folder needs:

```
WebATM/static/glyphs/Open Sans Regular/0-255.pbf
WebATM/static/glyphs/Open Sans Regular/256-511.pbf
... (one PBF per 256-codepoint range)
```

The PBFs are gitignored (a full range is tens of MB); ship them alongside the
app like the PMTiles archive.

## How to generate them

Either grab a prebuilt set or bake your own from a TTF/OTF.

**Option A - prebuilt (quickest).** Protomaps' `basemaps-assets` ships ready
glyph PBFs (Noto Sans, OFL-licensed):

```bash
git clone --depth 1 https://github.com/protomaps/basemaps-assets
# It provides fonts under fonts/<fontstack>/<range>.pbf. Copy the stack you
# want and name the folder to match the requested fontstack, e.g.:
cp -r "basemaps-assets/fonts/Noto Sans Regular" "WebATM/static/glyphs/Open Sans Regular"
```

(Renaming the folder is what matters — MapLibre matches on the requested
fontstack name, not the font's internal name. If you'd rather keep the real
name, set `text-font` in `NavdataRenderer.ts` to match instead.)

**Option B - from a TTF with `font-maker`:**

```bash
npm install -g @maplibre/font-maker   # or use fontnik's build-glyphs
font-maker "OpenSans-Regular.ttf" "WebATM/static/glyphs"
```

Open Sans is available under the OFL from Google Fonts.

## Verify

With the app running, a glyph request should return a PBF:

```
curl -I "http://localhost:8082/static/glyphs/Open%20Sans%20Regular/0-255.pbf"
```

If glyphs are missing, MapLibre logs font-load errors (which `MapDisplay`
suppresses) and labels simply don't appear — everything else keeps working.
