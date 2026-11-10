// Parse MSVC / GCC build output into capped error entries plus human hints.
//
// Pure: the caller passes the captured log. Paths are normalized to forward
// slashes and made project-relative (or `tool/<rel>`) when they fall under
// `root` / `toolDir`, so logs from different machines compare equal. Warnings
// are counted in `summary` but never mixed into `errors`.

const MSVC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(?:fatal\s+)?(error|warning)\s+([A-Z]+\d+):\s+(.*)$/;
const GCC_LINE = /^(.+?):(\d+):(\d+):\s+(error|warning):\s+(.*)$/;
// Linker diagnostics carry no line/column: "home.c.obj : error LNK2019:
// unresolved external symbol snprintf". They matter as much as compile errors,
// because a failed link produces no ui.dll and therefore no screenshot at all.
const MSVC_LINK_LINE = /^(.+?)\s*:\s+(?:fatal\s+)?(error|warning)\s+(LNK\d+)\s*:\s*(.*)$/;
// GCC/Clang: "src/ui.c:12: undefined reference to `snprintf'"
const GCC_UNDEF_LINE = /^(.+?):(\d+):\s+undefined reference to\s+[`'"](.+?)[`'"]/;

const HINT_RULES = [
  {
    test: (line) =>
      (/C1083|cannot open source file/i.test(line)) && /esp_|driver[\\/]/.test(line),
    text: 'UI 层不能 include 平台头文件；把硬件访问移到 ui_port 实现',
  },
  {
    test: (line) =>
      /LNK2019/.test(line) &&
      /\b(snprintf|vsnprintf|sprintf|strdup|strndup|strtok_r|strnlen|snprintf_s)\b/.test(line),
    text: 'MSVC 的 C 模式默认不声明 snprintf/strdup 这类 C99 函数：改用 LVGL 的 lv_snprintf，或在 CMake 里把 C 标准提到 C11',
  },
  {
    test: (line) => /LNK2019/.test(line) && /ui_port_/.test(line),
    text: '在目标工程实现 ui_port 函数；host 桩只提供空实现',
  },
  {
    test: (line) => /(?:fatal\s+)?error\s+LNK\d+/.test(line),
    text: '链接失败：按第一条 LNK error 找缺失的符号实现（C++ 项目还要检查 extern "C"）',
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
  const seenEntries = new Set();
  let errorCount = 0;
  let warningCount = 0;

  // cmd.exe redirects leave stray CRs behind (and some tools emit CRLF twice),
  // so trailing CRs must go before the anchored patterns can see the end.
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.replace(/\r+$/, ''));
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
    const link = msvc || gcc ? null : MSVC_LINK_LINE.exec(line);
    const undef = msvc || gcc || link ? null : GCC_UNDEF_LINE.exec(line);
    if (!msvc && !gcc && !link && !undef) continue;

    let entry;
    if (msvc || gcc) {
      entry = {
        file: normalizeFile(msvc ? msvc[1] : gcc[1], root, toolDir),
        line: Number.parseInt(msvc ? msvc[2] : gcc[2], 10),
        col: Number.parseInt(msvc ? msvc[3] : gcc[3], 10),
        severity: msvc ? msvc[4] : gcc[4],
        code: msvc ? msvc[5] : null,
        message: (msvc ? msvc[6] : gcc[5]).trim(),
        raw: line,
      };
    } else if (link) {
      // The "file" here is usually an object/dll, not a source file, and there
      // is no position: line/col stay 0 so callers can omit them when printing.
      entry = {
        file: normalizeFile(link[1], root, toolDir),
        line: 0,
        col: 0,
        severity: link[2],
        code: link[3],
        message: link[4].trim(),
        raw: line,
      };
    } else {
      entry = {
        file: normalizeFile(undef[1], root, toolDir),
        line: Number.parseInt(undef[2], 10),
        col: 0,
        severity: 'error',
        code: null,
        message: `undefined reference to ${undef[3]}`,
        raw: line,
      };
    }

    if (entry.severity === 'error') {
      // One failed link prints the same LNK error once per target (ui.dll,
      // shot.exe, preview.exe); report it once.
      const key = `${entry.file}|${entry.line}|${entry.code}|${entry.message}`;
      if (seenEntries.has(key)) continue;
      seenEntries.add(key);
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