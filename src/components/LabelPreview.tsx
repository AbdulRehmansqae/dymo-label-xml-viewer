import { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';
import type { LabelModel, LabelObjectModel, ShapeObjectModel } from '../types';
import {
  rotatedFootprint,
  textLineAvailablePx,
  estimateTextWidthPx,
  fittedFontSizePx,
} from '../geometry';

/**
 * Measure a single line's rendered width with canvas 2D (exact for the
 * requested font), falling back to a conservative estimate when canvas
 * is unavailable. Used to shrink-to-fit ONE non-wrapping line — see
 * geometry.ts `textLineAvailablePx` / `fittedFontSizePx`.
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function measureLineWidthPx(text: string, fontCss: string, baseFontSizePx: number): number {
  try {
    if (measureCtx === undefined) {
      measureCtx = document.createElement('canvas').getContext('2d');
    }
    if (measureCtx) {
      measureCtx.font = fontCss;
      const w = measureCtx.measureText(text).width;
      if (Number.isFinite(w) && w > 0) return w;
    }
  } catch {
    /* fall through to estimate */
  }
  return estimateTextWidthPx(text, baseFontSizePx);
}

export const BASE_PX_PER_IN = 96;

interface Props {
  model: LabelModel;
  /** Effective px-per-inch after zoom / fit / 1:1 is applied */
  pxPerIn: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, xIn: number, yIn: number) => void;
  /** Ref forwarded to the white label node for PNG/PDF export */
  labelRef: React.RefObject<HTMLDivElement>;
}

/**
 * One barcode, drawn once, at the object's UNROTATED size.
 *
 * The previous version's bug was DISTORTION: after JsBarcode drew, the
 * code force-set the SVG width/height to the object box with
 * preserveAspectRatio="none" and no viewBox, non-uniformly stretching
 * the bars (and, for a rotated object, stretching them in the wrong
 * axis entirely). Now the natural JsBarcode size becomes the viewBox
 * and the SVG is scaled into the object box properly: for DYMO
 * Size=AutoFit the barcode FITS INSIDE the box preserving its aspect
 * ratio ('meet'), otherwise it fills the box exactly ('none' — DYMO
 * fixed-size behaviour).
 *
 * The SVG is also cleared before each draw as cheap insurance for a
 * single rendering. (Verified: JsBarcode 3.12.3's own SVG renderer
 * already clears the target in prepareSVG(), so repeat draws do not
 * stack in this codebase — the distorted "second barcode" in the
 * user's screenshot came from the separate live-viewer build.)
 * Rotation is NOT handled here: the caller renders this at the unrotated
 * content size inside a rotated wrapper (see LabelPreview below).
 */
function BarcodeSvg({ value, format, widthPx, heightPx, font, textPosition, sizeMode }: {
  value: string;
  format: string;
  widthPx: number;
  heightPx: number;
  font: { fontName: string; fontSize: number };
  textPosition: string;
  sizeMode?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    // Start from an empty SVG so exactly one draw exists (see note above).
    svg.replaceChildren();
    svg.removeAttribute('viewBox');
    if (!value) return;

    const displayValue = textPosition !== 'None';
    // Caption height in generation units: XML points -> px at 96 dpi.
    const captionPx = displayValue ? Math.max(8, (font.fontSize || 8) * (96 / 72)) : 0;
    try {
      JsBarcode(svg, value, {
        format: format || 'CODE128',
        width: 2,
        height: Math.max(10, heightPx - captionPx - 2),
        displayValue,
        font: font.fontName || 'Arial',
        fontSize: captionPx,
        margin: 0,
        background: 'transparent',
        lineColor: '#000000',
      });
      // Scale the natural barcode into the content box via a viewBox.
      const natW = parseFloat(svg.getAttribute('width') || '');
      const natH = parseFloat(svg.getAttribute('height') || '');
      if (Number.isFinite(natW) && natW > 0 && Number.isFinite(natH) && natH > 0) {
        svg.setAttribute('viewBox', `0 0 ${natW} ${natH}`);
        svg.setAttribute(
          'preserveAspectRatio',
          sizeMode === 'AutoFit' ? 'xMidYMid meet' : 'none',
        );
      }
      svg.setAttribute('width', String(widthPx));
      svg.setAttribute('height', String(heightPx));
    } catch {
      // Invalid data for the chosen symbology — show a clear placeholder
      // instead of fake stripes.
      svg.replaceChildren();
      svg.setAttribute('viewBox', `0 0 ${Math.max(1, widthPx)} ${Math.max(1, heightPx)}`);
      svg.setAttribute('width', String(widthPx));
      svg.setAttribute('height', String(heightPx));
      svg.innerHTML =
        '<text x="4" y="18" font-size="11" fill="#b00020">Invalid barcode data</text>';
    }
  }, [value, format, widthPx, heightPx, font, textPosition, sizeMode]);

  return <svg ref={ref} width={widthPx} height={heightPx} aria-label={`Barcode ${value}`} />;
}

/** A DYMO ShapeObject drawn as real SVG geometry at its bounds. */
function ShapeSvg({ shape, widthPx, heightPx }: { shape: ShapeObjectModel; widthPx: number; heightPx: number }) {
  const fill = shape.fill ?? 'none';
  const stroke = shape.stroke ?? '#000000';
  const w = Math.max(1, widthPx);
  const h = Math.max(1, heightPx);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label={`${shape.shapeType} shape`}>
      {shape.shapeType === 'Ellipse' ? (
        <ellipse cx={w / 2} cy={h / 2} rx={Math.max(0.5, w / 2 - 1)} ry={Math.max(0.5, h / 2 - 1)} fill={fill} stroke={stroke} strokeWidth={2} />
      ) : shape.shapeType === 'HorizontalLine' ? (
        <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke={stroke} strokeWidth={3} />
      ) : shape.shapeType === 'VerticalLine' ? (
        <line x1={w / 2} y1={0} x2={w / 2} y2={h} stroke={stroke} strokeWidth={3} />
      ) : (
        <rect x={1} y={1} width={Math.max(0.5, w - 2)} height={Math.max(0.5, h - 2)} fill={fill} stroke={stroke} strokeWidth={2} />
      )}
    </svg>
  );
}

export default function LabelPreview({ model, pxPerIn, selectedId, onSelect, onMove, labelRef }: Props) {
  const dragRef = useRef<{
    id: string;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
  } | null>(null);

  const labelW = model.widthIn * pxPerIn;
  const labelH = model.heightIn * pxPerIn;

  function startDrag(e: React.PointerEvent, obj: LabelObjectModel) {
    e.preventDefault();
    e.stopPropagation();
    onSelect(obj.id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      id: obj.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: obj.layout.x,
      startY: obj.layout.y,
    };
  }

  function onDragMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dxIn = (e.clientX - d.startClientX) / pxPerIn;
    const dyIn = (e.clientY - d.startClientY) / pxPerIn;
    const nextX = Math.max(0, Math.round((d.startX + dxIn) * 10000) / 10000);
    const nextY = Math.max(0, Math.round((d.startY + dyIn) * 10000) / 10000);
    onMove(d.id, nextX, nextY);
  }

  function endDrag() {
    dragRef.current = null;
  }

  return (
    <div
      ref={labelRef}
      className="label-sheet"
      style={{ width: labelW, height: labelH }}
      onPointerDown={() => onSelect(null)}
      role="img"
      aria-label={`Label preview ${model.name}`}
    >
      {model.objects.map((obj) => {
        // ROTATION MODEL (see src/geometry.ts):
        //  - the OUTER box sits at the layout point with the ROTATED
        //    FOOTPRINT size (width/height swapped for 90°/270°) — this is
        //    the rectangle the object occupies on the label, it carries
        //    the selection outline, and it is what drag moves.
        //  - the INNER content is rendered at the UNROTATED layout size,
        //    centred in the outer box, and rotated around the centre.
        // The old code rotated the outer box itself, so a 270° barcode
        // kept a portrait layout box but painted a landscape visual that
        // overflowed the label and clipped at the edges.
        const fp = rotatedFootprint(obj.layout, obj.rotation);
        const outerW = fp.width * pxPerIn;
        const outerH = fp.height * pxPerIn;
        const contentW = obj.layout.width * pxPerIn;
        const contentH = obj.layout.height * pxPerIn;
        const left = fp.x * pxPerIn;
        const top = fp.y * pxPerIn;
        const selected = obj.id === selectedId;
        // Font size: XML points -> CSS px at 96dpi is pt * 96/72, then
        // scaled by the current zoom ratio (pxPerIn / BASE).
        const scale = pxPerIn / BASE_PX_PER_IN;

        return (
          <div
            key={obj.id}
            className={`label-object${selected ? ' selected' : ''}`}
            style={{ left, top, width: outerW, height: outerH }}
            onPointerDown={(e) => startDrag(e, obj)}
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            title={`${obj.name} — drag to move`}
          >
            <div
              className="object-content"
              style={{
                width: contentW,
                height: contentH,
                left: (outerW - contentW) / 2,
                top: (outerH - contentH) / 2,
                // Rotation around the shared centre, plus IsMirrored
                // (DYMO flips the object horizontally when printing).
                transform:
                  [obj.rotation ? `rotate(${obj.rotation}deg)` : '', obj.mirrored ? 'scaleX(-1)' : '']
                    .filter(Boolean)
                    .join(' ') || undefined,
              }}
            >
              {obj.kind === 'text' ? (
                <div
                  className="text-object"
                  style={{
                    // A real DYMO TextObject box can be much taller than its
                    // text (e.g. 0.889 in tall for 3 lines at 5 pt, extending
                    // over the barcode zone). Render the lines at their
                    // natural font size, anchored to the TOP of the box —
                    // never stretched or distributed to fill the box.
                    height: 'auto',
                    maxHeight: '100%',
                    alignSelf: 'flex-start',
                    textAlign:
                      obj.textAlignment.toLowerCase() === 'center'
                        ? 'center'
                        : obj.textAlignment.toLowerCase() === 'right'
                          ? 'right'
                          : 'left',
                    justifyContent:
                      obj.verticalAlignment.toLowerCase() === 'middle'
                        ? 'center'
                        : obj.verticalAlignment.toLowerCase() === 'bottom'
                          ? 'flex-end'
                          : 'flex-start',
                    // <IsVertical>: DYMO's vertical-text mode — lines run
                    // top-to-bottom instead of left-to-right.
                    flexDirection: obj.isVertical ? 'row' : 'column',
                  }}
                >
                  {obj.lines.map((line, i) => {
                    // ONE line per LineTextSpan — never re-wrapped. For
                    // rotated (90°/270°) objects the line runs along the
                    // object's long axis; a line longer than that axis is
                    // shrunk to fit instead of wrapping mid-word into a
                    // second column (the Small30334 live-viewer bug).
                    const basePx = Math.max(4, line.font.fontSize * (96 / 72) * scale);
                    const fontFamily = `'${line.font.fontName}', 'Segoe UI', Arial, sans-serif`;
                    const availablePx = obj.isVertical
                      ? contentH
                      : textLineAvailablePx(contentW, contentH, obj.rotation);
                    const measuredPx = line.text
                      ? measureLineWidthPx(
                          line.text,
                          `${line.font.isItalic ? 'italic ' : ''}${line.font.isBold ? '700' : '400'} ${basePx}px ${fontFamily}`,
                          basePx,
                        )
                      : 0;
                    const fittedPx = fittedFontSizePx(basePx, measuredPx, availablePx);
                    return (
                      <div
                        key={i}
                        style={{
                          fontFamily,
                          fontSize: fittedPx,
                          fontWeight: line.font.isBold ? 700 : 400,
                          fontStyle: line.font.isItalic ? 'italic' : 'normal',
                          textDecoration: line.font.isUnderline ? 'underline' : 'none',
                          lineHeight: 1.25,
                          // Hard no-wrap: one span = one line, full stop.
                          whiteSpace: 'nowrap',
                          wordBreak: 'normal',
                          overflowWrap: 'normal',
                          width: 'max-content',
                          maxWidth: 'none',
                          writingMode: obj.isVertical ? 'vertical-rl' : undefined,
                          // Keep each line at its natural height — no flex
                          // stretching inside the (often much taller) box.
                          flex: '0 0 auto',
                        }}
                      >
                        {line.text || '\u00A0'}
                      </div>
                    );
                  })}
                </div>
              ) : obj.kind === 'barcode' ? (
                <BarcodeSvg
                  value={obj.value}
                  format={obj.barcodeFormat}
                  widthPx={contentW}
                  heightPx={contentH}
                  font={obj.font}
                  textPosition={obj.textPosition}
                  sizeMode={obj.sizeMode}
                />
              ) : obj.kind === 'shape' ? (
                <ShapeSvg shape={obj} widthPx={contentW} heightPx={contentH} />
              ) : obj.kind === 'image' ? (
                obj.dataUrl ? (
                  <img className="embedded-image" src={obj.dataUrl} alt={obj.name} style={{ width: contentW, height: contentH }} />
                ) : (
                  <div className="unsupported-object" style={{ width: contentW, height: contentH }}>
                    <span>ImageObject — image not embedded in the file</span>
                  </div>
                )
              ) : (
                // Unrenderable object kind (CircularTextObject, 2D barcode
                // placeholders, unknown kinds): an honest labelled
                // placeholder at the object's real bounds — never fake
                // content, never a dropped object.
                <div className="unsupported-object" style={{ width: contentW, height: contentH }}>
                  <span>{obj.detail || `${obj.objectType} — not rendered`}</span>
                  {obj.dataValue && <span className="unsupported-data">{obj.dataValue}</span>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
