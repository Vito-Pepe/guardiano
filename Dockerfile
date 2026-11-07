# Pagina di stato del guardiano. node:22-alpine è multi-arch (amd64 + arm64): va bene sul Pi 5.
FROM node:22-alpine

WORKDIR /app
# Solo la pagina: lo script del guardiano gira sull'host, non qui
COPY web/ web/
USER node

ENV NODE_ENV=production PORT=3000 FOTO_DIR=/foto RICHIESTE_DIR=/richieste
EXPOSE 3000
CMD ["node", "web/server.js"]
