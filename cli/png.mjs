// Minimal PNG encoder (RGB565 -> RGB888 -> PNG with zlib), no dependencies.
// LVGL color conversion matches lv_color_to32(): (c5<<3)|(c5>>2), (c6<<2)|(c6>>4).
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function encodeRgb565Png(fb, width, height) {
  const need = width * height * 2;
  if (fb.length < need) throw new Error(`framebuffer too small: ${fb.length} < ${need}`);

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    let o = y * stride;
    raw[o++] = 0; // filter: None
    let p = y * width * 2;
    for (let x = 0; x < width; x++, p += 2) {
      const v = fb[p] | (fb[p + 1] << 8);
      const r = (v >> 11) & 0x1f;
      const g = (v >> 5) & 0x3f;
      const b = v & 0x1f;
      raw[o++] = (r << 3) | (r >> 2);
      raw[o++] = (g << 2) | (g >> 4);
      raw[o++] = (b << 3) | (b >> 2);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
