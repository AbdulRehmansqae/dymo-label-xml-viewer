import type { LabelObjectModel } from '../types';

interface Props {
  object: LabelObjectModel | null;
  onChange: (updated: LabelObjectModel) => void;
}

function NumField({ label, value, step, onChange }: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        step={step ?? 0.01}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </label>
  );
}

export default function ObjectInspector({ object, onChange }: Props) {
  if (!object) {
    return (
      <div className="inspector empty">
        <h3>Object Inspector</h3>
        <p>Parse a label, then click any object in the preview to edit its text, value, position and size.</p>
      </div>
    );
  }

  const setLayout = (patch: Partial<typeof object.layout>) =>
    onChange({ ...object, layout: { ...object.layout, ...patch } } as LabelObjectModel);

  return (
    <div className="inspector">
      <h3>Object Inspector</h3>
      <p className="inspector-name">
        {object.kind === 'text' ? '📝' : object.kind === 'barcode' ? '▦' : '▨'} {object.name} <em>({object.kind})</em>
      </p>

      {object.kind === 'unsupported' && (
        <div className="inspector-section">
          <p className="meta">
            This is a {object.objectType}. The viewer does not render this object kind — it is
            shown in the preview as a placeholder at its real position and size, and it is omitted
            from Copy / Download XML exports.
            {object.detail ? <><br />{object.detail}.</> : null}
            {object.dataValue ? <><br />Data: {object.dataValue}</> : null}
          </p>
        </div>
      )}

      {object.kind === 'shape' && (
        <div className="inspector-section">
          <h4>Shape</h4>
          <p className="meta">
            Type: {object.shapeType}
            <br />
            Fill: {object.fill ?? 'none'} · Outline: {object.stroke ?? 'default'}
          </p>
        </div>
      )}

      {object.kind === 'image' && (
        <div className="inspector-section">
          <h4>Image</h4>
          <p className="meta">
            {object.dataUrl
              ? 'Embedded image data found in the file — rendered in the preview.'
              : 'No embedded image data in the file (external reference) — shown as a placeholder.'}
          </p>
        </div>
      )}

      {object.kind === 'text' && (
        <div className="inspector-section">
          <h4>Text lines</h4>
          {object.lines.map((line, i) => (
            <label key={i} className="field wide">
              <span>Line {i + 1} — {line.font.fontName} {line.font.fontSize}pt{line.font.isBold ? ' · Bold' : ''}{line.font.isItalic ? ' · Italic' : ''}{line.font.isUnderline ? ' · Underline' : ''}</span>
              <input
                type="text"
                value={line.text}
                onChange={(e) => {
                  const lines = object.lines.map((l, j) => (j === i ? { ...l, text: e.target.value } : l));
                  onChange({ ...object, lines });
                }}
              />
            </label>
          ))}
          <div className="row">
            <label className="field">
              <span>Font size (pt)</span>
              <input
                type="number"
                step={0.5}
                min={1}
                value={object.lines[0]?.font.fontSize ?? 10}
                onChange={(e) => {
                  const fontSize = parseFloat(e.target.value) || 10;
                  const lines = object.lines.map((l) => ({ ...l, font: { ...l.font, fontSize } }));
                  onChange({ ...object, lines });
                }}
              />
            </label>
            <label className="field check">
              <span>Bold</span>
              <input
                type="checkbox"
                checked={!!object.lines[0]?.font.isBold}
                onChange={(e) => {
                  const lines = object.lines.map((l) => ({ ...l, font: { ...l.font, isBold: e.target.checked } }));
                  onChange({ ...object, lines });
                }}
              />
            </label>
          </div>
          <p className="meta">
            Align: {object.textAlignment} · V: {object.verticalAlignment} · Rotation: {object.rotation}°
            {object.sourceType ? <> · Source: {object.sourceType} (rendered as text)</> : null}
            {object.mirrored ? <> · Mirrored</> : null}
          </p>
        </div>
      )}

      {object.kind === 'barcode' && (
        <div className="inspector-section">
          <h4>Barcode</h4>
          <label className="field wide">
            <span>Value (barcode data)</span>
            <input
              type="text"
              value={object.value}
              onChange={(e) => onChange({ ...object, value: e.target.value })}
            />
          </label>
          <p className="meta">
            DYMO format: {object.barcodeFormatRaw} → JsBarcode: {object.barcodeFormat}
            <br />
            Text position: {object.textPosition} · Font: {object.font.fontName} {object.font.fontSize}pt
            {object.sizeMode ? <> · Size: {object.sizeMode}</> : null}
          </p>
        </div>
      )}

      <div className="inspector-section">
        <h4>Position &amp; size (inches)</h4>
        <div className="grid2">
          <NumField label="X" value={object.layout.x} onChange={(v) => setLayout({ x: v })} />
          <NumField label="Y" value={object.layout.y} onChange={(v) => setLayout({ y: v })} />
          <NumField label="Width" value={object.layout.width} onChange={(v) => setLayout({ width: Math.max(0.05, v) })} />
          <NumField label="Height" value={object.layout.height} onChange={(v) => setLayout({ height: Math.max(0.05, v) })} />
        </div>
        {object.rotation !== 0 && (
          <p className="hint">
            Rotation: {object.rotation}° — Width/Height are the unrotated object size; on the
            label the preview footprint is{' '}
            {object.rotation === 90 || object.rotation === 270
              ? `${object.layout.height} × ${object.layout.width} in (swapped)`
              : `${object.layout.width} × ${object.layout.height} in`}
            .
          </p>
        )}
        <p className="hint">Tip: you can also drag the object directly in the preview.</p>
      </div>
    </div>
  );
}
