# Image size ~ 400MB
FROM node:slim AS builder


WORKDIR /app


RUN corepack enable && corepack prepare pnpm@latest --activate
ENV PNPM_HOME=/usr/local/bin


COPY . .


COPY package*.json *-lock.yaml ./


RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && update-ca-certificates \
    && pnpm install && pnpm run build \
    && apt-get remove -y python3 make g++ git \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*


FROM node:slim AS deploy


WORKDIR /app


ARG PORT

ENV PORT=3008

EXPOSE $PORT

# Asegurar que la carpeta de credenciales exista
RUN mkdir -p /app/credentials

COPY --from=builder /app/assets ./assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/*.json /app/*-lock.yaml ./


RUN corepack enable && corepack prepare pnpm@latest --activate
ENV PNPM_HOME=/usr/local/bin
RUN mkdir /app/tmp
RUN npm cache clean --force && pnpm install --production --ignore-scripts \
    && rm -rf $PNPM_HOME/.npm $PNPM_HOME/.node-gyp

# Parchear la versión de Baileys automáticamente
RUN sed -i 's/version: \[[0-9, ]*\]/version: [2, 3000, 1023223821]/' node_modules/@builderbot/provider-baileys/dist/index.cjs

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -m nodejs


CMD ["npm", "start"]