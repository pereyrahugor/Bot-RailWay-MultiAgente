# Image size ~ 400MB
FROM node:20-slim AS builder


WORKDIR /app


RUN corepack enable && corepack prepare pnpm@latest --activate
ENV PNPM_HOME=/usr/local/bin




# Copiar archivos de configuración y dependencias primero para aprovechar la cache
COPY package*.json ./
COPY *-lock.yaml ./
COPY rollup.config.js ./
COPY tsconfig.json ./

# Instalar dependencias del sistema necesarias para build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates poppler-utils && update-ca-certificates

# Instalar dependencias node
RUN pnpm install

# Copiar el resto del código fuente y carpetas necesarias antes del build
COPY src/ ./src/
COPY src/assets/ ./src/assets/
COPY src/js/ ./src/js/
COPY src/style/ ./src/style/
COPY src/utils/ ./src/utils/
COPY src/utils-web/ ./src/utils-web/
COPY README.md ./
COPY nodemon.json ./
COPY railway.json ./

# Compilar y mostrar el error real en el log de Docker, imprimiendo logs si falla
RUN pnpm run build || (echo '--- npm-debug.log ---' && cat /app/npm-debug.log || true && echo '--- pnpm-debug.log ---' && cat /app/pnpm-debug.log || true && exit 1)

# Limpiar dependencias de build
RUN apt-get remove -y python3 make g++ git && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*



FROM node:20-slim AS deploy

# Instalar poppler-utils en la imagen final para que pdftoppm esté disponible
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*


WORKDIR /app


# Asegurar que la carpeta de credenciales exista
RUN mkdir -p /app/credentials


# Copiar los artefactos necesarios desde builder
COPY --from=builder /app/src/assets ./src/assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/*.json ./
COPY --from=builder /app/*-lock.yaml ./
COPY --from=builder /app/src/webchat.html ./src/webchat.html
COPY --from=builder /app/src/webreset.html ./src/webreset.html
COPY --from=builder /app/README.md ./
COPY --from=builder /app/nodemon.json ./
COPY --from=builder /app/railway.json ./
COPY --from=builder /app/src/js ./src/js
COPY --from=builder /app/src/style ./src/style


RUN corepack enable && corepack prepare pnpm@latest --activate
ENV PNPM_HOME=/usr/local/bin
RUN mkdir /app/tmp
RUN npm cache clean --force && pnpm install --production --ignore-scripts \
    && npm install polka @types/polka --legacy-peer-deps \
    && rm -rf $PNPM_HOME/.npm $PNPM_HOME/.node-gyp

# Parchear la versión de Baileys automáticamente
RUN sed -i 's/version: \[[0-9, ]*\]/version: [2, 3000, 1023223821]/' node_modules/@builderbot/provider-baileys/dist/index.cjs

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -m nodejs


CMD ["npm", "start"]