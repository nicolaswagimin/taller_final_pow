# --- Etapa 1: compilar TypeScript ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY compartido ./compartido
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# --- Etapa 2: imagen de ejecución (solo dependencias de producción) ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY lua ./lua
COPY web ./web
USER node
EXPOSE 3000
CMD ["node", "dist/src/servidor.js"]
