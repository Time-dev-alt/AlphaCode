/**
 * The background-process worker.
 *
 * Bundled separately by scripts/build-pages.mjs and started with
 * `new Worker(__WORKER_URL__, { type: 'module' })`. It owns a Node runtime with
 * its own copy of the project, streams stdout/stderr to the page, and reports
 * back any files it changed so the main thread can persist them.
 */
import { NodeRuntime } from './node/runtime.js';
import { NodeFS, fromBytes } from './node/vfs.js';

let runtime = null;

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type !== 'run') return;

  const fs = new NodeFS({ cwd: '/app' });
  fs.hydrate(message.files || {});
  const post = (payload) => self.postMessage(payload);
  let finished = false;

  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    const changed = [];
    for (const abs of fs.pendingWrites()) {
      const projectPath = fs.toProjectPath(abs);
      if (!projectPath || projectPath.startsWith('node_modules')) continue;
      const bytes = fs.readFile(abs);
      const text = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|mp3|zip|gz|wasm)$/i.test(abs) ? bytes : fromBytes(bytes);
      changed.push({ path: projectPath, content: text });
    }
    post({ type: 'exit', code, files: changed, error: error ? String(error.message || error) : null });
  };

  runtime = new NodeRuntime({
    fs,
    onStdout: (text) => post({ type: 'stdout', text }),
    onStderr: (text) => post({ type: 'stderr', text }),
    env: message.env || {},
    cwd: '/app',
    argv: message.args || [],
  });

  // A long-running "server" is a setInterval loop that never lets the worker
  // idle. We keep it alive deliberately: that is what a background process is.
  self.addEventListener?.('error', (err) => post({ type: 'stderr', text: `uncaught: ${err.message}\n` }));

  try {
    if (message.code) {
      runtime.evaluateSource(message.code, message.file || '<inline>');
      setTimeout(() => finish(runtime.process.exitCode ?? 0), 25);
    } else if (message.file) {
      runtime.run(message.file, { args: message.args || [] });
      setTimeout(() => finish(runtime.exitCode ?? runtime.process.exitCode ?? 0), 25);
    } else {
      post({ type: 'stderr', text: 'job: give me a file to run\n' });
      finish(1);
    }
  } catch (err) {
    if (err?.isExit) finish(err.code ?? 0);
    else {
      post({ type: 'stderr', text: `${err?.name || 'Error'}: ${err?.message || err}\n` });
      finish(1, err);
    }
  }
};
