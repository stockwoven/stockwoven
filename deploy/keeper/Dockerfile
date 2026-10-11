# The devnet keeper and peg bots on Fly.io, as one always-on machine with no public port.
# Built from the repository root (see the commands in deploy/keeper/fly.toml).
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# tsx runs the TypeScript scripts; no dependency install scripts run during the build.
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY scripts ./scripts
COPY deploy/keeper/run.sh ./run.sh
# The keeper writes its yield history next to it (scripts/keeper-state.json).
RUN chown -R node:node /app
USER node
ENV NODE_ENV=production
CMD ["sh", "run.sh"]
