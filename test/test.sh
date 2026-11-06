#!/usr/bin/env bash
# test.sh — prova guardiano.sh con un docker finto (test/finti/), senza toccare Docker vero.
# Uso: bash test/test.sh   (su Linux, sul Pi, o con Git Bash su Windows)

set -u
QUI=$(cd "$(dirname "$0")" && pwd)
GUARDIANO=$QUI/../guardiano.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export PATH="$QUI/finti:$PATH"
export SCENA=$TMP/scena GUARDIANO_BASE=$TMP/casa GUARDIANO_CASA=$TMP/guardiano GUARDIANO_ELENCO=$TMP/app.conf
REGISTRO=$GUARDIANO_CASA/guardiano.log

prove=0
falliti=0
prova() { echo "· $*"; }
ko() { falliti=$((falliti + 1)); echo "  FALLITO: $*"; }

# Due app: logoapp (servizio logoapp) e parole/meteo (servizio meteo)
nuova_scena() {
    rm -rf "$SCENA" "$GUARDIANO_BASE" "$GUARDIANO_CASA"
    mkdir -p "$SCENA" "$GUARDIANO_BASE" "$GUARDIANO_CASA"
    : > "$SCENA/chiamate"
    printf '# prova\n\nlogoapp   # commento\r\nparole/meteo\n' > "$GUARDIANO_ELENCO"
    app logoapp logoapp
    app parole/meteo meteo
}
app() {   # cartella, servizi...
    local cartella=$1 nome
    nome=$(basename "$1")
    shift
    mkdir -p "$GUARDIANO_BASE/$cartella" "$SCENA/$nome"
    touch "$GUARDIANO_BASE/$cartella/docker-compose.yml"
    printf '%s\n' "$@" > "$SCENA/$nome/servizi"
    : > "$SCENA/$nome/contenitori"
    echo "$GUARDIANO_BASE/$cartella" > "$SCENA/$nome/cartella"
}
contenitore() {   # app, servizio, stato, [salute], [politica], [uscita], [oneoff]
    echo "id$RANDOM$RANDOM|$2|${7:-False}|$3|${4:--}|${5:-unless-stopped}|${6:-0}|/$1-$2-1" >> "$SCENA/$1/contenitori"
}
tutto_acceso() {
    : > "$SCENA/logoapp/contenitori"
    : > "$SCENA/meteo/contenitori"
    contenitore logoapp logoapp running healthy
    contenitore meteo meteo running
}
giro() { bash "$GUARDIANO" "$@" > "$TMP/uscita" 2>&1; }

chiamate() {   # interventi attesi, uno per riga ("" = nessuno)
    prove=$((prove + 1))
    local fatte
    fatte=$(cat "$SCENA/chiamate")
    [ "$fatte" = "$1" ] || ko "interventi attesi [$1], fatti [$fatte]"
}
registro_righe() {
    prove=$((prove + 1))
    local n=0
    [ -f "$REGISTRO" ] && n=$(wc -l < "$REGISTRO")
    [ "$((n))" = "$1" ] || { ko "righe nel registro attese $1, sono $((n))"; cat "$REGISTRO" 2>/dev/null; }
}
registro_contiene() {
    prove=$((prove + 1))
    grep -qF -- "$1" "$REGISTRO" 2>/dev/null || { ko "il registro non contiene [$1]"; cat "$REGISTRO" 2>/dev/null; }
}
uscita_contiene() {
    prove=$((prove + 1))
    grep -qF -- "$1" "$TMP/uscita" || { ko "l'uscita non contiene [$1]"; cat "$TMP/uscita"; }
}

prova "tutto acceso: nessun intervento, registro vuoto"
nuova_scena; tutto_acceso
giro
chiamate ""
registro_righe 0
prove=$((prove + 1)); grep -q completo "$GUARDIANO_CASA/dati/ultimo-giro" || ko "ultimo-giro non dice completo"

prova "servizio fermato: docker compose up -d nella sua cartella, poi «a posto» una volta sola"
nuova_scena; contenitore logoapp logoapp running healthy; contenitore meteo meteo exited - unless-stopped 137
giro
chiamate "up meteo"
registro_contiene "meteo: servizi fermi: meteo → docker compose up -d: fatto"
tutto_acceso; : > "$SCENA/chiamate"
giro; giro
chiamate ""
registro_contiene "meteo: a posto"
registro_righe 2

prova "servizio senza container (sparito o mai creato): up"
nuova_scena; contenitore meteo meteo running
giro
chiamate "up logoapp"

prova "container unhealthy: docker restart con il suo nome"
nuova_scena; contenitore logoapp logoapp running unhealthy; contenitore meteo meteo running
giro
chiamate "restart logoapp-logoapp-1"
registro_contiene "logoapp: logoapp-logoapp-1 non risponde (unhealthy) → docker restart logoapp-logoapp-1: fatto"

prova "in avvio o sano: non si tocca"
nuova_scena; contenitore logoapp logoapp running starting; contenitore meteo meteo running healthy
giro
chiamate ""

prova "al massimo 3 interventi in un'ora, poi lo scrive una volta sola"
nuova_scena; contenitore logoapp logoapp running unhealthy; contenitore meteo meteo running
for i in 1 2 3 4 5; do giro; done
chiamate "restart logoapp-logoapp-1
restart logoapp-logoapp-1
restart logoapp-logoapp-1"
registro_contiene "L'ho già fatta ripartire 3 volte nell'ultima ora"
registro_righe 4
prova "  ...e dopo un'ora ci riprova"
vecchio=$(( $(date +%s) - 4000 ))
printf '%s\n%s\n%s\n' "$vecchio" "$vecchio" "$vecchio" > "$GUARDIANO_CASA/dati/logoapp.interventi"
: > "$SCENA/chiamate"
giro
chiamate "restart logoapp-logoapp-1"

prova "si riavvia in continuazione: solo segnalato, una volta"
nuova_scena; contenitore logoapp logoapp restarting; contenitore meteo meteo running
giro; giro
chiamate ""
registro_contiene "logoapp-logoapp-1 si riavvia da solo in continuazione"
registro_righe 1

prova "servizio che finisce da solo (riavvio «no», uscita 0) e container di «compose run»: non si toccano"
nuova_scena; app logoapp logoapp migrazione
contenitore logoapp logoapp running healthy
contenitore logoapp migrazione exited - no 0
contenitore logoapp logoapp exited - no 1 True
contenitore meteo meteo running
giro
chiamate ""
prova "  ...un container di «compose run» acceso non vale come servizio acceso"
nuova_scena
contenitore logoapp logoapp exited - unless-stopped 137
contenitore logoapp logoapp running - no 0 True
contenitore meteo meteo running
giro
chiamate "up logoapp"
prova "  ...ma se finisce con un errore sì"
nuova_scena; app logoapp logoapp migrazione
contenitore logoapp logoapp running healthy
contenitore logoapp migrazione exited - no 1
contenitore meteo meteo running
giro
chiamate "up logoapp"

prova "up che fallisce: lo scrive con l'errore"
nuova_scena; contenitore logoapp logoapp running; touch "$SCENA/meteo/up-rotto"
giro
chiamate "up meteo"
registro_contiene "NON riuscito (codice 1): Error: port is already allocated"

prova "pausa di un'app: non la tocca e lo scrive una volta; riprendi: la rimette a posto"
nuova_scena; contenitore meteo meteo running
bash "$GUARDIANO" pausa logoapp > /dev/null
giro; giro
chiamate ""
registro_contiene "logoapp: in pausa, non la controllo"
registro_righe 1
bash "$GUARDIANO" riprendi logoapp > /dev/null
giro
chiamate "up logoapp"

prova "pausa di tutto"
nuova_scena
bash "$GUARDIANO" pausa tutto > /dev/null
giro
chiamate ""
registro_contiene "tutto in pausa"
bash "$GUARDIANO" riprendi tutto > /dev/null
giro
chiamate "up logoapp
up meteo"
registro_contiene "pausa generale finita"

prova "pausa di un'app che non c'è: errore, nessuna pausa"
nuova_scena
prove=$((prove + 1))
if bash "$GUARDIANO" pausa logopp > "$TMP/uscita" 2>&1; then ko "doveva fallire"; fi
uscita_contiene "app: tutto logoapp meteo"
prove=$((prove + 1)); [ -e "$GUARDIANO_CASA/pausa/logopp" ] && ko "ha creato la pausa sbagliata"

prova "aggiornamento in corso da poco: salta il giro"
nuova_scena
echo 4242 > "$SCENA/pgrep"; echo "  120" > "$SCENA/eta-4242"
giro
chiamate ""
prove=$((prove + 1)); grep -q saltato "$GUARDIANO_CASA/dati/ultimo-giro" || ko "ultimo-giro non dice saltato"
prova "  ...da più di mezz'ora: lo segnala e controlla lo stesso"
echo 4000 > "$SCENA/eta-4242"
giro
chiamate "up logoapp
up meteo"
registro_contiene "un aggiornamento è in corso da più di 30 minuti (pid 4242)"

prova "Docker giù: lo scrive una volta, nessun intervento"
nuova_scena; touch "$SCENA/docker-giu"
giro; giro
chiamate ""
registro_righe 1
registro_contiene "Docker non risponde"
rm "$SCENA/docker-giu"; tutto_acceso
giro
registro_contiene "docker: di nuovo raggiungibile"

prova "compose illeggibile o cartella sparita: segnalato, niente interventi"
nuova_scena; tutto_acceso; touch "$SCENA/meteo/config-rotto"; rm -rf "$GUARDIANO_BASE/logoapp"
giro; giro
chiamate ""
registro_contiene "meteo: docker compose non riesce a leggere il compose"
registro_contiene "logoapp: manca la cartella"
registro_righe 2

prova "progetto compose non in app.conf: lo segnala una volta"
nuova_scena; tutto_acceso
echo "nuovaapp   running(1)   /home/pepe/nuovaapp/docker-compose.yml" > "$SCENA/progetti-extra"
giro; giro
registro_contiene "progetti compose che non controllo: nuovaapp (/home/pepe/nuovaapp)"
registro_righe 1

prova "prova: dice cosa farebbe, non tocca niente e non scrive niente"
nuova_scena; contenitore logoapp logoapp running unhealthy
giro prova
chiamate ""
uscita_contiene "logoapp: logoapp-logoapp-1 non risponde (unhealthy) → farei: docker restart logoapp-logoapp-1"
uscita_contiene "meteo: servizi fermi: meteo → farei: docker compose up -d"
registro_righe 0
prove=$((prove + 1)); [ -n "$(ls -A "$GUARDIANO_CASA/dati" 2>/dev/null)" ] && ko "in prova ha scritto in dati/"

prova "stato: riepilogo leggibile"
nuova_scena; contenitore logoapp logoapp running unhealthy; contenitore meteo meteo exited - unless-stopped 137
giro
giro stato
uscita_contiene "logoapp-logoapp-1"
uscita_contiene "acceso, NON risponde"
uscita_contiene "fermo (codice 137)"
uscita_contiene "(fatta ripartire 1 volta nell'ultima ora)"
uscita_contiene "Ultimo giro:"

prova "registro oltre 1 MB: diventa guardiano.log.1"
nuova_scena; tutto_acceso
head -c 1100000 /dev/zero | tr '\0' 'x' > "$REGISTRO"
giro
prove=$((prove + 1)); [ -f "$REGISTRO.1" ] || ko "manca guardiano.log.1"

echo
if [ "$falliti" = 0 ]; then
    echo "Tutto bene: $prove controlli superati."
else
    echo "$falliti controlli falliti su $prove."
    exit 1
fi
