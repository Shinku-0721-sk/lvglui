// Compact LVGL widget trees for MCP responses.
//
// The shot binary writes the full tree to `.lvglui/out/tree.json`; callers send
// the compact form to an agent: bounded nodes, truncated text, no empty
// `children`. Input tolerates `{ root }`, a raw root node, and null children.

import fs from 'node:fs';

const KEPT_FIELDS = ['name', 'cls', 'x', 'y', 'w', 'h', 'absX', 'absY', 'hidden', 'text', 'value', 'checked'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Prefer the wrapper's root when present; otherwise treat the input as a node.
function sourceRoot(tree) {
  if (!isObject(tree)) return null;
  return isObject(tree.root) ? tree.root : tree;
}

function truncateText(text, maxText) {
  if (typeof text !== 'string') return text;
  if (maxText <= 0) return '';
  if (text.length <= maxText) return text;
  return `${text.slice(0, maxText - 1)}…`;
}

/** @returns {object|null} parsed tree, or null on any read/parse failure. */
export function readTree(file) {
  try {
    const tree = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(tree) ? tree : null;
  } catch {
    return null;
  }
}

/**
 * Depth-first compact copy. Emits at most `maxNodes` nodes; when the budget
 * runs out, stops descending, sets `truncated`, and marks the parent that still
 * had children with `elided: true` (no dangling child references).
 *
 * @returns {{root: object|null, nodes: number, truncated: boolean}}
 */
export function compactTree(tree, { maxNodes = 200, maxText = 64 } = {}) {
  const source = sourceRoot(tree);
  if (!source) return { root: null, nodes: 0, truncated: false };

  const nodeLimit = Number.isInteger(maxNodes) && maxNodes > 0 ? maxNodes : 200;
  const textLimit = Number.isInteger(maxText) && maxText >= 0 ? maxText : 64;
  let nodes = 0;
  let truncated = false;

  const visit = (node) => {
    const out = {};
    for (const field of KEPT_FIELDS) {
      if (node[field] === undefined) continue;
      out[field] = field === 'text' ? truncateText(node[field], textLimit) : node[field];
    }
    nodes += 1;

    const children = Array.isArray(node.children) ? node.children : [];
    const kept = [];
    for (const child of children) {
      if (!isObject(child)) continue;
      if (nodes >= nodeLimit) {
        truncated = true;
        out.elided = true;
        break;
      }
      kept.push(visit(child));
    }
    if (kept.length > 0) out.children = kept;
    return out;
  };

  const root = visit(source);
  return { root, nodes, truncated };
}

/** Recursively collect non-empty widget names: deduped, lexicographic order. */
export function collectNames(tree) {
  const source = sourceRoot(tree);
  const names = new Set();
  if (!source) return [];

  const walk = (node) => {
    if (!isObject(node)) return;
    if (typeof node.name === 'string' && node.name.length > 0) names.add(node.name);
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) walk(child);
  };
  walk(source);

  return [...names].sort();
}