import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import english from '@tesseract.js-data/eng';
import german from '@tesseract.js-data/deu';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { checkCancellation, GoodnotesError } from './errors.mjs';

// Language models are installed with the package. No document or image leaves this machine.
export async function createOcr(directory, { signal } = {}) {
  checkCancellation(signal);
  const langPath = path.join(directory, 'ocr-models');
  await fs.mkdir(langPath, { recursive: true, mode: 0o700 });
  for (const model of [english, german]) {
    const name = `${model.code}.traineddata.gz`;
    await fs.copyFile(path.join(model.langPath, name), path.join(langPath, name));
  }
  const worker = await createWorker('eng+deu', 1, {
    langPath,
    cacheMethod: 'none',
    gzip: true,
    logger: () => {},
  });
  await worker.setParameters({ tessedit_pageseg_mode: '11', user_defined_dpi: '300' });
  const cancel = () => {
    void worker.terminate();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) {
    await worker.terminate();
    checkCancellation(signal);
  }
  return {
    async recognize(bytes, { layout = false, binarize = true } = {}) {
      checkCancellation(signal);
      const input = await loadImage(bytes),
        canvas = createCanvas(input.width, input.height),
        ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(input, 0, 0);
      if (binarize) {
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < pixels.data.length; i += 4) {
          const v =
            pixels.data[i] * 0.299 + pixels.data[i + 1] * 0.587 + pixels.data[i + 2] * 0.114 < 150
              ? 0
              : 255;
          pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = v;
        }
        ctx.putImageData(pixels, 0, 0);
      }
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new GoodnotesError('CANCELLED', 'Local OCR was cancelled.'));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      let data;
      try {
        ({ data } = await Promise.race([
          worker.recognize(canvas.toBuffer('image/png'), {}, { text: true, blocks: layout }),
          aborted,
        ]));
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      checkCancellation(signal);
      const lines = layout
        ? (data.blocks || []).flatMap((b) =>
            b.paragraphs.flatMap((p) =>
              p.lines.map((l) => ({
                text: l.text.trim(),
                confidence: l.confidence,
                bbox: l.bbox,
                words: l.words.map((w) => ({
                  text: w.text,
                  confidence: w.confidence,
                  bbox: w.bbox,
                })),
              })),
            ),
          )
        : undefined;
      return { text: data.text.trim(), confidence: data.confidence, ...(layout ? { lines } : {}) };
    },
    async close() {
      signal?.removeEventListener('abort', cancel);
      await worker.terminate();
    },
  };
}
