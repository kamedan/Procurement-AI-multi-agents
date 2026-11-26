# syntax=docker/dockerfile:1.7

FROM node:22.18.0-bookworm-slim AS deps

WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi


FROM node:22.18.0-bookworm-slim AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY apps/web ./

# Public app origin is safe build-time config; NO secrets are ever passed here.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}

RUN npm run build


FROM node:22.18.0-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --gid 10001 nextjs \
    && useradd --uid 10001 --gid 10001 --shell /usr/sbin/nologin --create-home nextjs \
    && mkdir -p /app/.next /tmp/next-cache \
    && chown -R nextjs:nextjs /app /tmp/next-cache

COPY --from=builder --chown=nextjs:nextjs /app/public ./public
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
