import fs from 'node:fs';
import path from 'node:path';
import { writeIfChanged } from './fsutil.mjs';

const TEMPLATE = 'cordis.patch.template.yml';
const GENERATED = 'cordis.patch.yml';
const TOKEN = '__TOOL_DIR__';

/**
 * Generate the DSH bundle patch from the committed template.
 *
 * The template stays in git; the generated file contains this checkout's
 * absolute path and must be regenerated after moving the tool directory.
 *
 * @param {string} toolDir absolute path of the lvglui checkout
 * @returns {{ok: boolean, patchFile: string|null, problems: string[]}}
 */
export function installDsh(toolDir) {
  const resolved = path.resolve(toolDir);
  const dshDir = path.join(resolved, 'dsh');
  const template = path.join(dshDir, TEMPLATE);
  const patchFile = path.join(dshDir, GENERATED);

  if (!fs.existsSync(template)) {
    return { ok: false, patchFile: null, problems: [`missing template: ${template}`] };
  }

  let text;
  try {
    text = fs.readFileSync(template, 'utf8');
  } catch (e) {
    return { ok: false, patchFile: null, problems: [`cannot read ${template}: ${e.message}`] };
  }

  if (!text.includes(TOKEN)) {
    return { ok: false, patchFile: null, problems: [`template has no ${TOKEN}: ${template}`] };
  }

  const posix = resolved.replace(/\\/g, '/');
  if (posix.includes('"') || posix.includes('\n') || posix.includes('\r')) {
    return { ok: false, patchFile: null, problems: [`tool directory contains a quote or newline: ${posix}`] };
  }

  const rendered = text.split(TOKEN).join(posix);
  try {
    writeIfChanged(patchFile, rendered);
  } catch (e) {
    return { ok: false, patchFile: null, problems: [`cannot write ${patchFile}: ${e.message}`] };
  }

  return { ok: true, patchFile, problems: [] };
}