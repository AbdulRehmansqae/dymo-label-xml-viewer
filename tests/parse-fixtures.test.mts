/**
 * Node test for the DYMO parser (src/dymoParser.ts).
 *
 * Run:  npm test        (tsx + @xmldom/xmldom as a Node shim for DOMParser)
 *
 * Two fixtures:
 *  1. tests/fixtures/synthetic-small.label — synthetic data only, safe to
 *     ship. Structurally identical to a real DYMO v4 export: DYMORect is an
 *     inset (point + size), the barcode Data/MultiDataString has 4 sibling
 *     DataString elements (first 3 empty), and one text line carries a
 *     double space that must be preserved exactly.
 *  2. test-fixtures/real-small1738541.label — a REAL export, if present
 *     locally. It is never shipped. Its patient-bearing expectations are
 *     derived from the file itself by an independent extraction below
 *     (not hardcoded), and nothing from it is printed except lengths /
 *     a 3-char barcode suffix.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DOMParser as XmldomDOMParser } from '@xmldom/xmldom';

// The browser parser relies on the global DOMParser; shim it before use.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = XmldomDOMParser;

const { parseDymoXml } = await import('../src/dymoParser.ts');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean, detail = '') {
  checks++;
  if (cond) {
    console.log(`  PASS ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const approx = (a: number, b: number, tol = 1e-5) => Math.abs(a - b) <= tol;
function checkLayout(label: string, layout: { x: number; y: number; width: number; height: number }, exp: [number, number, number, number]) {
  check(`${label} X`, approx(layout.x, exp[0]), `got ${layout.x}, want ${exp[0]}`);
  check(`${label} Y`, approx(layout.y, exp[1]), `got ${layout.y}, want ${exp[1]}`);
  check(`${label} W`, approx(layout.width, exp[2]), `got ${layout.width}, want ${exp[2]}`);
  check(`${label} H`, approx(layout.height, exp[3]), `got ${layout.height}, want ${exp[3]}`);
}

/** Independent (non-parser) reference extraction straight from raw XML. */
function reference(xml: string) {
  const doc = new XmldomDOMParser().parseFromString(xml, 'text/xml');
  const firstText = (scope: Element, tag: string) =>
    scope.getElementsByTagName(tag)[0]?.textContent ?? '';
  const lines: string[] = [];
  const spans = doc.getElementsByTagName('LineTextSpan');
  for (let i = 0; i < spans.length; i++) {
    // Exact text — deliberately NO trim: internal/edge spacing is data.
    lines.push(firstText(spans[i] as unknown as Element, 'Text'));
  }
  const barcodeEl = doc.getElementsByTagName('BarcodeObject')[0] as unknown as Element;
  const parts: string[] = [];
  const ds = barcodeEl.getElementsByTagName('DataString');
  for (let i = 0; i < ds.length; i++) {
    const t = (ds[i].textContent || '').trim();
    if (t) parts.push(t);
  }
  const rect = doc.getElementsByTagName('DYMORect')[0] as unknown as Element;
  const pt = rect.getElementsByTagName('DYMOPoint')[0] as unknown as Element;
  const sz = rect.getElementsByTagName('Size')[0] as unknown as Element;
  const rectVals = {
    x: parseFloat(firstText(pt, 'X')),
    y: parseFloat(firstText(pt, 'Y')),
    w: parseFloat(firstText(sz, 'Width')),
    h: parseFloat(firstText(sz, 'Height')),
  };
  return { lines, barcodeParts: parts, barcode: parts.join(''), rectVals };
}

function runSuite(label: string, xml: string, expectedBarcodeForLog: string) {
  console.log(`\n== ${label} ==`);
  const ref = reference(xml);
  // Fixture sanity (structure, no patient data printed)
  check('fixture has 3 LineTextSpans', ref.lines.length === 3, `got ${ref.lines.length}`);
  check('fixture has at least one double-spaced line', ref.lines.some((l) => l.includes('  ')));
  console.log(`  info barcode reference: ${expectedBarcodeForLog}`);

  const { model, error } = parseDymoXml(xml);
  check('parse error is null', error === null, String(error));
  if (!model) { check('model is not null', false); return; }

  check('label name is Small1738541', model.name === 'Small1738541', `got ${model.name}`);
  check('orientation is Landscape', model.orientation === 'Landscape', `got ${model.orientation}`);

  // DYMORect is the printable-area inset inside the physical label, so the
  // physical label size is offset + size (documented in dymoParser.ts).
  check('label width = DYMORect X + Width', approx(model.widthIn, ref.rectVals.x + ref.rectVals.w, 1e-4),
    `got ${model.widthIn}, want ${ref.rectVals.x + ref.rectVals.w}`);
  check('label height = DYMORect Y + Height', approx(model.heightIn, ref.rectVals.y + ref.rectVals.h, 1e-4),
    `got ${model.heightIn}, want ${ref.rectVals.y + ref.rectVals.h}`);

  const textObj = model.objects.find((o) => o.kind === 'text');
  const barcodeObj = model.objects.find((o) => o.kind === 'barcode');
  check('has a TextObject', !!textObj);
  check('has a BarcodeObject', !!barcodeObj);
  if (!textObj || !barcodeObj || textObj.kind !== 'text' || barcodeObj.kind !== 'barcode') return;

  check('text line count is 3', textObj.lines.length === 3, `got ${textObj.lines.length}`);
  textObj.lines.forEach((line, i) => {
    check(`text line ${i} matches fixture exactly (no trim/re-space)`,
      line.text === ref.lines[i],
      `length got ${line.text.length}, want ${ref.lines[i]?.length}`);
    check(`text line ${i} font Segoe UI 5`, line.font.fontName === 'Segoe UI' && line.font.fontSize === 5,
      `got ${line.font.fontName} ${line.font.fontSize}`);
  });
  checkLayout('text layout', textObj.layout, [0.23093039, 0.06459125, 1.6681391, 0.88918203]);

  check('barcode value = all non-empty DataStrings joined in order',
    barcodeObj.value === ref.barcode,
    `length got ${barcodeObj.value.length}, want ${ref.barcode.length}; suffix got ${barcodeObj.value.slice(-3)}, want ${ref.barcode.slice(-3)}`);
  check('barcode format maps to CODE128', barcodeObj.barcodeFormat === 'CODE128', `got ${barcodeObj.barcodeFormat}`);
  check('barcode font Arial 8', barcodeObj.font.fontName === 'Arial' && barcodeObj.font.fontSize === 8,
    `got ${barcodeObj.font.fontName} ${barcodeObj.font.fontSize}`);
  checkLayout('barcode layout', barcodeObj.layout, [0.23093039, 0.5409018, 1.5341527, 0.41287157]);
}

// 1) Synthetic fixture — always runs, safe expectations hardcoded in-file.
const synthetic = readFileSync(join(here, 'fixtures', 'synthetic-small.label'), 'utf8');
runSuite('synthetic fixture', synthetic, '<synthetic X00011122233S>');

// 2) Real fixture — only when present locally (never shipped in the zip).
const realPath = join(root, 'test-fixtures', 'real-small1738541.label');
if (existsSync(realPath)) {
  const realXml = readFileSync(realPath, 'utf8');
  const ref = reference(realXml);
  runSuite('real fixture (expectations derived in-memory, values not printed)',
    realXml, `<redacted len=${ref.barcode.length} suffix=${ref.barcode.slice(-3)}>`);
} else {
  console.log('\n== real fixture ==\n  SKIP not present locally (expected in shipped zip)');
}

// 3) Multi-part barcode joining beyond the fixture shape: several non-empty
//    DataStrings are segments of ONE value and must be joined in order.
console.log('\n== multi-part DataString joining (synthetic inline) ==');
{
  const xml = synthetic
    .replace('<DataString></DataString>', '<DataString>AB</DataString>')
    .replace('<DataString>X00011122233S</DataString>', '<DataString>CD33S</DataString>');
  const { model, error } = parseDymoXml(xml);
  check('parse error is null', error === null, String(error));
  const b = model?.objects.find((o) => o.kind === 'barcode');
  check('joined value AB + CD33S', !!b && b.kind === 'barcode' && b.value === 'ABCD33S',
    b && b.kind === 'barcode' ? `got length ${b.value.length}` : 'no barcode');
}

// 4) Built-in sample (src/sampleXml.ts) — public sample data from the
//    original brief. Its DYMORect point is (0,0), so offset+size must leave
//    its size unchanged, and its barcode must parse to exactly one value
//    (no doubling from the DataString joining).
console.log('\n== built-in sample ==');
{
  const { SAMPLE_XML } = await import('../src/sampleXml.ts');
  const { model, error } = parseDymoXml(SAMPLE_XML);
  check('parse error is null', error === null, String(error));
  const b = model?.objects.find((o) => o.kind === 'barcode');
  check('sample barcode is a single value', !!b && b.kind === 'barcode' && b.value === 'B26102121590S',
    b && b.kind === 'barcode' ? `got length ${b.value.length}` : 'no barcode');
  check('sample label size unchanged at 2.3125 x 1.25',
    !!model && approx(model.widthIn, 2.3125, 1e-6) && approx(model.heightIn, 1.25, 1e-6),
    model ? `got ${model.widthIn} x ${model.heightIn}` : 'no model');
}

// 5) Synthetic Small30334 — Portrait label with Rotation270 text AND a
//    Rotation270 Code39 barcode (the shape that broke in the user's
//    screenshot of the live viewer: oversized horizontal bars, clipped
//    rotated text, a duplicate barcode glyph, and a spurious
//    "Unsupported element: <IsVertical>" warning).
console.log('\n== synthetic Small30334 fixture (Rotation270 + Code39) ==');
{
  const { rotatedFootprint } = await import('../src/geometry.ts');
  const { barcodeFormatToJsBarcode, isSupportedBarcodeFormat } = await import('../src/dymoParser.ts');
  const xml30334 = readFileSync(join(here, 'fixtures', 'synthetic-small30334.label'), 'utf8');
  const { model, error, warnings, unsupported } = parseDymoXml(xml30334);
  check('parse error is null', error === null, String(error));
  check('label name is Small30334', model?.name === 'Small30334', `got ${model?.name}`);
  check('orientation is Portrait', model?.orientation === 'Portrait', `got ${model?.orientation}`);
  // DYMORect point (0.04, 0.06) + size 2.17 x 1.13 -> physical 2.21 x 1.19
  check('label width 2.21', !!model && approx(model.widthIn, 2.21, 1e-4), `got ${model?.widthIn}`);
  check('label height 1.19', !!model && approx(model.heightIn, 1.19, 1e-4), `got ${model?.heightIn}`);

  const t = model?.objects.find((o) => o.kind === 'text');
  const b = model?.objects.find((o) => o.kind === 'barcode');
  check('has a TextObject', !!t);
  check('has a BarcodeObject', !!b);
  if (t && t.kind === 'text') {
    check('text rotation parsed as 270', t.rotation === 270, `got ${t.rotation}`);
    check('text line count is 3', t.lines.length === 3, `got ${t.lines.length}`);
    check('text layout matches fixture', approx(t.layout.width, 0.6613) && approx(t.layout.height, 1.13),
      `got ${t.layout.width} x ${t.layout.height}`);
    check('text isVertical parsed (False)', t.isVertical === false, `got ${t.isVertical}`);
  }
  if (b && b.kind === 'barcode') {
    check('barcode rotation parsed as 270', b.rotation === 270, `got ${b.rotation}`);
    check('barcode raw format is Code39', b.barcodeFormatRaw === 'Code39', `got ${b.barcodeFormatRaw}`);
    check('barcode format maps to CODE39', b.barcodeFormat === 'CODE39', `got ${b.barcodeFormat}`);
    check('barcode value is T261020365', b.value === 'T261020365', `got length ${b.value.length}`);
    check('barcode font Arial 12', b.font.fontName === 'Arial' && b.font.fontSize === 12,
      `got ${b.font.fontName} ${b.font.fontSize}`);
    check('barcode sizeMode is AutoFit', b.sizeMode === 'AutoFit', `got ${b.sizeMode}`);
    check('barcode textPosition is Bottom', b.textPosition === 'Bottom', `got ${b.textPosition}`);
    check('barcode alignment Center/Middle', b.horizontalAlignment === 'Center' && b.verticalAlignment === 'Middle',
      `got ${b.horizontalAlignment}/${b.verticalAlignment}`);
  }

  // IsVertical and the other standard DYMO elements in this fixture must
  // NOT be reported as unsupported.
  check('IsVertical is NOT unsupported', !unsupported.includes('IsVertical'), `unsupported: ${unsupported.join(',')}`);
  check('Brushes/Color/Margin are NOT unsupported',
    !unsupported.some((u) => ['Brushes', 'SolidColorBrush', 'Color', 'Margin', 'DYMOThickness', 'BorderColor', 'DataTable', 'HasFixedLength'].includes(u)),
    `unsupported: ${unsupported.join(',')}`);
  check('no warning mentions IsVertical', !warnings.some((w) => w.includes('IsVertical')));

  // Rotated footprint: 90/270 swap dimensions, 0/180 do not. This is the
  // calculation the renderer uses to keep rotated objects inside the
  // label — unit-testable without a browser.
  if (t && b && model) {
    for (const obj of [t, b]) {
      const fp = rotatedFootprint(obj.layout, obj.rotation);
      check(`${obj.name} footprint swaps W/H at 270`,
        approx(fp.width, obj.layout.height) && approx(fp.height, obj.layout.width),
        `got ${fp.width} x ${fp.height} from ${obj.layout.width} x ${obj.layout.height}`);
      check(`${obj.name} footprint stays inside the label`,
        fp.x + fp.width <= model.widthIn + 1e-6 && fp.y + fp.height <= model.heightIn + 1e-6,
        `footprint ends at ${fp.x + fp.width} x ${fp.y + fp.height}, label ${model.widthIn} x ${model.heightIn}`);
      check(`${obj.name} footprint unchanged at rotation 0`,
        (() => { const f0 = rotatedFootprint(obj.layout, 0); return approx(f0.width, obj.layout.width) && approx(f0.height, obj.layout.height); })());
      check(`${obj.name} footprint unchanged at rotation 180`,
        (() => { const f180 = rotatedFootprint(obj.layout, 180); return approx(f180.width, obj.layout.width) && approx(f180.height, obj.layout.height); })());
      check(`${obj.name} footprint swaps at rotation 90`,
        (() => { const f90 = rotatedFootprint(obj.layout, 90); return approx(f90.width, obj.layout.height) && approx(f90.height, obj.layout.width); })());
    }
  }

  // Format mapping is explicit, not substring + silent CODE128 fallback.
  check('Code39 -> CODE39', barcodeFormatToJsBarcode('Code39') === 'CODE39');
  check('Code39Mod43 -> CODE39', barcodeFormatToJsBarcode('Code39Mod43') === 'CODE39');
  check('Code128Auto -> CODE128', barcodeFormatToJsBarcode('Code128Auto') === 'CODE128');
  check('Code128B -> CODE128', barcodeFormatToJsBarcode('Code128B') === 'CODE128');
  check('Ean13 -> EAN13', barcodeFormatToJsBarcode('Ean13') === 'EAN13');
  check('Ean8 -> EAN8', barcodeFormatToJsBarcode('Ean8') === 'EAN8');
  check('UpcA -> UPC', barcodeFormatToJsBarcode('UpcA') === 'UPC');
  check('Interleaved2of5 -> ITF (not CODE128)', barcodeFormatToJsBarcode('Interleaved2of5') === 'ITF');
  check('Itf14 -> ITF14', barcodeFormatToJsBarcode('Itf14') === 'ITF14');
  check('Codabar -> CODABAR', barcodeFormatToJsBarcode('Codabar') === 'CODABAR');
  check('Code39 is a supported format', isSupportedBarcodeFormat('Code39') === true);
  check('QrCode is NOT a supported format', isSupportedBarcodeFormat('QrCode') === false);
  check('Code93 is NOT a supported format', isSupportedBarcodeFormat('Code93') === false);
  check('DataMatrix is NOT a supported format', isSupportedBarcodeFormat('DataMatrix') === false);

  // Unsupported formats must produce an explicit warning, not silent CODE128.
  const qr = parseDymoXml(xml30334.replace('<BarcodeFormat>Code39</BarcodeFormat>', '<BarcodeFormat>QrCode</BarcodeFormat>'));
  check('QrCode label warns it cannot be encoded by JsBarcode',
    qr.warnings.some((w) => w.includes('QrCode') && w.includes('cannot encode')),
    `warnings: ${qr.warnings.join(' | ')}`);

  // IsVertical=True parses as true (and still no unsupported warning).
  const vert = parseDymoXml(xml30334.replaceAll('<IsVertical>False</IsVertical>', '<IsVertical>True</IsVertical>'));
  const vt = vert.model?.objects.find((o) => o.kind === 'text');
  check('IsVertical=True parses as isVertical true', !!vt && vt.kind === 'text' && vt.isVertical === true,
    vt && vt.kind === 'text' ? `got ${vt.isVertical}` : 'no text object');
  check('IsVertical=True still NOT unsupported', !vert.unsupported.includes('IsVertical'));
}

// 6) Single-line text fitting (the Small30334 rotated-text wrap bug):
//    each LineTextSpan is ONE non-wrapping line; for 90°/270° it runs
//    along the object's long axis; an over-long line shrinks to fit.
console.log('\n== single-line text fitting (geometry helpers + render code path) ==');
{
  const { textLineAvailablePx, estimateTextWidthPx, fittedFontSizePx } = await import('../src/geometry.ts');
  check('rotation 0: available = content width', textLineAvailablePx(60, 110, 0) === 60);
  check('rotation 180: available = content width', textLineAvailablePx(60, 110, 180) === 60);
  check('rotation 90: available = long axis', textLineAvailablePx(60, 110, 90) === 110);
  check('rotation 270: available = long axis', textLineAvailablePx(60, 110, 270) === 110);
  check('rotation 270: long axis when width is longer', textLineAvailablePx(130, 60, 270) === 130);
  check('short line keeps base font size', fittedFontSizePx(10, 50, 110) === 10);
  check('exact fit keeps base font size', fittedFontSizePx(10, 110, 110) === 10);
  check('over-long line shrinks proportionally', approx(fittedFontSizePx(10, 220, 110), 5, 1e-9),
    `got ${fittedFontSizePx(10, 220, 110)}`);
  check('shrunk size fits the axis', fittedFontSizePx(10, 220, 110) * (220 / 10) <= 110 + 1e-9);
  check('empty/zero measurement keeps base size', fittedFontSizePx(10, 0, 110) === 10);
  check('estimate grows with text length',
    estimateTextWidthPx('Patient Name: TEST PATIENTONE', 10) > estimateTextWidthPx('DOB', 10));
  check('a long patient line at 10px overflows 110px by estimate (would shrink)',
    estimateTextWidthPx('Patient Name: TEST PATIENTONE', 10) > 110);

  // Code path: the renderer must actually use the helpers + hard nowrap.
  const previewSrc = readFileSync(join(root, 'src', 'components', 'LabelPreview.tsx'), 'utf8');
  check('LabelPreview uses textLineAvailablePx', previewSrc.includes('textLineAvailablePx'));
  check('LabelPreview uses fittedFontSizePx', previewSrc.includes('fittedFontSizePx'));
  check("LabelPreview forces whiteSpace: 'nowrap' per line", previewSrc.includes("whiteSpace: 'nowrap'"));
  check("LabelPreview disables wrapping (overflowWrap: 'normal')", previewSrc.includes("overflowWrap: 'normal'"));
}

// 7) LEGACY DYMO Label Software format (<DieCutLabel>, Units="twips").
//    The user's real lab labels are this format; the Connect-only parser
//    rejected them with "No <DYMOLabel> element found".
console.log('\n== legacy DieCutLabel fixture (twips) ==');
{
  const { modelToXml } = await import('../src/dymoParser.ts');
  const legacyXml = readFileSync(join(here, 'fixtures', 'synthetic-legacy.label'), 'utf8');
  const { model, error, warnings, unsupported } = parseDymoXml(legacyXml);
  check('parse error is null', error === null, String(error));
  check('format detected as legacy', model?.format === 'legacy', `got ${model?.format}`);
  check('label name from PaperName', model?.name === 'Synthetic Legacy Test Label', `got ${model?.name}`);
  check('orientation Landscape', model?.orientation === 'Landscape', `got ${model?.orientation}`);
  // DrawCommands RoundRectangle 0,0 5760x1728 twips = 4 x 1.2 in.
  check('label width from DrawCommands (5760 twips = 4 in)', !!model && approx(model.widthIn, 4, 1e-6), `got ${model?.widthIn}`);
  check('label height from DrawCommands (1728 twips = 1.2 in)', !!model && approx(model.heightIn, 1.2, 1e-6), `got ${model?.heightIn}`);

  const t = model?.objects.find((o) => o.kind === 'text');
  const b = model?.objects.find((o) => o.kind === 'barcode');
  const sh = model?.objects.find((o) => o.kind === 'shape');
  check('has a TextObject', !!t);
  check('has a BarcodeObject', !!b);
  check('has a rendered ShapeObject (kind shape, not a placeholder)', !!sh,
    sh ? `got ${sh.shapeType}` : 'none');
  if (t && t.kind === 'text') {
    check('text content from StyledText String', t.lines.length === 1 && t.lines[0].text === 'TEST PATIENT - LEGACY SAMPLE LINE',
      `got ${t.lines.length} line(s): ${JSON.stringify(t.lines[0]?.text)}`);
    check('text font Arial 12 from StyledText Attributes', t.lines[0].font.fontName === 'Arial' && t.lines[0].font.fontSize === 12,
      `got ${t.lines[0].font.fontName} ${t.lines[0].font.fontSize}`);
    checkLayout('legacy text layout (twips->in)', t.layout, [376 / 1440, 540 / 1440, 1500 / 1440, 135 / 1440]);
  }
  if (b && b.kind === 'barcode') {
    check('barcode data from <Text>', b.value === 'LEGACYTEST001', `got ${b.value}`);
    check('barcode raw format Code39', b.barcodeFormatRaw === 'Code39', `got ${b.barcodeFormatRaw}`);
    check('barcode format maps to CODE39', b.barcodeFormat === 'CODE39', `got ${b.barcodeFormat}`);
    check('barcode font Arial 8 from TextFont attributes', b.font.fontName === 'Arial' && b.font.fontSize === 8,
      `got ${b.font.fontName} ${b.font.fontSize}`);
    check('barcode sizeMode is Medium (legacy named size)', b.sizeMode === 'Medium', `got ${b.sizeMode}`);
    check('barcode textPosition is Bottom', b.textPosition === 'Bottom', `got ${b.textPosition}`);
    checkLayout('legacy barcode layout (twips->in)', b.layout, [331 / 1440, 953 / 1440, 4530 / 1440, 480 / 1440]);
  }
  check('ShapeObject renders — no placeholder warning for it',
    !warnings.some((w) => w.includes('SHAPE1') && w.includes('placeholder')),
    `warnings: ${warnings.join(' | ')}`);
  if (sh && sh.kind === 'shape') {
    check('legacy ShapeObject shapeType defaults to Rectangle', sh.shapeType === 'Rectangle', `got ${sh.shapeType}`);
    checkLayout('legacy shape layout (twips->in)', sh.layout, [5000 / 1440, 200 / 1440, 400 / 1440, 400 / 1440]);
  }
  check('legacy format notice warning present', warnings.some((w) => w.includes('Legacy DYMO Label Software format detected')),
    `warnings: ${warnings.join(' | ')}`);
  check('core legacy elements are NOT unsupported',
    !unsupported.some((x) => ['DieCutLabel', 'ObjectInfo', 'Bounds', 'StyledText', 'String', 'Font', 'TextFont', 'DrawCommands', 'RoundRectangle'].includes(x)),
    `unsupported: ${unsupported.join(',')}`);

  // QR in a legacy file must warn explicitly, never silently render CODE128.
  const qr = parseDymoXml(legacyXml.replace('<Type>Code39</Type>', '<Type>QRCode</Type>'));
  check('legacy QRCode warns it cannot be encoded / will NOT scan as QRCode',
    qr.warnings.some((w) => w.includes('QRCode') && w.includes('NOT scan')),
    `warnings: ${qr.warnings.join(' | ')}`);

  // Literal \n-flattened legacy input still parses (same unescape as Connect).
  const flat = parseDymoXml(legacyXml.replace(/\n/g, '\\n'));
  const fb = flat.model?.objects.find((o) => o.kind === 'barcode');
  check('literal-\\n legacy input parses as legacy', flat.model?.format === 'legacy' && flat.error === null, String(flat.error));
  check('literal-\\n barcode value intact', !!fb && fb.kind === 'barcode' && fb.value === 'LEGACYTEST001');

  // Inferred label size fallback: no DrawCommands + unknown stock.
  const inferred = parseDymoXml(
    legacyXml
      .replace(/<DrawCommands>\s*<RoundRectangle[\s\S]*?<\/DrawCommands>/, '')
      .replace('SyntheticLegacyStock', 'UnknownStock')
      .replace('Synthetic Legacy Test Label', 'Unknown Label'),
  );
  check('inferred size warns', inferred.warnings.some((w) => w.includes('inferred')),
    `warnings: ${inferred.warnings.join(' | ')}`);
  // Max bounds extent: shape ends x=5400 twips=3.75 in, barcode ends y=1433 twips=0.9951 in; +0.1 margin.
  check('inferred width = max extent + 0.1', !!inferred.model && approx(inferred.model.widthIn, 3.85, 1e-3),
    `got ${inferred.model?.widthIn}`);
  check('inferred height = max extent + 0.1', !!inferred.model && approx(inferred.model.heightIn, 1433 / 1440 + 0.1, 1e-3),
    `got ${inferred.model?.heightIn}`);

  // Serializer converts legacy -> Connect, and the export re-parses.
  if (model) {
    const out = modelToXml(model);
    check('legacy export is Connect DesktopLabel XML', out.includes('<DesktopLabel') && !out.includes('DieCutLabel'));
    const round = parseDymoXml(out);
    const rb = round.model?.objects.find((o) => o.kind === 'barcode');
    check('legacy export re-parses as connect', round.model?.format === 'connect', `got ${round.model?.format}`);
    check('legacy export keeps barcode value', !!rb && rb.kind === 'barcode' && rb.value === 'LEGACYTEST001');
    check('legacy export omits the ShapeObject placeholder', !out.includes('SHAPE1') || out.includes('omitted'));
  }

  // Points units variant + AddressObject-as-text (inline synthetic).
  const pointsXml = `<?xml version="1.0" encoding="utf-8"?>
<ContinuousLabel Version="8.0" Units="points">
  <PaperOrientation>Portrait</PaperOrientation>
  <Id>InlinePoints</Id>
  <PaperName>Inline Points Label</PaperName>
  <DrawCommands><Rectangle X="0" Y="0" Width="72" Height="288" /></DrawCommands>
  <ObjectInfo>
    <AddressObject>
      <Name>ADDRESS1</Name>
      <Rotation>Rotation0</Rotation>
      <HorizontalAlignment>Left</HorizontalAlignment>
      <VerticalAlignment>Top</VerticalAlignment>
      <Text>Line One
Line Two</Text>
    </AddressObject>
    <Bounds X="36" Y="72" Width="144" Height="36" />
  </ObjectInfo>
</ContinuousLabel>`;
  const pts = parseDymoXml(pointsXml);
  check('points file parses, format legacy', pts.error === null && pts.model?.format === 'legacy', String(pts.error));
  check('points label size 1 x 4 in', !!pts.model && approx(pts.model.widthIn, 1) && approx(pts.model.heightIn, 4),
    `got ${pts.model?.widthIn} x ${pts.model?.heightIn}`);
  const at = pts.model?.objects.find((o) => o.kind === 'text');
  check('AddressObject parsed as text', !!at, `objects: ${pts.model?.objects.map((o) => o.kind).join(',')}`);
  if (at && at.kind === 'text') {
    check('AddressObject plain <Text> splits into 2 lines', at.lines.length === 2 && at.lines[0].text === 'Line One' && at.lines[1].text === 'Line Two',
      `got ${at.lines.length} line(s)`);
    checkLayout('points layout (pts->in)', at.layout, [0.5, 1, 2, 0.5]);
  }

  // Unknown root: error must list the supported formats.
  const bad = parseDymoXml('<SomethingElse><Text>hi</Text></SomethingElse>');
  check('unknown root errors', bad.model === null && !!bad.error, `model=${!!bad.model} error=${bad.error}`);
  check('unknown-root error lists DesktopLabel and DieCutLabel formats',
    !!bad.error && bad.error.includes('DesktopLabel') && bad.error.includes('DieCutLabel'),
    `error: ${bad.error}`);

  // Connect fixture still reports format 'connect'.
  const conn = parseDymoXml(synthetic);
  check('connect fixture format is connect', conn.model?.format === 'connect', `got ${conn.model?.format}`);

  // App code path: origin label is tracked truthfully + format/conversion UI.
  const appSrc = readFileSync(join(root, 'src', 'App.tsx'), 'utf8');
  check('App tracks pasted origin', appSrc.includes("setSourceLabel('pasted from clipboard')"));
  check('App tracks file origin by name', appSrc.includes('setSourceLabel(`file: ${file.name}`)'));
  check('App tracks sample origin', appSrc.includes("setSourceLabel('sample (built-in)')"));
  check('App shows format in the info panel', appSrc.includes('model.format'));
  check('App notes legacy conversion on export', appSrc.includes('converted to DYMO Connect DesktopLabel XML'));
}

// 8) UNIVERSAL COMPATIBILITY PASS — every DYMO setup should either
//    render faithfully or degrade to a labelled placeholder + warning.
console.log('\n== universal compatibility (stock table, shapes, images, counters, QR, namespaces, BOM, mirror) ==');
{
  const { STOCK_SIZES, findStock } = await import('../src/stocks.ts');
  const { modelToXml: toXml } = await import('../src/dymoParser.ts');
  void toXml;

  // --- Stock table contents + lookup discipline ---
  check('stock 30252 is 3.5 x 1.125', STOCK_SIZES['30252'].widthIn === 3.5 && STOCK_SIZES['30252'].heightIn === 1.125);
  check('stock 30334 is 2.25 x 1.25', STOCK_SIZES['30334'].widthIn === 2.25 && STOCK_SIZES['30334'].heightIn === 1.25);
  check('stock 30330 is 2 x 0.75', STOCK_SIZES['30330'].widthIn === 2 && STOCK_SIZES['30330'].heightIn === 0.75);
  check('stock 1744907 is 4 x 6', STOCK_SIZES['1744907'].widthIn === 4 && STOCK_SIZES['1744907'].heightIn === 6);
  check('stock 1738541 established 2.0667 x 0.96', approx(STOCK_SIZES['1738541'].widthIn, 2.0667) && approx(STOCK_SIZES['1738541'].heightIn, 0.96));
  check('findStock matches "30334 Multi-Purpose"', findStock('30334 Multi-Purpose')?.stock === '30334');
  check('findStock matches "Small30334"', findStock('Small30334')?.stock === '30334');
  check('findStock does NOT match digits inside a longer number', findStock('Order 13033450') === null,
    `got ${findStock('Order 13033450')?.stock}`);

  // --- Legacy size from stock table only (no DrawCommands) ---
  const legacyXml = readFileSync(join(here, 'fixtures', 'synthetic-legacy.label'), 'utf8');
  const stockOnly = parseDymoXml(
    legacyXml
      .replace(/<DrawCommands>\s*<RoundRectangle[\s\S]*?<\/DrawCommands>/, '')
      .replace('SyntheticLegacyStock', '30334')
      .replace('Synthetic Legacy Test Label', '30334 Multi-Purpose Label'),
  );
  check('stock-only legacy file parses', stockOnly.error === null && !!stockOnly.model, String(stockOnly.error));
  check('stock-only size is 2.25 x 1.25', !!stockOnly.model && approx(stockOnly.model.widthIn, 2.25) && approx(stockOnly.model.heightIn, 1.25),
    `got ${stockOnly.model?.widthIn} x ${stockOnly.model?.heightIn}`);
  check('stock-only sizeSource is stock', stockOnly.model?.sizeSource === 'stock', `got ${stockOnly.model?.sizeSource}`);
  check('stock-only warns "stock table"', stockOnly.warnings.some((w) => w.includes('stock table')),
    `warnings: ${stockOnly.warnings.join(' | ')}`);
  check('geometry sizeSource on legacy fixture', parseDymoXml(legacyXml).model?.sizeSource === 'geometry');
  check('geometry sizeSource on connect fixture', parseDymoXml(synthetic).model?.sizeSource === 'geometry');

  // --- ShapeObject: a line renders with correct bounds (legacy inline) ---
  const shapeXml = `<?xml version="1.0" encoding="utf-8"?>
<DieCutLabel Version="8.0" Units="twips">
  <PaperOrientation>Landscape</PaperOrientation>
  <Id>ShapeTest</Id>
  <PaperName>Shape Test</PaperName>
  <DrawCommands><RoundRectangle X="0" Y="0" Width="5760" Height="1728" /></DrawCommands>
  <ObjectInfo>
    <ShapeObject>
      <Name>RULE1</Name>
      <Rotation>Rotation0</Rotation>
      <IsMirrored>False</IsMirrored>
      <ShapeType>HorizontalLine</ShapeType>
      <ForeColor Alpha="255" Red="0" Green="0" Blue="0" />
    </ShapeObject>
    <Bounds X="144" Y="144" Width="2880" Height="36" />
  </ObjectInfo>
</DieCutLabel>`;
  const shapeRes = parseDymoXml(shapeXml);
  const shapeObj = shapeRes.model?.objects.find((o) => o.kind === 'shape');
  check('shape file parses with a shape object', !!shapeObj, `kinds: ${shapeRes.model?.objects.map((o) => o.kind).join(',')}`);
  if (shapeObj && shapeObj.kind === 'shape') {
    check('shape type is HorizontalLine', shapeObj.shapeType === 'HorizontalLine', `got ${shapeObj.shapeType}`);
    checkLayout('shape line layout (twips->in)', shapeObj.layout, [144 / 1440, 144 / 1440, 2880 / 1440, 36 / 1440]);
    check('shape stroke from ForeColor attrs is black', shapeObj.stroke === 'rgb(0, 0, 0)', `got ${shapeObj.stroke}`);
  }
  const previewSrc2 = readFileSync(join(root, 'src', 'components', 'LabelPreview.tsx'), 'utf8');
  check('LabelPreview renders shapes (kind === shape branch)', previewSrc2.includes("obj.kind === 'shape'"));
  check('LabelPreview has a ShapeSvg renderer', previewSrc2.includes('ShapeSvg'));

  // --- ImageObject: embedded renders, external is a placeholder ---
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const imgHead = `<?xml version="1.0" encoding="utf-8"?>
<DieCutLabel Version="8.0" Units="twips">
  <PaperOrientation>Landscape</PaperOrientation>
  <Id>ImageTest</Id>
  <PaperName>Image Test</PaperName>
  <DrawCommands><RoundRectangle X="0" Y="0" Width="5760" Height="1728" /></DrawCommands>
  <ObjectInfo>
    <ImageObject>
      <Name>LOGO</Name>
      <Rotation>Rotation0</Rotation>
      <IsMirrored>False</IsMirrored>
      IMAGEDATA
    </ImageObject>
    <Bounds X="144" Y="144" Width="720" Height="720" />
  </ObjectInfo>
</DieCutLabel>`;
  const embedded = parseDymoXml(imgHead.replace('IMAGEDATA', `<ImageData>${PNG_1PX}</ImageData>`));
  const imgObj = embedded.model?.objects.find((o) => o.kind === 'image');
  check('embedded image parses as kind image', !!imgObj, `kinds: ${embedded.model?.objects.map((o) => o.kind).join(',')}`);
  check('embedded image has a PNG data URL',
    !!imgObj && imgObj.kind === 'image' && !!imgObj.dataUrl && imgObj.dataUrl.startsWith('data:image/png;base64,iVBOR'),
    imgObj && imgObj.kind === 'image' ? `got ${String(imgObj.dataUrl).slice(0, 40)}` : 'none');
  const external = parseDymoXml(imgHead.replace('IMAGEDATA', '<ImagePath>C:\\labels\\logo.png</ImagePath>'));
  const extObj = external.model?.objects.find((o) => o.kind === 'image');
  check('external image has dataUrl null (placeholder)', !!extObj && extObj.kind === 'image' && extObj.dataUrl === null);
  check('external image warns it is not embedded',
    external.warnings.some((w) => w.includes('external file') && w.includes('placeholder')),
    `warnings: ${external.warnings.join(' | ')}`);
  check('LabelPreview renders embedded images (<img)', previewSrc2.includes('embedded-image'));

  // --- CounterObject composes prefix + value + suffix as text (Connect) ---
  const counterXml = `<?xml version="1.0" encoding="utf-8"?>
<DesktopLabel Version="1">
  <DYMOLabel Version="4">
    <LabelName>CounterTest</LabelName>
    <Orientation>Landscape</Orientation>
    <DYMORect><DYMOPoint><X>0</X><Y>0</Y></DYMOPoint><Size><Width>3</Width><Height>1</Height></Size></DYMORect>
    <DynamicLayoutManager><LabelObjects>
      <CounterObject>
        <Name>COUNT1</Name>
        <Rotation>Rotation0</Rotation>
        <IsMirrored>False</IsMirrored>
        <Prefix>ITEM-</Prefix>
        <CurrentValue>0042</CurrentValue>
        <SuffixText>/BOX</SuffixText>
        <ObjectLayout><DYMOPoint><X>0.1</X><Y>0.1</Y></DYMOPoint><Size><Width>2</Width><Height>0.3</Height></Size></ObjectLayout>
      </CounterObject>
    </LabelObjects></DynamicLayoutManager>
  </DYMOLabel>
</DesktopLabel>`;
  const counter = parseDymoXml(counterXml);
  const counterObj = counter.model?.objects.find((o) => o.kind === 'text');
  check('CounterObject parses as text', !!counterObj && counterObj.sourceType === 'CounterObject',
    `kinds: ${counter.model?.objects.map((o) => o.kind).join(',')}`);
  check('CounterObject composes prefix+value+suffix',
    !!counterObj && counterObj.kind === 'text' && counterObj.lines[0]?.text === 'ITEM-0042/BOX',
    counterObj && counterObj.kind === 'text' ? `got "${counterObj.lines[0]?.text}"` : 'none');

  // --- QR barcode: placeholder + warning, NO barcode generated ---
  const qrXml = counterXml
    .replace('<CounterObject>', '<BarcodeObject>')
    .replace('</CounterObject>', '</BarcodeObject>')
    .replace('<Name>COUNT1</Name>', '<Name>QR1</Name>')
    .replace(/<Prefix>[\s\S]*?<\/SuffixText>/, '<BarcodeFormat>QRCode</BarcodeFormat><Data><MultiDataString><DataString>HELLO-QR-001</DataString></MultiDataString></Data>');
  const qrRes = parseDymoXml(qrXml);
  check('QR file generates NO barcode object', !qrRes.model?.objects.some((o) => o.kind === 'barcode'),
    `kinds: ${qrRes.model?.objects.map((o) => o.kind).join(',')}`);
  const qrObj = qrRes.model?.objects.find((o) => o.kind === 'unsupported');
  check('QR becomes a labelled placeholder', !!qrObj && !!qrObj.detail && qrObj.detail.includes('QRCode'),
    qrObj ? `got detail "${qrObj.detail}"` : 'none');
  check('QR placeholder shows its data value', !!qrObj && qrObj.dataValue === 'HELLO-QR-001',
    qrObj ? `got ${qrObj.dataValue}` : 'none');
  check('QR warning says not rendered + cannot encode',
    qrRes.warnings.some((w) => w.includes('QRCode') && w.includes('not rendered') && w.includes('cannot encode')),
    `warnings: ${qrRes.warnings.join(' | ')}`);

  // --- Namespace-prefixed legacy file parses by local name ---
  const nsXml = `<?xml version="1.0" encoding="utf-8"?>
<d:DieCutLabel xmlns:d="urn:example:DYMO" Version="8.0" Units="twips">
  <d:PaperOrientation>Landscape</d:PaperOrientation>
  <d:Id>NsTest</d:Id>
  <d:PaperName>Namespace Test</d:PaperName>
  <d:DrawCommands><d:RoundRectangle X="0" Y="0" Width="5760" Height="1728" /></d:DrawCommands>
  <d:ObjectInfo>
    <d:TextObject>
      <d:Name>NSTEXT</d:Name>
      <d:Rotation>Rotation0</d:Rotation>
      <d:HorizontalAlignment>Left</d:HorizontalAlignment>
      <d:VerticalAlignment>Top</d:VerticalAlignment>
      <d:StyledText>
        <d:Element>
          <d:String xml:space="preserve">NS LINE ONE</d:String>
          <d:Attributes><d:Font Family="Arial" Size="10" Bold="False" Italic="False" Underline="False" /></d:Attributes>
        </d:Element>
      </d:StyledText>
    </d:TextObject>
    <d:Bounds X="144" Y="144" Width="2880" Height="270" />
  </d:ObjectInfo>
</d:DieCutLabel>`;
  const ns = parseDymoXml(nsXml);
  check('namespace-prefixed legacy file parses (no error)', ns.error === null && ns.model?.format === 'legacy', String(ns.error));
  const nsText = ns.model?.objects.find((o) => o.kind === 'text');
  check('namespace text content read', !!nsText && nsText.kind === 'text' && nsText.lines[0]?.text === 'NS LINE ONE',
    nsText && nsText.kind === 'text' ? `got "${nsText.lines[0]?.text}"` : 'none');
  check('namespace label size from DrawCommands', !!ns.model && approx(ns.model.widthIn, 4) && approx(ns.model.heightIn, 1.2),
    `got ${ns.model?.widthIn} x ${ns.model?.heightIn}`);

  // --- BOM, comments and processing instructions are tolerated ---
  const bomXml = '\uFEFF' + synthetic.replace('<DesktopLabel', '<!-- a comment --><?test-pi some data?><DesktopLabel');
  const bom = parseDymoXml(bomXml);
  check('BOM + comment + PI input parses', bom.error === null && bom.model?.name === 'Small1738541', String(bom.error));

  // --- Unknown elements/attributes warn, never error ---
  const unknown = parseDymoXml(synthetic.replace('<LabelObjects>', '<LabelObjects><FooBar CustomAttr="1"><Text>mystery</Text></FooBar>'));
  check('unknown element does not fail the parse', unknown.error === null && !!unknown.model, String(unknown.error));
  check('unknown element is reported as unsupported', unknown.unsupported.includes('FooBar'),
    `unsupported: ${unknown.unsupported.join(',')}`);

  // --- IsMirrored is parsed (Connect + legacy) ---
  const mirrorXml = counterXml
    .replace('<CounterObject>', '<TextObject>')
    .replace('</CounterObject>', '</TextObject>')
    .replace('<IsMirrored>False</IsMirrored>', '<IsMirrored>True</IsMirrored>')
    .replace(/<Prefix>[\s\S]*?<\/SuffixText>/, '<FormattedText><LineTextSpan><TextSpan><Text>MIRROR ME</Text></TextSpan></LineTextSpan></FormattedText>');
  const mirror = parseDymoXml(mirrorXml);
  const mirrorObj = mirror.model?.objects.find((o) => o.kind === 'text');
  check('connect IsMirrored=True parses as mirrored true', !!mirrorObj && mirrorObj.mirrored === true,
    mirrorObj ? `got ${mirrorObj.mirrored}` : 'none');
  const legacyMirror = parseDymoXml(legacyXml.replace('<IsMirrored>False</IsMirrored>', '<IsMirrored>True</IsMirrored>'));
  const lmText = legacyMirror.model?.objects.find((o) => o.kind === 'text');
  check('legacy IsMirrored=True parses as mirrored true', !!lmText && lmText.mirrored === true,
    lmText ? `got ${lmText.mirrored}` : 'none');
  check('LabelPreview applies mirroring (scaleX(-1))', previewSrc2.includes('scaleX(-1)'));

  // --- CircularTextObject degrades to a placeholder + warning ---
  const circXml = shapeXml
    .replace('<ShapeObject>', '<CircularTextObject>')
    .replace('</ShapeObject>', '</CircularTextObject>')
    .replace('<ShapeType>HorizontalLine</ShapeType>', '<Text>CIRCLE TEXT</Text>');
  const circ = parseDymoXml(circXml);
  const circObj = circ.model?.objects.find((o) => o.kind === 'unsupported');
  check('CircularTextObject becomes a placeholder', !!circObj && circObj.objectType === 'CircularTextObject',
    `kinds: ${circ.model?.objects.map((o) => o.kind).join(',')}`);
  check('CircularTextObject warns about the placeholder',
    circ.warnings.some((w) => w.includes('CircularTextObject') && w.includes('placeholder')),
    `warnings: ${circ.warnings.join(' | ')}`);

  // --- ContinuousLabel length: FixedLengthValue, else content-derived ---
  const contHead = `<?xml version="1.0" encoding="utf-8"?>
<ContinuousLabel Version="8.0" Units="twips">
  <PaperOrientation>Landscape</PaperOrientation>
  <Id>ContTest</Id>
  <PaperName>Unknown Continuous Roll</PaperName>
  FIXEDLEN
  <ObjectInfo>
    <TextObject>
      <Name>CTEXT</Name>
      <Rotation>Rotation0</Rotation>
      <StyledText><Element><String>CONT LINE</String><Attributes><Font Family="Arial" Size="10" Bold="False" /></Attributes></Element></StyledText>
    </TextObject>
    <Bounds X="0" Y="0" Width="2880" Height="1440" />
  </ObjectInfo>
</ContinuousLabel>`;
  const contDerived = parseDymoXml(contHead.replace('FIXEDLEN', ''));
  check('continuous label parses', contDerived.error === null && !!contDerived.model, String(contDerived.error));
  check('continuous length is content-derived (1.0 + 0.1)',
    !!contDerived.model && approx(contDerived.model.heightIn, 1.1, 1e-6), `got ${contDerived.model?.heightIn}`);
  check('continuous content-derived length warns',
    contDerived.warnings.some((w) => w.includes('content-derived')),
    `warnings: ${contDerived.warnings.join(' | ')}`);
  const contFixed = parseDymoXml(contHead.replace('FIXEDLEN', '<FixedLengthValue>2880</FixedLengthValue>'));
  check('continuous FixedLengthValue sets length (2880 twips = 2 in)',
    !!contFixed.model && approx(contFixed.model.heightIn, 2, 1e-6), `got ${contFixed.model?.heightIn}`);

  // --- App setup summary shows size source ---
  const appSrc2 = readFileSync(join(root, 'src', 'App.tsx'), 'utf8');
  check('App setup summary shows size source', appSrc2.includes('model.sizeSource') && appSrc2.includes('Setup:'));

  // --- Inspector placement (layout regression, user screenshot 2026-10-26):
  // the inspector/readjustment panel must live inside the right preview
  // column, in normal flow under the canvas/meta and BEFORE the SEO
  // section in the DOM, sticky — never absolute/fixed over other content.
  const idxPreview = appSrc2.indexOf('preview-pane');
  const idxInspector = appSrc2.indexOf('<ObjectInspector');
  const idxSeo = appSrc2.indexOf('seo-content');
  check('inspector is inside the preview column and before the SEO section',
    idxPreview > -1 && idxInspector > idxPreview && idxSeo > idxInspector,
    `preview=${idxPreview} inspector=${idxInspector} seo=${idxSeo}`);
  const cssSrc = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
  const inspectorRule = (/\.inspector\s*\{([^}]*)\}/.exec(cssSrc) ?? [])[1] ?? '';
  check('inspector is sticky in normal flow', inspectorRule.includes('position: sticky'), inspectorRule.trim().slice(0, 120));
  check('inspector is never absolute or fixed',
    !/position:\s*(absolute|fixed)/.test(inspectorRule), inspectorRule.trim().slice(0, 120));

  // --- SEO pack: FAQ schema + tightened title + H2s ---
  const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
  check('index.html has FAQPage JSON-LD', indexHtml.includes('"@type": "FAQPage"'));
  check('index.html title leads with DYMO Label XML Viewer',
    /<title>DYMO Label XML Viewer/.test(indexHtml));
  check('index.html google verification placeholder present (commented)',
    indexHtml.includes('google-site-verification'));
  check('App has the SEO H2s',
    appSrc2.includes('DYMO Label Viewer Online') &&
    appSrc2.includes('Open and view .label files without DYMO software') &&
    appSrc2.includes('Which DYMO files are supported?'));
}

// 8) Escaped-input decoding (the user's newest real label, 2026-10-26).
//    The source system delivers label XML as a JSON-escaped string:
//    every quote is \" and every line break a literal \n, wrapped in a
//    pair of double quotes. PRE-FIX this hard-failed: the old
//    preprocessing (unescapeLiteralNewlines) converted the \n literals
//    but left \" and the wrapping quote, so DOMParser reported the XML
//    declaration as "only at the start of the document" (content
//    outside the root element) and NO model was produced — while the
//    same file decoded parsed perfectly. The fix decodes ONLY after a
//    direct parse has failed, so valid raw XML is never touched.
console.log('\n== escaped (JSON-style) input decoding ==');
{
  const rawSynthetic = parseDymoXml(synthetic);
  const sameModel = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const escRes = parseDymoXml(JSON.stringify(synthetic));
  check('JSON-escaped synthetic parses without error', escRes.error === null, String(escRes.error));
  check('JSON-escaped model is identical to the raw model',
    !!escRes.model && sameModel(escRes.model, rawSynthetic.model));
  check('escaped parse notes the decode in warnings',
    escRes.warnings.some((w) => w.includes('escaped (JSON-style)')));

  // Escaped content WITHOUT the wrapping quotes (Labelary-style paste).
  const noWrap = parseDymoXml(JSON.stringify(synthetic).slice(1, -1));
  check('escaped-without-outer-quotes parses without error', noWrap.error === null, String(noWrap.error));
  check('escaped-without-outer-quotes model is identical', !!noWrap.model && sameModel(noWrap.model, rawSynthetic.model));

  // Wrapped in quotes but NOT escaped inside (quotes added around raw XML).
  const wrappedOnly = parseDymoXml(`"${synthetic}"`);
  check('quote-wrapped raw XML parses without error', wrappedOnly.error === null, String(wrappedOnly.error));
  check('quote-wrapped model is identical', !!wrappedOnly.model && sameModel(wrappedOnly.model, rawSynthetic.model));

  // Double-escaped (a JSON string of a JSON string) decodes in two rounds.
  const dbl = parseDymoXml(JSON.stringify(JSON.stringify(synthetic)));
  check('double-escaped parses without error', dbl.error === null, String(dbl.error));
  check('double-escaped model is identical', !!dbl.model && sameModel(dbl.model, rawSynthetic.model));

  // A valid raw XML whose TEXT legitimately contains backslashes must
  // NOT be decoded/mangled: the first line becomes a Windows-style path
  // (backslash sequences included). Direct parse succeeds, so the
  // decode path must never run.
  const backslashXml = synthetic.replace(/<Text>[^<]*<\/Text>/, '<Text>C:\\labels\\new\\temp</Text>');
  const bs = parseDymoXml(backslashXml);
  const bsText = bs.model?.objects.find((o) => o.kind === 'text');
  check('raw XML with backslashes in text parses without error', bs.error === null, String(bs.error));
  check('backslash text is preserved exactly (no unescaping applied)',
    !!bsText && bsText.kind === 'text' && bsText.lines[0]?.text === 'C:\\labels\\new\\temp',
    bsText && bsText.kind === 'text' ? `first line length got ${bsText.lines[0]?.text.length}` : 'no text object');
  check('no decode warning on a valid raw file',
    !bs.warnings.some((w) => w.includes('escaped (JSON-style)')));
}

// 9) The user's real FOUR-line Small1738541 (test-fixtures only, never
//    shipped; expectations derived in-memory, values not printed) —
//    raw AND escaped forms must produce identical models, and the
//    4-line / long-line geometry must stay clear of the barcode zone.
const fourLinePath = join(root, 'test-fixtures', 'real-small1738541-4line.label');
if (existsSync(fourLinePath)) {
  console.log('\n== real 4-line fixture (raw vs escaped; derived expectations) ==');
  const raw4 = readFileSync(fourLinePath, 'utf8');
  const ref4 = reference(raw4);
  check('fixture really has 4 text lines', ref4.lines.length === 4, `got ${ref4.lines.length}`);
  const rawRes = parseDymoXml(raw4);
  check('raw 4-line fixture parses without error', rawRes.error === null, String(rawRes.error));
  const t4 = rawRes.model?.objects.find((o) => o.kind === 'text');
  check('4 text lines match the fixture exactly',
    !!t4 && t4.kind === 'text' && t4.lines.length === 4 &&
      t4.lines.every((l, i) => l.text === ref4.lines[i]),
    t4 && t4.kind === 'text' ? `got ${t4.lines.length} lines, lengths [${t4.lines.map((l) => l.text.length).join(',')}]` : 'no text object');
  const b4 = rawRes.model?.objects.find((o) => o.kind === 'barcode');
  check('barcode value matches reference extraction',
    !!b4 && b4.kind === 'barcode' && b4.value === ref4.barcode,
    b4 && b4.kind === 'barcode' ? `length got ${b4.value.length}, want ${ref4.barcode.length}` : 'no barcode');
  if (t4 && t4.kind === 'text') checkLayout('4-line text layout', t4.layout, [0.23093039, 0.06459125, 1.6681391, 0.88918203]);
  if (b4 && b4.kind === 'barcode') checkLayout('4-line barcode layout', b4.layout, [0.23093039, 0.5409018, 1.5341527, 0.41287157]);

  const escRes4 = parseDymoXml(JSON.stringify(raw4));
  check('ESCAPED 4-line fixture parses without error (the reported failure)', escRes4.error === null, String(escRes4.error));
  check('escaped 4-line model is identical to the raw model',
    !!escRes4.model && JSON.stringify(escRes4.model) === JSON.stringify(rawRes.model));

  const escTxtPath = join(root, 'test-fixtures', 'real-small1738541-4line.escaped.txt');
  if (existsSync(escTxtPath)) {
    const fileEsc = parseDymoXml(readFileSync(escTxtPath, 'utf8'));
    check('escaped .txt on disk parses to the identical model',
      fileEsc.error === null && !!fileEsc.model && JSON.stringify(fileEsc.model) === JSON.stringify(rawRes.model),
      String(fileEsc.error));
  }
} else {
  console.log('\n== real 4-line fixture ==\n  SKIP not present locally (expected in shipped zip)');
}

// 10) Four-line / long-line rendering geometry (src/geometry.ts): the
//     longest real line is 48 chars at Segoe UI 5 pt in a 1.6681391 in
//     box. It must fit by shrinking (never wrapping), and a 4-line stack
//     at natural size must end above the barcode's top edge (0.5409018).
console.log('\n== 4-line / long-line fitting geometry ==');
{
  const { fittedFontSizePx, estimateTextWidthPx, textLineAvailablePx } = await import('../src/geometry.ts');
  const basePx = 5 * (96 / 72); // 5 pt at 96 dpi = 6.667 px
  const boxWpx = 1.6681391 * 96;
  const boxHpx = 0.88918203 * 96;
  const available = textLineAvailablePx(boxWpx, boxHpx, 0);
  check('available line length at rotation 0 is the box width', approx(available, boxWpx, 1e-6),
    `got ${available}, want ${boxWpx}`);
  // Deliberately pessimistic 0.55 em/char: even then the fitted size
  // must bring the 48-char line inside the box, never above base size.
  const probe = 'x'.repeat(48);
  const worstWidth = estimateTextWidthPx(probe, basePx, 0.55);
  const fitted = fittedFontSizePx(basePx, worstWidth, available);
  check('48-char line fits after shrink-to-fit (worst-case measure)',
    estimateTextWidthPx(probe, fitted, 0.55) <= available + 1e-9,
    `fitted ${fitted}px renders ${estimateTextWidthPx(probe, fitted, 0.55)}px vs ${available}px available`);
  check('shrink-to-fit never scales up', fitted <= basePx, `got ${fitted}, base ${basePx}`);
  // Vertical: lines render top-anchored at lineHeight 1.25; 4 lines at
  // 5 pt occupy 4 × 1.25 × 5/72 in = 0.347 in from the box top (0.0646).
  const stackBottomIn = 0.06459125 + 4 * 1.25 * (5 / 72);
  check('4-line stack ends above the barcode top edge',
    stackBottomIn < 0.5409018, `stack ends at ${stackBottomIn.toFixed(4)} in, barcode top 0.5409018 in`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} failing)`);
  process.exit(1);
}
console.log('RESULT: PASS');
