// Small filesystem helpers shared by discovery, config and build stages.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Decode source bytes. UTF-8 is tried first; when the buffer contains invalid
 * sequences (U+FFFD replacement characters) it is decoded as GBK instead.
 */
export function decodeBuffer(buf) {
  const text = buf.toString('utf8');
  if (!text.includes('\uFFFD')) return text;
  // If the producer already substituted U+FFFD (a literal EF BF BD sequence in
  // the bytes), decoding those bytes as GBK would only turn them into 锟斤拷.
  if (buf.indexOf(Buffer.from('\uFFFD', 'utf8')) !== -1) return text;
  return new TextDecoder('gbk').decode(buf);
}

/**
 * Read a text file, decoding UTF-8 or GBK. A missing file returns null; any
 * other IO failure is rethrown with the file path and the original reason.
 */
export function readText(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw new Error(`failed to read ${file}: ${e.message}`);
  }
  return decodeBuffer(buf);
}

/**
 * Write `text` only when the file content differs. Parent directories are
 * created; writes go through a temporary file so readers never see a partial
 * file. Returns `{ changed: boolean }`.
 */
export function writeIfChanged(file, text) {
  const buf = Buffer.from(text, 'utf8');
  let current = null;
  try {
    current = fs.readFileSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
      throw new Error(`failed to read ${file}: ${e.message}`);
    }
  }
  if (current !== null && current.equals(buf)) return { changed: false };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw new Error(`failed to write ${file}: ${e.message}`);
  }
  return { changed: true };
}

/** Hex SHA-256 of a file's bytes. */
export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}