/**
 * In-browser compilers for native languages: C, C++ and Rust → WebAssembly.
 *
 * Three backends, in the order they are tried:
 *
 *  1. **A compile endpoint** (`settings.cCompilerEndpoint`) — any service you
 *     run that accepts `{language, source, filename}` and answers with a
 *     `wasm32-wasi` module. Smallest download, works on every browser, and the
 *     only path that can compile *any* language today.
 *  2. **Wasmer's WASIX registry images**, run through `@wasmer/sdk` from a CDN.
 *     `clang/clang` is a real clang + lld + wasi-sysroot that self-hosts in the
 *     tab (~30 MB compressed, cached after the first compile), which is what
 *     makes `cc main.c` work with no infrastructure at all. `zig` is used as a
 *     fallback for C/C++ when the clang image cannot be pulled.
 *  3. **Nothing** — and then the error says so, with the two ways to fix it.
 *
 * Rust is the honest one: `rustc` cannot target `wasm32-wasip1` without the
 * standard library, so the registry image is attempted first (`rust/rustc` or
 * the user's configured image) and the endpoint is the reliable route. A fake
 * "compiled" result would be worse than an explanation.
 *
 * Nothing in this file touches the network at import time; every SDK load is
 * lazy, because the switch defaults to off.
 */

export const WASMER_CDN = 'https://esm.sh/@wasmer/sdk@0.9.0';

/** Registry images per language. `fallback` is tried when the first is missing. */
export const TOOLCHAINS = {
  c: { image: 'clang/clang', fallback: 'zig/zig', args: (file, out) => ['clang', '--target=wasm32-wasi', '-O2', '-o', out, file] },
  cpp: { image: 'clang/clang', fallback: 'zig/zig', args: (file, out) => ['clang++', '--target=wasm32-wasi', '-O2', '-std=c++20', '-o', out, file] },
  rust: { image: 'rust/rustc', fallback: '', args: (file, out) => ['rustc', '--target', 'wasm32-wasip1', '-O', '-o', out, file] },
};

export const SUPPORTED_LANGUAGES = Object.keys(TOOLCHAINS);

/** Extensions a file needs to be compiled as each language. */
export const LANGUAGE_EXTENSIONS = {
  c: ['.c'],
  cpp: ['.cpp', '.cc', '.cxx', '.c++', '.hpp'],
  rust: ['.rs'],
};

export const languageFor = (path = '') => {
  const lower = String(path).toLowerCase();
  for (const [language, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (extensions.some((ext) => lower.endsWith(ext))) return language;
  }
  return '';
};

/** True when the switch is on — the UI reads this, not the settings object. */
export const toolchainsEnabled = (settings = {}) => settings?.wasmCompilers === true;

let sdkPromise = null;

/** Load `@wasmer/sdk` once, from the CDN, only when a compile is requested. */
export async function loadWasmerSdk({ cdn = WASMER_CDN } = {}) {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const sdk = await import(/* @vite-ignore */ cdn);
      const init = sdk.init || (() => {});
      await init();
      return sdk;
    })().catch((err) => {
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
}

export class ToolchainError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'ToolchainError';
    this.hint = hint;
  }
}

/**
 * Run a compiler image with one source file and read the module back.
 *
 * The SDK's filesystem is mounted from a JS object; the compiled module is read
 * out of the same mount after the process exits, which avoids needs any host
 * file access.
 */
export async function compileWithRegistry({ language, source, filename = 'main', settings = {}, onOutput = () => {} }) {
  const spec = TOOLCHAINS[language];
  if (!spec) throw new ToolchainError(`no in-browser toolchain for ${language}`);
  const { Wasmer } = await loadWasmerSdk({ cdn: settings.wasmerCdn || WASMER_CDN });

  const workdir = '/work';
  const out = '/work/out.wasm';
  const sourceName = filename.includes('.') ? filename.split('/').pop() : `${language === 'rust' ? 'main.rs' : 'main.c'}`;
  const images = [settings.compilerImage, spec.image, spec.fallback].filter(Boolean);

  let lastError = null;
  for (const image of images) {
    try {
      onOutput(`pulling ${image} (cached after the first run)…\n`);
      const pkg = await Wasmer.fromRegistry(image);
      const instance = await pkg.entrypoint.run({
        args: spec.args(sourceName, out),
        cwd: workdir,
        mount: {
          [workdir]: {
            directory: {
              [sourceName]: { file: { data: source } },
            },
          },
        },
        stdout: (line) => onOutput(`${line}\n`),
        stderr: (line) => onOutput(`${line}\n`),
      });
      const exit = await instance.wait();
      if (exit !== 0) throw new ToolchainError(`${image} exited with code ${exit}`);
      const bytes = await instance.readFile(out);
      if (!bytes?.length) throw new ToolchainError(`${image} produced no output module`);
      const module = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (module[0] !== 0x00 || module[1] !== 0x61) throw new ToolchainError(`${image} did not produce a wasm module`);
      return { wasm: module, image, backend: 'wasmer' };
    } catch (err) {
      lastError = err;
      onOutput(`${image}: ${err.message}\n`);
    }
  }
  throw new ToolchainError(
    `no in-browser toolchain could compile this ${language} file`,
    `${lastError?.message || 'the registry image was unreachable'}. ` +
      'Set a compile endpoint in Settings → Runtimes, or compile elsewhere and run the .wasm here.',
  );
}

/** POST the source to the user's own compile service. */
export async function compileWithEndpoint({ endpoint, language, source, filename, settings = {} }) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language, source, filename, target: 'wasm32-wasi', flags: settings.compilerFlags || '' }),
  });
  if (!res.ok) throw new ToolchainError(`compile endpoint returned ${res.status}`);
  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.length < 4 || buffer[0] !== 0x00 || buffer[1] !== 0x61) {
    throw new ToolchainError('compile endpoint did not return a wasm module');
  }
  return { wasm: buffer, image: endpoint, backend: 'endpoint' };
}

/**
 * Compile one source file, choosing a backend.
 * @returns {Promise<{wasm: Uint8Array, backend: string, image: string}>}
 */
export async function compileNative({ source, language, filename = 'main.c', settings = {}, onOutput = () => {} }) {
  const endpoint = settings.cCompilerEndpoint;
  if (endpoint) return compileWithEndpoint({ endpoint, language, source, filename, settings });
  if (!toolchainsEnabled(settings)) {
    throw new ToolchainError(
      'C/C++/Rust compilation is switched off.',
      'Turn on “In-browser compilers (WASM)” in Settings → Runtimes, or point AlphaCode at a compile endpoint.',
    );
  }
  return compileWithRegistry({ language, source, filename, settings, onOutput });
}

/** What the Settings panel reports, without downloading anything. */
export function toolchainStatus(settings = {}) {
  const enabled = toolchainsEnabled(settings);
  const endpoint = Boolean(settings.cCompilerEndpoint);
  return {
    enabled,
    endpoint,
    languages: enabled || endpoint ? SUPPORTED_LANGUAGES : [],
    detail: endpoint
      ? 'A compile endpoint is configured — every language goes through it.'
      : enabled
        ? 'In-browser clang (Wasmer WASIX). The first C/C++ compile downloads ~30 MB, then it is cached.'
        : 'Off. Turn on the switch to compile C, C++ and Rust in this tab, or use a compile endpoint.',
  };
}
