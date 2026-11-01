/**
 * Node's standard library, implemented against the browser.
 *
 * Everything here exists because a real npm package will call it. The goal is
 * not API completeness — it is "the 40 modules that 95% of published packages
 * touch behave correctly". Anything genuinely impossible in a tab (native
 * addons, sockets, threads, process signals) fails loudly with a message that
 * tells the user what to do instead.
 */
import { Buffer } from 'buffer';
import { gzipSync, gunzipSync, deflateSync, inflateSync, zlibSync, unzlibSync, unzipSync, compressSync, decompressSync } from 'fflate';
import { fromBytes, toBytes, base64FromBytes, bytesFromBase64 } from './vfs.js';

/* --------------------------------------------------------------- errors -- */

const codedError = (code, message, extra = {}) => {
  const err = new Error(message);
  err.code = code;
  err.errno = -2;
  Object.assign(err, extra);
  return err;
};

const notSupported = (what, hint) => {
  const err = new Error(`${what} is not available in the browser runtime.${hint ? ` ${hint}` : ''}`);
  err.code = 'ENOTSUP';
  return err;
};

/* ----------------------------------------------------------- event loop -- */

export class EventEmitter {
  constructor() {
    this._events = Object.create(null);
    this._maxListeners = 10;
  }
  on(name, fn) {
    (this._events[name] ||= []).push(fn);
    return this;
  }
  addListener(name, fn) {
    return this.on(name, fn);
  }
  prependListener(name, fn) {
    (this._events[name] ||= []).unshift(fn);
    return this;
  }
  once(name, fn) {
    const wrapper = (...args) => {
      this.removeListener(name, wrapper);
      return fn.apply(this, args);
    };
    wrapper.listener = fn;
    return this.on(name, wrapper);
  }
  off(name, fn) {
    return this.removeListener(name, fn);
  }
  removeListener(name, fn) {
    const list = this._events[name];
    if (!list) return this;
    const index = list.findIndex((f) => f === fn || f.listener === fn);
    if (index >= 0) list.splice(index, 1);
    if (!list.length) delete this._events[name];
    return this;
  }
  removeAllListeners(name) {
    if (name) delete this._events[name];
    else this._events = Object.create(null);
    return this;
  }
  listeners(name) {
    return (this._events[name] || []).map((f) => f.listener || f);
  }
  rawListeners(name) {
    return [...(this._events[name] || [])];
  }
  listenerCount(name) {
    return (this._events[name] || []).length;
  }
  eventNames() {
    return Reflect.ownKeys(this._events);
  }
  setMaxListeners(n) {
    this._maxListeners = n;
    return this;
  }
  getMaxListeners() {
    return this._maxListeners;
  }
  emit(name, ...args) {
    const list = this._events[name];
    if (!list || !list.length) {
      if (name === 'error') {
        const err = args[0] instanceof Error ? args[0] : new Error(`Unhandled error. (${args[0]})`);
        throw err;
      }
      return false;
    }
    for (const fn of [...list]) {
      try {
        fn.apply(this, args);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
    return true;
  }
}

const once = (emitter, name) =>
  new Promise((resolve, reject) => {
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const cleanup = () => {
      emitter.removeListener('error', onError);
      emitter.removeListener(name, onEvent);
    };
    emitter.once('error', onError);
    emitter.once(name, onEvent);
  });

/* ------------------------------------------------------------- releases -- */

/** Readable / Writable / Duplex / Transform — enough for real packages. */
function makeStreams(EventEmitterClass) {
  class Stream extends EventEmitterClass {
    pipe(dest, options = {}) {
      this.on('data', (chunk) => {
        if (dest.write(chunk) === false && this.pause) this.pause();
      });
      const end = () => {
        if (!options.end) return;
        dest.end();
      };
      this.on('end', end);
      this.on('error', (err) => dest.emit?.('error', err));
      dest.on?.('drain', () => this.resume?.());
      return dest;
    }
  }

  class Readable extends Stream {
    constructor(options = {}) {
      super();
      this._readableState = { flowing: null, ended: false, buffer: [], objectMode: Boolean(options.objectMode) };
      if (options.read) this._read = options.read.bind(this);
    }
    _read() {
      this.push(null);
    }
    push(chunk, encoding) {
      if (chunk === null) {
        this._readableState.ended = true;
        if (this._readableState.flowing) queueMicrotask(() => this.emit('end'));
        return false;
      }
      const value = typeof chunk === 'string' && !this._readableState.objectMode ? Buffer.from(chunk, encoding || 'utf8') : chunk;
      if (this._readableState.flowing !== false) this.emit('data', value);
      else this._readableState.buffer.push(value);
      return true;
    }
    read(size) {
      const state = this._readableState;
      if (!state.buffer.length) {
        this._read();
        if (!state.buffer.length) return null;
      }
      if (size === undefined) {
        const all = state.buffer.splice(0);
        return all.length === 1 ? all[0] : Buffer.concat(all);
      }
      const out = [];
      let total = 0;
      while (state.buffer.length && total < size) {
        const chunk = state.buffer.shift();
        out.push(chunk);
        total += chunk.length ?? 1;
      }
      return out.length === 1 ? out[0] : Buffer.concat(out);
    }
    on(name, fn) {
      const result = super.on(name, fn);
      if (name === 'data') {
        this._readableState.flowing = true;
        // start pumping after the listener is attached
        queueMicrotask(() => {
          if (this._readableState.flowing === true && !this._readableState.ended) this._read();
        });
      }
      return result;
    }
    pause() {
      this._readableState.flowing = false;
      return this;
    }
    resume() {
      this._readableState.flowing = true;
      this._read();
      return this;
    }
    isPaused() {
      return this._readableState.flowing === false;
    }
    [Symbol.asyncIterator]() {
      const queue = [];
      let done = false;
      let waiter = null;
      const wake = () => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w();
        }
      };
      this.on('data', (chunk) => {
        queue.push(chunk);
        wake();
      });
      this.on('end', () => {
        done = true;
        wake();
      });
      this.on('error', (err) => {
        queue.push(err);
        done = true;
        wake();
      });
      return {
        next: async () => {
          while (!queue.length && !done) await new Promise((r) => (waiter = r));
          if (!queue.length && done) return { done: true, value: undefined };
          const value = queue.shift();
          if (value instanceof Error) throw value;
          return { done: false, value };
        },
        return: async () => ({ done: true, value: undefined }),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }
  }
  // `for await` support
  Readable.prototype[Symbol.asyncIterator] = function () {
    const queue = [];
    let done = false;
    let waiter = null;
    const wake = () => waiter && (waiter(), (waiter = null));
    this.on('data', (c) => {
      queue.push(c);
      wake();
    });
    this.on('end', () => {
      done = true;
      wake();
    });
    this.on('error', (e) => {
      queue.push(e);
      done = true;
      wake();
    });
    return {
      next: async () => {
        while (!queue.length && !done) await new Promise((r) => (waiter = r));
        if (!queue.length) return { done: true, value: undefined };
        const value = queue.shift();
        if (value instanceof Error) throw value;
        return { done: false, value };
      },
      return: async () => ({ done: true, value: undefined }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };

  class Writable extends Stream {
    constructor(options = {}) {
      super();
      this._writableState = { ended: false, pending: Promise.resolve() };
      if (options.write) this._write = options.write.bind(this);
      if (options.final) this._final = options.final.bind(this);
    }
    _write(chunk, encoding, callback) {
      callback();
    }
    write(chunk, encoding, callback) {
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      const value = typeof chunk === 'string' && !this.writableObjectMode ? Buffer.from(chunk, encoding || 'utf8') : chunk;
      try {
        this._write(value, encoding || 'utf8', (err) => {
          if (err) this.emit('error', err);
          callback?.(err);
        });
      } catch (err) {
        this.emit('error', err);
        callback?.(err);
      }
      return true;
    }
    end(chunk, encoding, callback) {
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
      }
      if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
      this._writableState.ended = true;
      const done = (err) => {
        if (err) this.emit('error', err);
        this.emit('finish');
        callback?.(err);
      };
      if (this._final) this._final(done);
      else queueMicrotask(() => done());
      return this;
    }
    cork() {}
    uncork() {}
    setDefaultEncoding() {
      return this;
    }
  }

  class Duplex extends Readable {
    constructor(options = {}) {
      super(options);
      this._writableState = { ended: false };
      if (options.write) this._write = options.write.bind(this);
    }
    write(chunk, encoding, callback) {
      Writable.prototype.write.call(this, chunk, encoding, callback);
      return true;
    }
    end(chunk, encoding, callback) {
      return Writable.prototype.end.call(this, chunk, encoding, callback);
    }
  }

  class Transform extends Duplex {
    constructor(options = {}) {
      super(options);
      this._transform = options.transform?.bind(this) || ((chunk, enc, cb) => cb(null, chunk));
    }
    _write(chunk, encoding, callback) {
      this._transform(chunk, encoding, (err, out) => {
        if (err) return callback(err);
        if (out !== undefined && out !== null) this.push(out);
        callback();
      });
    }
  }

  class PassThrough extends Transform {}

  return { Stream, Readable, Writable, Duplex, Transform, PassThrough, once };
}

/* ---------------------------------------------------------------- crypto -- */

/* Small, synchronous digests. `crypto.subtle` is async, and packages call
 * createHash() during module evaluation. */
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(bytes) {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const length = bytes.length;
  const total = ((length + 9 + 63) >> 6) << 6;
  const buffer = new Uint8Array(total);
  buffer.set(bytes);
  buffer[length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(total - 4, (length * 8) >>> 0, false);
  view.setUint32(total - 8, Math.floor((length * 8) / 0x100000000), false);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i], false);
  return out;
}

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

function sha1(bytes) {
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const length = bytes.length;
  const total = ((length + 9 + 63) >> 6) << 6;
  const buffer = new Uint8Array(total);
  buffer.set(bytes);
  buffer[length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(total - 4, (length * 8) >>> 0, false);
  view.setUint32(total - 8, Math.floor((length * 8) / 0x100000000), false);
  const w = new Uint32Array(80);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) outView.setUint32(i * 4, h[i], false);
  return out;
}
const rotl = (x, n) => (x << n) | (x >>> (32 - n));

/* md5 — short, table-free, and still used by plenty of packages */
function md5(bytes) {
  const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  const length = bytes.length;
  const total = ((length + 9 + 63) >> 6) << 6;
  const buffer = new Uint8Array(total);
  buffer.set(bytes);
  buffer[length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(total - 8, (length * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor((length * 8) / 0x100000000), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(offset + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const temp = D;
      D = C;
      C = B;
      const sum = (A + F + K[i] + M[g]) >>> 0;
      B = (B + rotl(sum, s[i])) >>> 0;
      A = temp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

function makeHash(algorithm, data = new Uint8Array(0)) {
  const algo = String(algorithm).toLowerCase().replace(/-/g, '');
  const digest = (bytes) => {
    if (algo === 'sha256') return sha256(bytes);
    if (algo === 'sha1') return sha1(bytes);
    if (algo === 'md5') return md5(bytes);
    if (algo === 'sha512' || algo === 'sha384') throw notSupported(`crypto.createHash('${algorithm}')`, 'Only md5, sha1 and sha256 are available offline.');
    throw notSupported(`crypto.createHash('${algorithm}')`);
  };
  let buffer = data instanceof Uint8Array ? data : toBytes(data);
  const hash = {
    update(chunk, encoding) {
      const bytes = chunk instanceof Uint8Array ? chunk : toBytes(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding || 'utf8'));
      const merged = new Uint8Array(buffer.length + bytes.length);
      merged.set(buffer);
      merged.set(bytes, buffer.length);
      buffer = merged;
      return hash;
    },
    digest(encoding) {
      const out = digest(buffer);
      if (!encoding) return Buffer.from(out);
      return Buffer.from(out).toString(encoding);
    },
    copy() {
      return makeHash(algorithm, buffer.slice());
    },
  };
  return hash;
}

function hmac(algorithm, key, data) {
  const blockSize = 64;
  let keyBytes = key instanceof Uint8Array ? key : toBytes(key);
  if (keyBytes.length > blockSize) keyBytes = makeHash(algorithm).update(keyBytes).digest();
  const pad = new Uint8Array(blockSize);
  pad.set(keyBytes);
  const inner = new Uint8Array(blockSize);
  const outer = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = pad[i] ^ 0x36;
    outer[i] = pad[i] ^ 0x5c;
  }
  const innerHash = makeHash(algorithm).update(inner).update(data).digest();
  return Buffer.from(makeHash(algorithm).update(outer).update(innerHash).digest());
}

/* ---------------------------------------------------------------- builtins */

/**
 * @param {object} ctx
 * @param {import('./vfs.js').NodeFS} ctx.fs
 * @param {object} ctx.process    the process object handed to user code
 * @param {(text: string) => void} ctx.stdout
 * @param {(text: string) => void} ctx.stderr
 * @param {(spec: string, from: string) => string} ctx.resolve  module resolver
 * @param {(path: string) => object} ctx.loadModule
 */
export function createBuiltins(ctx) {
  const { fs, process, stdout, stderr } = ctx;
  const streams = makeStreams(EventEmitter);

  /* ---- path (posix) ---- */
  const path = (() => {
    const normalize = (p) => {
      const abs = p.startsWith('/');
      const parts = [];
      for (const seg of String(p).split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
          if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
          else if (!abs) parts.push('..');
          continue;
        }
        parts.push(seg);
      }
      const out = parts.join('/');
      return abs ? `/${out}` : out || '.';
    };
    const join = (...args) => normalize(args.filter((a) => a !== undefined && a !== '').join('/'));
    const resolve = (...args) => {
      let resolved = '';
      for (let i = args.length - 1; i >= 0; i--) {
        const part = args[i];
        if (!part) continue;
        resolved = `${part}/${resolved}`;
        if (part.startsWith('/')) break;
      }
      if (!resolved.startsWith('/')) resolved = `${fs.cwd}/${resolved}`;
      return normalize(resolved);
    };
    const dirname = (p) => {
      const n = normalize(p);
      const i = n.lastIndexOf('/');
      if (i < 0) return '.';
      if (i === 0) return '/';
      return n.slice(0, i);
    };
    const basename = (p, ext) => {
      const name = normalize(p).split('/').pop() || '';
      return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name;
    };
    const extname = (p) => {
      const base = basename(p);
      const i = base.lastIndexOf('.');
      return i <= 0 ? '' : base.slice(i);
    };
    const relative = (from, to) => {
      const a = resolve(from).split('/').filter(Boolean);
      const b = resolve(to).split('/').filter(Boolean);
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/') || '';
    };
    const parse = (p) => {
      const dir = dirname(p);
      const base = basename(p);
      const ext = extname(p);
      return { root: p.startsWith('/') ? '/' : '', dir, base, ext, name: base.slice(0, base.length - ext.length) };
    };
    return {
      sep: '/',
      delimiter: ':',
      normalize,
      join,
      resolve,
      dirname,
      basename,
      extname,
      relative,
      parse,
      format: (obj) => {
        const dir = obj.dir || obj.root || '';
        const base = obj.base || `${obj.name || ''}${obj.ext || ''}`;
        return dir ? `${dir === '/' ? '' : dir}/${base}` : base;
      },
      isAbsolute: (p) => String(p).startsWith('/'),
      toNamespacedPath: (p) => p,
      posix: null,
      win32: null,
    };
  })();
  path.posix = path;
  path.win32 = path;

  /* ---- fs ---- */
  const watchFns = () => ({
    watch() {
      // A no-op watcher keeps dev-tool style packages working; changes come
      // from the agent's own tool calls, not from the OS.
      const watcher = new EventEmitter();
      watcher.close = () => {};
      return watcher;
    },
    watchFile: () => ({ close() {} }),
    unwatchFile: () => {},
  });

  const fsCallbacks = {
    readFileSync: (p, options) => {
      const encoding = typeof options === 'string' ? options : options?.encoding;
      const bytes = fs.readFile(p);
      return encoding ? fromBytes(bytes, encoding) : Buffer.from(bytes);
    },
    readFile: (p, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      const encoding = typeof options === 'string' ? options : options?.encoding;
      queueMicrotask(() => {
        try {
          cb(null, encoding ? fromBytes(fs.readFile(p), encoding) : Buffer.from(fs.readFile(p)));
        } catch (err) {
          cb(err);
        }
      });
    },
    writeFileSync: (p, data, options) => fs.writeFile(p, typeof data === 'string' ? toBytes(data) : toBytes(data)),
    appendFileSync: (p, data) => {
      const bytes = toBytes(data);
      let existing = new Uint8Array(0);
      try {
        existing = fs.readFile(p);
      } catch {
        /* new file */
      }
      const merged = new Uint8Array(existing.length + bytes.length);
      merged.set(existing);
      merged.set(bytes, existing.length);
      fs.writeFile(p, merged);
    },
    writeFile: (p, data, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      queueMicrotask(() => {
        try {
          fs.writeFile(p, toBytes(data));
          cb?.(null);
        } catch (err) {
          cb?.(err);
        }
      });
    },
    appendFile: (p, data, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      queueMicrotask(() => {
        try {
          fsCallbacks.appendFileSync(p, data);
          cb?.(null);
        } catch (err) {
          cb?.(err);
        }
      });
    },
    existsSync: (p) => Boolean(fs.stat(p)),
    exists: (p, callback) => queueMicrotask(() => callback(fsCallbacks.existsSync(p))),
    statSync: (p) => {
      const st = fs.stat(p);
      if (!st) throw codedError('ENOENT', `ENOENT: no such file or directory, stat '${fs.normalize(p)}'`);
      return st;
    },
    lstatSync: (p) => fsCallbacks.statSync(p),
    stat: (p, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      queueMicrotask(() => {
        try {
          cb(null, fsCallbacks.statSync(p));
        } catch (err) {
          cb(err);
        }
      });
    },
    lstat: (p, o, c) => fsCallbacks.stat(p, o, c),
    fstatSync: () => fsCallbacks.statSync(fs.cwd),
    fstat: (fd, cb) => fsCallbacks.stat(fs.cwd, cb),
    readdirSync: (p, options) => fs.readdir(p, { withFileTypes: Boolean(options?.withFileTypes) }),
    readdir: (p, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      queueMicrotask(() => {
        try {
          cb(null, fs.readdir(p, { withFileTypes: Boolean(typeof options === 'object' && options?.withFileTypes) }));
        } catch (err) {
          cb(err);
        }
      });
    },
    mkdirSync: (p, options) => fs.mkdir(p, options || {}),
    mkdir: (p, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      queueMicrotask(() => {
        try {
          fs.mkdir(p, typeof options === 'object' ? options : {});
          cb?.(null);
        } catch (err) {
          cb?.(err);
        }
      });
    },
    rmdirSync: (p, options) => fs.rmrf(p),
    rmdir: (p, options, cb) => {
      const callback = typeof options === 'function' ? options : cb;
      queueMicrotask(() => {
        try {
          fs.rmrf(p);
          callback?.(null);
        } catch (err) {
          callback?.(err);
        }
      });
    },
    rmSync: (p) => fs.rmrf(p),
    rm: (p, o, cb) => fsCallbacks.rmdir(p, o, cb),
    unlinkSync: (p) => fs.unlink(p),
    unlink: (p, cb) =>
      queueMicrotask(() => {
        try {
          fs.unlink(p);
          cb?.(null);
        } catch (err) {
          cb?.(err);
        }
      }),
    renameSync: (a, b) => fs.rename(a, b),
    rename: (a, b, cb) =>
      queueMicrotask(() => {
        try {
          fs.rename(a, b);
          cb?.(null);
        } catch (err) {
          cb?.(err);
        }
      }),
    copyFileSync: (a, b) => fs.copyFile(a, b),
    copyFile: (a, b, cb) =>
      queueMicrotask(() => {
        try {
          fs.copyFile(a, b);
          cb?.(null);
        } catch (err) {
          cb?.(err);
        }
      }),
    readlinkSync: () => fs.readlink(),
    symlinkSync: () => fs.symlink(),
    linkSync: () => fs.symlink(),
    realpathSync: Object.assign((p) => fs.normalize(p), { native: (p) => fs.normalize(p) }),
    realpath: (p, o, cb) => {
      const callback = typeof o === 'function' ? o : cb;
      queueMicrotask(() => callback(null, fs.normalize(p)));
    },
    accessSync: (p) => {
      if (!fs.stat(p)) throw codedError('ENOENT', `ENOENT: no such file or directory, access '${fs.normalize(p)}'`);
    },
    access: (p, mode, cb) => {
      const callback = typeof mode === 'function' ? mode : cb;
      queueMicrotask(() => callback(fs.stat(p) ? null : codedError('ENOENT', `ENOENT: access '${p}'`)));
    },
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 },
    ...watchFns(),
  };

  const fsPromises = {
    readFile: async (p, options) => fsCallbacks.readFileSync(p, options),
    writeFile: async (p, data, options) => fsCallbacks.writeFileSync(p, data, options),
    appendFile: async (p, data) => fsCallbacks.appendFileSync(p, data),
    readdir: async (p, options) => fsCallbacks.readdirSync(p, options),
    mkdir: async (p, options) => fsCallbacks.mkdirSync(p, options),
    rm: async (p) => fsCallbacks.rmSync(p),
    rmdir: async (p) => fsCallbacks.rmdirSync(p),
    unlink: async (p) => fsCallbacks.unlinkSync(p),
    rename: async (a, b) => fsCallbacks.renameSync(a, b),
    copyFile: async (a, b) => fsCallbacks.copyFileSync(a, b),
    stat: async (p) => fsCallbacks.statSync(p),
    lstat: async (p) => fsCallbacks.statSync(p),
    realpath: async (p) => fs.normalize(p),
    access: async (p) => fsCallbacks.accessSync(p),
    readlink: async () => fs.readlink(),
    symlink: async () => fs.symlink(),
    chmod: async () => undefined,
    chown: async () => undefined,
    utimes: async () => undefined,
    cp: async (a, b, options) => {
      const source = fs.stat(a);
      if (!source) throw codedError('ENOENT', `ENOENT: ${a}`);
      if (source.isDirectory()) {
        for (const entry of fs.walk(a)) {
          const target = b + entry.path.slice(fs.normalize(a).length);
          fs.writeFile(target, fs.readFile(entry.path));
        }
      } else fs.copyFile(a, b);
    },
    constants: fsCallbacks.constants,
  };

  const fsModule = {
    ...fsCallbacks,
    promises: fsPromises,
    default: null,
    createReadStream(p) {
      const bytes = fs.readFile(p);
      const stream = new streams.Readable();
      queueMicrotask(() => {
        stream.push(Buffer.from(bytes));
        stream.push(null);
      });
      return stream;
    },
    createWriteStream(p) {
      const chunks = [];
      const stream = new streams.Writable({
        write(chunk, enc, cb) {
          chunks.push(chunk);
          cb();
        },
        final: (cb) => {
          fs.writeFile(p, Buffer.concat(chunks));
          cb();
        },
      });
      return stream;
    },
    openSync: () => {
      throw notSupported('fs.openSync()', 'Use readFileSync/writeFileSync instead.');
    },
    readSync: () => {
      throw notSupported('fs.readSync()', 'Use readFileSync instead.');
    },
    writeSync: () => {
      throw notSupported('fs.writeSync()', 'Use writeFileSync instead.');
    },
    open: (_p, _f, cb) => queueMicrotask(() => cb?.(notSupported('fs.open()'))),
    close(fd, cb) {
      cb?.(null);
    },
    ftruncate() {},
    readFileUtf8: (p) => fromBytes(fs.readFile(p)),
    mkdtempSync: (prefix) => {
      const dir = `${prefix}${Math.random().toString(36).slice(2, 8)}`;
      fs.mkdir(dir, { recursive: true });
      return dir;
    },
    mkdtemp: (prefix, cb) => queueMicrotask(() => cb(null, fsModule.mkdtempSync(prefix))),
  };
  fsModule.default = fsModule;
  fsModule.promises.default = fsPromises;

  /* ---- os / process helpers ---- */
  const os = {
    platform: () => 'linux',
    type: () => 'Linux',
    arch: () => 'x64',
    release: () => '0.0.0-browser',
    version: () => '#1 AlphaCode browser runtime',
    hostname: () => 'alphacode',
    tmpdir: () => '/tmp',
    homedir: () => '/home/agent',
    userInfo: () => ({ username: 'agent', homedir: '/home/agent', shell: '/bin/sh', uid: 1000, gid: 1000 }),
    cpus: () => Array.from({ length: Math.max(2, Math.min(8, navigator?.hardwareConcurrency || 4)) }, () => ({ model: 'browser', speed: 1000 })),
    totalmem: () => 2 * 1024 ** 3,
    freemem: () => 1024 ** 3,
    loadavg: () => [0, 0, 0],
    uptime: () => Math.floor(performance.now() / 1000),
    endianness: () => 'LE',
    EOL: '\n',
    networkInterfaces: () => ({}),
    constants: {},
  };
  os.default = os;

  /* ---- util ---- */
  const inspect = (value, { depth = 2, colors = false } = {}) => {
    const seen = new WeakSet();
    const fmt = (v, d) => {
      if (v === null) return 'null';
      if (v === undefined) return 'undefined';
      if (typeof v === 'string') return `'${v.replace(/'/g, "\\'")}'`;
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
      if (typeof v === 'symbol') return v.toString();
      if (typeof v === 'function') return `[Function: ${v.name || 'anonymous'}]`;
      if (v instanceof Error) return `${v.name}: ${v.message}`;
      if (v instanceof Uint8Array) return `<Buffer ${v.length}>`;
      if (v instanceof Date) return v.toISOString();
      if (v instanceof RegExp) return String(v);
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
      if (d < 0) return Array.isArray(v) ? '[Array]' : '[Object]';
      if (Array.isArray(v)) return `[ ${v.map((x) => fmt(x, d - 1)).join(', ')} ]`;
      if (v instanceof Map) return `Map { ${[...v].map(([k, val]) => `${fmt(k, d - 1)} => ${fmt(val, d - 1)}`).join(', ')} }`;
      if (v instanceof Set) return `Set { ${[...v].map((x) => fmt(x, d - 1)).join(', ')} }`;
      const keys = Object.keys(v);
      if (!keys.length) return '{}';
      return `{ ${keys.map((k) => `${k}: ${fmt(v[k], d - 1)}`).join(', ')} }`;
    };
    void colors;
    return fmt(value, depth);
  };

  const util = {
    inspect,
    format(...args) {
      if (!args.length) return '';
      const [first, ...rest] = args;
      if (typeof first !== 'string') return [inspect(first), ...rest.map((a) => (typeof a === 'string' ? a : inspect(a)))].join(' ');
      let index = 0;
      const out = first.replace(/%[sdifjoO%]/g, (token) => {
        if (token === '%%') return '%';
        const value = rest[index++];
        if (token === '%s') return typeof value === 'string' ? value : inspect(value);
        if (token === '%d' || token === '%i') return String(Number(value));
        if (token === '%f') return String(parseFloat(value));
        if (token === '%j') return JSON.stringify(value);
        return inspect(value);
      });
      return [out, ...rest.slice(index).map((a) => (typeof a === 'string' ? a : inspect(a)))].join(' ');
    },
    promisify(fn) {
      return (...args) =>
        new Promise((resolve, reject) => {
          fn(...args, (err, value) => (err ? reject(err) : resolve(value)));
        });
    },
    callbackify(fn) {
      return (...args) => {
        const cb = args.pop();
        fn(...args).then((value) => cb(null, value), cb);
      };
    },
    inherits(ctor, superCtor) {
      Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
      ctor.super_ = superCtor;
    },
    deprecate(fn) {
      return fn;
    },
    types: {
      isDate: (v) => v instanceof Date,
      isRegExp: (v) => v instanceof RegExp,
      isPromise: (v) => v && typeof v.then === 'function',
      isArrayBuffer: (v) => v instanceof ArrayBuffer,
      isUint8Array: (v) => v instanceof Uint8Array,
      isAsyncFunction: (v) => typeof v === 'function' && v.constructor.name === 'AsyncFunction',
      isNativeError: (v) => v instanceof Error,
    },
    isDeepStrictEqual(a, b) {
      return JSON.stringify(a) === JSON.stringify(b);
    },
    TextEncoder,
    TextDecoder,
  };
  util.default = util;
  util._extend = (target, source) => Object.assign(target, source);

  /* ---- assert ---- */
  const assert = (value, message) => {
    if (!value) {
      const err = new Error(message || 'Assertion failed');
      err.name = 'AssertionError';
      err.code = 'ERR_ASSERTION';
      throw err;
    }
  };
  assert.ok = assert;
  assert.equal = (a, b, m) => assert(a == b, m || `${inspect(a)} == ${inspect(b)}`); // eslint-disable-line eqeqeq
  assert.notEqual = (a, b, m) => assert(a != b, m || `${inspect(a)} != ${inspect(b)}`); // eslint-disable-line eqeqeq
  assert.strictEqual = (a, b, m) => assert(Object.is(a, b) || a === b, m || `Expected ${inspect(a)} to equal ${inspect(b)}`);
  assert.notStrictEqual = (a, b, m) => assert(a !== b, m || `Expected ${inspect(a)} not to equal ${inspect(b)}`);
  assert.deepEqual = assert.deepStrictEqual = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), m || `Expected ${inspect(a)} to equal ${inspect(b)}`);
  assert.notDeepStrictEqual = (a, b, m) => assert(JSON.stringify(a) !== JSON.stringify(b), m);
  assert.throws = (fn, error, message) => {
    try {
      fn();
    } catch (err) {
      if (typeof error === 'function' && !(err instanceof error) && error.prototype) {
        throw new Error(message || `Expected ${error.name}, got ${err.name}: ${err.message}`);
      }
      return;
    }
    throw new Error(message || 'Missing expected exception');
  };
  assert.doesNotThrow = (fn, message) => {
    try {
      fn();
    } catch (err) {
      throw new Error(message || `Got unwanted exception: ${err.message}`);
    }
  };
  assert.rejects = async (promise, message) => {
    try {
      await (typeof promise === 'function' ? promise() : promise);
    } catch {
      return;
    }
    throw new Error(message || 'Missing expected rejection');
  };
  assert.fail = (message) => {
    throw new Error(message || 'Failed');
  };
  assert.ifError = (err) => {
    if (err) throw err;
  };
  assert.match = (value, re, m) => assert(re.test(String(value)), m || `${inspect(value)} did not match ${re}`);
  assert.doesNotMatch = (value, re, m) => assert(!re.test(String(value)), m);
  assert.AssertionError = class AssertionError extends Error {};
  assert.strict = assert;
  assert.default = assert;

  /* ---- zlib (sync via fflate) ---- */
  const zlib = {
    gzipSync: (data) => Buffer.from(gzipSync(toBytes(data))),
    gunzipSync: (data) => Buffer.from(gunzipSync(toBytes(data))),
    deflateSync: (data) => Buffer.from(deflateSync(toBytes(data))),
    inflateSync: (data) => Buffer.from(inflateSync(toBytes(data))),
    deflateRawSync: (data) => Buffer.from(zlibSync(toBytes(data), { level: 6, mem: 8 })),
    inflateRawSync: (data) => Buffer.from(unzlibSync(toBytes(data))),
    brotliDecompressSync: () => {
      throw notSupported('zlib.brotliDecompressSync()', 'Brotli is not bundled; gzip and deflate are.');
    },
    constants: { Z_NO_FLUSH: 0, Z_SYNC_FLUSH: 2, Z_FINISH: 4, GZIP: 0, DEFLATE: 1 },
  };
  zlib.default = zlib;

  /* ---- crypto ---- */
  const randomBytes = (size) => {
    const out = new Uint8Array(size);
    crypto.getRandomValues(out);
    return Buffer.from(out);
  };
  const cryptoModule = {
    createHash: (algorithm) => makeHash(algorithm),
    createHmac(algorithm, key) {
      const chunks = [];
      const api = {
        update(chunk) {
          chunks.push(toBytes(chunk));
          return api;
        },
        digest(encoding) {
          const data = Buffer.concat(chunks.map((c) => Buffer.from(c)));
          const out = hmac(algorithm, key, data);
          return encoding ? out.toString(encoding) : out;
        },
      };
      return api;
    },
    randomBytes,
    randomFillSync: (buffer) => {
      crypto.getRandomValues(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
      return buffer;
    },
    randomUUID: () => crypto.randomUUID(),
    getRandomValues: (arr) => crypto.getRandomValues(arr),
    timingSafeEqual: (a, b) => {
      if (a.length !== b.length) return false;
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
      return diff === 0;
    },
    createCipheriv: () => {
      throw notSupported('crypto.createCipheriv()', 'Symmetric ciphers are not bundled; use WebCrypto (crypto.subtle) in your own code.');
    },
    webcrypto: typeof crypto !== 'undefined' ? crypto : undefined,
    subtle: typeof crypto !== 'undefined' ? crypto.subtle : undefined,
    constants: {},
    default: null,
  };
  cryptoModule.default = cryptoModule;

  /* ---- net-less network modules ---- */
  const http = (() => {
    const request = (options, callback) => {
      const url = typeof options === 'string' ? options : `${options.protocol || 'https:'}//${options.hostname || options.host || 'localhost'}${options.port ? `:${options.port}` : ''}${options.path || '/'}`;
      const req = new EventEmitter();
      const chunks = [];
      req.write = (chunk) => {
        chunks.push(toBytes(chunk));
        return req;
      };
      req.setHeader = () => req;
      req.getHeader = () => undefined;
      req.removeHeader = () => req;
      req.setTimeout = (_ms, cb) => {
        if (cb) req.once('timeout', cb);
        return req;
      };
      req.abort = () => {};
      req.destroy = () => {};
      req.end = async (chunk) => {
        if (chunk) chunks.push(toBytes(chunk));
        try {
          const res = await fetch(url, {
            method: options.method || 'GET',
            headers: options.headers || {},
            body: chunks.length ? Buffer.concat(chunks.map((c) => Buffer.from(c))) : undefined,
          });
          const buffer = Buffer.from(await res.arrayBuffer());
          const stream = new streams.Readable();
          stream.statusCode = res.status;
          stream.statusMessage = res.statusText;
          stream.headers = Object.fromEntries(res.headers.entries());
          stream.setEncoding = () => stream;
          stream.push(buffer);
          stream.push(null);
          callback?.(stream);
          stream.on('data', (d) => res && void d);
        } catch (err) {
          req.emit('error', err);
        }
      };
      return req;
    };
    return {
      request,
      get: (options, callback) => {
        const req = request(options, callback);
        req.end();
        return req;
      },
      createServer: () => {
        throw notSupported('http.createServer()', 'A browser tab cannot listen on a port. Use a preview or deploy the app instead.');
      },
      Agent: class Agent {},
      STATUS_CODES: { 200: 'OK', 404: 'Not Found', 500: 'Internal Server Error' },
    };
  })();
  http.default = http;

  /* ---- misc small modules ---- */
  const querystring = {
    parse: (text) => Object.fromEntries(new URLSearchParams(String(text || ''))),
    stringify: (obj) => new URLSearchParams(Object.entries(obj || {}).map(([k, v]) => [k, String(v)])).toString(),
    escape: encodeURIComponent,
    unescape: decodeURIComponent,
  };
  querystring.default = querystring;

  const url = {
    URL,
    URLSearchParams,
    parse: (input) => new URL(input, `https://placeholder.local/`),
    format: (obj) => String(obj),
    resolve: (from, to) => new URL(to, from).toString(),
    fileURLToPath: (input) => new URL(input).pathname,
    pathToFileURL: (input) => new URL(`file://${input.startsWith('/') ? '' : '/'}${input}`),
  };
  url.default = url;

  const stringDecoder = {
    StringDecoder: class StringDecoder {
      constructor(encoding = 'utf8') {
        this.encoding = encoding;
        this.decoder = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding);
      }
      write(bytes) {
        return this.decoder.decode(bytes, { stream: true });
      }
      end(bytes) {
        return bytes ? this.decoder.decode(bytes) : this.decoder.decode();
      }
    },
  };
  stringDecoder.default = stringDecoder;

  const timers = {
    setTimeout,
    setInterval,
    setImmediate: (fn, ...args) => setTimeout(() => fn(...args), 0),
    clearTimeout,
    clearInterval,
    clearImmediate: clearTimeout,
  };
  timers.promises = { setTimeout: async (ms) => new Promise((r) => setTimeout(r, ms)) };
  timers.default = timers;

  const childProcess = {
    spawnSync: (cmd, args = []) => ({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(`spawnSync(${cmd}) is not available: a browser tab cannot start OS processes.`),
      error: notSupported(`child_process.spawnSync('${cmd}')`),
      pid: -1,
      output: [],
    }),
    execSync: (cmd) => {
      throw notSupported(`child_process.execSync('${String(cmd).slice(0, 40)}')`, 'Run the command with the shell tool instead — it is implemented natively.');
    },
    exec: (_cmd, cb) => queueMicrotask(() => cb?.(notSupported('child_process.exec()'))),
    spawn: () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write() {}, end() {} };
      proc.kill = () => {};
      queueMicrotask(() => proc.emit('error', notSupported('child_process.spawn()', 'Use background jobs (jobs / fg in the terminal) to run long tasks.')));
      return proc;
    },
    execFile: () => childProcess.spawn(),
    fork: () => childProcess.spawn(),
  };
  childProcess.default = childProcess;

  const workerThreads = {
    isMainThread: true,
    parentPort: null,
    workerData: undefined,
    Worker: class Worker {
      constructor() {
        throw notSupported('worker_threads', 'Use the terminal’s background jobs (jobs / fg) instead.');
      }
    },
  };

  const vm = {
    createContext: (sandbox = {}) => sandbox,
    runInContext: (code, sandbox) => new Function('sandbox', 'with (sandbox) { return eval(arguments[1]); }')(sandbox, code),
    runInNewContext: (code, sandbox = {}) => vm.runInContext(code, sandbox),
    runInThisContext: (code) => new Function(code)(),
    Script: class Script {
      constructor(code) {
        this.code = code;
      }
      runInThisContext() {
        return new Function(this.code)();
      }
      runInNewContext(sandbox = {}) {
        return vm.runInContext(this.code, sandbox);
      }
    },
  };

  const module_ = {
    createRequire: () => ctx.require,
    builtinModules: [],
    isBuiltin: (name) => Boolean(BUILTIN_NAMES.has(String(name).replace(/^node:/, ''))),
  };

  const perfHooks = {
    performance,
    now: () => performance.now(),
    PerformanceObserver: class PerformanceObserver {
      observe() {}
      disconnect() {}
    },
  };

  const tty = { isatty: () => false, ReadStream: class {}, WriteStream: class {} };

  const BUILTINS = {
    events: EventEmitter,
    fs: fsModule,
    'fs/promises': fsPromises,
    path,
    os,
    util,
    assert,
    zlib,
    crypto: cryptoModule,
    http,
    https: http,
    querystring,
    url,
    string_decoder: stringDecoder,
    timers,
    'timers/promises': timers.promises,
    child_process: childProcess,
    worker_threads: workerThreads,
    vm,
    module: module_,
    perf_hooks: perfHooks,
    tty,
    stream: { ...streams, default: streams },
    process: { ...process, default: process },
    buffer: { Buffer, constants: Buffer.constants || {}, default: { Buffer } },
    console: Object.assign(Object.create(console), {
      log: (...a) => stdout(`${util.format(...a)}\n`),
      info: (...a) => stdout(`${util.format(...a)}\n`),
      debug: (...a) => stdout(`${util.format(...a)}\n`),
      warn: (...a) => stderr(`${util.format(...a)}\n`),
      error: (...a) => stderr(`${util.format(...a)}\n`),
      trace: (...a) => stderr(`${util.format(...a)}\n`),
      dir: (value) => stdout(`${util.inspect(value)}\n`),
      table: (value) => stdout(`${util.inspect(value)}\n`),
      time: () => {},
      timeEnd: () => {},
      group: (...a) => stdout(`${util.format(...a)}\n`),
      groupEnd: () => {},
    }),
    net: {
      createServer: () => {
        throw notSupported('net.createServer()', 'No sockets in a browser tab.');
      },
      connect: () => {
        throw notSupported('net.connect()');
      },
      Socket: class Socket {},
    },
    dns: { lookup: (_h, cb) => queueMicrotask(() => cb(null, '127.0.0.1', 4)), promises: { lookup: async () => ({ address: '127.0.0.1', family: 4 }) } },
    async_hooks: { AsyncLocalStorage: class AsyncLocalStorage { run(store, fn) { return fn(); } getStore() { return undefined; } }, createHook: () => ({ enable() {}, disable() {} }) },
    readline: {
      createInterface: ({ input } = {}) => {
        const rl = new EventEmitter();
        rl.question = (_q, cb) => cb('');
        rl.setPrompt = () => {};
        rl.prompt = () => {};
        rl.close = () => rl.emit('close');
        if (input?.on) input.on('data', (line) => rl.emit('line', String(line).trim()));
        return rl;
      },
    },
    punycode: { toASCII: (s) => s, toUnicode: (s) => s },
    constants: { ...fsCallbacks.constants },
  };

  for (const [name, mod] of Object.entries(BUILTINS)) {
    if (mod && typeof mod === 'object' && !('default' in mod)) mod.default = mod;
  }

  BUILTIN_NAMES.clear();
  for (const name of Object.keys(BUILTINS)) BUILTIN_NAMES.add(name);

  void base64FromBytes;
  void bytesFromBase64;
  void stderr;
  void ctx.resolve;

  return BUILTINS;
}

export const BUILTIN_NAMES = new Set();

export function isBuiltin(name) {
  return BUILTIN_NAMES.has(String(name).replace(/^node:/, ''));
}

export function getBuiltin(name) {
  return BUILTIN_CACHE.get(String(name).replace(/^node:/, ''));
}

const BUILTIN_CACHE = new Map();

/** Called by the runtime once per process to bind fs/process into the modules. */
export function installBuiltins(builtins) {
  for (const [name, mod] of Object.entries(builtins)) BUILTIN_CACHE.set(name, mod);
  return BUILTIN_CACHE;
}
