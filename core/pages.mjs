// Multi-page support: detect the optional `ui_page_*` contract in the UI
// sources and turn runtime page names into safe file names.
//
// The contract is three functions (no shared struct, so the host never needs
// the UI's headers):
//
//   int         ui_page_count(void);
//   const char *ui_page_name(int index);
//   lv_obj_t   *ui_page_show(int index, lv_obj_t *parent);
//
// All three must be defined for multi-page rendering. A project that defines
// none of them keeps the single-entry behaviour unchanged; a project that
// defines only some of them gets a precise problem list instead of a link
// error at build time.

import fs from 'node:fs';

const DEFINITIONS = [
  {
    key: 'count',
    symbol: 'ui_page_count',
    re: /\bint\s+ui_page_count\s*\(\s*void\s*\)\s*\{/,
    signature: 'int ui_page_count(void)',
  },
  {
    key: 'name',
    symbol: 'ui_page_name',
    re: /\bconst\s+char\s*\*\s*ui_page_name\s*\(\s*int\s+\w*\s*\)\s*\{/,
    signature: 'const char *ui_page_name(int index)',
  },
  {
    key: 'show',
    symbol: 'ui_page_show',
    re: /\blv_obj_t\s*\*\s*ui_page_show\s*\(\s*int\s+\w*\s*,\s*lv_obj_t\s*\*\s*\w*\s*\)\s*\{/,
    signature: 'lv_obj_t *ui_page_show(int index, lv_obj_t *parent)',
  },
];

/**
 * Scan UI source files for the page contract.
 * @param {string[]} sources absolute paths of the UI component's .c files
 * @returns {{supported: boolean, found: string[], missing: string[],
 *   problems: string[]}}
 */
export function detectPages(sources) {
  const files = Array.isArray(sources) ? sources.filter((s) => typeof s === 'string' && s !== '') : [];
  const texts = [];
  const problems = [];

  for (const file of files) {
    try {
      texts.push(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      problems.push(`cannot read ${file}: ${e.message}`);
    }
  }
  const text = texts.join('\n');

  const found = [];
  const missing = [];
  for (const def of DEFINITIONS) {
    if (def.re.test(text)) found.push(def.key);
    else missing.push(def.key);
  }

  if (found.length > 0 && found.length < DEFINITIONS.length) {
    const absent = DEFINITIONS.filter((def) => missing.includes(def.key));
    problems.push(
      `incomplete page contract: found ${found.join(', ')} but missing ${absent
        .map((def) => def.signature)
        .join(', ')}`,
    );
  }

  return { supported: found.length === DEFINITIONS.length, found, missing, problems };
}

/**
 * Turn a page name into a file-name-safe stem. Page names are free-form C
 * strings, so anything outside [A-Za-z0-9._-] becomes '-'.
 */
export function sanitizePageName(name, fallback = 'page') {
  const raw = typeof name === 'string' ? name.trim() : '';
  if (raw === '') return fallback;
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned === '' ? fallback : cleaned;
}

/**
 * Assign unique, file-name-safe stems to page names, preserving order.
 * Duplicates get `-2`, `-3`, ... suffixes so no page silently overwrites
 * another page's PNG.
 * @param {string[]} names
 * @returns {string[]}
 */
export function pageFileStems(names) {
  const used = new Set();
  return names.map((name, index) => {
    const base = sanitizePageName(name, `page-${index}`);
    let stem = base;
    let n = 1;
    while (used.has(stem.toLowerCase())) {
      n += 1;
      stem = `${base}-${n}`;
    }
    used.add(stem.toLowerCase());
    return stem;
  });
}