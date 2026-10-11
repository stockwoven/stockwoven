# Stockwoven on Fly.io (or any container host): the Next.js standalone server, as a non-root user.
# Fly terminates HTTPS in front of it. NEXT_PUBLIC_RPC_URL is baked into the browser bundle at build
# time, so it is a build argument (fly.toml sets it).

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts: no dependency gets to run code during the build (native addons fall back to JS).
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY . .
ARG NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
ENV NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S app && adduser -S -G app app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]
