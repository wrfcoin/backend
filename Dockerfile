# WRFCoin Backend — standalone Dockerfile
#
# Multi-stage build: install deps + compile TypeScript in builder,
# then copy only compiled output, production deps, and drizzle
# migration assets into a slim runtime image.
#
# The db-migrate init container re-uses this image to run
# `npx drizzle-kit migrate`, so drizzle.config.ts and drizzle/
# MUST be present in the runtime stage.

# =============================================================================
# Stage 1: Builder
# =============================================================================
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS builder

WORKDIR /app

# Install system deps for native modules (bcrypt, etc.)
RUN apk add --no-cache python3 make g++ git

# .npmrc skips onnxruntime-node's ~238 MB GPU provider download (infra#1113).
COPY package*.json .npmrc ./
RUN npm ci

# Copy source
COPY . .

# Remove stale .js where .ts exists (prevents tsc misresolution)
RUN find . -name '*.js' -not -path './node_modules/*' -not -path './dist/*' | \
    while read f; do ts="${f%.js}.ts"; [ -f "$ts" ] && rm "$f"; done; true

RUN npm run build

# =============================================================================
# Stage 2: Runtime
# =============================================================================
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime

WORKDIR /app

RUN apk add --no-cache curl

# Production dependencies only
# .npmrc skips onnxruntime-node's ~238 MB GPU provider download (infra#1113).
COPY package*.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled JS output
COPY --from=builder /app/dist ./dist/

# Drizzle migration assets for db-migrate init container (#452)
COPY --from=builder /app/drizzle ./drizzle/
COPY --from=builder /app/drizzle.config.ts ./

# Create non-root user and writable runtime directories. Keep node_modules
# root-owned/readable so image builds do not spend minutes chowning dependencies.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S wrfcoin -u 1001 -G nodejs && \
    mkdir -p /app/logs /app/data && \
    chown -R wrfcoin:nodejs /app/logs /app/data

USER wrfcoin

EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:${PORT:-4001}/health || exit 1

CMD ["node", "dist/server/enhanced_unified_api_optimized.js"]

# =============================================================================
# Stage 3: Service-specific runtime targets for the RTL-SDR stack
# =============================================================================
FROM runtime AS main-api

FROM runtime AS iot-gateway
EXPOSE 1883
EXPOSE 5683/udp
EXPOSE 5684
CMD ["node", "dist/server/iot-edge-gateway/gateway.js"]

FROM runtime AS rtl433-ingestion
ENV RTL433_INGESTION_MODE=internal
EXPOSE 3052
CMD ["node", "dist/server/rtl433_ingestion_server.js"]
