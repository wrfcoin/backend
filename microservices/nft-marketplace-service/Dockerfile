# ---- Builder stage ----
# Install ALL dependencies (including devDependencies) and compile TypeScript.
# Image pinned to SHA256 digest for reproducible builds (mutable tags can be overwritten).
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS builder

WORKDIR /app

# Install curl for health checks in builder (needed to verify build output)
RUN apk add --no-cache curl

# Copy package manifests and install all deps (dev + prod) so tsc is available.
COPY package*.json ./
RUN npm ci && npm cache clean --force

# Copy source and compile TypeScript to dist/.
COPY . .
RUN npm run build

# ---- Runtime stage ----
# Only production dependencies and compiled JS — no devDependencies, no source.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

WORKDIR /app

# Install curl for health checks
RUN apk add --no-cache curl

# Create non-root user for security
RUN addgroup -g 1001 -S wrfcoin && \
    adduser -S wrfcoin -u 1001 -G wrfcoin

# Copy package manifests and install production dependencies only.
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy compiled output from builder stage.
COPY --from=builder /app/dist ./dist

# Change ownership of app directory to non-root user
RUN chown -R wrfcoin:wrfcoin /app

# Switch to non-root user
USER wrfcoin

# Expose port
EXPOSE 4002

# Health check (run as non-root user)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:4002/health || exit 1

# Start the service
CMD ["node", "dist/index.js"]
