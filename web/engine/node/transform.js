/**
 * ESM → CJS, in the tab.
 *
 * The runtime is synchronous (like Node's `require`), which is what makes
 * `import` of a CommonJS package and `require` of an ESM package both work
 * without a bundler. To get there, ESM source is rewritten into CommonJS at
 * load time. Top-level await cannot be represented in CJS, so it is reported
 * with a precise message instead of a mysterious syntax error.
 *
 * The scanner understands strings, template literals, comments and regex-ish
 * division well enough to avoid rewriting the word "import" inside a string —
 * which is the bug that makes naive regex rewriters useless on real packages.
 */

const KEYWORDS_BEFORE_STATEMENT = new Set([';', '{', '}', ')', '']);

/** Walk source, yielding [start, end] spans of top-level import/export statements. */
export function findModuleStatements(code) {
  const spans = [];
  let i = 0;
  let depth = 0;
  let lastSignificant = '';
  let atStatementStart = true;

  const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);

  while (i < code.length) {
    const c = code[i];

    // comments
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // strings
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < code.length) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      lastSignificant = 'string';
      atStatementStart = false;
      continue;
    }

    // template literals (including ${} nesting)
    if (c === '`') {
      i++;
      let nested = 0;
      while (i < code.length) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === '$' && code[i + 1] === '{') {
          nested++;
          i += 2;
          continue;
        }
        if (code[i] === '}' && nested) {
          nested--;
          i++;
          continue;
        }
        if (code[i] === '`' && !nested) {
          i++;
          break;
        }
        i++;
      }
      lastSignificant = 'string';
      atStatementStart = false;
      continue;
    }

    if (c === '{' || c === '(' || c === '[') depth++;
    if (c === '}' || c === ')' || c === ']') depth--;

    if (depth === 0 && atStatementStart && (code.startsWith('import', i) || code.startsWith('export', i))) {
      const word = code.startsWith('import', i) ? 'import' : 'export';
      const before = i === 0 ? '' : code[i - 1];
      const after = code[i + word.length] || '';
      const okBefore = before === '' || /\s|;|\}/.test(before);
      const okAfter = !isIdent(after);
      // `import(` is a dynamic import expression, not a statement.
      const isDynamic = word === 'import' && /^\s*\(/.test(code.slice(i + 6));
      // `export` inside a class body is impossible; a `{` after export is a list.
      if (okBefore && okAfter && !isDynamic) {
        const end = scanStatementEnd(code, i);
        spans.push([i, end]);
        i = end;
        lastSignificant = ';';
        atStatementStart = true;
        continue;
      }
    }

    if (!/\s/.test(c)) {
      lastSignificant = c;
      atStatementStart = lastSignificant === ';' || lastSignificant === '}' || (lastSignificant === '{' && depth === 0);
      if (KEYWORDS_BEFORE_STATEMENT.has(lastSignificant)) atStatementStart = true;
      if (c === ')' || c === ']') atStatementStart = false;
      else if (isIdent(c)) atStatementStart = false;
      if (lastSignificant === '}') atStatementStart = true;
    }
    i++;
  }
  return spans;
}

/** From the `import`/`export` keyword, find the end of the statement. */
function scanStatementEnd(code, start) {
  let i = start;
  let depth = 0;
  let sawBrace = false;
  if (code.startsWith('export', start) && /^export\s*(\*|\{)/.test(code.slice(start))) {
    // export {…} [from "…"]  /  export * from "…"
  }
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < code.length && code[i] !== q) i += code[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '`') {
      i++;
      while (i < code.length && code[i] !== '`') i += code[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      if (c === '{') sawBrace = true;
    }
    if (c === '}' || c === ')' || c === ']') depth--;
    if (depth <= 0 && c === ';') return i + 1;
    if (depth <= 0 && c === '\n') {
      // A newline ends an import/export statement unless the next non-space
      // token continues it with `from`.
      const rest = code.slice(i + 1);
      const next = rest.match(/^\s*(from)\s+/);
      if (next) {
        i++;
        continue;
      }
      const current = code.slice(start, i).trim();
      if (/^export\s*\{[^}]*$/.test(current)) {
        i++;
        continue;
      }
      return i;
    }
    i++;
  }
  void sawBrace;
  return code.length;
}

const NAME = '[A-Za-z_$][\\w$]*';

/** Split `a = 1, b = [1,2], c` on commas that are not nested. */
function splitTopLevel(input) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      current += c;
      if (c === '\\') {
        current += input[++i] || '';
        continue;
      }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      current += c;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Parse one import statement into {source, defaultName, namespace, named[]}. */
export function parseImport(statement) {
  const text = statement.replace(/^import\s+/, '').trim().replace(/;$/, '');
  const sideEffect = /^['"]([^'"]+)['"]$/.exec(text);
  if (sideEffect) return { source: sideEffect[1], named: [], sideEffect: true };
  const fromMatch = /^([\s\S]*?)\s*from\s*['"]([^'"]+)['"]$/.exec(text);
  if (!fromMatch) return null;
  const clause = fromMatch[1].trim();
  const source = fromMatch[2];
  const out = { source, named: [], defaultName: null, namespace: null };
  let rest = clause;
  const nsMatch = /^\*\s*as\s+([\w$]+)$/.exec(rest);
  if (nsMatch) {
    out.namespace = nsMatch[1];
    return out;
  }
  const namedMatch = /\{([\s\S]*)\}/.exec(rest);
  if (namedMatch) {
    out.named = namedMatch[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [imported, local] = part.split(/\s+as\s+/).map((s) => s.trim());
        return { imported: imported.replace(/^['"]|['"]$/g, ''), local: local || imported };
      });
    rest = rest.replace(namedMatch[0], '');
  }
  const def = new RegExp(`^(${NAME})\\s*,?\\s*$`).exec(rest.trim().replace(/,$/, ''));
  if (def) out.defaultName = def[1];
  else {
    const def2 = new RegExp(`^(${NAME})\\s*,`).exec(rest.trim());
    if (def2) out.defaultName = def2[1];
  }
  return out;
}

/** Parse `export …` into a description the rewriter can emit. */
export function parseExport(statement) {
  const text = statement.replace(/^export\s+/, '').trim().replace(/;$/, '');
  if (/^default\s+/.test(text)) {
    return { kind: 'default', value: text.replace(/^default\s+/, '') };
  }
  const list = /^\{([\s\S]*?)\}(?:\s*from\s*['"]([^'"]+)['"])?$/.exec(text);
  if (list) {
    const named = list[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((part) => {
        const [local, exported] = part.split(/\s+as\s+/).map((s) => s.trim());
        return { local: local.replace(/^['"]|['"]$/g, ''), exported: (exported || local).replace(/^['"]|['"]$/g, '') };
      });
    return { kind: 'list', named, source: list[2] || null };
  }
  const star = /^\*\s*(?:as\s+([\w$]+)\s*)?from\s*['"]([^'"]+)['"]$/.exec(text);
  if (star) return { kind: 'star', as: star[1] || null, source: star[2] };
  const decl = /^(const|let|var|function|class|async\s+function)\s+([\w$*]+)/.exec(text);
  if (decl) {
    return { kind: 'decl', decl: decl[1], name: decl[2], text };
  }
  return { kind: 'unknown', text };
}

/**
 * Rewrite ESM source to CommonJS.
 * @param {string} code
 * @param {{filename?: string, requireExpr?: string}} [options]
 */
export function esmToCjs(code, { filename = 'module.js' } = {}) {
  if (!/\b(import|export)\b/.test(code)) return { code, esm: false, exportsList: [] };

  const spans = findModuleStatements(code);
  if (!spans.length) return { code, esm: false, exportsList: [] };

  const imports = [];
  const replacements = [];
  const exportedNames = [];
  let exportIndex = 0;

  for (const [start, end] of spans) {
    const statement = code.slice(start, end);
    if (statement.startsWith('import')) {
      const parsed = parseImport(statement);
      if (!parsed) continue;
      const local = `__mod${imports.length}`;
      imports.push({ ...parsed, local });
      const lines = [`const ${local} = __require(${JSON.stringify(parsed.source)});`, `const ${local}__esm = __interop(${local});`];
      if (parsed.namespace) lines.push(`const ${parsed.namespace} = __ns(${local});`);
      if (parsed.defaultName) lines.push(`const ${parsed.defaultName} = ${local}__esm.default;`);
      for (const { imported, local: localName } of parsed.named) {
        lines.push(`const ${localName} = ${local}__esm[${JSON.stringify(imported)}];`);
      }
      replacements.push({ start, end, text: lines.join(' ') });
      continue;
    }
    // export …
    const parsed = parseExport(statement);
    if (parsed.kind === 'default') {
      const value = parsed.value;
      const named = /^(?:async\s+)?function\s+([\w$]+)/.exec(value) || /^class\s+([\w$]+)/.exec(value);
      if (named) {
        // keep the declaration (it may be referenced by name inside the module)
        replacements.push({ start, end, text: `${value}\n__exports.default = ${named[1]};` });
      } else if (/^(async\s+)?function\s*\(/.test(value) || /^class\s*\{/.test(value)) {
        replacements.push({ start, end, text: `__exports.default = (${value});` });
      } else {
        const name = `__default${exportIndex++}`;
        replacements.push({ start, end, text: `const ${name} = (${value});\n__exports.default = ${name};` });
      }
      exportedNames.push('default');
    } else if (parsed.kind === 'list') {
      const lines = [];
      if (parsed.source) {
        const local = `__mod${imports.length}`;
        imports.push({ source: parsed.source, named: [], local });
        lines.push(`const ${local} = __require(${JSON.stringify(parsed.source)});`);
        for (const { local: imported, exported } of parsed.named) {
          lines.push(`__exports[${JSON.stringify(exported)}] = ${local}[${JSON.stringify(imported)}];`);
          exportedNames.push(exported);
        }
      } else {
        for (const { local: value, exported } of parsed.named) {
          lines.push(`__exports[${JSON.stringify(exported)}] = ${value};`);
          exportedNames.push(exported);
        }
      }
      replacements.push({ start, end, text: lines.join(' ') });
    } else if (parsed.kind === 'star') {
      const local = `__mod${imports.length}`;
      imports.push({ source: parsed.source, named: [], local });
      if (parsed.as) {
        replacements.push({ start, end, text: `const ${local} = __require(${JSON.stringify(parsed.source)});\n__exports[${JSON.stringify(parsed.as)}] = __ns(${local});` });
        exportedNames.push(parsed.as);
      } else {
        replacements.push({ start, end, text: `const ${local} = __require(${JSON.stringify(parsed.source)});\nObject.keys(${local}).forEach((k) => { if (k !== 'default') __exports[k] = ${local}[k]; });` });
      }
    } else if (parsed.kind === 'decl') {
      // export const a = 1, b = 2;  |  export function f() {}
      const line = parsed.text;
      const names = [];
      if (/^(?:const|let|var)\s+/.test(line)) {
        for (const part of splitTopLevel(line.replace(/^(?:const|let|var)\s+/, ''))) {
          const n = part.split('=')[0].trim();
          if (new RegExp(`^${NAME}$`).test(n)) names.push(n);
        }
      } else {
        const m = /^(?:async\s+)?(?:function\s*\*?|class)\s+([\w$]+)/.exec(line);
        if (m) names.push(m[1]);
      }
      // Explicit assignments, never `eval`: the production bundle is minified,
      // and eval'd identifiers would be renamed out from under us.
      const assigns = names.map((n) => `__exports[${JSON.stringify(n)}] = ${n};`).join(' ');
      replacements.push({ start, end, text: `${line};\n${assigns}` });
      for (const n of names) exportedNames.push(n);
    }
  }

  // splice from the end so offsets stay valid
  replacements.sort((a, b) => b.start - a.start);
  let out = code;
  for (const r of replacements) out = out.slice(0, r.start) + r.text + out.slice(r.end);

  const header = [
    'Object.defineProperty(__exports, "__esModule", { value: true });',
    'const __interop = (m) => (m && m.__esModule ? m : { ...(m || {}), default: m && m.default !== undefined ? m.default : m });',
    'const __ns = (m) => { const ns = { ...(m || {}) }; if (ns.default === undefined) ns.default = m; return Object.freeze(ns); };',
  ].join('\n');

  return { code: `${header}\n${out}`, esm: true, exportsList: exportedNames };
}

/** Quick check used by the loader to pick a path without a full parse. */
export function looksEsm(code) {
  return /(^|\n)\s*(import\s+[\w$*{'"]|export\s+(default|const|let|var|function|class|\{|\*))/.test(String(code));
}
