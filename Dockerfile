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


ARG ASSISTANT_ID
ARG OPENAI_API_KEY
ARG ID_GRUPO_RESUMEN
ARG SHEET1_ID_RESUMEN
ARG SHEET1_RANGE
ARG SHEET2_ID
ARG SHEET2_RANGE
ARG SHEET3_ID
ARG SHEET3_RANGE
ARG DOCX1_FILE_ID
ARG VECTOR_STORE_API_URL
ARG VECTOR_STORE
ARG PORT

ENV ASSISTANT_ID=""
ENV OPENAI_API_KEY=""
ENV ID_GRUPO_RESUMEN="@g.us"
ENV SHEET1_ID_RESUMEN=""
ENV SHEET1_RANGE=""
ENV SHEET2_ID=""
ENV SHEET2_RANGE=""
ENV SHEET3_ID=""
ENV SHEET3_RANGE=""
ENV DOCX1_FILE_ID=""
ENV VECTOR_STORE_API_URL="https://api.openai.com/v1/vector_stores/"
ENV VECTOR_STORE=""
ENV PORT=3008

EXPOSE $PORT

# Asegurar que la carpeta de credenciales exista
RUN mkdir -p /app/credentials


# Copiar el archivo JSON dentro del contenedor
COPY credentials/bot-test-v1-450813-c85b778a9c36.json /app/credentials/


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