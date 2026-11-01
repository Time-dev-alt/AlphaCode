/**
 * Structured, redacting logger. Never prints secrets or API keys.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const level = LEVELS[process.env.ALPHACODE_LOG_LEVEL] ?? (process.env.NODE_ENV === 'test' ? LEVELS.error : LEVELS.info);

const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{12,})/g,
  /\b(sk-or-v1-[A-Za-z0-9_-]{12,})/g,
  /\b(AIza[0-9A-Za-z_-]{20,})/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})/g,
  /\b(vcp_[A-Za-z0-9]{20,})/g,
  /\b(nfp_[A-Za-z0-9]{20,})/g,
  /\b([A-Za-z0-9_-]{32,})\b(?<=.{0})/g,
];

export function redact(input) {
  if (typeof input !== 'string') {
    try {
      input = JSON.stringify(input);
    } catch {
      input = String(input);
    }
  }
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      // keep short identifiers (hashes, ids) readable; scrub long opaque tokens
      if (m.length < 34) return m;
      return m.slice(0, 6) + '…' + m.slice(-4);
    });
  }
  return out;
}

function emit(lv, msg, meta) {
  if (LEVELS[lv] < level) return;
  const line = {
    t: new Date().toISOString(),
    lv,
    msg: redact(msg),
  };
  if (meta !== undefined) line.meta = typeof meta === 'string' ? redact(meta) : meta;
  const text = `${line.t} ${lv.toUpperCase().padEnd(5)} ${line.msg}${
    line.meta !== undefined ? ' ' + (typeof line.meta === 'string' ? line.meta : redact(JSON.stringify(line.meta))) : ''
  }`;
  if (lv === 'error' || lv === 'warn') console.error(text);
  else console.log(text);
}

export const log = {
  debug: (m, meta) => emit('debug', m, meta),
  info: (m, meta) => emit('info', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  error: (m, meta) => emit('error', m, meta),
};
