# Relay server image for remote demos (2-machine setup).
# Build context is the repo root:  docker build -f server/Dockerfile -t vericall-relay .
FROM node:22-slim

WORKDIR /app

# Install deps (tsx is used to run the TS server directly).
COPY package.json package-lock.json ./
RUN npm ci

# Only the relay needs the server + core sources.
COPY tsconfig.json ./
COPY core ./core
COPY server ./server

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
