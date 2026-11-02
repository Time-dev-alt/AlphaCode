# Deploying AlphaCode

AlphaCode is a static site plus (optionally) two OAuth functions. There is no
database, no runtime server, and no secret to configure for the app itself.

**When can you connect the repo in Cloudflare Pages?** As soon as this branch is
merged into `main`. Pages builds whatever is on the branch you pick, so if you
want to test before merging, choose the feature branch instead of `main` — the
build settings below are identical.

---

## Cloudflare Pages (recommended)

### 1. Connect the repository

Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
**Connect to Git** → authorise GitHub → pick `Time-dev-alt/Nex`.

### 2. Build settings

| Field | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | `None` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | *(leave empty — the repo root)* |

### 2b. (Optional) the npm edge cache

`functions/api/npm/**` is the dependency resolver the browser talks to. It works
with nothing bound, but binding a KV namespace makes every resolved plan global:

```bash
npx wrangler kv namespace create NPM_CACHE
```

Then **Pages → Settings → Functions → KV namespace bindings → Add**:
variable name `NPM_CACHE`, namespace = the one you just created. Redeploy.

With it, the first install of a dependency set does the graph walk; every later
user gets a single request. Without it, Cloudflare's per-colo cache still helps
and browsers fall back to resolving locally.

### 3. Environment variables

| Name | Value | Needed? |
| --- | --- | --- |
| `NODE_VERSION` | `22` | Yes (Pages defaults to an older Node) |
| `GITHUB_CLIENT_ID` | OAuth App client id | Only for "publish to my GitHub" |
| `GITHUB_CLIENT_SECRET` | OAuth App client secret | Only for the same feature |

Set them for **Production and Preview** so branch builds behave the same.

### 4. Deploy

The first build runs `npm ci`-equivalent, bundles `web/` with esbuild into
`dist/assets/app.<hash>.js` (+ CSS, SRI hashes, SQLite WASM), validates
`functions/`, writes `_headers` and `_redirects`, and publishes. Expect roughly
**40–80 seconds** and a **< 1 MB** upload.

What Cloudflare serves afterwards:

```
/                       index.html (static)
/assets/app.<hash>.js   immutable, SRI-checked bundle
/assets/sql-wasm.wasm   application/wasm (explicit Content-Type in _headers)
/api/oauth/github/*     Pages Functions (only if the OAuth env vars are set)
/api/health             Pages Function → {"mode":"client", ...}
/claim/*, /p/*          rewritten to index.html (claimable preview routes)
```

### 5. Later deploys

Every push to `main` rebuilds production; every pull request gets a preview URL
automatically. Nothing else to configure.

---

## Workers with static assets (the newer Cloudflare flow)

If the dashboard sends you to **Workers** instead of **Pages**, the same repo
works there:

- **Build command: leave it empty.** `wrangler.jsonc` declares
  `build.command = "npm run build"`, so Wrangler builds `dist/` itself. A clean
  checkout has no `dist/` (it is git-ignored) and that, not the code, is what
  used to fail the build with *"the directory specified by assets.directory does
  not exist"*.
- **Deploy command: `npx wrangler deploy`.**
- ❌ **Not `npx wrangler preview`.** That command is open beta — Wrangler says so
  in its own help text — and it creates a *preview* deployment that expires; a
  build wired to it succeeds at nothing and the Worker never gets a live
  version. If your project shows that command, change it in **Settings → Build →
  Deploy command**.
- `wrangler.jsonc` (committed) sets `assets.directory = "dist"` and SPA
  fallback. No `main` entry — this is an assets-only Worker.
- Verify locally without touching your account:

  ```bash
  npm run deploy:worker -- --dry-run     # builds, packages, uploads nothing
  ```
- Add `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` as Worker variables; the
  OAuth routes then need to be served by a Pages project or a small Worker
  route, because `functions/` is a Pages-only convention. Without them the app
  is fully functional except GitHub publishing.

Direct upload from a laptop:

```bash
npm run build
npx wrangler pages deploy dist --project-name alphacode
```

---

## Netlify

Committed `netlify.toml` already contains the build command, publish dir,
function directory, redirects and headers.

1. **Add new site → Import an existing project → GitHub → `Time-dev-alt/Nex`.**
2. Build command `npm run build`, publish directory `dist` (pre-filled).
3. Environment: `NODE_VERSION=22`, plus the two `GITHUB_*` vars if you want
   GitHub publishing.
4. Deploy. OAuth endpoints are served by `netlify/functions/github-oauth.js`.

## Vercel

Committed `vercel.json` sets `buildCommand`, `outputDirectory`, rewrites and
headers.

1. **Add New → Project → Import Git Repository → `Time-dev-alt/Nex`.**
2. Framework preset: **Other**. Build `npm run build`, output `dist`.
3. Environment variables: the two `GITHUB_*` values (optional).
4. Deploy. OAuth lives in `api/oauth/github/[...path].js`.

## Any static host (no OAuth)

`npm run build` then upload `dist/`. GitHub OAuth will not work (there is no
function runtime), everything else does — including previews, ZIP export, and
pushing a repo if the user pastes a token they created themselves.

---

## GitHub OAuth App setup (once)

1. <https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**.
2. **Homepage URL:** your site URL.
3. **Authorization callback URL:** `https://<your-domain>/api/oauth/github/callback`
   — for Pages preview deployments this must match exactly, so either add the
   preview domain as a second app or use the production domain only.
4. Copy the client id and generate a client secret, then paste them into the
   host's environment variables (never into the repo).

The app requests `repo` scope by default (`public_repo` is enough for public
projects) and never stores the token anywhere except the user's browser.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Build fails with `Invalid or unexpected token` in a `.mjs` file | Node < 20 | set `NODE_VERSION=22` |
| `dist/assets/sql-wasm.wasm` 404 in production | build ran before `npm install` | re-run the build; `sql.js` is a build-time dependency |
| `npm install` works but is slow | no KV binding | create `NPM_CACHE` (section 2b) — plans are then cached globally |
| npm install fails with CORS on another host | the npm edge is a Pages Function | normal: the browser falls back to `registry.npmjs.org` directly; it still works |
| `python` says "could not load" | Pyodide CDN blocked | it is loaded from jsdelivr on first use; allow it in CSP/network policy |
| "The database panel fell back to the CDN" in build logs | `sql.js` missing | `npm install` locally, commit nothing, rebuild |
| OAuth popup says "not configured" | env vars missing on the host | add both, redeploy |
| OAuth popup says "redirect_uri mismatch" | callback URL differs from the deployment domain | update the OAuth App or use the production domain |
| Files disappear after reload | storage blocked (private mode / sandboxed frame) | the file panel says "temporary memory"; export the ZIP |
| 404 on `/claim/...` | `_redirects` not published | ensure output directory is `dist` (the file is generated there) |
