# LinkPulse server. Build from this directory:  docker build -t linkpulse-server server
# Runs the API and the redirect on port 4000. The dashboard (client/) is a separate static site.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Production dependencies only; the lockfile makes the build reproducible
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
# Set at build time (--build-arg RELEASE=$(git rev-parse --short HEAD)) so error reports say which build failed
ARG RELEASE=
ENV RELEASE=$RELEASE
# The base image ships an unprivileged "node" user; the app never needs root
USER node
EXPOSE 4000
# Readiness: /health runs a query against the database. Uses Node because the image has no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Not `npm start`: that script loads a .env file, and a container gets its settings from real environment variables.
# `node` as PID 1 receives SIGTERM directly, so the click buffer is flushed on `docker stop`.
CMD ["node", "src/index.js"]
