/**
 * Background processes.
 *
 * A browser tab cannot fork, but it can start a Web Worker and keep it running
 * while the user talks to the agent, switches panels, or navigates the SPA. That
 * is a real background process for our purposes: it has a pid, a log, an exit
 * code and a kill switch, and it survives everything short of closing the tab.
 *
 * `jobs`, `fg %1`, `kill %1` and a trailing `&` in the terminal are wired to
 * this manager, and the agent gets `job_start` / `job_output` / `job_kill` tools.
 */

export class Job {
  constructor({ id, command, projectId }) {
    this.id = id;
    this.pid = id;
    this.command = command;
    this.projectId = projectId;
    this.status = 'running';
    this.startedAt = Date.now();
    this.endedAt = null;
    this.exitCode = null;
    this.log = '';
    this.maxLog = 200_000;
    this.worker = null;
    this.listeners = new Set();
  }

  append(text) {
    this.log += text;
    if (this.log.length > this.maxLog) this.log = this.log.slice(-this.maxLog);
    for (const fn of this.listeners) {
      try {
        fn(text);
      } catch {
        /* a broken listener must not kill the job */
      }
    }
  }

  onOutput(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get durationMs() {
    return (this.endedAt || Date.now()) - this.startedAt;
  }
}

export class JobManager {
  /**
   * @param {object} deps
   * @param {() => Worker} deps.spawnWorker  creates the runtime worker
   * @param {(path: string, content: string) => Promise<void>} deps.writeFile
   * @param {(text: string) => void} [deps.onEvent]
   */
  constructor({ spawnWorker, writeFile, onEvent = () => {}, snapshot = null }) {
    this.spawnWorker = spawnWorker;
    this.writeFile = writeFile;
    this.snapshot = snapshot;
    this.onEvent = onEvent;
    this.jobs = new Map();
    this.nextId = 1;
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => a.id - b.id);
  }

  get(id) {
    const key = String(id).replace(/^%/, '');
    return this.jobs.get(Number(key)) || [...this.jobs.values()].find((job) => String(job.id) === key) || null;
  }

  /**
   * Start a script in the background.
   * @param {object} options
   * @param {string} options.command   display string, e.g. "node server.js"
   * @param {string} [options.file]    entry file inside the project
   * @param {string} [options.code]    inline source
   * @param {string[]} [options.args]
   * @param {Record<string,string>} [options.files]  project snapshot
   */
  start({ command, file, code, args = [], files = null, projectId = '' }) {
    const id = this.nextId++;
    const job = new Job({ id, command, projectId });
    this.jobs.set(id, job);
    let worker;
    try {
      worker = this.spawnWorker();
    } catch (err) {
      job.status = 'failed';
      job.append(`cannot start a worker: ${err.message}\n`);
      return job;
    }
    job.worker = worker;
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === 'stdout') job.append(message.text);
      else if (message.type === 'stderr') job.append(message.text);
      else if (message.type === 'exit') {
        job.status = message.code === 0 ? 'done' : 'failed';
        job.exitCode = message.code ?? 0;
        job.endedAt = Date.now();
        job.append(`\n[${message.code === 0 ? 'done' : `exit ${message.code}`} in ${(job.durationMs / 1000).toFixed(1)}s]\n`);
        this.onEvent({ type: 'job_end', job: this.describe(job) });
        if (Array.isArray(message.files)) {
          for (const file of message.files) {
            this.writeFile?.(file.path, file.content).catch(() => {});
          }
        }
        try {
          worker.terminate();
        } catch {
          /* already gone */
        }
      } else if (message.type === 'error') {
        job.append(`\n${message.message}\n`);
      }
    };
    worker.onerror = (event) => {
      job.append(`\nworker error: ${event.message || 'unknown'}\n`);
      job.status = 'failed';
      job.endedAt = Date.now();
    };
    worker.postMessage({
      type: 'run',
      file,
      code,
      args,
      files: files || this.snapshot?.() || {},
      env: { NODE_ENV: 'development' },
    });
    this.onEvent({ type: 'job_start', job: this.describe(job) });
    return job;
  }

  kill(id) {
    const job = this.get(id);
    if (!job) return false;
    if (job.status === 'running') {
      job.status = 'killed';
      job.endedAt = Date.now();
      job.append('\n[terminated]\n');
      try {
        job.worker?.terminate();
      } catch {
        /* already gone */
      }
      this.onEvent({ type: 'job_end', job: this.describe(job) });
    }
    return true;
  }

  clear() {
    for (const job of this.jobs.values()) if (job.status === 'running') job.kill?.(job.id);
    for (const job of this.jobs.values()) if (job.status !== 'running') this.jobs.delete(job.id);
  }

  describe(job) {
    return {
      id: job.id,
      command: job.command,
      status: job.status,
      exitCode: job.exitCode,
      durationMs: job.durationMs,
      startedAt: job.startedAt,
    };
  }

  /** Text for `jobs` in the terminal. */
  render() {
    const rows = this.list();
    if (!rows.length) return 'no background jobs\n';
    const lines = ['  ID  STATUS   TIME    COMMAND'];
    for (const job of rows) {
      lines.push(`  %${job.id} ${job.status.padEnd(8)} ${`${(job.durationMs / 1000).toFixed(1)}s`.padEnd(7)} ${job.command}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
