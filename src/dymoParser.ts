import type {
  BarcodeObjectModel,
  FontInfo,
  ImageObjectModel,
  LabelModel,
  LabelObjectModel,
  ObjectLayout,
  ParseResult,
  Rotation,
  ShapeObjectModel,
  SizeSource,
  TextLine,
  TextObjectModel,
  UnsupportedObjectModel,
} from './types';
import { findStock } from './stocks';

/**
 * DYMO label XML parser — two file families are supported:
 *
 *  1. DYMO Connect / DesktopLabel XML ("connect"):
 *     <DesktopLabel> containing <DYMOLabel>, geometry in inches.
 *     Elements: DesktopLabel, DYMOLabel, DynamicLayoutManager,
 *     LabelObjects, TextObject, BarcodeObject, FormattedText,
 *     LineTextSpan, TextSpan, FontInfo, ObjectLayout, DYMOPoint, Size —
 *     plus AddressObject (as text), ShapeObject (rendered), ImageObject
 *     (embedded data rendered), CounterObject / DateTimeObject
 *     (composed as text) and CircularTextObject (placeholder).
 *
 *  2. Legacy DYMO Label Software XML ("legacy"):
 *     <DieCutLabel> / <ContinuousLabel> (Version 8.x) containing
 *     <ObjectInfo> entries, geometry as ATTRIBUTES in the root Units
 *     (twips by default: 1440 twips = 1 inch; points: 72 = 1 inch),
 *     <StyledText> runs for text and attribute-carried barcode fonts.
 *     See parseLegacyLabel() below.
 *
 * Robustness rules (universal-compatibility pass):
 *  - A leading BOM, XML comments and processing instructions are fine.
 *  - Tags are matched by LOCAL NAME, so namespace-prefixed files
 *    (<d:TextObject xmlns:d="...">) parse like unprefixed ones.
 *  - Unknown elements/attributes become warnings, never parse errors.
 *  - Any object kind that cannot be rendered faithfully degrades to a
 *    labelled placeholder at its real bounds — a file only hard-fails
 *    when it is not DYMO XML at all or contains no objects.
 *
 * Uses the browser's built-in DOMParser — a reliable, standards-based
 * XML parser. No label data ever leaves the browser.
 */

// ---------------------------------------------------------------------------
// Namespace-tolerant element lookup helpers.
// getElementsByTagName() does NOT match namespace-prefixed tags
// (<x:TextObject>), so every lookup in this parser goes through these
// local-name helpers instead.
// ---------------------------------------------------------------------------

function localName(el: Element): string {
  const ln = el.localName || el.tagName || '';
  const idx = ln.indexOf(':');
  return idx >= 0 ? ln.slice(idx + 1) : ln;
}

function allByTag(scope: Element | Document, tag: string): Element[] {
  const out: Element[] = [];
  const all = scope.getElementsByTagName('*');
  for (const el of Array.from(all)) {
    if (tag === '*' || localName(el) === tag) out.push(el);
  }
  return out;
}

function firstByTag(scope: Element | Document, tag: string): Element | null {
  return allByTag(scope, tag)[0] ?? null;
}

function directChild(parent: Element, tag: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (localName(child) === tag) return child;
  }
  return null;
}

const SUPPORTED = new Set([
  'DesktopLabel',
  'DYMOLabel',
  'Description',
  'Orientation',
  'LabelName',
  'InitialLength',
  'BorderStyle',
  'DYMORect',
  'BorderThickness',
  'Show_Border',
  'DynamicLayoutManager',
  'RotationBehavior',
  'LabelObjects',
  'TextObject',
  'BarcodeObject',
  'AddressObject',
  'ShapeObject',
  'ImageObject',
  'CounterObject',
  'DateTimeObject',
  'CircularTextObject',
  'ShapeType',
  'LineWidth',
  'ImageData',
  'ImagePath',
  'ImageSource',
  'Path',
  'FileName',
  'Source',
  'Prefix',
  'Suffix',
  'Value',
  'PrefixText',
  'SuffixText',
  'PostfixText',
  'CurrentValue',
  'InitialValue',
  'DateTimeFormat',
  'Format',
  'StyledText',
  'Element',
  'String',
  'Attributes',
  'Font',
  'Type',
  'CheckSumFont',
  'TextFont',
  'ECLevel',
  'TextEmbedding',
  'PaperName',
  'Id',
  'Name',
  'Rotation',
  'OutlineThickness',
  'IsOutlined',
  'HorizontalAlignment',
  'VerticalAlignment',
  'TextAlignment',
  'FormattedText',
  'FitMode',
  'LineTextSpan',
  'TextSpan',
  'Text',
  'FontInfo',
  'FontName',
  'FontSize',
  'IsBold',
  'IsItalic',
  'IsUnderline',
  'ObjectLayout',
  'DYMOPoint',
  'X',
  'Y',
  'Size',
  'Width',
  'Height',
  'BarcodeFormat',
  'BarcodeType',
  'Data',
  'MultiDataString',
  'DataString',
  'TextPosition',
  'Layout',
  // Standard DYMO elements that carry styling/structure this viewer
  // understands or safely accounts for. Listing them here keeps real
  // exports from producing spurious "unsupported element" warnings —
  // notably <IsVertical>, a standard text property (parsed below).
  'Brushes',
  'BackgroundBrush',
  'BorderBrush',
  'StrokeBrush',
  'FillBrush',
  'FontBrush',
  'SolidColorBrush',
  'Color',
  'Margin',
  'DYMOThickness',
  'BorderColor',
  'IsVertical',
  'HasFixedLength',
  'FixedLengthValue',
  'LabelApplication',
  'DataTable',
  'Columns',
  'Rows',
  'IsMirrored',
  'IsVariable',
  'GroupID',
  'BorderWidth',
  'ForeColor',
  'BackColor',
  'LinkedObjectName',
  'TextFitMode',
  'UseFullFontHeight',
  'Verticalized',
]);

const DEFAULT_FONT: FontInfo = {
  fontName: 'Segoe UI',
  fontSize: 10,
  isBold: false,
  isItalic: false,
  isUnderline: false,
};

/** Small label default used when the XML carries no DYMORect / Size. */
export const DEFAULT_LABEL_W = 2.3125;
export const DEFAULT_LABEL_H = 1.25;

/**
 * The user's real DYMO data sometimes arrives with literal backslash-n
 * escapes (e.g. pasted out of Labelary, where the XML is flattened to
 * `>\n<TextObject>\n...`). Unescape those before parsing, otherwise
 * DOMParser sees one long text blob instead of markup.
 */
export function unescapeLiteralNewlines(input: string): string {
  if (!input.includes('\\n') && !input.includes('\\r') && !input.includes('\\t')) {
    return input;
  }
  // Only unescape if the content does not already look like real
  // multi-line XML — a flattened export will have very few real newlines
  // relative to the number of \n literals.
  const literalCount = (input.match(/\\n/g) || []).length;
  const realCount = (input.match(/\n/g) || []).length;
  if (literalCount === 0) return input;
  if (realCount > literalCount) return input;
  return input
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t');
}

function textOf(parent: Element | null | undefined, tag: string): string {
  if (!parent) return '';
  const el = firstByTag(parent, tag);
  return el ? (el.textContent || '').trim() : '';
}

/**
 * Exact text of the first <tag> descendant, for label text content where
 * spacing IS data (a real export contains e.g. a line whose prefix is
 * followed by two spaces — that must survive parsing untouched).
 * Only pretty-print whitespace is removed: if the raw content contains a
 * newline, the file was almost certainly indented around the value, so
 * trim; single-line content is returned exactly as written.
 */
function exactTextOf(parent: Element, tag: string): string {
  const el = firstByTag(parent, tag);
  if (!el) return '';
  const raw = el.textContent || '';
  return raw.includes('\n') ? raw.trim() : raw;
}

function num(value: string, fallback: number): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolText(value: string): boolean {
  return /^true$/i.test(value.trim()) || value.trim() === '1';
}

function parseRotation(raw: string): Rotation {
  const v = raw.replace(/rotation/i, '').trim();
  const n = parseInt(v, 10);
  if (n === 90 || n === 180 || n === 270) return n;
  return 0;
}

function parseFontInfo(scope: Element | null | undefined): FontInfo {
  if (!scope) return { ...DEFAULT_FONT };
  const fi = firstByTag(scope, 'FontInfo');
  if (!fi) return { ...DEFAULT_FONT };
  return {
    fontName: textOf(fi, 'FontName') || DEFAULT_FONT.fontName,
    fontSize: num(textOf(fi, 'FontSize'), DEFAULT_FONT.fontSize),
    isBold: boolText(textOf(fi, 'IsBold')),
    isItalic: boolText(textOf(fi, 'IsItalic')),
    isUnderline: boolText(textOf(fi, 'IsUnderline')),
  };
}

function parseLayout(scope: Element): ObjectLayout {
  const layoutEl =
    directChild(scope, 'ObjectLayout') ||
    firstByTag(scope, 'ObjectLayout');
  if (!layoutEl) return { x: 0.05, y: 0.05, width: 1.5, height: 0.4 };

  const point = firstByTag(layoutEl, 'DYMOPoint');
  const size = firstByTag(layoutEl, 'Size');
  return {
    x: point ? num(textOf(point, 'X'), 0) : 0,
    y: point ? num(textOf(point, 'Y'), 0) : 0,
    width: size ? num(textOf(size, 'Width'), 1.5) : 1.5,
    height: size ? num(textOf(size, 'Height'), 0.4) : 0.4,
  };
}

/** Extract a CSS colour from DYMO brush/colour elements under `scope`.
 * Handles both colour encodings: legacy attribute colours
 * (Alpha/Red/Green/Blue on a 0–255 scale, on the element itself) and
 * Connect <Color A="1" R="0" .../> floats on a 0–1 scale nested inside
 * brush containers. Returns undefined for transparent/absent colours. */
function extractColor(scope: Element, containerNames: string[]): string | undefined {
  for (const name of containerNames) {
    const container = firstByTag(scope, name);
    if (!container) continue;
    const src = localName(container) === 'Color' ? container : firstByTag(container, 'Color') || container;
    const rawR = src.getAttribute('R') ?? src.getAttribute('Red');
    const rawG = src.getAttribute('G') ?? src.getAttribute('Green');
    const rawB = src.getAttribute('B') ?? src.getAttribute('Blue');
    if (rawR === null || rawG === null || rawB === null) continue;
    const rawA = src.getAttribute('A') ?? src.getAttribute('Alpha');
    let r = parseFloat(rawR);
    let g = parseFloat(rawG);
    let b = parseFloat(rawB);
    let a = rawA === null ? 1 : parseFloat(rawA);
    if (![r, g, b].every(Number.isFinite)) continue;
    // 0–1 float scale (Connect) vs 0–255 scale (legacy): scale up when
    // every channel is ≤ 1.
    if (Math.max(r, g, b, a) <= 1) {
      r *= 255; g *= 255; b *= 255; // alpha already 0..1
    } else {
      a = a / 255;
    }
    if (a <= 0) return undefined;
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  }
  return undefined;
}

function normalizeShapeType(raw: string): string {
  const v = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (v.includes('ellipse') || v.includes('oval') || v.includes('circle')) return 'Ellipse';
  if (v.includes('horizontal')) return 'HorizontalLine';
  if (v.includes('vertical')) return 'VerticalLine';
  if (v === 'line') return 'HorizontalLine';
  return 'Rectangle';
}

/** Embedded image (base64) or external reference from an ImageObject. */
function extractImageData(objEl: Element, name: string, warnings: string[]): string | null {
  for (const tag of ['ImageData', 'EmbeddedImage', 'Image', 'Data']) {
    const el = firstByTag(objEl, tag);
    if (!el) continue;
    const t = (el.textContent || '').replace(/\s+/g, '');
    if (t.length > 40 && /^[A-Za-z0-9+/=]+$/.test(t)) {
      const mime = t.startsWith('iVBOR')
        ? 'image/png'
        : t.startsWith('/9j/')
          ? 'image/jpeg'
          : t.startsWith('R0lGOD')
            ? 'image/gif'
            : t.startsWith('Qk')
              ? 'image/bmp'
              : 'image/png';
      return `data:${mime};base64,${t}`;
    }
  }
  const path =
    textOf(objEl, 'ImagePath') || textOf(objEl, 'Path') || textOf(objEl, 'FileName') ||
    textOf(objEl, 'Source') || textOf(objEl, 'ImageSource') ||
    objEl.getAttribute('Path') || objEl.getAttribute('Source') || '';
  if (path) {
    warnings.push(
      `Image "${name}" references an external file (${path}) that is not embedded in the label file — it is shown as a placeholder.`,
    );
  } else {
    warnings.push(`Image "${name}" has no embedded image data in the XML — it is shown as a placeholder.`);
  }
  return null;
}

/**
 * Explicit DYMO -> JsBarcode format mapping.
 *
 * The previous implementation substring-matched ('128', '39', 'itf'...)
 * and silently fell back to CODE128 for everything else — so e.g.
 * Interleaved2of5 rendered as a Code 128, and a QR code rendered as a
 * Code 128 with no hint anything was wrong. The map below is explicit:
 * every DYMO format JsBarcode can encode is listed, and anything else is
 * reported via isSupportedBarcodeFormat() so the UI can warn honestly
 * that the CODE128 on screen will NOT scan as the original symbology.
 * 2D symbologies (QRCode, DataMatrix, PDF417, Aztec) never reach the
 * fallback: they become labelled placeholders (see is2DBarcodeFormat).
 */
function normalizeFormatName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const JSBARCODE_FORMAT_MAP: Record<string, string> = {
  code128: 'CODE128',
  code128auto: 'CODE128',
  code128a: 'CODE128',
  code128b: 'CODE128',
  code128c: 'CODE128',
  gs1128: 'CODE128',
  code39: 'CODE39',
  code39cs: 'CODE39',
  code39mod43: 'CODE39',
  codabar: 'CODABAR',
  ean13: 'EAN13',
  ean: 'EAN13',
  jan13: 'EAN13',
  ean8: 'EAN8',
  ean5: 'EAN5',
  ean2: 'EAN2',
  upca: 'UPC',
  upc: 'UPC',
  upce: 'UPC',
  itf14: 'ITF14',
  itf: 'ITF',
  interleaved2of5: 'ITF',
  i2of5: 'ITF',
  industrial2of5: 'ITF',
  msi: 'MSI',
  msi10: 'MSI10',
  msi11: 'MSI11',
  msi1010: 'MSI1010',
  msi1110: 'MSI1110',
  pharmacode: 'pharmacode',
};

const TWOD_FORMATS = new Set(['qrcode', 'qr', 'datamatrix', 'pdf417', 'azteccode', 'aztec', 'maxicode']);

/** 2D symbologies are placeholders in this viewer, never drawn as 1D. */
export function is2DBarcodeFormat(raw: string): boolean {
  return TWOD_FORMATS.has(normalizeFormatName(raw));
}

function twoDWarning(name: string, rawFormat: string): string {
  return (
    `Barcode "${name}" uses ${rawFormat}, a 2D symbology this viewer cannot encode as a barcode image ` +
    `(cannot encode ${rawFormat} with JsBarcode) — it is shown as a labelled placeholder with its data, ` +
    `not rendered as a barcode, and the placeholder will NOT scan as ${rawFormat}.`
  );
}

function twoDPlaceholder(
  idPrefix: string,
  idx: number,
  name: string,
  rawFormat: string,
  value: string,
  layout: ObjectLayout,
  rotation: Rotation,
  mirrored: boolean,
): UnsupportedObjectModel {
  return {
    id: `${idPrefix}-${idx}`,
    kind: 'unsupported',
    name,
    objectType: 'BarcodeObject',
    detail: `${rawFormat} barcode — not rendered`,
    dataValue: value || undefined,
    layout,
    rotation,
    mirrored,
  };
}

/** True when JsBarcode can actually encode this DYMO format. */
export function isSupportedBarcodeFormat(raw: string): boolean {
  const v = normalizeFormatName(raw);
  if (!v) return true; // absent format -> DYMO default (Code128Auto)
  return v in JSBARCODE_FORMAT_MAP;
}

export function barcodeFormatToJsBarcode(raw: string): string {
  const v = normalizeFormatName(raw);
  // Unknown 1D formats (Code93, ...) fall back to CODE128 so *something*
  // scannable-looking renders, but callers must check
  // isSupportedBarcodeFormat() and warn — the fallback barcode does NOT
  // encode the original symbology. (2D formats never reach this path.)
  return JSBARCODE_FORMAT_MAP[v] || 'CODE128';
}

/** Extract barcode value from the many shapes DYMO uses. */
function extractBarcodeValue(obj: Element): string {
  const dataEl = directChild(obj, 'Data') || firstByTag(obj, 'Data');
  if (dataEl) {
    // MultiDataString / DataString: a real DYMO v4 export stores the
    // value as MULTIPLE sibling <DataString> segments — e.g. four
    // siblings where the first three are empty and the fourth holds the
    // value, or several non-empty segments that are parts of ONE value.
    // Collect every leaf DataString (one with no DataString descendant,
    // so a wrapper that only nests another DataString is not double
    // counted), skip empty / whitespace-only segments, and join the
    // rest in document order. Never just take the first one.
    const all = allByTag(dataEl, 'DataString');
    const leaves = all.filter(
      (s) => allByTag(s, 'DataString').length === 0,
    );
    const parts = leaves
      .map((s) => (s.textContent || '').trim())
      .filter((t) => t.length > 0);
    if (parts.length > 0) return parts.join('');
    const multi = firstByTag(dataEl, 'MultiDataString');
    if (multi) {
      const t = (multi.textContent || '').trim();
      if (t) return t;
    }
    const direct = (dataEl.textContent || '').trim();
    if (direct) return direct;
  }
  // Fallbacks: <Text>, <BarcodeData>, plain CDATA under the object
  for (const tag of ['BarcodeData', 'Text', 'Value']) {
    const t = textOf(obj, tag);
    if (t) return t;
  }
  return '';
}

function parseTextObject(el: Element, idx: number, sourceType?: string): TextObjectModel {
  const lines: TextLine[] = [];
  const formatted = firstByTag(el, 'FormattedText');

  if (formatted) {
    const spans = allByTag(formatted, 'LineTextSpan');
    if (spans.length > 0) {
      for (const span of spans) {
        const textSpan = firstByTag(span, 'TextSpan') || span;
        const text =
          exactTextOf(textSpan, 'Text') ||
          (textSpan.textContent || '').trim();
        lines.push({ text, font: parseFontInfo(textSpan) });
      }
    } else {
      // FormattedText with bare TextSpan children
      const textSpans = allByTag(formatted, 'TextSpan');
      for (const ts of textSpans) {
        lines.push({
          text: exactTextOf(ts, 'Text') || (ts.textContent || '').trim(),
          font: parseFontInfo(ts),
        });
      }
    }
  }

  if (lines.length === 0) {
    // Plain <Text> fallback
    const t = textOf(el, 'Text');
    if (t) lines.push({ text: t, font: parseFontInfo(el) });
  }
  if (lines.length === 0) lines.push({ text: '', font: parseFontInfo(el) });

  return {
    id: `text-${idx}`,
    kind: 'text',
    name: textOf(el, 'Name') || `${sourceType || 'TextObject'}${idx}`,
    lines,
    layout: parseLayout(el),
    rotation: parseRotation(textOf(el, 'Rotation')),
    mirrored: boolText(textOf(el, 'IsMirrored')),
    horizontalAlignment: textOf(el, 'HorizontalAlignment') || 'Left',
    verticalAlignment: textOf(el, 'VerticalAlignment') || 'Top',
    textAlignment:
      textOf(el, 'TextAlignment') || textOf(el, 'HorizontalAlignment') || 'Left',
    // <IsVertical> appears both as a direct TextObject child and inside
    // <FormattedText>; take the object's own value when present.
    isVertical: boolText(
      directChild(el, 'IsVertical')?.textContent || textOf(el, 'IsVertical'),
    ),
    sourceType,
  };
}

/**
 * CounterObject / DateTimeObject: rendered as text. When the object
 * carries FormattedText it is composed exactly like a TextObject;
 * otherwise the line is composed from prefix + value + suffix parts
 * (the way DYMO itself assembles counter/date output).
 */
function parseComposedTextObject(el: Element, idx: number, sourceType: string): TextObjectModel {
  const base = parseTextObject(el, idx, sourceType);
  const hasFormatted = !!firstByTag(el, 'FormattedText');
  const plainText = textOf(el, 'Text');
  if (hasFormatted || plainText) return base;
  const prefix = textOf(el, 'PrefixText') || textOf(el, 'Prefix');
  const value =
    textOf(el, 'CurrentValue') || textOf(el, 'InitialValue') ||
    textOf(el, 'Value') || textOf(el, 'DateTimeFormat') || textOf(el, 'Format');
  const suffix = textOf(el, 'SuffixText') || textOf(el, 'PostfixText') || textOf(el, 'Suffix');
  const composed = `${prefix}${value}${suffix}`;
  return {
    ...base,
    lines: [{ text: composed, font: parseFontInfo(el) }],
  };
}

function parseBarcodeObject(el: Element, idx: number): BarcodeObjectModel {
  const rawFormat =
    textOf(el, 'BarcodeFormat') || textOf(el, 'BarcodeType') || 'Code128Auto';
  // <Size> directly under BarcodeObject is a mode (e.g. AutoFit), not dims.
  const sizeModeEl = directChild(el, 'Size');
  const sizeMode = sizeModeEl ? (sizeModeEl.textContent || '').trim() : undefined;

  return {
    id: `barcode-${idx}`,
    kind: 'barcode',
    name: textOf(el, 'Name') || `BarcodeObject${idx}`,
    barcodeFormatRaw: rawFormat,
    barcodeFormat: barcodeFormatToJsBarcode(rawFormat),
    value: extractBarcodeValue(el),
    layout: parseLayout(el),
    rotation: parseRotation(textOf(el, 'Rotation')),
    mirrored: boolText(textOf(el, 'IsMirrored')),
    horizontalAlignment: textOf(el, 'HorizontalAlignment') || 'Left',
    verticalAlignment: textOf(el, 'VerticalAlignment') || 'Middle',
    textPosition: textOf(el, 'TextPosition') || 'Bottom',
    font: parseFontInfo(el),
    sizeMode: sizeMode && !/^\d/.test(sizeMode) ? sizeMode : undefined,
  };
}

function parseShapeObject(el: Element, idx: number): ShapeObjectModel {
  const shapeTypeRaw =
    textOf(el, 'ShapeType') || el.getAttribute('ShapeType') || textOf(el, 'Type') || 'Rectangle';
  return {
    id: `shape-${idx}`,
    kind: 'shape',
    name: textOf(el, 'Name') || `ShapeObject${idx}`,
    shapeType: normalizeShapeType(shapeTypeRaw),
    fill: extractColor(el, ['FillBrush', 'FillColor', 'ShapeFillColor', 'BackColor']),
    stroke: extractColor(el, ['StrokeBrush', 'BorderBrush', 'LineColor', 'ForeColor']),
    layout: parseLayout(el),
    rotation: parseRotation(textOf(el, 'Rotation')),
    mirrored: boolText(textOf(el, 'IsMirrored')),
  };
}

function parseImageObject(el: Element, idx: number, warnings: string[]): ImageObjectModel {
  const name = textOf(el, 'Name') || `ImageObject${idx}`;
  return {
    id: `image-${idx}`,
    kind: 'image',
    name,
    dataUrl: extractImageData(el, name, warnings),
    layout: parseLayout(el),
    rotation: parseRotation(textOf(el, 'Rotation')),
    mirrored: boolText(textOf(el, 'IsMirrored')),
  };
}

/** Shared post-parse barcode checks (both file families). */
function addBarcodeWarnings(objects: LabelObjectModel[], warnings: string[]): void {
  for (const obj of objects) {
    if (obj.kind !== 'barcode') continue;
    if (!isSupportedBarcodeFormat(obj.barcodeFormatRaw)) {
      warnings.push(
        `Barcode "${obj.name}" uses DYMO format ${obj.barcodeFormatRaw}, which JsBarcode cannot encode. ` +
          `It is shown as a CODE128 fallback — it will NOT scan as ${obj.barcodeFormatRaw}.`,
      );
    } else if (obj.barcodeFormat !== 'CODE128') {
      warnings.push(`Barcode "${obj.name}" uses ${obj.barcodeFormatRaw} — rendered as ${obj.barcodeFormat}. Verify it scans as expected.`);
    }
    if (!obj.value) {
      warnings.push(`Barcode "${obj.name}" has no data value in the XML.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy DYMO Label Software format (<DieCutLabel> / <ContinuousLabel>)
// ---------------------------------------------------------------------------
//
// Real legacy exports (DYMO Label Software v8, still produced by lab LIS
// integrations) look nothing like DesktopLabel XML:
//   <DieCutLabel Version="8.0" Units="twips">
//     <PaperOrientation>Landscape</PaperOrientation>
//     <Id>...</Id><PaperName>...</PaperName>
//     <DrawCommands><RoundRectangle X="0" Y="0" Width=".." Height=".."/></DrawCommands>
//     <ObjectInfo>
//       <TextObject>... <StyledText>... </TextObject>
//       <Bounds X="376" Y="540" Width="1500" Height="135"/>
//     </ObjectInfo>
//     ...
//   </DieCutLabel>
// Geometry lives in ATTRIBUTES, in the root Units (twips unless stated:
// 1440 twips = 1 inch; points = 72/inch). Fonts are split between
// <StyledText> runs (text) and attribute-carried <Font>/<TextFont>
// elements (barcodes), and colors are 0–255 attribute values rather than
// the 0–1 floats of the Connect format.

const LEGACY_SUPPORTED = new Set([
  'DieCutLabel', 'ContinuousLabel', 'PaperOrientation', 'Id', 'PaperName',
  'Paper', 'DrawCommands', 'DrawCommand', 'RoundRectangle', 'Rectangle',
  'Ellipse', 'Line', 'ObjectInfo', 'Bounds',
  'TextObject', 'AddressObject', 'BarcodeObject',
  'ShapeObject', 'ImageObject', 'CounterObject', 'DateTimeObject',
  'CircularTextObject',
  'ShapeType', 'LineWidth', 'FillColor', 'ShapeFillColor', 'LineColor',
  'ImageData', 'ImagePath', 'ImageSource', 'Path', 'FileName', 'Source',
  'Image', 'EmbeddedImage',
  'Prefix', 'Suffix', 'Value', 'InitialValue', 'CurrentValue',
  'PrefixText', 'SuffixText', 'PostfixText', 'DateTimeFormat', 'Format',
  'HasFixedLength', 'FixedLengthValue', 'Length',
  'StyledText', 'Element', 'String', 'Attributes', 'Font',
  'ForeColor', 'BackColor', 'Name', 'Rotation', 'IsMirrored', 'IsVariable',
  'GroupID', 'IsOutlined', 'LinkedObjectName', 'HorizontalAlignment',
  'VerticalAlignment', 'TextFitMode', 'UseFullFontHeight', 'Verticalized',
  'Text', 'Type', 'Size', 'TextPosition', 'TextFont', 'CheckSumFont',
  'TextEmbedding', 'ECLevel', 'QuietZonesPadding', 'BorderStyle',
  'AddressFont', 'FontInfo', 'FontName', 'FontSize', 'IsBold', 'IsItalic',
  'IsUnderline', 'BarcodeFormat', 'Data', 'DataString',
  'Brushes', 'BackgroundBrush', 'BorderBrush', 'StrokeBrush', 'FillBrush',
  'FontBrush', 'SolidColorBrush', 'Color', 'Margin', 'DYMOThickness',
]);

function attrNum(el: Element | null, name: string, fallback: number): number {
  if (!el) return fallback;
  const raw = el.getAttribute(name);
  if (raw === null) return fallback;
  return num(raw, fallback);
}

function attrBool(el: Element | null, name: string, fallback: boolean): boolean {
  if (!el) return fallback;
  const raw = el.getAttribute(name);
  if (raw === null) return fallback;
  return boolText(raw);
}

/** Font from a legacy attribute-carried element (<Font/>, <TextFont/>). */
function fontFromAttrs(fontEl: Element | null, base: FontInfo): FontInfo {
  if (!fontEl) return { ...base };
  return {
    fontName: fontEl.getAttribute('Family') || base.fontName,
    fontSize: attrNum(fontEl, 'Size', base.fontSize),
    isBold: attrBool(fontEl, 'Bold', base.isBold),
    isItalic: attrBool(fontEl, 'Italic', base.isItalic),
    isUnderline: attrBool(fontEl, 'Underline', base.isUnderline),
  };
}

/** Split text into printed lines on any line-break style. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Lines for a legacy TextObject / AddressObject.
 * Preferred source: <StyledText> — a sequence of <Element> runs, each
 * with a <String> and an attribute-carried <Font>. Runs concatenate,
 * and each run's text splits on line breaks (the runs' fonts carry
 * onto the lines they produce). Fallback: a plain <Text> child.
 */
function parseLegacyTextLines(objEl: Element): TextLine[] {
  const lines: TextLine[] = [];
  const styled = directChild(objEl, 'StyledText') || firstByTag(objEl, 'StyledText');
  if (styled) {
    for (const element of Array.from(styled.children)) {
      if (localName(element) !== 'Element') continue;
      const strEl = firstByTag(element, 'String');
      const fontEl = firstByTag(element, 'Font') || null;
      const font = fontFromAttrs(fontEl, DEFAULT_FONT);
      const segments = splitLines(strEl ? strEl.textContent || '' : '');
      segments.forEach((seg, i) => {
        if (i === 0 && lines.length > 0) {
          // Run boundary mid-line: append to the previous line rather
          // than starting a new one (runs concatenate into lines).
          lines[lines.length - 1] = { ...lines[lines.length - 1], text: lines[lines.length - 1].text + seg };
        } else {
          lines.push({ text: seg, font });
        }
      });
    }
  }
  if (lines.length === 0) {
    const plain = directChild(objEl, 'Text');
    if (plain) {
      const fontEl = firstByTag(objEl, 'Font') || null;
      const font = fontFromAttrs(fontEl, DEFAULT_FONT);
      for (const seg of splitLines(plain.textContent || '')) lines.push({ text: seg, font });
    }
  }
  if (lines.length === 0) lines.push({ text: '', font: { ...DEFAULT_FONT } });
  return lines;
}

function parseLegacyLabel(doc: Document, warnings: string[]): ParseResult {
  const root = doc.documentElement;
  const rootTag = localName(root);
  const unsupportedSet = new Set<string>();
  for (const el of allByTag(doc, '*')) {
    const ln = localName(el);
    if (!LEGACY_SUPPORTED.has(ln)) unsupportedSet.add(ln);
  }
  const unsupported = Array.from(unsupportedSet).sort();
  if (unsupported.length > 0) {
    warnings.push(
      `${unsupported.length} element type(s) are not fully rendered by this viewer: ${unsupported.join(', ')}. Their data is preserved in the source XML panel only.`,
    );
  }

  // Unit conversion to inches. Default is twips (the DYMO default when
  // the Units attribute is absent); points are also common in the wild.
  const unitsRaw = (root.getAttribute('Units') || 'twips').trim().toLowerCase();
  let unitDivisor = 1440;
  let unitName = 'twips';
  if (unitsRaw === 'points' || unitsRaw === 'point' || unitsRaw === 'pt') {
    unitDivisor = 72;
    unitName = 'points';
  } else if (unitsRaw === 'inches' || unitsRaw === 'inch' || unitsRaw === 'in') {
    unitDivisor = 1;
    unitName = 'inches';
  } else if (unitsRaw !== 'twips') {
    warnings.push(`Unknown legacy Units="${root.getAttribute('Units')}" — assuming twips (1440 per inch). Check the label proportions.`);
  }
  const toIn = (v: number) => v / unitDivisor;
  warnings.push(
    `Legacy DYMO Label Software format detected (root <${rootTag}>, geometry in ${unitName}, converted to inches). ` +
      'Copy / Download will export it converted to DYMO Connect DesktopLabel XML.',
  );

  // Objects: each <ObjectInfo> holds one object element + a <Bounds>
  // sibling whose ATTRIBUTES give position/size in root Units.
  const objects: LabelObjectModel[] = [];
  const infos = allByTag(doc, 'ObjectInfo');
  let tIdx = 0;
  let bIdx = 0;
  let sIdx = 0;
  let iIdx = 0;
  let uIdx = 0;
  for (const info of infos) {
    const objEl = Array.from(info.children).find((c) => localName(c) !== 'Bounds');
    if (!objEl) continue; // wrapper <ObjectInfo> with no direct object
    const objTag = localName(objEl);
    const boundsEl = directChild(info, 'Bounds');
    const layout: ObjectLayout = boundsEl
      ? {
          x: toIn(attrNum(boundsEl, 'X', 0)),
          y: toIn(attrNum(boundsEl, 'Y', 0)),
          width: toIn(attrNum(boundsEl, 'Width', 0)),
          height: toIn(attrNum(boundsEl, 'Height', 0)),
        }
      : { x: 0.05, y: 0.05, width: 1.5, height: 0.4 };
    const rotation = parseRotation(textOf(objEl, 'Rotation'));
    const mirrored = boolText(textOf(objEl, 'IsMirrored'));
    const name = textOf(objEl, 'Name') || `${objTag}${objects.length}`;

    if (objTag === 'TextObject' || objTag === 'AddressObject') {
      objects.push({
        id: `text-${tIdx++}`,
        kind: 'text',
        name,
        lines: parseLegacyTextLines(objEl),
        layout,
        rotation,
        mirrored,
        horizontalAlignment: textOf(objEl, 'HorizontalAlignment') || 'Left',
        verticalAlignment: textOf(objEl, 'VerticalAlignment') || 'Top',
        textAlignment: textOf(objEl, 'HorizontalAlignment') || 'Left',
        isVertical: boolText(textOf(objEl, 'Verticalized')),
        sourceType: objTag === 'AddressObject' ? 'AddressObject' : undefined,
      } satisfies TextObjectModel);
    } else if (objTag === 'CounterObject' || objTag === 'DateTimeObject') {
      // Composed and rendered as text: StyledText when present,
      // otherwise prefix + value + suffix parts.
      let lines = parseLegacyTextLines(objEl);
      if (lines.every((l) => l.text.trim() === '')) {
        const prefix = textOf(objEl, 'PrefixText') || textOf(objEl, 'Prefix');
        const value =
          textOf(objEl, 'CurrentValue') || textOf(objEl, 'InitialValue') ||
          textOf(objEl, 'Value') || textOf(objEl, 'DateTimeFormat') || textOf(objEl, 'Format') ||
          textOf(objEl, 'Text');
        const suffix = textOf(objEl, 'SuffixText') || textOf(objEl, 'PostfixText') || textOf(objEl, 'Suffix');
        const fontEl = firstByTag(objEl, 'Font');
        lines = [{ text: `${prefix}${value}${suffix}`, font: fontFromAttrs(fontEl, DEFAULT_FONT) }];
      }
      objects.push({
        id: `text-${tIdx++}`,
        kind: 'text',
        name,
        lines,
        layout,
        rotation,
        mirrored,
        horizontalAlignment: textOf(objEl, 'HorizontalAlignment') || 'Left',
        verticalAlignment: textOf(objEl, 'VerticalAlignment') || 'Top',
        textAlignment: textOf(objEl, 'HorizontalAlignment') || 'Left',
        isVertical: boolText(textOf(objEl, 'Verticalized')),
        sourceType: objTag,
      } satisfies TextObjectModel);
    } else if (objTag === 'BarcodeObject') {
      const rawFormat = textOf(objEl, 'Type') || textOf(objEl, 'BarcodeFormat') || 'Code128Auto';
      const value = (directChild(objEl, 'Text')?.textContent || textOf(objEl, 'Text')).trim();
      if (is2DBarcodeFormat(rawFormat)) {
        objects.push(twoDPlaceholder('unsupported', uIdx++, name, rawFormat, value, layout, rotation, mirrored));
        warnings.push(twoDWarning(name, rawFormat));
        continue;
      }
      // <TextFont> carries the human-readable caption font as attributes.
      const textFontEl = directChild(objEl, 'TextFont') || firstByTag(objEl, 'TextFont');
      const font = fontFromAttrs(textFontEl, { ...DEFAULT_FONT, fontName: 'Arial', fontSize: 8 });
      // Legacy <Size> is a named module size (Small|Medium|Large), not
      // the Connect AutoFit mode — kept verbatim in sizeMode.
      const sizeMode = textOf(objEl, 'Size') || undefined;
      objects.push({
        id: `barcode-${bIdx++}`,
        kind: 'barcode',
        name,
        barcodeFormatRaw: rawFormat,
        barcodeFormat: barcodeFormatToJsBarcode(rawFormat),
        value,
        layout,
        rotation,
        mirrored,
        horizontalAlignment: textOf(objEl, 'HorizontalAlignment') || 'Center',
        verticalAlignment: textOf(objEl, 'VerticalAlignment') || 'Middle',
        textPosition: textOf(objEl, 'TextPosition') || 'Bottom',
        font,
        sizeMode,
      } satisfies BarcodeObjectModel);
    } else if (objTag === 'ShapeObject') {
      const shapeTypeRaw =
        textOf(objEl, 'ShapeType') || objEl.getAttribute('ShapeType') || textOf(objEl, 'Type') || 'Rectangle';
      objects.push({
        id: `shape-${sIdx++}`,
        kind: 'shape',
        name,
        shapeType: normalizeShapeType(shapeTypeRaw),
        fill: extractColor(objEl, ['FillBrush', 'FillColor', 'ShapeFillColor', 'BackColor']),
        stroke: extractColor(objEl, ['StrokeBrush', 'BorderBrush', 'LineColor', 'ForeColor']),
        layout,
        rotation,
        mirrored,
      } satisfies ShapeObjectModel);
    } else if (objTag === 'ImageObject') {
      objects.push({
        id: `image-${iIdx++}`,
        kind: 'image',
        name,
        dataUrl: extractImageData(objEl, name, warnings),
        layout,
        rotation,
        mirrored,
      } satisfies ImageObjectModel);
    } else {
      // CircularTextObject / anything else: never fail the parse — keep
      // an honest placeholder at the object's real bounds.
      objects.push({
        id: `unsupported-${uIdx++}`,
        kind: 'unsupported',
        name,
        objectType: objTag,
        layout,
        rotation,
        mirrored,
      } satisfies UnsupportedObjectModel);
      warnings.push(
        `Object "${name}" is a ${objTag}, which this viewer does not render — it is shown as a placeholder at its position.`,
      );
    }
  }

  if (objects.length === 0) {
    return {
      model: null,
      error:
        'Legacy DYMO file: no <ObjectInfo> objects were found. Supported formats: ' +
        'DYMO Connect DesktopLabel XML (<DesktopLabel> containing <DYMOLabel>) and legacy DYMO Label Software XML ' +
        '(<DieCutLabel> or <ContinuousLabel> with <ObjectInfo> entries).',
      warnings,
      unsupported,
    };
  }

  // Label size derivation, in order of trust:
  //  1. <DrawCommands> shape extents (explicit geometry in the file).
  //  2. The stock table (src/stocks.ts) via <Id>/<PaperName> — warned.
  //  3. Object bounds extent + a small margin — warned as inferred.
  // ContinuousLabel without explicit geometry derives its LENGTH from
  // FixedLengthValue or from the content extents (warned either way).
  let widthIn = 0;
  let heightIn = 0;
  let sizeSource: SizeSource = 'inferred';
  const draw = firstByTag(doc, 'DrawCommands');
  if (draw) {
    for (const shape of Array.from(draw.children)) {
      const x = attrNum(shape, 'X', NaN);
      const y = attrNum(shape, 'Y', NaN);
      const w = attrNum(shape, 'Width', NaN);
      const h = attrNum(shape, 'Height', NaN);
      if ([x, y, w, h].every(Number.isFinite)) {
        widthIn = Math.max(widthIn, toIn(x + w));
        heightIn = Math.max(heightIn, toIn(y + h));
      }
    }
  }
  if (widthIn > 0 && heightIn > 0) {
    sizeSource = 'geometry';
  } else {
    const maxX = Math.max(0, ...objects.map((o) => o.layout.x + o.layout.width));
    const maxY = Math.max(0, ...objects.map((o) => o.layout.y + o.layout.height));
    const idText = `${textOf(root, 'Id')} ${textOf(root, 'PaperName')}`;
    const stock = findStock(idText);
    if (rootTag === 'ContinuousLabel') {
      if (stock) {
        widthIn = stock.widthIn;
        sizeSource = 'stock';
        warnings.push(
          `Label width from stock table: paper stock "${stock.stock}" (${stock.name}) is ${stock.widthIn} in wide — ` +
            'the file has no DrawCommands extents. This size is from the stock table (a published-size lookup), not from geometry in the file.',
        );
      } else {
        widthIn = maxX + 0.1;
        sizeSource = 'inferred';
      }
      const flv = num(textOf(root, 'FixedLengthValue'), NaN);
      if (Number.isFinite(flv) && flv > 0) {
        heightIn = toIn(flv);
        warnings.push(`Continuous label length taken from FixedLengthValue (${heightIn.toFixed(3)} in).`);
      } else {
        heightIn = maxY + 0.1;
        warnings.push(
          `Continuous label length is content-derived: the file sets no FixedLengthValue, so the length is the object extents plus a 0.1 in margin (${heightIn.toFixed(2)} in). ` +
            'Verify it against your printer setup before printing a run.',
        );
      }
    } else if (stock) {
      widthIn = stock.widthIn;
      heightIn = stock.heightIn;
      sizeSource = 'stock';
      warnings.push(
        `Label size from stock table: paper stock "${stock.stock}" (${stock.name}) is ${widthIn} × ${heightIn} in — ` +
          'the file has no DrawCommands extents, so this size is from the stock table (a published-size lookup for the known paper stock), not from geometry in the file.',
      );
    } else {
      widthIn = maxX + 0.1;
      heightIn = maxY + 0.1;
      sizeSource = 'inferred';
      warnings.push(
        `Label size was inferred from the object bounds plus a 0.1 in margin (${widthIn.toFixed(2)} × ${heightIn.toFixed(2)} in) — ` +
          'the file has no DrawCommands extents and its paper stock is not recognised. Verify the proportions against your label stock.',
      );
    }
  }

  const name = textOf(root, 'PaperName') || textOf(root, 'Id') || (rootTag === 'ContinuousLabel' ? 'Continuous Label' : 'Die-Cut Label');
  const orientationRaw = textOf(root, 'PaperOrientation');
  const orientation: LabelModel['orientation'] = /portrait/i.test(orientationRaw)
    ? 'Portrait'
    : /landscape/i.test(orientationRaw)
      ? 'Landscape'
      : widthIn >= heightIn
        ? 'Landscape'
        : 'Portrait';

  addBarcodeWarnings(objects, warnings);

  return {
    model: { name, orientation, format: 'legacy', sizeSource, widthIn, heightIn, objects },
    error: null,
    warnings,
    unsupported,
  };
}

// ---------------------------------------------------------------------------
// Escaped-input decoding (JSON-style escaped label XML)
// ---------------------------------------------------------------------------
//
// Some source systems (LIS integrations in particular) deliver label
// XML as a JSON-escaped string: every attribute quote is \" and every
// line break is a literal \n, and the whole payload is sometimes
// wrapped in a pair of double quotes. Fed to an XML parser as-is, that
// string is not markup at all — it fails with errors like "content
// outside root element" / "XML declaration only at the start of the
// document", which is exactly how a real, perfectly valid label
// "didn't work" for the user.
//
// SAFETY RULE: decodeEscapedInput is ONLY invoked after the input has
// already FAILED to parse as XML (see parseDymoXml). A valid raw XML
// file is therefore never decoded — in particular a file whose text
// content legitimately contains backslashes (a Windows path, an
// abbreviation with a \, ...) parses successfully on the first attempt
// and is left completely untouched. Decoding is attempted at most
// twice (double-escaped payloads), and each round must change the
// string for decoding to continue.

function manualJsonUnescape(s: string): string {
  // Single left-to-right pass with JSON string semantics: \\ collapses
  // to one backslash BEFORE the following character is considered, so
  // "\\n" (an escaped backslash + n) correctly stays a literal "\n"
  // instead of becoming a newline.
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_m, esc: string) => {
    if (esc.startsWith('u')) return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      default: return esc; // \" \\ \/ and any other escaped char → itself
    }
  });
}

/**
 * Try to decode an escaped/wrapped payload into raw XML text.
 * Returns the decoded string, or null when nothing decodable was found.
 * Rounds (max 2): JSON.parse when the trimmed text is a valid JSON
 * string literal; otherwise a manual escape pass when escape markers
 * are present; otherwise strip one wrapping pair of quotes.
 */
export function decodeEscapedInput(input: string): string | null {
  let current = input.trim();
  let changed = false;
  for (let round = 0; round < 2; round++) {
    let next: string | null = null;
    if (current.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(current);
        if (typeof parsed === 'string') next = parsed;
      } catch {
        // Not a valid JSON string literal — try the manual passes.
      }
    }
    if (next === null && /\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/.test(current)) {
      next = manualJsonUnescape(current);
    }
    if (
      next === null &&
      current.length >= 2 &&
      current.startsWith('"') &&
      current.endsWith('"')
    ) {
      next = current.slice(1, -1).trim();
    }
    if (next === null || next === current) break;
    current = next.trim();
    changed = true;
  }
  return changed ? current : null;
}

/** One XML parse attempt: a Document on success, an error string otherwise. */
function tryParseXml(xml: string): { doc: Document | null; error: string | null } {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch (e) {
    return { doc: null, error: `XML parsing failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parserError = allByTag(doc, 'parsererror')[0];
  if (parserError) {
    const msg = (parserError.textContent || 'Unknown XML error').trim().split('\n')[0];
    return { doc: null, error: `Invalid XML: ${msg}` };
  }
  if (!doc.documentElement) {
    return { doc: null, error: 'Invalid XML: no root element found.' };
  }
  return { doc, error: null };
}

// ---------------------------------------------------------------------------
// Main entry point (DYMO Connect branch + format dispatch)
// ---------------------------------------------------------------------------

export function parseDymoXml(rawInput: string): ParseResult {
  const warnings: string[] = [];
  const unsupportedSet = new Set<string>();

  if (!rawInput || !rawInput.trim()) {
    return { model: null, error: 'XML is empty. Paste DYMO XML, upload a .label / .xml file, or load the sample.', warnings, unsupported: [] };
  }

  // A leading byte-order mark (common in files saved by Windows tools)
  // is not XML content — strip it before parsing.
  const bomStripped = rawInput.replace(/^\uFEFF+/, '');
  const input = unescapeLiteralNewlines(bomStripped);
  if (input !== rawInput) {
    if (bomStripped !== rawInput) {
      warnings.push('A byte-order mark (BOM) at the start of the file was removed before parsing.');
    }
    if (input !== bomStripped) {
      warnings.push('Input contained literal \\n escapes — they were converted to real newlines before parsing.');
    }
  }

  // First attempt: parse the (BOM-stripped, \n-unescaped) input as-is.
  // A valid raw XML file — including one whose text content contains
  // backslashes — succeeds here and is never decoded (see the safety
  // rule on decodeEscapedInput above).
  let attempt = tryParseXml(input);
  if (!attempt.doc) {
    // Second attempt: the input failed as XML — it may be an escaped
    // (JSON-style) or quote-wrapped payload. Decode and retry once.
    const decoded = decodeEscapedInput(bomStripped);
    if (decoded !== null) {
      const retry = tryParseXml(unescapeLiteralNewlines(decoded));
      if (retry.doc) {
        attempt = retry;
        warnings.push(
          'Input arrived as an escaped (JSON-style) string — it was decoded before parsing.',
        );
      }
    }
  }
  if (!attempt.doc) {
    return { model: null, error: attempt.error || 'Invalid XML.', warnings, unsupported: [] };
  }
  const doc: Document = attempt.doc;

  const root = doc.documentElement;
  // Format detection by root element (local name — namespace safe).
  const rootTag = localName(root);
  if (rootTag === 'DieCutLabel' || rootTag === 'ContinuousLabel') {
    return parseLegacyLabel(doc, warnings);
  }
  if (rootTag !== 'DesktopLabel' && !firstByTag(doc, 'DYMOLabel')) {
    return {
      model: null,
      error:
        `Unsupported label format: the root element is <${rootTag}>. Supported formats: ` +
        'DYMO Connect DesktopLabel XML (root <DesktopLabel> containing <DYMOLabel>) and legacy DYMO Label Software XML ' +
        '(root <DieCutLabel> or <ContinuousLabel> with <ObjectInfo> entries). ' +
        'ZPL (starting with ^XA) is a Zebra format and will not parse here.',
      warnings,
      unsupported: [],
    };
  }

  // Collect unsupported elements (deduplicated, by local name)
  for (const el of allByTag(doc, '*')) {
    const ln = localName(el);
    if (!SUPPORTED.has(ln)) unsupportedSet.add(ln);
  }
  const unsupported = Array.from(unsupportedSet).sort();
  if (unsupported.length > 0) {
    warnings.push(
      `${unsupported.length} element type(s) are not fully rendered by this viewer: ${unsupported.join(', ')}. Their data is preserved in the source XML panel only.`,
    );
  }

  // Label metadata
  const name = textOf(doc.documentElement, 'LabelName') || 'Untitled Label';
  const orientationRaw = textOf(doc.documentElement, 'Orientation');
  const orientation = /portrait/i.test(orientationRaw) ? 'Portrait' : 'Landscape';

  // Label size, in order of trust:
  //  1. DYMORect (explicit geometry).
  //  2. The stock table via the label name — warned.
  //  3. The built-in Small default — warned.
  //
  // IMPORTANT (verified against a real DYMO v4 export): DYMORect is NOT
  // the physical label size — it is the printable-area rectangle INSET
  // from the label's top-left corner. The real file's DYMORect is point
  // (0.09, 0.0567) with size 1.9767 × 0.9033 in, and the objects are
  // positioned in label coordinates that extend to ≈2.07 × 0.96 in.
  // So the physical label size is offset + size:
  //   width  = DYMOPoint.X + Size.Width   (0.09 + 1.9767 = 2.0667 in)
  //   height = DYMOPoint.Y + Size.Height  (0.0567 + 0.9033 = 0.9600 in)
  // Treating Size alone as the label size (the previous behaviour) made
  // every real label render ~0.09 in too narrow and ~0.06 in too short.
  // Exports written with the point at (0,0) are unaffected: offset + size
  // equals size there. If a file omits DYMOPoint, the offset is 0.
  let widthIn = DEFAULT_LABEL_W;
  let heightIn = DEFAULT_LABEL_H;
  let sizeSource: SizeSource = 'default';
  let usedDefaultSize = true;
  const rect = firstByTag(doc, 'DYMORect');
  if (rect) {
    const size = firstByTag(rect, 'Size');
    const point = firstByTag(rect, 'DYMOPoint');
    if (size) {
      const w = num(textOf(size, 'Width'), NaN);
      const h = num(textOf(size, 'Height'), NaN);
      const ox = point ? num(textOf(point, 'X'), 0) : 0;
      const oy = point ? num(textOf(point, 'Y'), 0) : 0;
      if (Number.isFinite(w) && w > 0) { widthIn = ox + w; usedDefaultSize = false; }
      if (Number.isFinite(h) && h > 0) { heightIn = oy + h; usedDefaultSize = false; }
    }
  }
  if (!usedDefaultSize) {
    sizeSource = 'geometry';
  } else {
    const stock = findStock(name);
    if (stock) {
      widthIn = stock.widthIn;
      heightIn = stock.heightIn;
      sizeSource = 'stock';
      warnings.push(
        `Label size from stock table: label name matches paper stock "${stock.stock}" (${stock.name}) at ${widthIn} × ${heightIn} in — ` +
          'the file carries no DYMORect geometry, so this size is from the stock table (a published-size lookup), not from the file.',
      );
    } else {
      warnings.push(
        `No label size (DYMORect / Size) found in the XML — defaulting to a Small label at ${DEFAULT_LABEL_W} × ${DEFAULT_LABEL_H} in. Check proportions if your label stock differs.`,
      );
    }
  }

  // Objects: prefer LabelObjects scope, fall back to whole document
  const labelObjectsEl = firstByTag(doc, 'LabelObjects');
  const scope: Element = labelObjectsEl || doc.documentElement;

  const objects: LabelObjectModel[] = [];
  let tIdx = 0;
  let bIdx = 0;
  let sIdx = 0;
  let iIdx = 0;
  let uIdx = 0;

  // Walk in document order so text/barcode stacking matches the source.
  // Any *Object element that is not one of the known renderable kinds
  // degrades to a labelled placeholder rather than being dropped.
  const allInScope = allByTag(scope, '*');
  for (const el of allInScope) {
    const tag = localName(el);
    if (tag === 'TextObject') {
      objects.push(parseTextObject(el, tIdx++));
    } else if (tag === 'AddressObject') {
      objects.push(parseTextObject(el, tIdx++, 'AddressObject'));
    } else if (tag === 'CounterObject' || tag === 'DateTimeObject') {
      objects.push(parseComposedTextObject(el, tIdx++, tag));
    } else if (tag === 'BarcodeObject') {
      const rawFormat = textOf(el, 'BarcodeFormat') || textOf(el, 'BarcodeType') || 'Code128Auto';
      if (is2DBarcodeFormat(rawFormat)) {
        const nm = textOf(el, 'Name') || `BarcodeObject${bIdx}`;
        objects.push(twoDPlaceholder('unsupported', uIdx++, nm, rawFormat, extractBarcodeValue(el), parseLayout(el), parseRotation(textOf(el, 'Rotation')), boolText(textOf(el, 'IsMirrored'))));
        warnings.push(twoDWarning(nm, rawFormat));
        bIdx++;
      } else {
        objects.push(parseBarcodeObject(el, bIdx++));
      }
    } else if (tag === 'ShapeObject') {
      objects.push(parseShapeObject(el, sIdx++));
    } else if (tag === 'ImageObject') {
      objects.push(parseImageObject(el, iIdx++, warnings));
    } else if (tag.endsWith('Object')) {
      const nm = textOf(el, 'Name') || `${tag}${uIdx}`;
      objects.push({
        id: `unsupported-${uIdx++}`,
        kind: 'unsupported',
        name: nm,
        objectType: tag,
        layout: parseLayout(el),
        rotation: parseRotation(textOf(el, 'Rotation')),
        mirrored: boolText(textOf(el, 'IsMirrored')),
      });
      warnings.push(
        `Object "${nm}" is a ${tag}, which this viewer does not render — it is shown as a placeholder at its position.`,
      );
    }
  }

  // Fallback if the walker scope missed direct children
  if (objects.length === 0) {
    for (const el of allByTag(doc, 'TextObject')) objects.push(parseTextObject(el, tIdx++));
    for (const el of allByTag(doc, 'BarcodeObject')) objects.push(parseBarcodeObject(el, bIdx++));
  }

  if (objects.length === 0) {
    return {
      model: null,
      error:
        'No TextObject or BarcodeObject elements were found. Supported formats: DYMO Connect DesktopLabel XML ' +
        '(<DesktopLabel> containing <DYMOLabel>) and legacy DYMO Label Software XML (<DieCutLabel> or <ContinuousLabel> ' +
        'with <ObjectInfo> entries). ZPL (starting with ^XA) is a Zebra format and will not parse here.',
      warnings,
      unsupported,
    };
  }

  addBarcodeWarnings(objects, warnings);

  return {
    model: { name, orientation, format: 'connect', sizeSource, widthIn, heightIn, objects },
    error: null,
    warnings,
    unsupported,
  };
}

// ---------------------------------------------------------------------------
// Serialization: regenerate DesktopLabel XML from the (possibly edited) model
//
// NOTE: output is always DYMO Connect DesktopLabel format. A legacy
// (DieCutLabel) input is therefore CONVERTED on Copy / Download — the UI
// says so when the loaded model came from a legacy file. Shape, image
// and placeholder objects have no Connect representation here and are
// omitted (noted as an XML comment).
// ---------------------------------------------------------------------------

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fontInfoXml(font: FontInfo, indent: string): string {
  return [
    `${indent}<FontInfo>`,
    `${indent}  <FontName>${escapeXml(font.fontName)}</FontName>`,
    `${indent}  <FontSize>${font.fontSize}</FontSize>`,
    `${indent}  <IsBold>${font.isBold ? 'True' : 'False'}</IsBold>`,
    `${indent}  <IsItalic>${font.isItalic ? 'True' : 'False'}</IsItalic>`,
    `${indent}  <IsUnderline>${font.isUnderline ? 'True' : 'False'}</IsUnderline>`,
    `${indent}</FontInfo>`,
  ].join('\n');
}

function layoutXml(layout: ObjectLayout, indent: string): string {
  return [
    `${indent}<ObjectLayout>`,
    `${indent}  <DYMOPoint>`,
    `${indent}    <X>${layout.x}</X>`,
    `${indent}    <Y>${layout.y}</Y>`,
    `${indent}  </DYMOPoint>`,
    `${indent}  <Size>`,
    `${indent}    <Width>${layout.width}</Width>`,
    `${indent}    <Height>${layout.height}</Height>`,
    `${indent}  </Size>`,
    `${indent}</ObjectLayout>`,
  ].join('\n');
}

export function modelToXml(model: LabelModel): string {
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="utf-8"?>');
  parts.push('<DesktopLabel Version="1">');
  parts.push('  <DYMOLabel Version="3">');
  parts.push('    <Description>DYMO Label</Description>');
  parts.push(`    <Orientation>${model.orientation}</Orientation>`);
  parts.push(`    <LabelName>${escapeXml(model.name)}</LabelName>`);
  parts.push('    <BorderStyle>SolidLine</BorderStyle>');
  // DYMORect point is (0,0) here, so under the parser's offset+size rule
  // this serializes back to exactly model.widthIn × model.heightIn.
  parts.push('    <DYMORect>');
  parts.push('      <DYMOPoint><X>0</X><Y>0</Y></DYMOPoint>');
  parts.push(`      <Size><Width>${model.widthIn}</Width><Height>${model.heightIn}</Height></Size>`);
  parts.push('    </DYMORect>');
  parts.push('    <DynamicLayoutManager>');
  parts.push('      <RotationBehavior>ClearObjects</RotationBehavior>');
  parts.push('      <LabelObjects>');

  for (const obj of model.objects) {
    if (obj.kind === 'unsupported' || obj.kind === 'shape' || obj.kind === 'image') {
      // No Connect representation in this serializer — omitted from the
      // exported XML, with a comment saying so.
      const typeName = obj.kind === 'shape' ? 'ShapeObject' : obj.kind === 'image' ? 'ImageObject' : obj.objectType;
      parts.push(`        <!-- ${escapeXml(typeName)} "${escapeXml(obj.name)}" is not exported by this viewer and is omitted from this export -->`);
      continue;
    }
    if (obj.kind === 'text') {
      parts.push('        <TextObject>');
      parts.push(`          <Name>${escapeXml(obj.name)}</Name>`);
      parts.push(`          <Rotation>Rotation${obj.rotation}</Rotation>`);
      if (obj.mirrored) parts.push('          <IsMirrored>True</IsMirrored>');
      parts.push(`          <IsVertical>${obj.isVertical ? 'True' : 'False'}</IsVertical>`);
      parts.push(`          <HorizontalAlignment>${escapeXml(obj.horizontalAlignment)}</HorizontalAlignment>`);
      parts.push(`          <VerticalAlignment>${escapeXml(obj.verticalAlignment)}</VerticalAlignment>`);
      parts.push('          <FormattedText>');
      for (const line of obj.lines) {
        parts.push('            <LineTextSpan>');
        parts.push('              <TextSpan>');
        parts.push(`                <Text>${escapeXml(line.text)}</Text>`);
        parts.push(fontInfoXml(line.font, '                '));
        parts.push('              </TextSpan>');
        parts.push('            </LineTextSpan>');
      }
      parts.push('          </FormattedText>');
      parts.push(layoutXml(obj.layout, '          '));
      parts.push('        </TextObject>');
    } else {
      parts.push('        <BarcodeObject>');
      parts.push(`          <Name>${escapeXml(obj.name)}</Name>`);
      parts.push(`          <Rotation>Rotation${obj.rotation}</Rotation>`);
      if (obj.mirrored) parts.push('          <IsMirrored>True</IsMirrored>');
      parts.push(`          <BarcodeFormat>${escapeXml(obj.barcodeFormatRaw)}</BarcodeFormat>`);
      parts.push('          <Data>');
      parts.push('            <MultiDataString>');
      parts.push(`              <DataString>${escapeXml(obj.value)}</DataString>`);
      parts.push('            </MultiDataString>');
      parts.push('          </Data>');
      parts.push(`          <HorizontalAlignment>${escapeXml(obj.horizontalAlignment)}</HorizontalAlignment>`);
      parts.push(`          <VerticalAlignment>${escapeXml(obj.verticalAlignment)}</VerticalAlignment>`);
      if (obj.sizeMode) parts.push(`          <Size>${escapeXml(obj.sizeMode)}</Size>`);
      parts.push(`          <TextPosition>${escapeXml(obj.textPosition)}</TextPosition>`);
      parts.push(fontInfoXml(obj.font, '          '));
      parts.push(layoutXml(obj.layout, '          '));
      parts.push('        </BarcodeObject>');
    }
  }

  parts.push('      </LabelObjects>');
  parts.push('    </DynamicLayoutManager>');
  parts.push('  </DYMOLabel>');
  parts.push('</DesktopLabel>');
  return parts.join('\n');
}
