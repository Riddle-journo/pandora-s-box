// OCR fallback for SCANNED / image-only PDFs — the ones pdf-parse returns empty
// for because they carry no text layer (old affidavits, scanned award ledgers,
// Devanagari question papers). Pipeline: render each page to a PNG with
// pdf-to-img (pdfjs + @napi-rs/canvas, prebuilt — no native build), then read
// the pixels with tesseract.js (pure-WASM OCR, English by default, Hindi opt-in).
//
// EVERYTHING here is optional and fail-silent, exactly like fetchPdfText: if the
// deps aren't installed, or a render/recognise throws, it returns "" and the
// caller degrades to the text-layer result (usually also ""). It is also OFF by
// default — OCR is slow (seconds per page) and downloads a language model on
// first use — so it only runs when PDF_OCR=1 (or opts.force) is set.
//
// Env:
//   PDF_OCR=1              enable the fallback
//   PDF_OCR_LANGS=eng+hin  tesseract languages (default "eng")
//   PDF_OCR_MAX_PAGES=8    cap pages OCR'd per document (default 8)

const langs = () => process.env.PDF_OCR_LANGS || "eng";
const maxPages = () => Number(process.env.PDF_OCR_MAX_PAGES) || 8;

export const ocrEnabled = () => process.env.PDF_OCR === "1";

// A short piece of text after cleanup is the signal that a PDF is image-only:
// a real text layer yields hundreds+ of characters, a scanned page yields a few
// stray ligatures or nothing. Callers use this to decide whether to try OCR.
export const looksScanned = (text, min = 40) => String(text ?? "").trim().length < min;

let _renderer = null;   // null = untried, false = unavailable, else the pdf() fn
async function renderer() {
  if (_renderer !== null) return _renderer || null;
  try { ({ pdf: _renderer } = await import("pdf-to-img")); }
  catch { console.warn("[pdf-ocr] pdf-to-img not installed — OCR disabled. Run: npm install pdf-to-img @napi-rs/canvas"); _renderer = false; }
  return _renderer || null;
}

// One reused tesseract worker (spinning one up loads the WASM core + language
// model — expensive; sharing it across pages/documents is the whole game).
let _workerPromise = null, _workerLangs = null;
async function worker() {
  const want = langs();
  if (_workerPromise && _workerLangs === want) return _workerPromise;
  if (_workerPromise) { await terminateOcr(); } // language changed → rebuild
  _workerLangs = want;
  _workerPromise = (async () => {
    try {
      const { createWorker } = await import("tesseract.js");
      return await createWorker(want.split("+"));
    } catch (e) {
      console.warn(`[pdf-ocr] tesseract.js unavailable — OCR disabled (${e.message}). Run: npm install tesseract.js`);
      return null;
    }
  })();
  return _workerPromise;
}

// Cleanly shut the worker down (call once at process end so Node can exit).
export async function terminateOcr() {
  const w = _workerPromise ? await _workerPromise : null;
  _workerPromise = null; _workerLangs = null;
  try { await w?.terminate(); } catch { /* already gone */ }
}

// OCR a PDF buffer → plain text. Returns "" on any failure or if OCR is off and
// not forced. `maxLen` caps the returned string (matches fetchPdfText).
export async function ocrPdfBuffer(buf, { force = false, maxLen = 20000, pages = maxPages() } = {}) {
  if (!force && !ocrEnabled()) return "";
  if (!buf || !buf.length) return "";
  const render = await renderer();
  if (!render) return "";
  const w = await worker();
  if (!w) return "";

  let out = "";
  try {
    const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const doc = await render(data, { scale: 2 }); // 2× → ~150dpi, enough for OCR
    let n = 0;
    for await (const png of doc) {
      if (n++ >= pages) break;
      try {
        const { data: { text } } = await w.recognize(png);
        if (text) out += text + "\n";
      } catch { /* skip a bad page, keep going */ }
      if (out.length >= maxLen) break;
    }
  } catch { return ""; }
  return out.replace(/\s+/g, " ").trim().slice(0, maxLen);
}
