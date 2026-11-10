/**
 * Browser download helpers — one shared path for XML / PNG / PDF export.
 *
 * The bugs this module exists to prevent (all present in the previous
 * App.tsx implementations, all producing the user report "download is
 * not actually downloading anything"):
 *
 *  1. SYNCHRONOUS REVOKE — `downloadXml` created a blob URL, called
 *     `a.click()`, and revoked the URL on the very next line. The
 *     browser may not have started fetching the blob yet when the URL
 *     dies, so the download silently never happens (notoriously in
 *     Firefox, intermittently elsewhere). Here the revoke is deferred
 *     by REVOKE_DELAY_MS, long after the click has been consumed.
 *  2. DETACHED ANCHOR — the old anchors were never appended to the
 *     document. Some browsers ignore `.click()` on a detached anchor,
 *     especially with a `download` attribute. Here the anchor is
 *     appended, clicked, then removed.
 *  3. jsPDF .save() — the old PDF path delegated the whole download to
 *     jsPDF's internal save mechanism, which in some sandboxed/iframe
 *     contexts silently does nothing. Now the app calls
 *     `doc.output('blob')` and routes the blob through this helper,
 *     giving all three exports the exact same reliable path and the
 *     same user-visible success/error reporting.
 *
 * The environment (document / URL / timers) is injectable so the
 * sequence can be unit-tested in Node without a browser.
 */

/** How long the object URL stays alive after the click (ms). */
export const REVOKE_DELAY_MS = 4000;

export interface AnchorLike {
  href: string;
  download: string;
  click(): void;
}

export interface DownloadEnv {
  createAnchor(): AnchorLike;
  appendToBody(a: AnchorLike): void;
  removeFromBody(a: AnchorLike): void;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  setTimeoutFn(fn: () => void, ms: number): void;
}

export function browserDownloadEnv(): DownloadEnv {
  return {
    createAnchor: () => document.createElement('a') as unknown as AnchorLike,
    appendToBody: (a) => {
      document.body.appendChild(a as unknown as Node);
    },
    removeFromBody: (a) => {
      (a as unknown as HTMLElement).remove();
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    setTimeoutFn: (fn, ms) => {
      window.setTimeout(fn, ms);
    },
  };
}

/**
 * Make a filename safe for every browser / OS:
 * strips path separators and Windows-illegal characters
 * (`\ / : * ? " < > |` and control characters), turns whitespace
 * runs into single dashes, collapses repeats, and trims leading /
 * trailing dots and dashes. Inner dots are preserved so callers can
 * pass "name.png". Falls back to `fallback` when nothing survives.
 */
export function sanitizeFilename(raw: string, fallback = 'label'): string {
  const cleaned = (raw ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '');
  return cleaned || fallback;
}

/**
 * Download a Blob under a sanitized filename. Returns the sanitized
 * filename actually used (for the user-visible status message).
 * Throws whatever createObjectURL/anchor operations throw — callers
 * must catch and report, never swallow.
 */
export function downloadBlob(
  blob: Blob,
  filename: string,
  env: DownloadEnv = browserDownloadEnv(),
): string {
  const safeName = sanitizeFilename(filename);
  const url = env.createObjectURL(blob);
  const a = env.createAnchor();
  a.href = url;
  a.download = safeName;
  env.appendToBody(a);
  try {
    a.click();
  } finally {
    env.removeFromBody(a);
  }
  // Deferred revoke — see the header note. Revoking synchronously
  // after click() is the bug that made downloads silently vanish.
  env.setTimeoutFn(() => env.revokeObjectURL(url), REVOKE_DELAY_MS);
  return safeName;
}

/** Decode a `data:` URL (base64 or URL-encoded) into a Blob. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) {
    throw new Error('Not a data URL.');
  }
  const head = dataUrl.slice(5, comma);
  const body = dataUrl.slice(comma + 1);
  const isBase64 = /;base64$/i.test(head);
  const mime = head.replace(/;base64$/i, '') || 'application/octet-stream';
  if (isBase64) {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

/** Read a Blob back as a `data:` URL (for jsPDF addImage). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image data.'));
    reader.readAsDataURL(blob);
  });
}
