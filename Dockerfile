# anti-rea-mcp - thin MCP server wrapper for antiRea
# Build:  docker build -t anti-rea-mcp .
# Run:    docker run -i --rm anti-rea-mcp   (stdio MCP server)

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/index.js"]
