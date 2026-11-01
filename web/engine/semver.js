/**
 * A small, dependency-free semver engine.
 *
 * Used by both the Cloudflare edge resolver (functions/api/npm) and the
 * in-browser installer, so the version chosen by the edge and the version the
 * browser expects can never disagree. Supports the range grammar npm actually
 * uses in the wild: ^ ~ >= <= > < = x/* hyphen ranges, || unions, and
 * prerelease exclusion (a range only matches a prerelease if it names one).
 */

const NUM = /^[0-9]+$/;

export function parse(version) {
  if (!version) return null;
  const text = String(version).trim().replace(/^[=v]+/, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(text);
  if (!m) {
    // "1.2" and "1" are legal in ranges and in loose version strings
    const loose = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text);
    if (!loose) return null;
    return { major: +loose[1], minor: +(loose[2] || 0), patch: +(loose[3] || 0), pre: [], raw: text };
  }
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [], raw: text };
}

export function compare(a, b) {
  const x = typeof a === 'string' ? parse(a) : a;
  const y = typeof b === 'string' ? parse(b) : b;
  if (!x || !y) throw new Error(`cannot compare ${a} and ${b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1; // release > prerelease
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = NUM.test(p);
    const qn = NUM.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export const eq = (a, b) => compare(a, b) === 0;
export const gt = (a, b) => compare(a, b) > 0;

const bump = (v, at) => {
  if (at === 'major') return { major: v.major + 1, minor: 0, patch: 0, pre: [] };
  if (at === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0, pre: [] };
  return { major: v.major, minor: v.minor, patch: v.patch + 1, pre: [] };
};
const withPre = (v, pre) => ({ ...v, pre });
const lt = (a, b) => compare(a, b) < 0;
const lte = (a, b) => compare(a, b) <= 0;

/** Turn one comparator token into a predicate. Partial versions behave like x-ranges. */
function comparator(token) {
  const m = /^(>=|<=|>|<|=|\^|~>|~)?\s*v?([0-9xX*][0-9A-Za-z.*+-]*)$/.exec(token.trim());
  if (!m) return () => false;
  const op = m[1] || '=';
  const parts = m[2].split('-')[0].split('.');
  const given = parts.length;
  const wild = parts.map((p) => p === 'x' || p === 'X' || p === '*');
  const nums = parts.map((p) => (p === 'x' || p === 'X' || p === '*' ? null : Number(p)));
  const pre = (/-([0-9A-Za-z.-]+)$/.exec(m[2]) || [])[1];

  if (wild[0]) return () => true; // "*" / "x"

  const base = { major: nums[0] ?? 0, minor: nums[1] ?? 0, patch: nums[2] ?? 0, pre: pre ? pre.split('.') : [] };
  const precision = wild[1] ? 1 : wild[2] || given < 3 ? 2 : 3;

  switch (op) {
    case '^': {
      let high;
      if (base.major > 0) high = bump(base, 'major');
      else if (base.minor > 0 || precision <= 2) high = bump({ major: 0, minor: base.minor, patch: 0 }, 'minor');
      else high = bump({ major: 0, minor: 0, patch: base.patch }, 'patch');
      return (v) => lte(base, v) && lt(v, high);
    }
    case '~':
    case '~>': {
      const high = precision === 1 ? bump({ major: base.major, minor: 0, patch: 0 }, 'major') : bump(base, 'minor');
      return (v) => lte(base, v) && lt(v, high);
    }
    case '>':
      return (v) => (precision === 3 && !pre ? gt(v, base) : gt(v, bump(base, precision === 1 ? 'major' : 'minor')));
    case '>=':
      return (v) => lte(base, v) === true && compare(v, base) >= 0;
    case '<':
      return (v) => lt(v, withPre(base, [0])); // <1.2.3 never includes its prereleases
    case '<=':
      return (v) => lte(v, base);
    default: {
      if (precision === 3) return (v) => eq(v, base);
      if (precision === 2) return (v) => v.major === base.major && v.minor === base.minor;
      return (v) => v.major === base.major;
    }
  }
}

/** Parse a range into a list of comparator sets (OR of ANDs). */
export function parseRange(range) {
  const text = String(range ?? '').trim();
  if (!text || text === '*' || text === 'latest' || text === 'x') return [[]];
  return text
    .split('||')
    .map((part) => {
      const clean = part.trim();
      if (!clean) return [];
      // hyphen range "1.2.3 - 2.3.4"
      const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(clean);
      if (hyphen) return [`>=${hyphen[1]}`, `<=${hyphen[2]}`];
      return clean
        .replace(/(\^|~>|~|>=|<=|>|<|=)\s+/g, '$1')
        .split(/\s+/)
        .filter(Boolean);
    })
    .map((tokens) => tokens.map((t) => ({ raw: t, test: comparator(t) })));
}

export function satisfies(version, range) {
  const v = typeof version === 'string' ? parse(version) : version;
  if (!v) return false;
  const sets = parseRange(range);
  const anyPre = sets.some((set) => set.some((c) => /-/.test(String(c.raw).replace(/^[^0-9]*/, ''))));
  if (v.pre.length && !anyPre && !hasPreComparator(range)) return false;
  return sets.some((set) => set.every((c) => c.test(v)));
}

const hasPreComparator = (range) => /-\d|\d-[0-9A-Za-z]/.test(String(range)) && !String(range).includes(' - ');

/** Highest version in `versions` that satisfies `range`, or null. */
export function maxSatisfying(versions, range) {
  let best = null;
  for (const version of versions) {
    if (!satisfies(version, range)) continue;
    if (!best || gt(version, best)) best = version;
  }
  return best;
}

/** Resolve `dist-tags`-aware specifiers: "^1.2.3", "latest", "beta", "npm:other@1". */
export function resolveSpec(spec, distTags = {}) {
  const text = String(spec ?? '').trim();
  if (distTags[text]) return { range: distTags[text], tag: text };
  const alias = /^npm:([^@]+)(@.*)?$/.exec(text);
  if (alias) return { range: alias[2] ? alias[2].slice(1) : '*', alias: alias[1] };
  if (/^[a-z][\w.-]*$/i.test(text) && !/^\d/.test(text) && text !== 'latest') {
    if (distTags[text]) return { range: distTags[text], tag: text };
  }
  return { range: text || '*' };
}

export function validRange(range) {
  try {
    parseRange(range);
    return true;
  } catch {
    return false;
  }
}

export function sortDesc(versions) {
  return [...versions].filter((v) => parse(v)).sort((a, b) => compare(b, a));
}
