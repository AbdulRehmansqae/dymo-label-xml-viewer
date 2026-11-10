/**
 * DYMO label stock table — stock number → physical size in inches.
 *
 * Used ONLY as a fallback size source, when a label file carries no
 * explicit geometry (no DYMORect in Connect files, no DrawCommands
 * extents in legacy files). Every use is surfaced to the user with a
 * "size from stock table" warning — a stock-derived size is a lookup,
 * not a measurement from the file.
 *
 * Only sizes published by DYMO for the named stock are included, in the
 * form widthIn × heightIn as the label sits in its natural (named)
 * orientation. Stocks whose published size could not be stated
 * confidently are deliberately OMITTED — add them here as they are
 * verified; this table is meant to be extended.
 */
export interface StockSize {
  /** DYMO stock / SKU number as printed on the box, e.g. "30334" */
  stock: string;
  /** Published product name for the stock */
  name: string;
  /** Inches */
  widthIn: number;
  /** Inches */
  heightIn: number;
}

export const STOCK_SIZES: Record<string, StockSize> = {
  // LabelWriter die-cut stocks
  '30252': { stock: '30252', name: 'Address 1-1/8" × 3-1/2"', widthIn: 3.5, heightIn: 1.125 },
  '30256': { stock: '30256', name: 'Shipping 2-5/16" × 4"', widthIn: 4, heightIn: 2.3125 },
  '30321': { stock: '30321', name: 'Large Address 1-7/16" × 3-1/2"', widthIn: 3.5, heightIn: 1.4375 },
  '30323': { stock: '30323', name: 'Shipping 2-1/8" × 4"', widthIn: 4, heightIn: 2.125 },
  '30330': { stock: '30330', name: 'Return Address 3/4" × 2"', widthIn: 2, heightIn: 0.75 },
  '30332': { stock: '30332', name: 'Multi-Purpose 1-1/4" × 1-1/4"', widthIn: 1.25, heightIn: 1.25 },
  '30334': { stock: '30334', name: 'Multi-Purpose 2-1/4" × 1-1/4"', widthIn: 2.25, heightIn: 1.25 },
  '30336': { stock: '30336', name: 'Multi-Purpose 1-1/8" × 2-1/8"', widthIn: 2.125, heightIn: 1.125 },
  '30857': { stock: '30857', name: 'Name Badge 2-1/4" × 4"', widthIn: 4, heightIn: 2.25 },
  // European (990-series) stock: 36 × 89 mm ≈ 1.4" × 3.5"
  '99012': { stock: '99012', name: 'Large Address 36 × 89 mm', widthIn: 3.5, heightIn: 1.4 },
  // LabelWriter 4XL shipping stock, 4" × 6" (portrait feed)
  '1744907': { stock: '1744907', name: 'Shipping 4" × 6"', widthIn: 4, heightIn: 6 },
  // Small specimen/bottle stock behind the user's real Small1738541
  // export. Size established from that file's own geometry (DYMORect
  // printable extents + object bounds): 2.0667 × 0.96 in — NOT a
  // published DYMO catalogue size.
  '1738541': { stock: '1738541', name: 'Small (size from a real export)', widthIn: 2.0667, heightIn: 0.96 },
};

/**
 * Find a known stock referenced anywhere in `text` (a PaperName, Id or
 * LabelName such as "30334 Multi-Purpose" or "Small30334"). Matches on
 * digit boundaries so a stock number embedded in a longer number does
 * not match. Longest stock numbers win.
 */
export function findStock(text: string): StockSize | null {
  if (!text) return null;
  const keys = Object.keys(STOCK_SIZES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const re = new RegExp(`(?<!\\d)${key}(?!\\d)`);
    if (re.test(text)) return STOCK_SIZES[key];
  }
  return null;
}
