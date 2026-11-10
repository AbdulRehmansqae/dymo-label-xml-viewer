import type { ObjectLayout, Rotation } from './types';

/**
 * Rotation geometry for DYMO objects.
 *
 * An object's ObjectLayout (DYMOPoint + Size) describes the object in its
 * UNROTATED orientation: `width` runs along the object's reading
 * direction, `height` across it. When the object is rotated 90° or 270°,
 * the rectangle it actually occupies on the label — its footprint — has
 * the two dimensions swapped. (For 0°/180° the footprint is unchanged.)
 *
 * The renderer therefore:
 *   1. positions an outer box at the layout point with the FOOTPRINT size,
 *   2. renders the content at the unrotated layout size, centred in that
 *      box, and rotates only the content around the shared centre.
 * The rotated content then exactly fills the footprint — it can never
 * spill outside the object's own box or off the label, which is what the
 * old "rotate the whole layout-sized box" rendering did.
 */
export interface RectIn {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isQuarterTurn(rotation: Rotation): boolean {
  return rotation === 90 || rotation === 270;
}

/** Size the object occupies on the label after rotation (inches). */
export function rotatedFootprint(layout: ObjectLayout, rotation: Rotation): RectIn {
  if (isQuarterTurn(rotation)) {
    return { x: layout.x, y: layout.y, width: layout.height, height: layout.width };
  }
  return { x: layout.x, y: layout.y, width: layout.width, height: layout.height };
}

/** Size at which content is drawn BEFORE the rotation is applied. */
export function contentSize(layout: ObjectLayout): { width: number; height: number } {
  return { width: layout.width, height: layout.height };
}

/**
 * Single-line text fitting.
 *
 * A DYMO LineTextSpan is ONE line. It must never be re-wrapped by the
 * renderer — the live viewer broke a rotated label by letting a long
 * line wrap mid-word into a second column ("Patient Name: TEST …
 * PATIENTONE" split across two columns). The rule instead:
 *
 *  - the line renders on a single, non-wrapping line;
 *  - for 90°/270° objects the line runs along the object's LONG axis
 *    (after the quarter turn, the reading direction maps onto the
 *    longer of the content box's two dimensions);
 *  - if the line is wider than that axis at its XML font size, the
 *    line's font is shrunk just enough to fit — never wrapped.
 */

/** Length (px) available to a single text line along its reading axis. */
export function textLineAvailablePx(contentWpx: number, contentHpx: number, rotation: Rotation): number {
  return isQuarterTurn(rotation) ? Math.max(contentWpx, contentHpx) : contentWpx;
}

/**
 * Conservative fallback text-width estimate (px) used when canvas
 * measurement is unavailable (e.g. during tests). Latin UI fonts such
 * as Segoe UI / Arial average roughly half an em per character.
 */
export function estimateTextWidthPx(text: string, fontSizePx: number, avgCharRatio = 0.5): number {
  return text.length * fontSizePx * avgCharRatio;
}

/**
 * Font size (px) at which `text` fits `availablePx`: the base size when
 * it already fits, otherwise scaled down proportionally. Never scales
 * up, and never returns below 1px for non-empty input.
 */
export function fittedFontSizePx(
  baseFontSizePx: number,
  measuredWidthPx: number,
  availablePx: number,
): number {
  if (!(baseFontSizePx > 0) || !(measuredWidthPx > 0) || !(availablePx > 0)) return baseFontSizePx;
  if (measuredWidthPx <= availablePx) return baseFontSizePx;
  return Math.max(1, baseFontSizePx * (availablePx / measuredWidthPx));
}
