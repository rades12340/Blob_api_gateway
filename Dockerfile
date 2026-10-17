FROM oven/bun:1.4.2-alpine

WORKDIR /app

# --ignore-scripts skips the "prepare" script (husky), a dev-only git hook setup.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

USER bun
EXPOSE 8080
CMD ["bun", "src/app.ts"]
