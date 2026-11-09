// Contact sheet: tile every rendered page into one RGB565 image so a
// multi-page project can be reviewed at a glance. No text labels -- drawing
// page names would need a glyph set; the order is recorded in meta.json.

const DEFAULT_GAP = 8;
// #101820 in RGB565: r=0x10 -> 2, g=0x18 -> 6, b=0x20 -> 4.
export const SHEET_BACKGROUND = (2 << 11) | (6 << 5) | 4;
export const SHEET_MAX_WIDTH = 2048;

function pixelAt(fb, width, x, y) {
  const o = (y * width + x) * 2;
  return fb[o] | (fb[o + 1] << 8);
}

function putPixel(fb, width, x, y, value) {
  const o = (y * width + x) * 2;
  fb[o] = value & 0xff;
  fb[o + 1] = (value >> 8) & 0xff;
}

/**
 * Tile pages into one RGB565 buffer.
 * @param {Array<{name?: string, fb: Buffer, width: number, height: number}>} pages
 * @param {{gap?: number, background?: number, maxWidth?: number}} [options]
 * @returns {{fb: Buffer, width: number, height: number, cols: number,
 *   rows: number, gap: number, scale: number}|null}
 */
export function composeSheet(pages, options = {}) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  for (const page of pages) {
    if (!page || !Buffer.isBuffer(page.fb) || !Number.isInteger(page.width)
      || !Number.isInteger(page.height) || page.width <= 0 || page.height <= 0
      || page.fb.length < page.width * page.height * 2) {
      throw new Error('composeSheet: every page needs an RGB565 buffer with positive width/height');
    }
  }

  const gap = Number.isInteger(options.gap) && options.gap >= 0 ? options.gap : DEFAULT_GAP;
  const background = Number.isInteger(options.background) ? options.background : SHEET_BACKGROUND;
  const maxWidth = Number.isInteger(options.maxWidth) && options.maxWidth > 0
    ? options.maxWidth
    : SHEET_MAX_WIDTH;

  const count = pages.length;
  const cols = count <= 4 ? Math.min(2, count) : 4;
  const rows = Math.ceil(count / cols);
  const cellW = Math.max(...pages.map((p) => p.width));
  const cellH = Math.max(...pages.map((p) => p.height));

  const fullW = cols * cellW + (cols + 1) * gap;
  const fullH = rows * cellH + (rows + 1) * gap;
  const step = Math.max(1, Math.ceil(fullW / maxWidth));
  const width = Math.ceil(fullW / step);
  const height = Math.ceil(fullH / step);

  const fb = Buffer.alloc(width * height * 2);
  for (let i = 0; i < width * height; i++) {
    fb[i * 2] = background & 0xff;
    fb[i * 2 + 1] = (background >> 8) & 0xff;
  }

  pages.forEach((page, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const originX = gap + col * (cellW + gap);
    const originY = gap + row * (cellH + gap);

    for (let y = 0; y < page.height; y++) {
      const sy = originY + y;
      if (sy < 0 || sy >= fullH) continue;
      const dy = Math.floor(sy / step);
      if (dy < 0 || dy >= height) continue;
      for (let x = 0; x < page.width; x++) {
        const sx = originX + x;
        if (sx < 0 || sx >= fullW) continue;
        const dx = Math.floor(sx / step);
        if (dx < 0 || dx >= width) continue;
        putPixel(fb, width, dx, dy, pixelAt(page.fb, page.width, x, y));
      }
    }
  });

  return { fb, width, height, cols, rows, gap, scale: step };
}