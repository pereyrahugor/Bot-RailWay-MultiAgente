# Build Stage
FROM node:20-slim AS builder

WORKDIR /app

# Copiar archivos de configuración
COPY package*.json ./
COPY tsconfig.json ./
COPY rollup.config.js ./
COPY nodemon.json ./
COPY railway.json ./

# Instalar dependencias del sistema necesarias para build
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates poppler-utils \
    && update-ca-certificates

# Instalar todas las dependencias
RUN npm install

# Copiar el código fuente
COPY src/ ./src/
COPY README.md ./

# Compilar
RUN npm run build

# Stage de Producción
FROM node:20-slim AS deploy

# Instalar utilidades necesarias en la imagen final
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Crear directorios necesarios
RUN mkdir -p /app/credentials /app/tmp /app/bot_sessions

# Copiar artefactos desde el builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/README.md ./
COPY --from=builder /app/nodemon.json ./
COPY --from=builder /app/railway.json ./
COPY --from=builder /app/src/assets ./src/assets
COPY --from=builder /app/src/html ./src/html
COPY --from=builder /app/src/js ./src/js
COPY --from=builder /app/src/style ./src/style

# Instalar SOLO dependencias de producción
RUN npm install --omit=dev

# Parche de versión para Baileys (si es necesario)
RUN if [ -f node_modules/@builderbot/provider-baileys/dist/index.cjs ]; then \
    sed -i 's/version: \[[0-9, ]*\]/version: [2, 3000, 1023223821]/' node_modules/@builderbot/provider-baileys/dist/index.cjs; \
    fi

# Configuración de usuario no-root
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -m nodejs
RUN chown -R nodejs:nodejs /app

USER nodejs

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]