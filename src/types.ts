export interface FontInfo {
  fontName: string;
  fontSize: number;
  isBold: boolean;
  isItalic: boolean;
  isUnderline: boolean;
}

export interface ObjectLayout {
  /** Inches */
  x: number;
  /** Inches */
  y: number;
  /** Inches */
  width: number;
  /** Inches */
  height: number;
}

export type LabelOrientation = 'Landscape' | 'Portrait';

export type Rotation = 0 | 90 | 180 | 270;

export interface TextLine {
  text: string;
  font: FontInfo;
}

export interface TextObjectModel {
  id: string;
  kind: 'text';
  name: string;
  lines: TextLine[];
  layout: ObjectLayout;
  rotation: Rotation;
  /** DYMO <IsMirrored>: content is flipped horizontally when printed. */
  mirrored: boolean;
  horizontalAlignment: string;
  verticalAlignment: string;
  textAlignment: string;
  /** DYMO <IsVertical>: text runs vertically (per-character columns). */
  isVertical: boolean;
  /**
   * Original DYMO element this text came from, when it was not a plain
   * TextObject — e.g. 'AddressObject', 'CounterObject', 'DateTimeObject'
   * (counters and date/time objects are composed and rendered as text).
   */
  sourceType?: string;
}

export interface BarcodeObjectModel {
  id: string;
  kind: 'barcode';
  name: string;
  /** Raw DYMO format, e.g. Code128Auto */
  barcodeFormatRaw: string;
  /** JsBarcode format, e.g. CODE128 */
  barcodeFormat: string;
  value: string;
  layout: ObjectLayout;
  rotation: Rotation;
  mirrored: boolean;
  horizontalAlignment: string;
  verticalAlignment: string;
  textPosition: string; // Top | Bottom | None
  font: FontInfo;
  sizeMode?: string; // e.g. AutoFit
}

/** A DYMO ShapeObject — really rendered (rect / ellipse / rules). */
export interface ShapeObjectModel {
  id: string;
  kind: 'shape';
  name: string;
  /** Normalised: Rectangle | Ellipse | HorizontalLine | VerticalLine */
  shapeType: string;
  /** CSS colour for the fill, or undefined for no fill */
  fill?: string;
  /** CSS colour for the outline/rule, or undefined */
  stroke?: string;
  layout: ObjectLayout;
  rotation: Rotation;
  mirrored: boolean;
}

/** A DYMO ImageObject. dataUrl is null when the file references an
 * external image instead of embedding one — rendered as a placeholder. */
export interface ImageObjectModel {
  id: string;
  kind: 'image';
  name: string;
  dataUrl: string | null;
  layout: ObjectLayout;
  rotation: Rotation;
  mirrored: boolean;
}

/**
 * Object kinds this viewer cannot render (CircularTextObject, 2D
 * barcode placeholders for QRCode/DataMatrix, unknown kinds, ...).
 * They are kept in the model so the preview can show an honest labelled
 * placeholder at the object's real position instead of silently
 * dropping it or failing the parse.
 */
export interface UnsupportedObjectModel {
  id: string;
  kind: 'unsupported';
  name: string;
  /** Original DYMO element name, e.g. ShapeObject */
  objectType: string;
  /** Short human label for the placeholder, e.g. "QRCode barcode" */
  detail?: string;
  /** Underlying data value worth showing (e.g. the QR payload text) */
  dataValue?: string;
  layout: ObjectLayout;
  rotation: Rotation;
  mirrored: boolean;
}

export type LabelObjectModel =
  | TextObjectModel
  | BarcodeObjectModel
  | ShapeObjectModel
  | ImageObjectModel
  | UnsupportedObjectModel;

/**
 * Which DYMO file family a label came from:
 *  - 'connect' — DYMO Connect / DesktopLabel XML
 *    (<DesktopLabel> containing <DYMOLabel>, geometry in inches).
 *  - 'legacy'  — legacy DYMO Label Software XML
 *    (<DieCutLabel> / <ContinuousLabel> with <ObjectInfo> entries,
 *    geometry in the root Units, usually twips).
 */
export type LabelFormat = 'connect' | 'legacy';

/**
 * Where the label's physical size came from, most trustworthy first:
 *  - 'geometry' — explicit geometry in the file (DYMORect / DrawCommands)
 *  - 'stock'    — the stock table in src/stocks.ts (always warned)
 *  - 'inferred' — object extents (+ margin) (always warned)
 *  - 'default'  — the built-in Small default (always warned)
 */
export type SizeSource = 'geometry' | 'stock' | 'inferred' | 'default';

export interface LabelModel {
  name: string;
  orientation: LabelOrientation;
  /** Source file family (see LabelFormat). */
  format: LabelFormat;
  /** How widthIn/heightIn were derived (see SizeSource). */
  sizeSource: SizeSource;
  /** Inches */
  widthIn: number;
  /** Inches */
  heightIn: number;
  objects: LabelObjectModel[];
}

export interface ParseResult {
  model: LabelModel | null;
  error: string | null;
  warnings: string[];
  unsupported: string[];
}
