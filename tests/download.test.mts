/**
 * Node tests for the download/export hardening (src/download.ts and
 * its wiring in src/App.tsx).
 *
 * Run:  npm test   (tsx; no browser involved)
 *
 * What is covered:
 *  - sanitizeFilename: illegal characters, whitespace → dashes,
 *    fallback when nothing survives, extension preservation.
 *  - dataUrlToBlob: a base64 data URL decodes to the right bytes/type.
 *  - downloadBlob with a MOCKED environment: the exact call order is
 *    createObjectURL → append → click → remove, the object URL is NOT
 *    revoked synchronously (the original "download does nothing" bug
 *    was a revoke on the line right after click()), and the anchor
 *    receives the sanitized filename.
 *  - Code-path assertions on App.tsx: all three exports route through
 *    downloadBlob; the old failure patterns (synchronous
 *    URL.revokeObjectURL, jsPDF .save(), cacheBust, disabled export
 *    buttons) are gone; the "Parse a label first" guard exists.
 *
 * NOT covered: a real browser actually saving a file — that needs a
 * human/browser check and is called out in the delivery report.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { downloadBlob, sanitizeFilename, dataUrlToBlob, REVOKE_DELAY_MS } = await import(
  '../src/download.ts'
);

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

console.log('== sanitizeFilename ==');
check('plain name unchanged', sanitizeFilename('Small1738541') === 'Small1738541');
check('extension preserved', sanitizeFilename('my label.png') === 'my-label.png');
check(
  'illegal chars stripped',
  sanitizeFilename('a/b\\c:d*e?f"g<h>i|j') === 'a-b-c-d-e-f-g-h-i-j',
  sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'),
);
check('whitespace runs become one dash', sanitizeFilename('a   b\tc') === 'a-b-c');
check('repeated dashes collapse', sanitizeFilename('a - - b') === 'a-b');
check('empty falls back', sanitizeFilename('') === 'label');
check('only-illegal falls back', sanitizeFilename('///***') === 'label');
check('custom fallback', sanitizeFilename('??', 'label') === 'label');
check('leading/trailing dots trimmed', sanitizeFilename('..name.') === 'name');
check(
  'label name with spaces + ext',
  sanitizeFilename('Test Patient Label.label') === 'Test-Patient-Label.label',
);

console.log('\n== dataUrlToBlob ==');
{
  // 3-byte payload "abc" = YWJj
  const blob = dataUrlToBlob('data:image/png;base64,YWJj');
  check('mime type parsed', blob.type === 'image/png', blob.type);
  check('byte length parsed', blob.size === 3, String(blob.size));
  const text = dataUrlToBlob('data:text/plain,hello%20world');
  check('url-encoded body', text.size === 11, String(text.size));
  let threw = false;
  try {
    dataUrlToBlob('not-a-data-url');
  } catch {
    threw = true;
  }
  check('non-data URL throws (visible failure, not silent)', threw);
}

console.log('\n== downloadBlob (mocked env) ==');
{
  const order: string[] = [];
  let timerFn: (() => void) | null = null;
  let timerMs = -1;
  let revokedUrl: string | null = null;
  const anchor = {
    href: '',
    download: '',
    click() {
      order.push('click');
    },
  };
  const env = {
    createAnchor: () => {
      order.push('createAnchor');
      return anchor;
    },
    appendToBody: () => {
      order.push('append');
    },
    removeFromBody: () => {
      order.push('remove');
    },
    createObjectURL: (_blob: Blob) => {
      order.push('createObjectURL');
      return 'blob:mock-123';
    },
    revokeObjectURL: (url: string) => {
      order.push('revoke');
      revokedUrl = url;
    },
    setTimeoutFn: (fn: () => void, ms: number) => {
      order.push('scheduleRevoke');
      timerFn = fn;
      timerMs = ms;
    },
  };
  const used = downloadBlob(new Blob(['x'], { type: 'text/xml' }), 'My Label: v2.label', env);
  check('returns sanitized filename', used === 'My-Label-v2.label', used);
  check('anchor download is sanitized', anchor.download === 'My-Label-v2.label', anchor.download);
  check('anchor href is the object URL', anchor.href === 'blob:mock-123');
  check(
    'order: create → append → click → remove → schedule',
    order.join(',') === 'createObjectURL,createAnchor,append,click,remove,scheduleRevoke',
    order.join(','),
  );
  check('revoke NOT called synchronously (the original bug)', revokedUrl === null);
  check('revoke delay is the shared constant', timerMs === REVOKE_DELAY_MS, String(timerMs));
  check('revoke delay is seconds, not 0', REVOKE_DELAY_MS >= 1000, String(REVOKE_DELAY_MS));
  (timerFn as unknown as () => void)();
  check('revoke fires with the URL after the delay', revokedUrl === 'blob:mock-123');
}

console.log('\n== App.tsx code paths ==');
{
  const app = readFileSync(join(root, 'src', 'App.tsx'), 'utf8');
  check('App imports downloadBlob', /from '\.\/download'/.test(app) && app.includes('downloadBlob'));
  check('XML download routes through helper', /downloadBlob\(\s*new Blob/.test(app));
  check('PNG export routes through helper', app.includes("downloadBlob(blob, `${model!.name || 'label'}.png`)") || app.includes('downloadBlob(blob,'));
  check('PDF uses doc.output(\'blob\')', app.includes("pdf.output('blob')"));
  check('PDF does NOT rely on pdf.save()', !app.includes('pdf.save('));
  check('no direct URL.revokeObjectURL race left in App', !/URL\.revokeObjectURL\(url\)/.test(app));
  check('no cacheBust fragility left in capture', !app.includes('cacheBust'));
  check('PNG has the SVG/canvas fallback path', app.includes('fallbackCapturePngBlob') && app.includes('foreignObject'));
  check('exports are guarded with a visible message', app.includes('Parse a label first'));
  check('PNG button not disabled into silence', !app.includes('onClick={exportPng} disabled'));
  check('PDF button not disabled into silence', !app.includes('onClick={exportPdf} disabled'));
  check('download button not disabled into silence', !app.includes('onClick={downloadXml} disabled'));
  check(
    'empty XML gives a message, not a silent blob',
    app.includes('Nothing to download yet'),
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} failing)`);
  process.exit(1);
}
console.log('RESULT: PASS');
