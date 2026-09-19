import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { format } from 'date-fns';

// Stitches pasted screenshots (manpower grid, progress blocks, dispatch summary, …) into one
// tall PNG, top to bottom, the way the daily report image is laid out by hand today. Everything
// happens in the browser — nothing is uploaded — so the output is exactly the pixels pasted in.

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]';
const BUTTON = `rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`;
const PRIMARY_BUTTON = `rounded-full px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100 ${FOCUS_RING}`;

// One control sets both the gutter between images and the margin around the whole sheet, so
// the border always matches the gaps — the thing that makes a pasted-together sheet look made
// rather than assembled.
const SPACING = { none: 0, tight: 8, normal: 16, roomy: 28 };

// Row packing. A row is filled until adding the next image would squeeze the row below
// MIN_SCALE, and closed as soon as it is full enough not to need stretching past MAX_SCALE.
// The caps exist because these are screenshots of small type: blowing one up to fill the width
// turns the figures to mush, and shrinking a wide table too far makes it unreadable. A row that
// cannot fill the width even at MAX_SCALE is centred instead — deliberate white on both sides
// reads as a margin, while white down one edge reads as a mistake.
const MIN_SCALE = 0.55;
const MAX_SCALE = 1.35;

// A hairline round each image. Two white screenshots side by side otherwise run into each other
// with no edge to tell them apart.
const IMAGE_BORDER = '#d4d4d8';

// The finished image is always on white, whatever the page theme: the screenshots are of a
// white spreadsheet, and a dark or transparent gap between them would show in the email.
const BACKGROUND = '#ffffff';

// Browsers refuse to draw a canvas past these (Chrome/Firefox: 16,384 px a side, ~268 MP in
// all). A report taller than that is scaled down as a whole rather than silently coming out
// blank.
const MAX_SIDE = 16_384;
const MAX_AREA = 268_000_000;

// Greedy, left to right, in the order the images are listed — so the sheet still reads
// chronologically, row by row, the way the printed report does.
function packRows(sizes, target, gap) {
  const rows = [];
  let row = [];
  let natural = 0;
  sizes.forEach((size, index) => {
    const candidate = natural + size.width + (row.length ? gap : 0);
    if (row.length && target / candidate < MIN_SCALE) {
      rows.push(row);
      row = [index];
      natural = size.width;
    } else {
      row.push(index);
      natural = candidate;
    }
    if (target / natural <= MAX_SCALE) {
      rows.push(row);
      row = [];
      natural = 0;
    }
  });
  if (row.length) rows.push(row);
  return rows;
}

function layoutReport(sizes, { gap, margin, mode }) {
  if (!sizes.length) return { width: 0, height: 0, boxes: [], rows: 0, scale: 1 };
  // The widest image sets the sheet width, so at least one image is always at its true size and
  // nothing has to be blown up to reach an arbitrary target.
  const content = Math.max(...sizes.map((s) => s.width));
  const rows = mode === 'stack' ? sizes.map((_, i) => [i]) : packRows(sizes, content, gap);

  const boxes = [];
  let y = margin;
  rows.forEach((indexes, rowIndex) => {
    const natural = indexes.reduce((sum, i) => sum + sizes[i].width, 0) + gap * (indexes.length - 1);
    const rowScale = Math.min(content / natural, MAX_SCALE);
    const rowWidth = natural * rowScale;
    let x = margin + (content - rowWidth) / 2; // only ever off-centre when the row is capped
    let rowHeight = 0;
    indexes.forEach((i) => {
      const w = sizes[i].width * rowScale;
      const h = sizes[i].height * rowScale;
      boxes[i] = { x, y, w, h };
      x += w + gap * rowScale;
      rowHeight = Math.max(rowHeight, h);
    });
    y += rowHeight + (rowIndex < rows.length - 1 ? gap : 0);
  });

  const width = content + margin * 2;
  const height = y + margin;
  const scale = Math.min(1, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
  return { width, height, boxes, rows: rows.length, scale };
}

function drawReport(items, layout) {
  const { boxes, scale } = layout;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(layout.width * scale));
  canvas.height = Math.max(1, Math.round(layout.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  items.forEach((item, i) => {
    const { x, y, w, h } = boxes[i];
    ctx.drawImage(item.img, x * scale, y * scale, w * scale, h * scale);
  });
  // Drawn after every image, so a hairline is never painted over by the next one along.
  ctx.strokeStyle = IMAGE_BORDER;
  ctx.lineWidth = 1;
  boxes.forEach(({ x, y, w, h }) => {
    ctx.strokeRect(Math.round(x * scale) + 0.5, Math.round(y * scale) + 0.5, Math.round(w * scale) - 1, Math.round(h * scale) - 1);
  });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The browser could not produce the image.'))), 'image/png');
  });
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return { url, img, width: img.naturalWidth, height: img.naturalHeight };
}

const TOAST_MS = 3500;

// Rendered into <body>: the builder sits inside a container the Email page hides when the other
// view is open, and a fixed-position child of a hidden element is never shown. The live region
// itself is always present, so screen readers announce each toast as it appears.
function Toast({ toast, onClose }) {
  return createPortal(
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.18 }}
            className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-lg"
            style={{ background: 'var(--surface-1)', borderColor: toast.good ? 'var(--status-good)' : 'var(--status-critical)' }}
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
              style={{ background: toast.good ? 'var(--status-good)' : 'var(--status-critical)' }}
            >
              {toast.good ? '✓' : '!'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {toast.title}
              </div>
              <div className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                {toast.detail}
              </div>
            </div>
            <button type="button" onClick={onClose} aria-label="Dismiss" className={`shrink-0 rounded-sm text-xs leading-none ${FOCUS_RING}`} style={{ color: 'var(--text-muted)' }}>
              ✕
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

let nextSeq = 0;

export function ImageReportBuilder({ active }) {
  const [items, setItems] = useState([]);
  const [spacing, setSpacing] = useState('normal');
  const [mode, setMode] = useState('fit');
  const [output, setOutput] = useState(null); // { url, blob, width, height, scaled }
  const [composing, setComposing] = useState(false);
  const [notice, setNotice] = useState(null); // { text, good }
  const [dropActive, setDropActive] = useState(false);
  const [toast, setToast] = useState(null); // { id, good, title, detail }
  const fileInputRef = useRef(null);
  const dragIndexRef = useRef(null);
  // Images decode asynchronously; a quick second paste could otherwise land above the first.
  // Each batch waits for the one before it, so the stack is always in the order things arrived.
  const queueRef = useRef(Promise.resolve());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const addFiles = useCallback((files, source) => {
    const images = [...files].filter((f) => f?.type?.startsWith('image/'));
    if (!images.length) {
      setNotice({ text: 'No image found. Copy a screenshot or a picture (Excel: select the cells → Copy → paste here).', good: false });
      return;
    }
    // Files chosen together in the picker arrive in no useful order; their own timestamps
    // (when the screenshot was saved) are the chronological order. Pastes arrive one at a time.
    if (source === 'files') images.sort((a, b) => a.lastModified - b.lastModified);
    const batch = images.map((file) => ({ file, seq: nextSeq++, takenAt: file.lastModified || Date.now() }));

    queueRef.current = queueRef.current.then(async () => {
      const results = await Promise.allSettled(batch.map((b) => loadImage(b.file)));
      const loaded = [];
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') return;
        const { file, seq, takenAt } = batch[i];
        loaded.push({ id: `img-${seq}`, seq, takenAt, name: file.name && file.name !== 'image.png' ? file.name : 'Pasted screenshot', ...r.value });
      });
      const failed = results.length - loaded.length;
      if (loaded.length) setItems((list) => [...list, ...loaded]);
      setNotice(
        failed
          ? { text: `${failed} image${failed > 1 ? 's' : ''} could not be read and ${failed > 1 ? 'were' : 'was'} skipped.`, good: false }
          : { text: `Added ${loaded.length} image${loaded.length > 1 ? 's' : ''}.`, good: true },
      );
    });
  }, []);

  // Ctrl+V anywhere on the page while this view is open.
  useEffect(() => {
    if (!active) return undefined;
    function onPaste(e) {
      const target = e.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName))) return;
      const files = [...(e.clipboardData?.items ?? [])]
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile());
      e.preventDefault();
      addFiles(files, 'paste');
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [active, addFiles]);

  // Free every object URL when the page goes away.
  useEffect(
    () => () => {
      itemsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    },
    [],
  );

  // The preview is the finished PNG itself, re-rendered on every change — what is shown is
  // exactly what is downloaded or copied.
  useEffect(() => {
    if (!items.length) {
      setOutput(null);
      return undefined;
    }
    let cancelled = false;
    const gap = SPACING[spacing];
    const layout = layoutReport(items, { gap, margin: gap, mode });
    setComposing(true);
    drawReport(items, layout)
      .then((blob) => {
        if (cancelled) return;
        setOutput({
          url: URL.createObjectURL(blob),
          blob,
          width: Math.round(layout.width * layout.scale),
          height: Math.round(layout.height * layout.scale),
          rows: layout.rows,
          scaled: layout.scale < 1,
        });
      })
      .catch((err) => !cancelled && setNotice({ text: err.message, good: false }))
      .finally(() => !cancelled && setComposing(false));
    return () => {
      cancelled = true;
    };
  }, [items, spacing, mode]);

  useEffect(() => () => output && URL.revokeObjectURL(output.url), [output]);

  // Keyed on the toast's id, so copying again while one is showing restarts its timer.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  function move(from, to) {
    setItems((list) => {
      if (to < 0 || to >= list.length || from === to) return list;
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  function remove(id) {
    setItems((list) => {
      const item = list.find((i) => i.id === id);
      if (item) URL.revokeObjectURL(item.url);
      return list.filter((i) => i.id !== id);
    });
  }

  function clearAll() {
    items.forEach((item) => URL.revokeObjectURL(item.url));
    setItems([]);
    setNotice(null);
  }

  function resetOrder() {
    setItems((list) => [...list].sort((a, b) => a.takenAt - b.takenAt || a.seq - b.seq));
  }

  async function pasteFromClipboard() {
    try {
      const clipboardItems = await navigator.clipboard.read();
      const files = [];
      for (const item of clipboardItems) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          files.push(new File([blob], 'image.png', { type, lastModified: Date.now() }));
        }
      }
      addFiles(files, 'paste');
    } catch {
      setNotice({ text: 'The browser did not allow reading the clipboard. Press Ctrl+V on this page instead.', good: false });
    }
  }

  function download() {
    if (!output) return;
    const a = document.createElement('a');
    a.href = output.url;
    a.download = `HSD-report-${format(new Date(), 'yyyy-MM-dd-HHmm')}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function copyImage() {
    if (!output) return;
    try {
      // No await before this call: Safari only allows clipboard writes inside the click itself.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': output.blob })]);
      setToast({
        id: Date.now(),
        good: true,
        title: 'Image copied to clipboard',
        detail: `${output.width} × ${output.height} px — paste it with Ctrl+V into an email, WhatsApp, Excel, …`,
      });
    } catch {
      setToast({
        id: Date.now(),
        good: false,
        title: 'Could not copy the image',
        detail: 'Use Download PNG, or right-click the preview → Copy image.',
      });
    }
  }

  function handleDragOver(e) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDropActive(true);
  }

  function handleDrop(e) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDropActive(false);
    addFiles(e.dataTransfer.files, 'files');
  }

  const canReadClipboard = typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.read);
  const busy = composing || !output;

  return (
    <div className="space-y-4">
      <Toast toast={toast} onClose={() => setToast(null)} />
      <div
        onDragOver={handleDragOver}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setDropActive(false)}
        onDrop={handleDrop}
        className="rounded-2xl border-2 border-dashed p-5 text-center"
        style={{
          background: dropActive ? 'var(--surface-2)' : 'var(--surface-1)',
          borderColor: dropActive ? 'var(--series-1)' : 'var(--baseline)',
        }}
      >
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          Press <kbd className="rounded border px-1.5 py-0.5 text-xs">Ctrl</kbd> + <kbd className="rounded border px-1.5 py-0.5 text-xs">V</kbd> to add a screenshot
        </div>
        <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          They are arranged in the order you paste them — side by side where two fit, otherwise one per row. You can also drop image files here.
        </div>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {canReadClipboard && (
            <button type="button" onClick={pasteFromClipboard} className={BUTTON} style={{ color: 'var(--text-secondary)' }}>
              Paste from clipboard
            </button>
          )}
          <button type="button" onClick={() => fileInputRef.current?.click()} className={BUTTON} style={{ color: 'var(--text-secondary)' }}>
            Choose files…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => {
              addFiles(e.target.files, 'files');
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {notice && (
        <div role="status" aria-live="polite" className="text-xs" style={{ color: notice.good ? 'var(--status-good)' : 'var(--status-critical)' }}>
          {notice.text}
        </div>
      )}

      {items.length > 0 && (
        <div className="rounded-2xl border p-4 sm:p-5" style={{ background: 'var(--surface-1)' }}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Images ({items.length}) — in order
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={resetOrder} className={BUTTON} style={{ color: 'var(--text-secondary)' }} title="Put the images back in the order they were taken or pasted">
                Sort by time
              </button>
              <button type="button" onClick={clearAll} className={BUTTON} style={{ color: 'var(--status-critical)' }}>
                Clear all
              </button>
            </div>
          </div>

          <ol className="space-y-2">
            {items.map((item, index) => (
              <li
                key={item.id}
                draggable
                onDragStart={(e) => {
                  dragIndexRef.current = index;
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (dragIndexRef.current === null) return;
                  e.preventDefault();
                }}
                onDrop={(e) => {
                  if (dragIndexRef.current === null) return;
                  e.preventDefault();
                  e.stopPropagation();
                  move(dragIndexRef.current, index);
                  dragIndexRef.current = null;
                }}
                onDragEnd={() => {
                  dragIndexRef.current = null;
                }}
                className="flex cursor-grab items-center gap-3 rounded-lg border px-2 py-2 active:cursor-grabbing"
                style={{ borderColor: 'var(--baseline)' }}
              >
                <span className="w-6 shrink-0 text-center text-xs font-semibold tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  {index + 1}
                </span>
                <img src={item.url} alt="" className="h-12 w-20 shrink-0 rounded border object-contain" style={{ background: BACKGROUND }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm" style={{ color: 'var(--text-primary)' }}>
                    {item.name}
                  </div>
                  <div className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {format(item.takenAt, 'd MMM, HH:mm:ss')} · {item.width} × {item.height}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button type="button" onClick={() => move(index, index - 1)} disabled={index === 0} aria-label={`Move image ${index + 1} up`} className={BUTTON} style={{ color: 'var(--text-secondary)' }}>
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, index + 1)}
                    disabled={index === items.length - 1}
                    aria-label={`Move image ${index + 1} down`}
                    className={BUTTON}
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    ↓
                  </button>
                  <button type="button" onClick={() => remove(item.id)} aria-label={`Remove image ${index + 1}`} className={BUTTON} style={{ color: 'var(--status-critical)' }}>
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {items.length > 0 && (
        <div className="rounded-2xl border" style={{ background: 'var(--surface-1)' }}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 sm:p-5" style={{ borderColor: 'var(--baseline)' }}>
            <div className="flex flex-wrap items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              <label className="flex items-center gap-1.5">
                Layout
                <select value={mode} onChange={(e) => setMode(e.target.value)} className={`rounded-lg px-2 py-1 text-sm ${FOCUS_RING}`} style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}>
                  <option value="fit">Fit — fill the width</option>
                  <option value="stack">Stack — one per row</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                Spacing
                <select value={spacing} onChange={(e) => setSpacing(e.target.value)} className={`rounded-lg px-2 py-1 text-sm ${FOCUS_RING}`} style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}>
                  <option value="none">None</option>
                  <option value="tight">Tight</option>
                  <option value="normal">Normal</option>
                  <option value="roomy">Roomy</option>
                </select>
              </label>
              {output && (
                <span className="tabular-nums">
                  {output.width} × {output.height} px · {output.rows} row{output.rows === 1 ? '' : 's'}
                  {output.scaled ? ' (scaled down — too large for the browser at full size)' : ''}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={copyImage} disabled={busy} className={`${PRIMARY_BUTTON} border`} style={{ background: 'transparent', color: 'var(--text-primary)' }}>
                Copy image
              </button>
              <button type="button" onClick={download} disabled={busy} className={PRIMARY_BUTTON} style={{ background: 'var(--series-1)' }}>
                Download PNG
              </button>
            </div>
          </div>
          <div className="max-h-[75vh] overflow-auto p-4 sm:p-5">
            {output ? (
              <img
                src={output.url}
                alt={`Combined report of ${items.length} images`}
                className="h-auto max-w-full border"
                style={{ opacity: composing ? 0.6 : 1, borderColor: 'var(--baseline)' }}
              />
            ) : (
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Building preview…
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
