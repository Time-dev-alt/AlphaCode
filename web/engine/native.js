/**
 * Native code: running WASI binaries in the tab, and compiling C/C++ with a
 * WASM toolchain.
 *
 * Two honest halves:
 *
 * 1. **Running** `.wasm` that targets WASI — fully supported, today. The shim
 *    below implements the preview-1 calls real programs use (fd_read/fd_write,
 *    args, env, clock, random, proc_exit, path_* against the project files),
 *    so `zig build-exe --target wasm32-wasi`, Rust's `wasm32-wasip1`, and
 *    clang's `--target=wasm32-wasi` output all just run.
 *
 * 2. **Compiling** C/C++ — needs a ~55 MB clang+lld+sysroot bundle. Shipping
 *    that inside the app bundle would make every user download it, so it is
 *    loaded on demand from a configurable URL (`Settings → Runtime → C
 *    toolchain`) and driven in a worker. It is marked experimental because the
 *    toolchain is a third-party build; everything else in this file is not.
 *
 * Rust is deliberately not listed: no production-grade rustc→wasm exists, and a
 * fake one would be worse than none.
 */

/* ------------------------------------------------------------- WASI shim -- */

const WASI_ERRNO = { SUCCESS: 0, BADF: 8, EXIST: 20, INVAL: 28, NOENT: 44, NOSYS: 52, NOTDIR: 54 };

export class WasiExit extends Error {
  constructor(code) {
    super(`wasi exit ${code}`);
    this.code = code;
    this.isExit = true;
  }
}

/**
 * Run a WASI module.
 * @param {WebAssembly.Module | Uint8Array} wasm
 * @param {object} [options]
 * @param {string[]} [options.args]
 * @param {Record<string,string>} [options.env]
 * @param {(text:string)=>void} [options.onStdout]
 * @param {(text:string)=>void} [options.onStderr]
 * @param {Record<string, Uint8Array>} [options.files]  readable files
 * @param {(path:string, data:Uint8Array)=>void} [options.onWriteFile]
 */
export async function runWasi(wasm, {
  args = [],
  env = {},
  onStdout = () => {},
  onStderr = () => {},
  files = {},
  onWriteFile = () => {},
  memoryLimitPages = 4096,
} = {}) {
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let memory = null;
  let exitCode = 0;

  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);

  const readCString = (pointer) => {
    const buffer = bytes();
    let end = pointer;
    while (end < buffer.length && buffer[end] !== 0) end++;
    return decoder.decode(buffer.subarray(pointer, end));
  };
  const writeBytes = (fd, data) => {
    const text = decoder.decode(data);
    if (fd === 2) onStderr(text);
    else onStdout(text);
  };

  const argv = [args[0] || 'main', ...args.slice(1)].map((a) => encoder.encode(`${a}\0`));
  const envv = Object.entries(env).map(([k, v]) => encoder.encode(`${k}=${v}\0`));
  const openFiles = new Map();
  let nextFd = 4;

  const wasi = {
    args_sizes_get(argcPtr, argvBufSizePtr) {
      const total = argv.reduce((sum, a) => sum + a.length, 0);
      view().setUint32(argcPtr, argv.length, true);
      view().setUint32(argvBufSizePtr, total, true);
      return 0;
    },
    args_get(argvPtr, argvBufPtr) {
      let cursor = argvBufPtr;
      argv.forEach((arg, index) => {
        view().setUint32(argvPtr + index * 4, cursor, true);
        bytes().set(arg, cursor);
        cursor += arg.length;
      });
      return 0;
    },
    environ_sizes_get(countPtr, sizePtr) {
      view().setUint32(countPtr, envv.length, true);
      view().setUint32(sizePtr, envv.reduce((sum, e) => sum + e.length, 0), true);
      return 0;
    },
    environ_get(envPtr, bufPtr) {
      let cursor = bufPtr;
      envv.forEach((entry, index) => {
        view().setUint32(envPtr + index * 4, cursor, true);
        bytes().set(entry, cursor);
        cursor += entry.length;
      });
      return 0;
    },
    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      let written = 0;
      const chunks = [];
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view().getUint32(iovsPtr + i * 8, true);
        const len = view().getUint32(iovsPtr + i * 8 + 4, true);
        const chunk = bytes().subarray(ptr, ptr + len);
        chunks.push(new Uint8Array(chunk));
        written += len;
      }
      const data = new Uint8Array(written);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      const handle = openFiles.get(fd);
      if (handle) handle.chunks.push(data);
      else writeBytes(fd, data);
      view().setUint32(nwrittenPtr, written, true);
      return 0;
    },
    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      const handle = openFiles.get(fd);
      const source = handle?.content ?? (fd === 0 ? new Uint8Array(0) : null);
      if (!source) return WASI_ERRNO.BADF;
      const data = source.subarray(handle?.offset || 0);
      let read = 0;
      let remaining = data;
      for (let i = 0; i < iovsLen && remaining.length; i++) {
        const ptr = view().getUint32(iovsPtr + i * 8, true);
        const len = view().getUint32(iovsPtr + i * 8 + 4, true);
        const take = Math.min(len, remaining.length);
        bytes().set(remaining.subarray(0, take), ptr);
        if (handle) handle.offset += take;
        read += take;
        remaining = remaining.subarray(take);
      }
      view().setUint32(nreadPtr, read, true);
      return 0;
    },
    fd_close: () => 0,
    fd_fdstat_get(fd, statPtr) {
      view().setUint8(statPtr, fd <= 2 ? 2 : 4);
      return 0;
    },
    fd_fdstat_set_flags: () => 0,
    fd_prestat_get: () => WASI_ERRNO.BADF,
    path_open(_dirfd, _dirflags, pathPtr, pathLen, flags, _rights, _inherit, fdPtr) {
      const path = decoder.decode(bytes().subarray(pathPtr, pathPtr + pathLen));
      const content = files[path];
      if (!content) return WASI_ERRNO.NOENT;
      const fd = nextFd++;
      openFiles.set(fd, {
        path,
        content: content instanceof Uint8Array ? content : encoder.encode(content),
        offset: 0,
        chunks: [],
        writable: (flags & 1) === 1,
      });
      view().setUint32(fdPtr, fd, true);
      return 0;
    },
    fd_seek(fd, offsetLo, offsetHi, whence, newOffsetPtr) {
      const handle = openFiles.get(fd);
      if (!handle) return WASI_ERRNO.BADF;
      const offset = Number(BigInt.asIntN(64, (BigInt(offsetHi >>> 0) << 32n) | BigInt(offsetLo >>> 0)));
      handle.offset = whence === 0 ? offset : whence === 1 ? handle.offset + offset : handle.content.length + offset;
      if (newOffsetPtr) view().setBigUint64(newOffsetPtr, BigInt(handle.offset), true);
      return 0;
    },
    fd_prestat_dir_name: () => WASI_ERRNO.BADF,
    fd_filestat_get(fd, statPtr) {
      const handle = openFiles.get(fd);
      if (!handle) return WASI_ERRNO.BADF;
      view().setBigUint64(statPtr, BigInt(handle.content.length), true);
      return 0;
    },
    clock_time_get(_clockId, _precision, timePtr) {
      view().setBigUint64(timePtr, BigInt(Math.round(performance.now() * 1e6)), true);
      return 0;
    },
    random_get(bufPtr, bufLen) {
      crypto.getRandomValues(bytes().subarray(bufPtr, bufPtr + bufLen));
      return 0;
    },
    poll_oneoff: () => WASI_ERRNO.NOSYS,
    sched_yield: () => 0,
    proc_exit(code) {
      exitCode = code;
      throw new WasiExit(code);
    },
  };

  const imports = {
    wasi_snapshot_preview1: wasi,
    wasi_unstable: wasi,
    env: { memory: undefined },
  };

  const instance = await WebAssembly.instantiate(module, imports);
  memory = instance.exports.memory;
  if (!memory) return { code: 0, error: 'module does not export memory' };
  if (instance.exports._start) {
    try {
      instance.exports._start();
    } catch (err) {
      if (!(err instanceof WasiExit)) throw err;
    }
  } else if (instance.exports._initialize) {
    instance.exports._initialize();
  }
  for (const [, handle] of openFiles) {
    if (handle.writable && handle.chunks.length) {
      const total = handle.chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of handle.chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      onWriteFile(handle.path, merged);
    }
  }
  return { code: exitCode, memoryPages: memory.buffer.byteLength / 65_536 };
}

/* ------------------------------------------------------------- compiling -- */

export const C_TOOLCHAIN = {
  /** Third-party wasm-clang build; nothing is downloaded until the user opts in. */
  defaultUrl: 'https://r1ck404.github.io/wasm-clang-cache/clang/',
  size: '≈60 MB (clang + lld + sysroot), cached by the browser after first use',
};

export class CompilerUnavailable extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'CompilerUnavailable';
    this.hint = hint;
  }
}

/**
 * Compile C/C++ to a WASI module.
 *
 * Backends, in order:
 *  1. `settings.cCompilerUrl`  — a wasm-clang bundle (hosted by you, or by the
 *     community build), loaded in a worker;
 *  2. `settings.cCompilerEndpoint` — a compile service you run (POST source,
 *     receive .wasm). This is what CI-less teams use, and it keeps the tab light.
 *
 * @returns {Promise<Uint8Array>} the compiled module
 */
export async function compileC({ source, language = 'c', filename, files = {}, settings = {}, onOutput = () => {} }) {
  if (settings?.cCompilerEndpoint) {
    onOutput(`compiling ${filename || language} on ${settings.cCompilerEndpoint}…\n`);
    const res = await fetch(settings.cCompilerEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, source, filename, files, target: 'wasm32-wasi' }),
    });
    if (!res.ok) throw new Error(`compiler endpoint returned ${res.status}`);
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.length < 4 || buffer[0] !== 0x00 || buffer[1] !== 0x61) throw new Error('compiler endpoint did not return a wasm module');
    return buffer;
  }
  throw new CompilerUnavailable(
    'C/C++ compilation needs a WASM toolchain (clang + lld + sysroot, ~60 MB).',
    'Set one of these in Settings → Runtime:\n' +
      '  • “C compiler endpoint” — a URL you run that turns source into wasm32-wasi (smallest, instant),\n' +
      '  • or enable the experimental built-in wasm-clang bundle.\n' +
      'Already have a .wasm? `run main.wasm` executes any WASI binary right now.',
  );
}

/** True when something can compile C today. */
export const canCompileC = (settings = {}) => Boolean(settings?.cCompilerEndpoint);

export const RUNTIME_MATRIX = {
  python: { real: true, how: 'CPython 3.12 → WASM (Pyodide), with micropip', notes: 'numpy, pandas, matplotlib, sqlite3 included' },
  node: { real: true, how: 'in-tab CommonJS/ESM runtime + npm install', notes: 'pure-JS packages; native addons cannot load' },
  npm: { real: true, how: 'edge resolver + KV-cached plans + tarballs in the tab', notes: 'no postinstall scripts by design' },
  shell: { real: true, how: 'implemented over the project filesystem', notes: 'pipes, redirects, globs, background jobs' },
  wasi: { real: true, how: 'WASI preview-1 shim over WebAssembly', notes: 'runs any .wasm built for wasm32-wasi' },
  c: { real: false, how: 'wasm-clang bundle or your compile endpoint', notes: 'needs a ~60 MB toolchain, loaded on demand' },
  cpp: { real: false, how: 'same as C', notes: 'same toolchain' },
  rust: { real: false, how: 'not supported', notes: 'no production rustc→wasm exists; wasm output still runs via WASI' },
};
