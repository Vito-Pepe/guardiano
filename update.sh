#!/usr/bin/env bash
# update.sh — aggiorna il guardiano sul Raspberry Pi
# Uso manuale: ./update.sh
# Gira da cron ogni 5 minuti, come gli update.sh delle app. Il guardiano non ha container:
# basta portare la cartella all'ultimo main, e il giro successivo usa già lo script nuovo.

set -e
cd "$(dirname "$0")"

BRANCH=$(git rev-parse --abbrev-ref HEAD)

git fetch -q origin "$BRANCH"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') — nessun aggiornamento, già alla versione più recente."
    exit 0
fi

git pull -q --ff-only origin "$BRANCH"
echo "$(date '+%Y-%m-%d %H:%M:%S') — aggiornato a $(git log -1 --format='%h %s')."
