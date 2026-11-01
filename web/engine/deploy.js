/**
 * Deployment — to the *user's* accounts, without us holding anything.
 *
 * Two paths, in order of preference:
 *
 *  1. **OAuth + provider import (tokenless for the user).**
 *     We create a repository in the user's GitHub via GitHub OAuth, push the
 *     project, then hand them the provider's own "import this repo" flow
 *     (Vercel, Netlify, Cloudflare Pages). They click once, authorise the
 *     provider, and the app is theirs. No API token is ever pasted, and the
 *     build runs on the provider that is hosting it — not on us.
 *
 *  2. **Instant preview + claim.** No account at all: the project is bundled
 *     into one self-contained HTML document and published as a blob URL. A
 *     claimed preview persists in this browser (`#/p/<id>`) and can be
 *     exported or converted into (1) at any time.
 *
 * The only secret involved in (1) is GitHub's *client* secret, which lives in
 * the Pages Function environment — never in the browser.
 */

const GH_API = 'https://api.github.com';

export const DEPLOY_TARGETS = {
  cloudflare: { id: 'cloudflare', label: 'Cloudflare Pages', needs: 'github' },
  vercel: { id: 'vercel', label: 'Vercel', needs: 'github' },
  netlify: { id: 'netlify', label: 'Netlify', needs: 'github' },
  preview: { id: 'preview', label: 'Instant preview', needs: 'none' },
};

/** Provider "import this repo" URLs — the user authorises in the provider UI. */
export function importUrl(provider, repoFullName, branch = 'main') {
  const repo = `https://github.com/${repoFullName}`;
  switch (provider) {
    case 'vercel':
      return `https://vercel.com/new/clone?repository-url=${encodeURIComponent(repo)}&repository-name=${encodeURIComponent(repoFullName.split('/').pop())}`;
    case 'netlify':
      return `https://app.netlify.com/start/deploy?repository=${encodeURIComponent(repo)}`;
    case 'cloudflare':
      return `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(repo)}`;
    default:
      return repo;
  }
}

// ---------------------------------------------------------------- preview ---

const MIME_INLINE = { '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript' };

/** Inline local <link>/<script>/<img> references so one file is a whole site. */
export function bundlePreview(files, entry = 'index.html') {
  const read = (p) => files[p] ?? files[`./${p}`] ?? null;
  let html = read(entry);
  if (html === null) {
    const anyHtml = Object.keys(files).find((k) => k.endsWith('.html'));
    if (!anyHtml) throw new Error('No HTML entry point found (expected index.html)');
    html = files[anyHtml];
  }
  html = html.replace(/<link[^>]+href=["']([^"']+\.css)["'][^>]*>/gi, (m, href) => {
    const css = read(href.replace(/^\.?\//, ''));
    return css === null ? m : `<style>\n${css}\n</style>`;
  });
  html = html.replace(/<script([^>]*)\ssrc=["']([^"']+\.m?js)["']([^>]*)><\/script>/gi, (m, pre, src, post) => {
    const js = read(src.replace(/^\.?\//, ''));
    if (js === null) return m;
    const type = /type=["']module["']/.test(pre + post) ? ' type="module"' : '';
    return `<script${type}>\n${js}\n</script>`;
  });
  html = html.replace(/(src|href)=["']([^"':]+\.(?:png|jpe?g|gif|svg|webp|ico))["']/gi, (m, attr, path) => {
    const data = read(path.replace(/^\.?\//, ''));
    if (!data || typeof data !== 'string' || !data.startsWith('data:')) return m;
    return `${attr}="${data}"`;
  });
  return html;
}

export function createPreview(files, entry) {
  const html = bundlePreview(files, entry);
  const blob = new Blob([html], { type: 'text/html' });
  return { url: URL.createObjectURL(blob), html, bytes: blob.size };
}

// ----------------------------------------------------------------- GitHub ---

export async function waitForOAuth(popup, { timeoutMs = 180_000, target } = {}) {
  const bus = target || (typeof window !== 'undefined' ? window : globalThis);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('The GitHub sign-in window timed out.'));
    }, timeoutMs);
    const onMessage = (event) => {
      const here = bus.location?.origin || (typeof location !== 'undefined' ? location.origin : '');
      if (!here || event.origin !== here) return;
      const data = event.data || {};
      if (data.type !== 'alphacode:oauth') return;
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    const poll = setInterval(() => {
      if (popup && popup.closed) {
        cleanup();
        reject(new Error('The sign-in window was closed before finishing.'));
      }
    }, 800);
    function cleanup() {
      clearTimeout(timer);
      clearInterval(poll);
      bus.removeEventListener('message', onMessage);
    }
    bus.addEventListener('message', onMessage);
  });
}

/** Open the Pages Function OAuth flow and wait for the access token. */
export async function connectGitHub({ scope = 'repo' } = {}) {
  const popup = window.open(
    `/api/oauth/github/start?scope=${encodeURIComponent(scope)}`,
    'alphacode-github',
    'width=720,height=780,menubar=no,toolbar=no',
  );
  if (!popup) throw new Error('Pop-up blocked — allow pop-ups for this site to connect GitHub.');
  return waitForOAuth(popup);
}

async function gh(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${json?.message || text.slice(0, 200)}`);
  return json;
}

export async function whoAmI(token) {
  return gh(token, '/user');
}

/** Create (or reuse) a repository and push every project file to it. */
export async function publishToGitHub({ token, files, name, isPrivate = false, branch = 'main', onProgress = () => {} }) {
  const user = await whoAmI(token);
  const repoName = String(name || 'alphacode-app')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'alphacode-app';

  let repo;
  try {
    repo = await gh(token, `/repos/${user.login}/${repoName}`);
    onProgress(`using existing repository ${repo.full_name}`);
  } catch {
    onProgress(`creating repository ${user.login}/${repoName}`);
    repo = await gh(token, '/user/repos', {
      method: 'POST',
      body: { name: repoName, private: isPrivate, auto_init: false, description: 'Built with AlphaCode' },
    });
  }

  const entries = Object.entries(files).filter(([, v]) => typeof v === 'string');
  // One commit: blobs → tree → commit → ref (works on a brand-new empty repo).
  onProgress(`uploading ${entries.length} files`);
  const blobs = [];
  for (const [path, content] of entries) {
    const blob = await gh(token, `/repos/${repo.full_name}/git/blobs`, {
      method: 'POST',
      body: { content: btoa(String.fromCharCode(...new TextEncoder().encode(content))), encoding: 'base64' },
    });
    blobs.push({ path: path.replace(/^\/+/, ''), mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await gh(token, `/repos/${repo.full_name}/git/trees`, { method: 'POST', body: { tree: blobs } });
  const commit = await gh(token, `/repos/${repo.full_name}/git/commits`, {
    method: 'POST',
    body: { message: `AlphaCode: ${new Date().toISOString()}`, tree: tree.sha, parents: [] },
  });
  try {
    await gh(token, `/repos/${repo.full_name}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  } catch {
    await gh(token, `/repos/${repo.full_name}/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: commit.sha, force: true } });
  }
  onProgress(`pushed to ${repo.full_name}`);
  return { repo: repo.full_name, url: repo.html_url, branch, commit: commit.sha };
}

// ----------------------------------------------------------- orchestration ---

/**
 * Publish a project for a target.
 * @returns {{provider,url,claimUrl?,repo?,message,display}}
 */
export async function deployProject({
  target = 'preview',
  files,
  projectName = 'alphacode-app',
  githubToken = '',
  isPrivate = false,
  onProgress = () => {},
}) {
  const safeFiles = Object.fromEntries(Object.entries(files || {}).filter(([p]) => !p.startsWith('node_modules/')));

  if (target === 'preview' || !githubToken) {
    onProgress('bundling a self-contained preview');
    const preview = createPreview(safeFiles);
    const claimId = `pv_${Math.random().toString(36).slice(2, 10)}`;
    return {
      provider: 'preview',
      url: preview.url,
      claimUrl: `${typeof location !== 'undefined' ? location.origin : ''}/#/claim/${claimId}`,
      claimId,
      previewHtml: preview.html,
      message:
        `Preview ready: a single self-contained HTML document (${(preview.bytes / 1024).toFixed(1)} KB) opened in a new tab.\n` +
        `It is a **local preview** — it lives in this browser only and is not on the internet.\n` +
        `To get a permanent public URL, connect GitHub (one OAuth click) and pick Cloudflare, Vercel or Netlify: the deploy runs on your own account.\n` +
        `Press **Claim URL** to store this preview and keep working on it.`,
      display: { provider: 'preview', url: preview.url, claimable: true, files: Object.keys(safeFiles).length, bytes: preview.bytes },
    };
  }

  onProgress('pushing to your GitHub');
  const published = await publishToGitHub({ token: githubToken, files: safeFiles, name: projectName, isPrivate, onProgress });
  const provider = target === 'preview' ? 'vercel' : target;
  const url = importUrl(provider, published.repo, published.branch);
  return {
    provider,
    url,
    repo: published.repo,
    repoUrl: published.url,
    message:
      `Pushed **${Object.keys(safeFiles).length} files** to \`${published.repo}\` (your GitHub).\n\n` +
      `Next: the ${provider} import page is opening — sign in there once and confirm the import.\n` +
      `${url}\n\n` +
      `The build runs on your ${provider} account, billed to you, owned by you. AlphaCode never sees the deployed site.`,
    display: { provider, url, repo: published.repo, repoUrl: published.url, files: Object.keys(safeFiles).length, claimable: false },
  };
}
