// Display geometry and color depth: resolve width/height and enforce RGB565.
//
// Precedence is cli > config.display > sdkconfig > sourceText. There is no
// 240x320 default: when no source yields a complete pair the caller gets a
// problem naming the inputs to set instead. Pure function: no filesystem
// access, no imports; `root` is only used in diagnostics.

const RESOLUTION_FAMILIES = [
  { width: 'LV_DISPLAY_DEFAULT_WIDTH', height: 'LV_DISPLAY_DEFAULT_HEIGHT' },
  { width: 'LV_HOR_RES_MAX', height: 'LV_VER_RES_MAX' },
  { width: 'LCD_H_RES', height: 'LCD_V_RES' },
  { width: 'BSP_LCD_H_RES', height: 'BSP_LCD_V_RES' },
];

const SOURCE_MACRO_NAMES = RESOLUTION_FAMILIES.flatMap((family) => [family.width, family.height]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isGiven(value) {
  return value !== undefined && value !== null;
}

function show(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  if (typeof value === 'object') return '{...}';
  return String(value);
}

// CLI and config carry JSON numbers; NaN, floats, zero and negatives are out.
function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

// sdkconfig values arrive as strings from parseSdkconfig, but a caller that
// pre-parsed them may pass numbers. Hierarchy values are never floats.
function sdkPositiveInteger(value) {
  if (typeof value === 'number') return positiveInteger(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function sdkGet(sdkconfig, key) {
  if (!sdkconfig) return undefined;
  const prefixed = `CONFIG_${key}`;
  if (sdkconfig instanceof Map) {
    if (sdkconfig.has(key)) return sdkconfig.get(key);
    if (sdkconfig.has(prefixed)) return sdkconfig.get(prefixed);
    return undefined;
  }
  if (typeof sdkconfig === 'object') {
    if (Object.prototype.hasOwnProperty.call(sdkconfig, key)) return sdkconfig[key];
    if (Object.prototype.hasOwnProperty.call(sdkconfig, prefixed)) return sdkconfig[prefixed];
  }
  return undefined;
}

// parseSdkconfig turns "# CONFIG_X is not set" into 0; that is "absent", not a
// zero-sized display.
function sdkPresent(value) {
  return isGiven(value) && value !== '' && String(value) !== '0';
}

// Replace // and /* */ comments with whitespace, preserving newlines so line
// numbers and "#define" line starts survive. Strings are not special-cased:
// only #define lines matter here and their values are decimal integers.
function stripComments(text) {
  let out = '';
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      } else if (ch === '\n') {
        out += '\n';
      } else {
        out += ' ';
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      if (i < text.length) out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Parse display size macros from concatenated C source text. Pure: the caller
 * reads the files. Only `#define NAME <decimal>` lines count; commented-out
 * defines, expressions and suffixed values are ignored.
 *
 * @returns {{complete: Array<{width:string,height:string,widthValue:number,heightValue:number}>,
 *   mentioned: string[]}} `mentioned` uses the raw text so commented-out
 *   macros still produce an "ignored" warning.
 */
function parseSourceText(sourceText) {
  const text = typeof sourceText === 'string' ? sourceText : '';
  const defines = new Map();
  for (const line of stripComments(text).split('\n')) {
    const match = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+(.+)$/.exec(line);
    if (!match) continue;
    const name = match[1];
    if (!SOURCE_MACRO_NAMES.includes(name)) continue;
    const raw = match[2].trim();
    if (!/^\d+$/.test(raw)) continue;
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) continue;
    // First definition wins when a macro is redefined per #if branch.
    if (!defines.has(name)) defines.set(name, value);
  }

  const complete = [];
  for (const family of RESOLUTION_FAMILIES) {
    if (defines.has(family.width) && defines.has(family.height)) {
      complete.push({
        ...family,
        widthValue: defines.get(family.width),
        heightValue: defines.get(family.height),
      });
    }
  }
  const mentioned = SOURCE_MACRO_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
  return { complete, mentioned };
}

/**
 * Resolve the v1 color rule. Returns `{ colorDepth: 16 }` or `{ problem }`.
 * `warnings` is appended to: how the accepted evidence was derived.
 */
function resolveColorDepth(config, sdkconfig, warnings) {
  const display = isPlainObject(config?.display) ? config.display : null;
  const configHasDepth = display !== null && isGiven(display.colorDepth);
  const configDepth = configHasDepth ? display.colorDepth : null;

  const rawDepth = sdkGet(sdkconfig, 'LV_COLOR_DEPTH');
  const depthDeclared = sdkPresent(rawDepth);
  const sdkDepth = depthDeclared ? Number(rawDepth) : null;
  const rgb565Raw = sdkGet(sdkconfig, 'LV_COLOR_FORMAT_RGB565');
  const rgb565 = rgb565Raw === 1 || rgb565Raw === 'y' || rgb565Raw === 'Y' || rgb565Raw === true;

  if (configHasDepth && configDepth !== 16) {
    return {
      problem: `config.display.colorDepth is ${show(configDepth)}; only 16-bit RGB565 is supported`,
    };
  }

  if (depthDeclared) {
    if (!Number.isFinite(sdkDepth) || sdkDepth !== 16) {
      if (configHasDepth) {
        return {
          problem: `conflict: config.display.colorDepth is 16 but sdkconfig LV_COLOR_DEPTH is ${show(rawDepth)}; only 16-bit RGB565 is supported`,
        };
      }
      return {
        problem: `sdkconfig LV_COLOR_DEPTH is ${show(rawDepth)}; only 16-bit RGB565 is supported (LV_COLOR_FORMAT_DEFAULT must be LV_COLOR_FORMAT_RGB565)`,
      };
    }
    if (configHasDepth) {
      warnings.push('config.display.colorDepth and sdkconfig LV_COLOR_DEPTH both declare 16-bit RGB565');
    }
    return { colorDepth: 16 };
  }

  if (rgb565) {
    if (configHasDepth) {
      warnings.push('config.display.colorDepth and sdkconfig LV_COLOR_FORMAT_RGB565 both declare 16-bit RGB565');
    } else {
      warnings.push('sdkconfig sets LV_COLOR_FORMAT_RGB565=y without LV_COLOR_DEPTH; using 16-bit RGB565');
    }
    return { colorDepth: 16 };
  }

  if (configHasDepth) {
    warnings.push(
      'sdkconfig does not declare a color depth (LV_COLOR_DEPTH or LV_COLOR_FORMAT_RGB565); using config.display.colorDepth = 16',
    );
    return { colorDepth: 16 };
  }

  return {
    problem:
      'cannot determine color depth: only 16-bit RGB565 is supported, so sdkconfig must set LV_COLOR_DEPTH=16 or LV_COLOR_FORMAT_RGB565=y (LV_COLOR_FORMAT_DEFAULT must be LV_COLOR_FORMAT_RGB565), or lvglui.json display.colorDepth must be 16',
  };
}

/**
 * Resolve display size and color depth for the v1 renderer.
 *
 * @param {object} options
 * @param {string} [options.root] project root, diagnostics only
 * @param {object} [options.config] normalized lvglui.json data
 * @param {object|Map} [options.sdkconfig] parseSdkconfig result (keys without CONFIG_)
 * @param {{width?: number, height?: number}} [options.cli]
 * @param {string} [options.sourceText] already-concatenated C source text
 * @returns {{ok:boolean, width:number|null, height:number|null,
 *   colorDepth:number|null, source:'cli'|'config'|'sdkconfig'|'source'|null,
 *   problem:string|null, warnings:string[]}}
 */
export function detectDisplay({ root, config, sdkconfig, cli = {}, sourceText = '' } = {}) {
  const warnings = [];
  const result = {
    ok: false,
    width: null,
    height: null,
    colorDepth: null,
    source: null,
    problem: null,
    warnings,
  };
  const where = root ? ` for ${root}` : '';
  const sourceInfo = parseSourceText(sourceText);
  const cliArgs = isPlainObject(cli) ? cli : {};

  let resolution = null;
  let problem = null;

  // ---- 1. CLI ----------------------------------------------------------
  const cliHasWidth = isGiven(cliArgs.width);
  const cliHasHeight = isGiven(cliArgs.height);
  if (cliHasWidth || cliHasHeight) {
    if (cliHasWidth !== cliHasHeight) {
      problem = `--width and --height must be given together (missing ${cliHasWidth ? '--height' : '--width'})${where}`;
    } else {
      const width = positiveInteger(cliArgs.width);
      const height = positiveInteger(cliArgs.height);
      if (width === null) problem = `--width must be a positive integer, got ${show(cliArgs.width)}`;
      else if (height === null) problem = `--height must be a positive integer, got ${show(cliArgs.height)}`;
      else resolution = { width, height, source: 'cli' };
    }
  }

  // ---- 2. config.display ----------------------------------------------
  if (!problem && !resolution) {
    const display = config?.display;
    if (display !== undefined && display !== null) {
      if (!isPlainObject(display)) {
        problem = `config.display must be an object with width, height and colorDepth, got ${show(display)}`;
      } else {
        const hasWidth = isGiven(display.width);
        const hasHeight = isGiven(display.height);
        if (hasWidth || hasHeight) {
          if (hasWidth !== hasHeight) {
            problem = `config.display.width and config.display.height must be given together (missing config.display.${hasWidth ? 'height' : 'width'})`;
          } else {
            const width = positiveInteger(display.width);
            const height = positiveInteger(display.height);
            if (width === null) {
              problem = `config.display.width must be a positive integer, got ${show(display.width)}`;
            } else if (height === null) {
              problem = `config.display.height must be a positive integer, got ${show(display.height)}`;
            } else {
              resolution = { width, height, source: 'config' };
            }
          }
        }
      }
    }
  }

  // ---- 3. sdkconfig pairs, first complete pair wins --------------------
  if (!problem && !resolution) {
    for (const family of RESOLUTION_FAMILIES) {
      const rawWidth = sdkGet(sdkconfig, family.width);
      const rawHeight = sdkGet(sdkconfig, family.height);
      const hasWidth = sdkPresent(rawWidth);
      const hasHeight = sdkPresent(rawHeight);
      if (!hasWidth && !hasHeight) continue;
      if (hasWidth !== hasHeight) {
        const missing = hasWidth ? family.height : family.width;
        problem = `sdkconfig has ${hasWidth ? family.width : family.height} but ${missing} is missing; both keys of the pair are required`;
        break;
      }
      const width = sdkPositiveInteger(rawWidth);
      const height = sdkPositiveInteger(rawHeight);
      if (width === null) {
        problem = `sdkconfig ${family.width} must be a positive integer, got ${show(rawWidth)}`;
        break;
      }
      if (height === null) {
        problem = `sdkconfig ${family.height} must be a positive integer, got ${show(rawHeight)}`;
        break;
      }
      resolution = { width, height, source: 'sdkconfig' };
      break;
    }
  }

  // ---- 4. source macros ------------------------------------------------
  // Consulted only when no higher-precedence source resolved; ambiguity here
  // is a hard error because picking a pair would be a guess.
  if (!problem && !resolution) {
    if (sourceInfo.complete.length > 1) {
      const pairs = sourceInfo.complete
        .map((family) => `${family.width}/${family.height} = ${family.widthValue}x${family.heightValue}`)
        .join(', ');
      problem = `source code defines multiple display size macro pairs (${pairs}); exactly one pair must define the resolution`;
    } else if (sourceInfo.complete.length === 1) {
      const family = sourceInfo.complete[0];
      resolution = { width: family.widthValue, height: family.heightValue, source: 'source' };
    }
  }

  // ---- Warnings about source macros that did not drive the resolution ---
  const mentioned = sourceInfo.mentioned.join(', ');
  if (resolution && sourceInfo.complete.length === 1 && resolution.source !== 'source') {
    const family = sourceInfo.complete[0];
    warnings.push(
      `source macros ${family.width}/${family.height} (${family.widthValue}x${family.heightValue}) were ignored; resolution came from ${resolution.source}`,
    );
  } else if (resolution && sourceInfo.complete.length > 1) {
    warnings.push(
      `source code defines multiple display size macro pairs (${mentioned}); they were ignored because resolution came from ${resolution.source}`,
    );
  } else if (sourceInfo.complete.length === 0 && sourceInfo.mentioned.length > 0) {
    warnings.push(
      `source display macros ${mentioned} were found but not usable (commented out, non-integer, non-positive, or incomplete); they were ignored`,
    );
  }

  if (problem) {
    result.problem = problem;
    return result;
  }
  if (!resolution) {
    result.problem = `cannot determine display resolution${where}: pass --width and --height, set display.width/display.height in lvglui.json, or call init with width and height; this tool never defaults to 240x320`;
    return result;
  }

  result.width = resolution.width;
  result.height = resolution.height;
  result.source = resolution.source;

  // ---- Color depth ------------------------------------------------------
  const color = resolveColorDepth(config, sdkconfig, warnings);
  if (color.problem) {
    result.problem = color.problem;
    return result;
  }
  result.colorDepth = color.colorDepth;
  result.ok = true;
  return result;
}