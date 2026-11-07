#!/usr/bin/env bash
# update.sh — aggiorna il guardiano sul Raspberry Pi
# Uso manuale: ./update.sh
# Gira da cron ogni 5 minuti, come gli update.sh delle app. Lo script del guardiano non ha bisogno
# d'altro che del git pull (il giro dopo usa già quello nuovo); la pagina di stato (web/) è un
# container e va ricostruita. Se non ci sono commit nuovi e il container c'è, non tocca niente.

set -e
cd "$(dirname "$0")"

BRANCH=$(git rev-parse --abbrev-ref HEAD)

git fetch -q origin "$BRANCH"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ] && [ -n "$(docker compose ps -a -q web 2>/dev/null)" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') — nessun aggiornamento, già alla versione più recente."
    exit 0
fi

if [ "$LOCAL" != "$REMOTE" ]; then
    echo "==> Nuovi commit trovati, aggiorno..."
    git pull -q --ff-only origin "$BRANCH"
fi

# Le cartelle in memoria (fotografia e richieste dei pulsanti) devono esserci prima del container:
# vedi docker-compose.yml. Nelle richieste scrive il container (utente node).
mkdir -p /dev/shm/guardiano /dev/shm/guardiano-richieste
chmod 777 /dev/shm/guardiano-richieste

echo "==> Rebuild e riavvio della pagina di stato..."
docker compose up --build -d

echo "==> Pulizia immagini obsolete..."
docker image prune -f

echo "$(date '+%Y-%m-%d %H:%M:%S') — aggiornato a $(git log -1 --format='%h %s')."
