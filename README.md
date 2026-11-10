# DYMO Label XML Viewer

**Live demo:** https://abdulrehmansqae.github.io/dymo-label-xml-viewer/
_(primary URL — live once the repo is pushed and GitHub Pages is enabled; see Deployment below)_
**Mirror:** the app is also published on Muse — that link is a working backlink/mirror, but the
GitHub Pages URL above is the canonical one for search engines.

A browser-based tool inspired by the Labelary workflow — but for **DYMO
DesktopLabel XML** instead of Zebra ZPL. Paste or upload a `.label` / `.xml`
file, parse it, see the label redrawn at accurate proportions, edit text /
barcode values, drag objects, and export PNG / PDF.

> **Privacy:** All XML processing happens entirely in the browser.
> No patient information or label data is ever uploaded to a server.

> **Compatibility note:** This is an initial release. It prioritises accurate
> rendering of common DYMO DesktopLabel objects (text + Code 128 barcodes)
> and shows explicit warnings for unsupported elements. It does **not**
> claim full DYMO compatibility.

## Run it locally

Requirements: Node.js 18+ and npm.

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default: http://localhost:5173).

Production build:

```bash
npm run build
npm run preview
```

Type-check only:

```bash
npm run typecheck
```

## What it does

- **XML editor** (left): Paste (clipboard), Clear, Upload `.label`/`.xml`,
  and a **Sample** button preloaded with the `Small1738541` sample label.
- **Parse XML** button using the browser's `DOMParser`.
  - Supports: `DesktopLabel`, `DYMOLabel`, `DynamicLayoutManager`,
    `LabelObjects`, `TextObject`, `BarcodeObject`, `FormattedText`,
    `LineTextSpan`, `TextSpan`, `FontInfo`, `ObjectLayout`, `DYMOPoint`, `Size`.
  - Extracts label name, orientation, label/object positions & sizes
    (inches), text lines, font name/size/bold/italic/underline, rotation,
    alignment, and barcode format / value / text position / font.
  - Barcode data is read from `MultiDataString` / `DataString`, or
    `Data` / `Text` / CDATA fallbacks. All leaf `DataString` segments are
    collected in document order, empty/whitespace segments are skipped,
    and the rest are **joined** — a real DYMO v4 export stores the value
    as 4 sibling `DataString` elements with only the last one non-empty,
    and multi-segment values are parts of one barcode, not alternatives.
  - **Label size:** `DYMORect` is the printable-area rectangle *inset*
    from the label's top-left corner, not the physical label size
    (verified against a real v4 export: point 0.09, 0.0567 in + size
    1.9767 × 0.9033 in). Physical size is therefore computed as
    `DYMOPoint + Size` (= 2.0667 × 0.9600 in for that file). Files with
    the point at (0, 0) are unaffected.
  - Text is preserved **exactly** as written — including meaningful
    internal spacing (e.g. a prefix followed by two spaces). Only
    pretty-print whitespace around a value is removed.
  - Input containing literal `\n` escapes (as pasted out of Labelary) is
    unescaped to real newlines before parsing.
  - If the XML has no label size, it defaults to a Small label
    (2.3125 × 1.25 in) and says so in the warnings panel.
- **Live preview** (right): white label on a light-grey canvas, black text,
  consistent inches → pixels conversion (base 96 px/in).
  Zoom 50–300%, **Fit to screen**, and **1:1 pixel-accurate** mode.
  Text renders at its XML font size anchored to the **top** of its object
  box — DYMO text boxes are often far taller than the text (one real box
  is 0.889 in tall for 3 lines at 5 pt and overlaps the barcode zone), so
  lines are never stretched or spread to fill the box.
- **Real barcodes:** generated with [JsBarcode](https://github.com/lindell/JsBarcode).
  DYMO `Code128Auto` maps to JsBarcode `CODE128`. Barcodes are never faked
  as text or random stripes; invalid data shows an explicit error.
- **Editing:** click an object to select it, drag it in the preview to
  reposition, edit text lines / barcode value / X / Y / Width / Height
  (inches) / font size / bold in the Object Inspector.
- **Export:** PNG (html-to-image, 3×) and PDF (jsPDF, sized in inches to
  match the label, landscape/portrait matching the label).
- **Copy XML / Download XML:** regenerates `DesktopLabel` XML from the
  edited model (with proper XML escaping) and copies or downloads it
  as a `.label` file.
- **Errors & warnings:** clear parse-error banner (e.g. malformed XML, or
  ZPL pasted by mistake) plus a warnings panel listing every unsupported
  element type found in the file.

## Preloaded sample

`src/sampleXml.ts` contains the supplied sample:

| Item | Value |
|---|---|
| Label name | `Small1738541` |
| Orientation | Landscape |
| Text lines | `DOB- 01/01/2026 test patient` · `DOC- 10/21/2026 EST` · `RD- 10/21/2026 EST LIVERFAST, LiverFast + FIB4` |
| Text font | Segoe UI, size 5 |
| Barcode | Code 128 (`Code128Auto`), value `B26102121590S` |
| Barcode font | Arial, size 8 |
| Barcode layout | X 0.23093039, Y 0.5409018, W 1.5341527, H 0.41287157 (inches) |

## Tests

```bash
npm test
```

Runs `tests/parse-fixtures.test.mts` in Node (tsx, with
`@xmldom/xmldom` as a dev-only `DOMParser` shim) against:

- `tests/fixtures/synthetic-small.label` — a synthetic fixture with the
  same structure as a real DYMO v4 export (inset `DYMORect`, 4 sibling
  `DataString`s, a double-spaced text line), asserting label name,
  orientation, exact text lines, joined barcode value, both object
  layouts, and fonts (Segoe UI 5 / Arial 8).
- A real export at `test-fixtures/real-small1738541.label`, **if present
  locally**. That file contains real patient data: it is never committed
  to this package or the zip, its expectations are derived from the file
  in-memory by the test (nothing is hardcoded or printed beyond lengths
  and a 3-character barcode suffix), and the suite skips it when absent.

## Deployment (GitHub Pages)

The site deploys automatically via `.github/workflows/deploy.yml`
(GitHub Actions → GitHub Pages) on every push to `main`.

One-time setup:

1. Create a **public** GitHub repository named **`dymo-label-xml-viewer`**.
2. Push this project to it:
   ```bash
   git remote add origin https://github.com/<your-user>/dymo-label-xml-viewer.git
   git push -u origin main
   ```
3. In the repo, open **Settings → Pages** and set **Source: GitHub Actions**.
4. Wait for the "Deploy to GitHub Pages" workflow to finish — the site is
   live at `https://<your-user>.github.io/dymo-label-xml-viewer/`.

How it works: `vite.config.ts` sets `base: '/dymo-label-xml-viewer/'` for
production builds (project Pages sites are served from a sub-path) and
`'/'` for local dev. The workflow runs `npm ci` + `npm run build` and
publishes `dist/` with `actions/upload-pages-artifact` +
`actions/deploy-pages`. If you rename the repo or use a custom domain,
update the `base`, the canonical URL in `index.html`, and
`public/robots.txt` / `public/sitemap.xml` to match.

## SEO

- `index.html` carries a keyworded `<title>`, meta description, keywords,
  author, `robots` (index, follow), theme-color, a canonical URL, Open
  Graph + Twitter card tags, and JSON-LD `WebApplication` structured data
  (free offer, `UtilitiesApplication`, feature list).
- The app renders a visible About / How-to / FAQ section below the tool
  (what a `.label` file is, supported DYMO elements, Code 128 / Code 39,
  PNG/PDF export, local-only privacy, and a not-affiliated-with-DYMO note)
  so search engines and visitors get real content, not just a canvas.
- `public/robots.txt` allows all crawlers and points at
  `public/sitemap.xml` (single-URL sitemap). Both are copied into `dist/`
  by Vite at build time.
- After going live, submit the sitemap URL in Google Search Console to
  speed up indexing.

## Project structure

```
index.html                  SEO meta, Open Graph, JSON-LD WebApplication schema
package.json
vite.config.ts              base '/dymo-label-xml-viewer/' in production (Pages)
tsconfig.json
public/
  robots.txt                Allow all + sitemap pointer
  sitemap.xml               Single-URL sitemap
.github/workflows/
  deploy.yml                Build + deploy to GitHub Pages on push to main
src/
  main.tsx                  App entry
  App.tsx                   Editor, toolbar, zoom, export, warnings UI
  types.ts                  Label / object model types
  dymoParser.ts             DOMParser-based parser + XML serializer
  sampleXml.ts              Preloaded Small1738541 sample
  styles.css                Clean engineering-utility styling
  components/
    LabelPreview.tsx        SVG/DOM label rendering, JsBarcode, drag-to-move
    ObjectInspector.tsx     Edit text, barcode value, position & size
tests/
  parse-fixtures.test.mts   Node parser tests (npm test)
  fixtures/
    synthetic-small.label   Synthetic v4-shaped fixture (safe to share)
```

## Tech stack

React 18 · TypeScript · Vite · JsBarcode · jsPDF · html-to-image

## Notes / limitations

- Each `LineTextSpan` renders as exactly **one non-wrapping line**. For
  rotated (90°/270°) objects the line runs along the object's long axis,
  and a line longer than that axis is shrunk to fit (canvas-measured,
  `src/geometry.ts`) instead of wrapping mid-word into a second column.
- Rotation (`Rotation0/90/180/270`) renders via a footprint model
  (`src/geometry.ts`): the layout Width/Height are the object's
  unrotated size, the on-label footprint swaps them for 90°/270°, and
  the content is drawn at the unrotated size and rotated around the
  shared centre — so rotated text/barcodes stay inside their box and
  inside the label. `<IsVertical>` is parsed and rendered as vertical
  text. Rotated drag behaviour is approximate.
- Barcode formats map explicitly (`Code39` → CODE39,
  `Code128Auto/A/B/C` → CODE128, `Ean13` → EAN13, `Interleaved2of5` →
  ITF, `Codabar` → CODABAR, UPC, MSI, pharmacode…). Formats JsBarcode
  cannot encode (QR, DataMatrix, Code93…) produce an explicit warning
  and a clearly-labelled CODE128 fallback, never a silent substitution.
  Barcodes are scaled into their box via a viewBox; `Size=AutoFit`
  fits inside the box preserving aspect ratio.
- Decorative DYMO elements (brushes, borders, shapes, images, counters,
  date/time objects) are reported as unsupported rather than silently
  dropped — their names appear in the warnings panel.
- Font sizes in DYMO XML are points; the preview converts pt → px at
  96 dpi and scales with zoom so proportions stay consistent.
