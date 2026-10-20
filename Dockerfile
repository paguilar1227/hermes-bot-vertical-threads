FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
COPY plugin.yaml ./
RUN npm run check
CMD ["npm", "run", "check"]
