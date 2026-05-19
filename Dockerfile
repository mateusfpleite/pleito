FROM node:20-slim

RUN apt-get update \
  && apt-get install -y poppler-utils chromium \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.26.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile

CMD ["pnpm", "worker"]
