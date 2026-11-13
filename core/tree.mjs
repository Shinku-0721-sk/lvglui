// Compact LVGL widget trees for MCP responses.
//
// The shot binary writes the full tree to `.lvglui/out/tree.json`; callers send
// the compact form to an agent: bounded nodes, truncated text, no empty
// `children`. Input tolerates `{ root }`, a raw root node, and null children.

import fs from 'node:fs';

const KEPT_FIELDS = [
  'name', 'cls', 'x', 'y', 'w', 'h', 'absX', 'absY',
  'selfW', 'selfH', 'overflow', 'scrollable', 'hidden', 'text', 'value', 'checked',
];

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
/**
 * Advisory clipping check for a compact tree: a widget whose intrinsic size
 * is larger than its own box, or a child that falls outside a parent that
 * neither scrolls nor shows overflow, is being cut. This is geometry, not a
 * pixel measurement, so it is deterministic and cheap; it intentionally
 * ignores scrollable/overflow parents where children are expected to extend.
 *
 * @returns {string[]} human-readable warnings (bounded)
 */
export function clipWarnings(compact, { tolerance = 1, limit = 20 } = {}) {
  const root = isObject(compact?.root) ? compact.root : compact;
  if (!isObject(root)) return [];
  const out = [];
  const push = (node, message) => {
    if (out.length >= limit) return;
    const label = node.name ? `${node.cls} "${node.name}"` : node.cls || 'widget';
    out.push(`[clip] ${label}: ${message}`);
  };
  const walk = (node, parent) => {
    if (!isObject(node)) return;
    const w = Number(node.w);
    const h = Number(node.h);
    const selfW = Number(node.selfW);
    const selfH = Number(node.selfH);
    if (Number.isFinite(selfW) && Number.isFinite(w) && selfW > w + tolerance) {
      push(node, `content is ${selfW}px wide but the box is ${w}px; it will be clipped`);
    }
    if (Number.isFinite(selfH) && Number.isFinite(h) && selfH > h + tolerance) {
      push(node, `content is ${selfH}px tall but the box is ${h}px; it will be clipped`);
    }
    if (isObject(parent) && parent.scrollable !== true && parent.overflow !== true
        && Number.isFinite(parent.absX) && Number.isFinite(parent.absY)
        && Number.isFinite(parent.w) && Number.isFinite(parent.h)
        && Number.isFinite(node.absX) && Number.isFinite(node.absY)
        && Number.isFinite(node.w) && Number.isFinite(node.h)) {
      const left = parent.absX;
      const top = parent.absY;
      const right = parent.absX + parent.w;
      const bottom = parent.absY + parent.h;
      if (node.absX < left - tolerance || node.absY < top - tolerance
          || node.absX + node.w > right + tolerance
          || node.absY + node.h > bottom + tolerance) {
        push(node, `lies outside its parent (parent ${parent.w}x${parent.h} at ${parent.absX},${parent.absY}); the parent does not scroll or show overflow`);
      }
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) walk(child, node);
  };
  walk(root, null);
  if (out.length >= limit) out.push(`[clip] ... more clipped widgets were not listed (limit ${limit})`);
  return out;
}
