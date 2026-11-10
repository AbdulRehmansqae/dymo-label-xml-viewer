import { useCallback, useMemo, useRef, useState } from 'react';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import LabelPreview, { BASE_PX_PER_IN } from './components/LabelPreview';
import ObjectInspector from './components/ObjectInspector';
import { modelToXml, parseDymoXml } from './dymoParser';
import { REVOKE_DELAY_MS, blobToDataUrl, dataUrlToBlob, downloadBlob } from './download';
import { SAMPLE_XML } from './sampleXml';
import type { LabelModel, LabelObjectModel } from './types';

type ZoomMode = 'manual' | 'fit' | 'actual';

export default function App() {
  const [xml, setXml] = useState<string>(SAMPLE_XML);
  const [model, setModel] = useState<LabelModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [unsupported, setUnsupported] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.6); // 160% default so a Small label is readable
  const [zoomMode, setZoomMode] = useState<ZoomMode>('manual');
  const [status, setStatus] = useState<string>('Sample loaded. Click “Parse XML” to render it.');
  const [copied, setCopied] = useState(false);
  // Where the editor content actually came from. This label must stay
  // truthful: it must NOT keep saying "sample (built-in)" after the user
  // pastes or opens a file. Updated by every handler that changes `xml`.
  const [sourceLabel, setSourceLabel] = useState<string>('sample (built-in)');

  const fileRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const parse = useCallback((source: string) => {
    const result = parseDymoXml(source);
    setError(result.error);
    setWarnings(result.warnings);
    setUnsupported(result.unsupported);
    if (result.model) {
      setModel(result.model);
      setSelectedId(result.model.objects[0]?.id ?? null);
      setStatus(
        `Parsed “${result.model.name}” — ${result.model.objects.length} object(s), ` +
          `${result.model.widthIn} × ${result.model.heightIn} in, ${result.model.orientation}, ` +
          `${result.model.format === 'legacy' ? 'legacy DYMO Label Software format' : 'DYMO Connect format'}.`,
      );
    } else {
      setModel(null);
      setSelectedId(null);
      setStatus('Parse failed — see the error above.');
    }
  }, []);

  const handleParse = () => parse(xml);

  const handleSample = () => {
    setXml(SAMPLE_XML);
    setSourceLabel('sample (built-in)');
    parse(SAMPLE_XML);
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setXml(text);
        setSourceLabel('pasted from clipboard');
        setStatus('Pasted from clipboard. Click “Parse XML”.');
      } else {
        setStatus('Clipboard was empty (or clipboard access was denied by the browser).');
      }
    } catch {
      setStatus('Clipboard read was blocked by the browser — paste manually with Ctrl+V in the editor.');
    }
  };

  const handleClear = () => {
    setXml('');
    setSourceLabel('empty editor');
    setModel(null);
    setError(null);
    setWarnings([]);
    setUnsupported([]);
    setSelectedId(null);
    setStatus('Editor cleared.');
  };

  const handleUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      setXml(text);
      setSourceLabel(`file: ${file.name}`);
      parse(text);
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsText(file);
  };

  const selectedObject = useMemo(
    () => model?.objects.find((o) => o.id === selectedId) ?? null,
    [model, selectedId],
  );

  const updateObject = useCallback((updated: LabelObjectModel) => {
    setModel((prev) =>
      prev ? { ...prev, objects: prev.objects.map((o) => (o.id === updated.id ? updated : o)) } : prev,
    );
  }, []);

  const moveObject = useCallback((id: string, x: number, y: number) => {
    setModel((prev) =>
      prev
        ? {
            ...prev,
            objects: prev.objects.map((o) =>
              o.id === id ? ({ ...o, layout: { ...o.layout, x, y } } as LabelObjectModel) : o,
            ),
          }
        : prev,
    );
  }, []);

  // --- Zoom handling -------------------------------------------------------
  const pxPerIn = useMemo(() => {
    if (zoomMode === 'actual') return BASE_PX_PER_IN; // 1:1 pixel-accurate: 96 px = 1 inch (CSS)
    if (zoomMode === 'fit' && model && canvasRef.current) {
      const availW = canvasRef.current.clientWidth - 48;
      const availH = 520;
      const fit = Math.min(availW / model.widthIn, availH / model.heightIn);
      return Math.max(24, fit);
    }
    return BASE_PX_PER_IN * zoom;
  }, [zoom, zoomMode, model]);

  const fitToScreen = () => {
    setZoomMode('fit');
    // Force recompute on next frame once mode is applied
    requestAnimationFrame(() => setZoomMode('fit'));
  };

  // --- Export --------------------------------------------------------------
  // All three downloads (XML / PNG / PDF) go through downloadBlob in
  // src/download.ts. The previous implementations each rolled their
  // own anchor handling and silently failed in real browsers:
  // downloadXml revoked its blob URL synchronously after click(), and
  // PDF relied on jsPDF .save(). Every handler below instead reports
  // success or failure in the visible status/error lines — an export
  // click NEVER does nothing quietly.

  /**
   * Fallback label capture used when html-to-image fails (it is
   * fragile around font/CSS embedding): serialize the label node into
   * a self-contained SVG <foreignObject>, draw it to a canvas, and
   * take the canvas PNG. Layout-critical styles in LabelPreview are
   * inline, so the clone carries them. Throws if any step is
   * unsupported, so the caller can report a visible error.
   */
  const fallbackCapturePngBlob = async (node: HTMLElement): Promise<Blob> => {
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    if (!width || !height) throw new Error('Label preview has no size to capture.');
    const clone = node.cloneNode(true) as HTMLElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    const html = new XMLSerializer().serializeToString(clone);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject width="100%" height="100%">${html}</foreignObject></svg>`;
    const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Could not load the fallback label image.'));
        img.src = svgUrl;
      });
      const scale = 3;
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D is not available in this browser.');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Canvas produced no PNG image.');
      return blob;
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(svgUrl), REVOKE_DELAY_MS);
    }
  };

  /** Capture the rendered label as a PNG blob (+ data URL for jsPDF). */
  const captureLabelPng = async (): Promise<{ blob: Blob; dataUrl: string }> => {
    const node = labelRef.current;
    if (!node) throw new Error('Label preview is not rendered yet.');
    try {
      const dataUrl = await toPng(node, { pixelRatio: 3, backgroundColor: '#ffffff' });
      return { blob: dataUrlToBlob(dataUrl), dataUrl };
    } catch {
      const blob = await fallbackCapturePngBlob(node);
      return { blob, dataUrl: await blobToDataUrl(blob) };
    }
  };

  const requireModel = (what: string): boolean => {
    if (model) return true;
    setStatus(`Parse a label first — ${what} works once a label is rendered. Click “Parse XML” (the sample is preloaded).`);
    return false;
  };

  const exportPng = async () => {
    if (!requireModel('PNG export')) return;
    if (!labelRef.current) {
      setError('PNG export failed: the label preview is not rendered. Nothing was downloaded.');
      return;
    }
    try {
      const { blob } = await captureLabelPng();
      const used = downloadBlob(blob, `${model!.name || 'label'}.png`);
      setStatus(`PNG exported at 3× resolution — check your downloads for “${used}”.`);
    } catch (e) {
      setError(`PNG export failed: ${e instanceof Error ? e.message : String(e)} Nothing was downloaded.`);
    }
  };

  const exportPdf = async () => {
    if (!requireModel('PDF export')) return;
    if (!labelRef.current) {
      setError('PDF export failed: the label preview is not rendered. Nothing was downloaded.');
      return;
    }
    try {
      const { dataUrl } = await captureLabelPng();
      const orientation = model!.widthIn >= model!.heightIn ? 'landscape' : 'portrait';
      const pdf = new jsPDF({ orientation, unit: 'in', format: [model!.widthIn, model!.heightIn] });
      pdf.addImage(dataUrl, 'PNG', 0, 0, model!.widthIn, model!.heightIn);
      // Blob + the shared download helper instead of delegating to
      // jsPDF's built-in save, whose internal download mechanism
      // silently no-ops in some sandboxed/iframe contexts.
      const used = downloadBlob(pdf.output('blob'), `${model!.name || 'label'}.pdf`);
      setStatus(
        `PDF exported at the label's true size (${model!.widthIn} × ${model!.heightIn} in, ${orientation}) — check your downloads for “${used}”.`,
      );
    } catch (e) {
      setError(`PDF export failed: ${e instanceof Error ? e.message : String(e)} Nothing was downloaded.`);
    }
  };

  // --- XML out -------------------------------------------------------------
  const regeneratedXml = useMemo(() => (model ? modelToXml(model) : ''), [model]);

  const copyXml = async () => {
    const out = model ? regeneratedXml : xml;
    try {
      await navigator.clipboard.writeText(out);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setStatus('Clipboard write was blocked — select the editor text and copy manually.');
    }
  };

  const downloadXml = () => {
    const out = model ? regeneratedXml : xml;
    if (!out.trim()) {
      setStatus('Nothing to download yet — paste or load label XML first.');
      return;
    }
    try {
      // Shared helper: appended anchor + DEFERRED revoke. The old
      // inline version revoked the blob URL synchronously after
      // click(), which is why downloads silently never happened.
      const used = downloadBlob(
        new Blob([out], { type: 'text/xml;charset=utf-8' }),
        `${model?.name || 'label'}.label`,
      );
      setStatus(`XML downloaded — check your downloads for “${used}”.`);
    } catch (e) {
      setError(`XML download failed: ${e instanceof Error ? e.message : String(e)} Nothing was downloaded.`);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">DYMO <span>Label XML Viewer</span></div>
        <span className="privacy-note">🔒 All XML processing happens in your browser. Nothing — including patient or label data — is uploaded to a server.</span>
        <span className="compat-note">Supports DYMO Connect DesktopLabel XML and legacy DYMO Label Software (DieCutLabel) XML, with explicit warnings for unsupported elements. Not a claim of full DYMO compatibility.</span>
      </header>

      <div className="layout">
        {/* ---------------- Left: XML editor ---------------- */}
        <section className="editor-pane" aria-label="XML editor">
          <div className="toolbar">
            <button className="primary" onClick={handleParse}>▶ Parse XML</button>
            <button onClick={handleSample}>Load Sample</button>
            <button onClick={handlePaste}>Paste</button>
            <button onClick={handleClear}>Clear</button>
            <button onClick={() => fileRef.current?.click()}>Upload .label / .xml</button>
            <input
              ref={fileRef}
              type="file"
              accept=".label,.xml,text/xml"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleUpload(f);
                e.target.value = '';
              }}
            />
          </div>

          <div className="source-line">
            Source: {sourceLabel} · {xml.length.toLocaleString()} chars
            {model
              ? ` · Format: ${model.format === 'legacy' ? 'legacy DYMO Label Software (DieCutLabel)' : 'DYMO Connect (DesktopLabel)'}`
              : ''}
          </div>

          <textarea
            className="xml-editor"
            value={xml}
            onChange={(e) => {
              setXml(e.target.value);
              setSourceLabel('edited in editor');
            }}
            placeholder="Paste DYMO DesktopLabel or legacy DieCutLabel XML here…"
            spellCheck={false}
            aria-label="DYMO XML source"
          />

          <div className="toolbar">
            <button onClick={copyXml} disabled={!xml && !model}>{copied ? '✓ Copied' : 'Copy XML'}</button>
            <button onClick={downloadXml}>Download XML</button>
            <span className="spacer" />
            <span className="status-line">{model ? 'Copy / Download use the edited model.' : ''}</span>
          </div>

          {model?.format === 'legacy' && (
            <div className="status-line">
              Legacy file — Copy / Download exports it <strong>converted to DYMO Connect DesktopLabel XML</strong>;
              objects this viewer does not render are omitted from the export (they remain in the source above).
            </div>
          )}

          <div className="status-line" role="status">{status}</div>

          {error && <div className="error-banner" role="alert">⚠ {error}</div>}

          {(warnings.length > 0 || unsupported.length > 0) && (
            <div className="warnings-panel">
              <strong>Warnings ({warnings.length})</strong>
              {warnings.length > 0 && (
                <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              )}
              {unsupported.length > 0 && (
                <details>
                  <summary>Unsupported elements ({unsupported.length})</summary>
                  <ul>{unsupported.map((u) => <li key={u}>&lt;{u}&gt;</li>)}</ul>
                </details>
              )}
            </div>
          )}
        </section>

        {/* ---------------- Right: preview ---------------- */}
        <section className="preview-pane" aria-label="Label preview">
          <div className="preview-toolbar">
            <button onClick={() => { setZoomMode('manual'); setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2))); }}>−</button>
            <span className="zoom-label">{zoomMode === 'actual' ? '1:1' : zoomMode === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
            <button onClick={() => { setZoomMode('manual'); setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2))); }}>+</button>
            <button onClick={fitToScreen}>Fit to screen</button>
            <button onClick={() => setZoomMode('actual')}>1:1 Pixel-accurate</button>
            <span className="spacer" style={{ flex: 1 }} />
            <button onClick={exportPng}>Export PNG</button>
            <button onClick={exportPdf}>Export PDF</button>
          </div>

          <div className="canvas" ref={canvasRef}>
            {model ? (
              <LabelPreview
                model={model}
                pxPerIn={pxPerIn}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMove={moveObject}
                labelRef={labelRef}
              />
            ) : (
              <div className="empty-preview">
                <p><strong>No label rendered yet.</strong></p>
                <p>Paste DYMO XML on the left (or use the preloaded sample) and click <strong>Parse XML</strong>. ZPL for Zebra printers (starting with <code>^XA</code>) is a different format and will be reported as an error here.</p>
              </div>
            )}
          </div>

          {model && (
            <div className="label-meta">
              <strong>{model.name}</strong> · {model.orientation} · {model.widthIn}″ × {model.heightIn}″ ·
              Format: {model.format === 'legacy' ? 'Legacy DYMO Label Software' : 'DYMO Connect DesktopLabel'} ·
              Scale: {Math.round(pxPerIn)} px/in (base {BASE_PX_PER_IN} px/in) · {model.objects.length} object(s)
              <br />
              Setup: size from {model.sizeSource === 'geometry' ? 'geometry in the file' : model.sizeSource === 'stock' ? 'stock table' : model.sizeSource} ·
              Objects: {(['text', 'barcode', 'shape', 'image', 'unsupported'] as const)
                .map((k) => `${model.objects.filter((o) => o.kind === k).length} ${k}`)
                .filter((s) => !s.startsWith('0 '))
                .join(', ') || 'none'}
            </div>
          )}

          <ObjectInspector object={selectedObject} onChange={updateObject} />
        </section>
      </div>

      {/* ---------- About / SEO content (below the tool) ---------- */}
      <section className="seo-content" aria-label="About this tool">
        <h1>DYMO Label XML Viewer — view &amp; edit DYMO .label files online, free</h1>
        <h2>DYMO Label Viewer Online</h2>
        <p>
          The <strong>DYMO Label XML Viewer</strong> is a free browser tool for anyone who works with
          DYMO LabelWriter labels and needs to see what a label file actually contains — without
          installing DYMO Connect or DYMO Label software. If you have ever tried to open a DYMO
          label in a Zebra/ZPL viewer such as Labelary and hit an error, this is the DYMO equivalent:
          it understands <strong>DYMO DesktopLabel XML</strong> natively.
        </p>

        <h2>What is a .label file?</h2>
        <p>
          A <code>.label</code> file is the XML format saved by DYMO Connect / DYMO Label software.
          Inside the XML, a <code>DesktopLabel</code> document describes the label size and
          orientation, and each element on the label — text blocks, barcodes, and their positions
          in inches — as objects such as <code>TextObject</code> and <code>BarcodeObject</code> with
          an <code>ObjectLayout</code> (position and size), formatted text
          (<code>FormattedText</code>, <code>LineTextSpan</code>, <code>TextSpan</code>) and font
          details (<code>FontInfo</code>: font name, size, bold, italic, underline), including
          rotation (0°, 90°, 180°, 270°). This viewer parses all of that and redraws the label at
          accurate proportions.
        </p>

        <h2>Open and view .label files without DYMO software</h2>
        <ol>
          <li>Click <strong>Upload .label / .xml</strong>, paste your XML, or load the built-in sample.</li>
          <li>Click <strong>Parse XML</strong> — the label is redrawn on the right, white on a grey canvas.</li>
          <li>Click any object to edit its text or barcode value, drag it to move it, or fine-tune its position and size in inches.</li>
          <li>Zoom, fit to screen, or switch to the 1:1 pixel-accurate view to check the layout.</li>
          <li>Export a <strong>PNG</strong> or a <strong>PDF at the label&apos;s true physical size</strong> for a print test, or copy / download the edited XML.</li>
        </ol>

        <h2>Real barcodes, not pictures</h2>
        <p>
          Barcodes are generated with JsBarcode from the actual data in your file — DYMO{' '}
          <code>Code128Auto</code> becomes a genuine <strong>Code 128</strong> barcode and{' '}
          <code>Code39</code> a genuine <strong>Code 39</strong> barcode (EAN, UPC, ITF, Codabar,
          MSI and pharmacode are also mapped explicitly). A format a browser barcode library cannot
          encode is reported with a clear warning instead of being silently substituted, so what
          you scan-test is what the data really says.
        </p>

        <h2>Private by design</h2>
        <p>
          Everything runs <strong>locally in your browser</strong>. Your label files — including any
          patient names, dates of birth or accession barcodes on specimen labels — are never
          uploaded to a server. Close the tab and the data is gone.
        </p>

        <h2>Which DYMO files are supported?</h2>
        <p>
          Both DYMO file families: <strong>DYMO Connect</strong> files (a{' '}
          <code>DesktopLabel</code> document) and older <strong>DYMO Label Software</strong>{' '}
          v7/v8 files (<code>DieCutLabel</code> and <code>ContinuousLabel</code>) — the label
          designs used by LabelWriter 4xx and 5-series printers, LabelWriter Duo and Twin
          Turbo, LabelWriter Wireless, and LabelManager label makers. If a file contains an
          element this viewer cannot draw, it is listed in the warnings panel and shown as a
          placeholder at its real position instead of failing.
        </p>

        <h2>Frequently asked questions</h2>
        <div className="faq-grid">
          <div>
            <h3>Can I open a DYMO .label file without DYMO software?</h3>
            <p>Yes. Upload or paste the file&apos;s XML here and it is parsed and previewed in your browser — no DYMO Connect installation and no account needed.</p>
          </div>
          <div>
            <h3>Why does Labelary reject my DYMO file?</h3>
            <p>Labelary renders Zebra ZPL (files starting with <code>^XA</code>). DYMO labels are a completely different XML format, which is what this viewer is built for.</p>
          </div>
          <div>
            <h3>Which DYMO elements are supported?</h3>
            <p>DYMO Connect: <code>DesktopLabel</code>, <code>DYMOLabel</code>, <code>DynamicLayoutManager</code>, <code>TextObject</code>, <code>BarcodeObject</code>, <code>FormattedText</code>, <code>LineTextSpan</code>, <code>TextSpan</code>, <code>FontInfo</code>, <code>ObjectLayout</code>, <code>DYMOPoint</code> and <code>Size</code>. Legacy DYMO Label Software files are supported too: <code>DieCutLabel</code> / <code>ContinuousLabel</code> with <code>ObjectInfo</code>, <code>Bounds</code> and <code>StyledText</code> (geometry in twips is converted to inches). Anything else in a file is listed in the warnings panel rather than silently dropped, and unrenderable object kinds appear as placeholders.</p>
          </div>
          <div>
            <h3>Can I print from here?</h3>
            <p>Export a PDF at the label&apos;s exact size (in inches) and print that as a test, or download the edited XML and open it in DYMO Connect for final printing on your LabelWriter.</p>
          </div>
        </div>

        <p className="disclaimer">
          This is an independent, unofficial tool. It is not affiliated with, endorsed by, or
          sponsored by DYMO or Newell Brands. DYMO, LabelWriter and DYMO Connect are trademarks of
          their respective owners. Rendering prioritises common DesktopLabel objects; it is not a
          claim of full DYMO compatibility.
        </p>
      </section>
    </div>
  );
}
