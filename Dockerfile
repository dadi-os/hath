FROM node:22-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build

COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM deps AS dev

COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY public ./public
# src/ arrives via Nas's bind mount, not COPY —
# this stage exists to have dependencies installed,
# not to hold a frozen copy of the source.
EXPOSE 8080
CMD ["npm", "run", "dev"]

FROM node:22-slim AS production

WORKDIR /app
RUN npm install --global serve@14
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["serve", "-s", "dist", "-l", "8080"]
