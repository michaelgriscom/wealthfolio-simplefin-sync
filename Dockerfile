# Sync daemon image. The daemon reuses src/lib/{simplefin,mapping}.ts, which have
# no runtime third-party imports (the @wealthfolio/addon-sdk import is type-only),
# so tsx alone is enough to run it — no pnpm install / SDK bundle needed.
FROM node:22-slim

WORKDIR /app
RUN npm install -g tsx@4.19.2

COPY src/lib ./src/lib
COPY sync ./sync

ENV NODE_ENV=production
EXPOSE 8080

CMD ["tsx", "sync/main.ts"]
