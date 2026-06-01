FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

# psql is needed for database restore via upload
RUN apk add --no-cache postgresql17-client

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
COPY public ./public
COPY scripts ./scripts

# Run HTTP API by default. For MCP server, command can be overridden.
CMD ["node", "dist/src/api/server.js"]
