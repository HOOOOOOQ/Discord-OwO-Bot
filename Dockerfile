# OwO Bot runtime image
#
# Multi-stage: the builder compiles the single native dependency (canvas), the
# runtime stage carries only production dependencies and the source tree.
FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential python3 libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Runtime libraries for canvas + tini for correct signal handling
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
        tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY index.js ./
COPY src ./src
COPY utils ./utils
COPY secret ./secret

# Runs as a non-root user
RUN useradd --create-home --uid 10001 owobot && chown -R owobot:owobot /app
USER owobot

# .env is injected at runtime (see .env.example); never baked into the image
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
    CMD ["node", "scripts/healthcheck.js"]
CMD ["node", "index.js"]
