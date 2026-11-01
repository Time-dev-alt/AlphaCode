# AlphaCode runtime image — Node 22 + latest npm + Python 3 + a real shell.
# Used by Cloudflare Containers, Fly.io, Railway, Render, Docker, or any VPS.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000 \
    ALPHACODE_HOST=0.0.0.0 \
    ALPHACODE_HOME=/opt/alphacode

# Python (latest from bookworm), compilers, git and the PTY dependencies the
# harness needs to give the agent a genuine interactive shell.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip \
      git curl ca-certificates \
      build-essential gcc libc6-dev \
      bash zsh less ripgrep sqlite3 \
      jq vim-tiny procps \
    && rm -rf /var/lib/apt/lists/*

# Latest npm, pinned only to the major the platform was tested against.
RUN npm install -g npm@11

WORKDIR /opt/alphacode

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || true

COPY native ./native
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY tests ./tests
COPY wrangler.jsonc ./

# Build the PTY helper used by the terminal (falls back to `script` if absent).
RUN bash scripts/build-pty.sh || echo "ptyhelper build skipped (fallback available)"

# Writable state: SQLite database, workspaces, deploy artifacts, secret key.
RUN mkdir -p /opt/alphacode/data/workspaces && chown -R node:node /opt/alphacode/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.mjs"]
