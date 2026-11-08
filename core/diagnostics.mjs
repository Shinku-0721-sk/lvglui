// Parse MSVC / GCC build output into capped error entries plus human hints.
//
// Pure: the caller passes the captured log. Paths are normalized to forward
// slashes and made project-relative (or `tool/<rel>`) when they fall under
// `root` / `toolDir`, so logs from different machines compare equal. Warnings
// are counted in `summary` but never mixed into `errors`.

const MSVC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(?:fatal\s+)?(error|warning)\s+([A-Z]+\d+):\s+(.*)$/;
const GCC_LINE = /^(.+?):(\d+):(\d+):\s+(error|warning):\s+(.*)$/;

const HINT_RULES = [
  {
    test: (line) =>
      (/C1083|cannot open source file/i.test(line)) && /esp_|driver[\\/]/.test(line),
    text: 'UI 层不能 include 平台头文件；把硬件访问移到 ui_port 实现',
  },
  {
    test: (line) => /LNK2019/.test(line) && /ui_port_/.test(line),
    text: '在目标工程实现 ui_port 函数；host 桩只提供空实现',
  },
  {
    test: (line) => /C2065/.test(line) && /\blv_/.test(line),
    text: '检查 LVGL 版本/头文件路径',
  },
  {
    test: (line) => /ninja: build stopped/.test(line),
    text: '先看上面第一条 error',
  },
];

function toPosix(file) {
  return String(file).replace(/\\/g, '/');
}

// Case-insensitive prefix match (Windows paths are case-preserving but
// case-insensitive); returns the relative remainder or null.
function under(pathText, base) {
  if (!base) return null;
  const normalizedBase = toPosix(base).replace(/\/+$/, '');
  if (!normalizedBase) return null;
  const lowerPath = pathText.toLowerCase();
  const lowerBase = normalizedBase.toLowerCase();
  if (lowerPath === lowerBase) return '';
  if (lowerPath.startsWith(`${lowerBase}/`)) return pathText.slice(normalizedBase.length + 1);
  return null;
}

function normalizeFile(file, root, toolDir) {
  const abs = toPosix(String(file).trim());
  const rootRel = under(abs, root);
  if (rootRel !== null) return rootRel || abs;
  const toolRel = under(abs, toolDir);
  if (toolRel !== null) return toolRel ? `tool/${toolRel}` : 'tool';
  return abs;
}

/**
 * @param {string} text raw compiler output
 * @param {{root?:string, toolDir?:string, max?:number}} [options]
 * @returns {{errors:Array<{file:string,line:number,col:number,severity:string,
 *   code:string|null,message:string,raw:string}>, summary:{errors:number,
 *   warnings:number,total:number}, hints:string[]}}
 */
export function parseDiagnostics(text, { root, toolDir, max = 50 } = {}) {
  const limit = Number.isInteger(max) && max >= 0 ? max : 50;
  const errors = [];
  const hints = [];
  const seenHints = new Set();
  let errorCount = 0;
  let warningCount = 0;

  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;

    for (const rule of HINT_RULES) {
      if (rule.test(line) && !seenHints.has(rule.text)) {
        seenHints.add(rule.text);
        hints.push(rule.text);
      }
    }

    const msvc = MSVC_LINE.exec(line);
    const gcc = msvc ? null : GCC_LINE.exec(line);
    if (!msvc && !gcc) continue;

    const entry = {
      file: normalizeFile(msvc ? msvc[1] : gcc[1], root, toolDir),
      line: Number.parseInt(msvc ? msvc[2] : gcc[2], 10),
      col: Number.parseInt(msvc ? msvc[3] : gcc[3], 10),
      severity: msvc ? msvc[4] : gcc[4],
      code: msvc ? msvc[5] : null,
      message: (msvc ? msvc[6] : gcc[5]).trim(),
      raw: line,
    };

    if (entry.severity === 'error') {
      errorCount += 1;
      if (errors.length < limit) errors.push(entry);
    } else {
      warningCount += 1;
    }
  }

  return {
    errors,
    summary: { errors: errorCount, warnings: warningCount, total: errorCount + warningCount },
    hints,
  };
}