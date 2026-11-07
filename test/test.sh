#!/usr/bin/env bash
# test.sh — prova guardiano.sh con un docker finto (test/finti/), senza toccare Docker vero.
# Uso: bash test/test.sh   (su Linux, sul Pi, o con Git Bash su Windows)

set -u
# In Git Bash, ln -s fa link veri (serve la Modalità sviluppatore di Windows; senza, quel test si salta)
export MSYS=winsymlinks:nativestrict
QUI=$(cd "$(dirname "$0")" && pwd)
GUARDIANO=$QUI/../guardiano.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export PATH="$QUI/finti:$PATH"
export SCENA=$TMP/scena GUARDIANO_BASE=$TMP/casa GUARDIANO_CASA=$TMP/guardiano GUARDIANO_ELENCO=$TMP/app.conf GUARDIANO_FOTO=$TMP/foto
export GUARDIANO_RICHIESTE=$TMP/richieste
REGISTRO=$GUARDIANO_CASA/guardiano.log

prove=0
falliti=0
prova() { echo "· $*"; }
ko() { falliti=$((falliti + 1)); echo "  FALLITO: $*"; }

# Due app: logoapp (servizio logoapp) e parole/meteo (servizio meteo)
nuova_scena() {
    rm -rf "$SCENA" "$GUARDIANO_BASE" "$GUARDIANO_CASA" "$GUARDIANO_FOTO" "$GUARDIANO_RICHIESTE"
    mkdir -p "$SCENA" "$GUARDIANO_BASE" "$GUARDIANO_CASA" "$GUARDIANO_RICHIESTE"
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

foto_contiene() {   # file dentro la fotografia attuale, testo
    prove=$((prove + 1))
    local dir
    dir=$GUARDIANO_FOTO/$(cat "$GUARDIANO_FOTO/attuale" 2>/dev/null)
    grep -qF -- "$2" "$dir/$1" 2>/dev/null || { ko "nella fotografia, $1 non contiene [$2]"; cat "$dir/$1" 2>/dev/null; }
}

prova "fotografia: stato, log, pause e problemi; nessun intervento e niente nel registro"
nuova_scena; contenitore logoapp logoapp running unhealthy; contenitore meteo meteo exited - unless-stopped 137
contenitore logoapp logoapp exited - no 0 True
bash "$GUARDIANO" pausa meteo > /dev/null
giro
: > "$SCENA/chiamate"; : > "$REGISTRO"
giro fotografia
chiamate ""
registro_righe 0
foto_contiene docker "ok"
foto_contiene elenco "meteo"
foto_contiene app/logoapp/info "cartella	logoapp"
foto_contiene app/logoapp/info "interventi	1"
foto_contiene app/meteo/info "cartella	parole/meteo"
foto_contiene app/meteo/info "pausa	1"
foto_contiene app/logoapp/servizi "logoapp"
foto_contiene app/logoapp/contenitori '/logoapp-logoapp-1|logoapp|False|unless-stopped|immagine/logoapp:1|2|{"Status":"running"'
foto_contiene log/logoapp-logoapp-1 "primo messaggio di logoapp-logoapp-1"
foto_contiene pause "meteo"
foto_contiene problemi "meteo	in pausa"
foto_contiene problemi "logoapp	intervento"
prova "  ...ne tiene due: la nuova e quella di prima"
prima=$(cat "$GUARDIANO_FOTO/attuale")
giro fotografia; giro fotografia; giro fotografia
prove=$((prove + 1))
n=$(ls -d "$GUARDIANO_FOTO"/foto-* | wc -l)
[ "$((n))" = 2 ] || ko "fotografie tenute: $((n)), attese 2"
prove=$((prove + 1)); [ -d "$GUARDIANO_FOTO/$(cat "$GUARDIANO_FOTO/attuale")" ] || ko "attuale non esiste"
prove=$((prove + 1)); [ -d "$GUARDIANO_FOTO/$prima" ] && ko "la prima fotografia non è stata tolta"
prova "  ...con Docker giù scrive solo «giu»"
touch "$SCENA/docker-giu"
giro fotografia
foto_contiene docker "giu"
prove=$((prove + 1)); [ -d "$GUARDIANO_FOTO/$(cat "$GUARDIANO_FOTO/attuale")/app/logoapp" ] && ko "con Docker giù non doveva fotografare le app"

prova "fotografia letta dalla pagina (web/foto.js)"
if command -v node > /dev/null 2>&1; then
    nuova_scena; contenitore logoapp logoapp running unhealthy; contenitore meteo meteo running
    bash "$GUARDIANO" pausa meteo > /dev/null
    giro fotografia
    modulo=$QUI/../web/foto.js; cartella=$GUARDIANO_FOTO
    if command -v cygpath > /dev/null 2>&1; then modulo=$(cygpath -w "$modulo"); cartella=$(cygpath -w "$cartella"); fi
    prove=$((prove + 1))
    esito=$(node -e '
        const s = require(process.argv[1]).leggiStato(process.argv[2]);
        const app = n => s.app.find(a => a.nome === n) || {};
        const c = (app("logoapp").contenitori || [])[0] || {};
        const atteso = [
          [s.pronto, true], [s.docker, "ok"], [s.app.length, 2],
          [app("logoapp").esito, "errore"], [app("logoapp").cartella, "logoapp"], [app("logoapp").interventi, 0],
          [c.nome, "logoapp-logoapp-1"], [c.salute, "unhealthy"], [c.esito, "errore"], [c.riavvii, 2],
          [c.controllo && c.controllo.testo, "wget: can'"'"'t connect | prova"],
          [app("meteo").esito, "pausa"], [app("meteo").pausa, true]
        ];
        const sbagliati = atteso.filter(([v, a]) => v !== a).map(([v, a]) => JSON.stringify(v) + " invece di " + JSON.stringify(a));
        const log = require(process.argv[1]).leggiLog(process.argv[2], "logoapp-logoapp-1");
        if (!log || !log.includes("primo messaggio") || log.includes("\x1b")) sbagliati.push("log: " + JSON.stringify(log));
        if (require(process.argv[1]).leggiLog(process.argv[2], "../attuale") !== null) sbagliati.push("log con ../ accettato");
        console.log(sbagliati.length ? sbagliati.join("; ") : "ok");
    ' "$modulo" "$cartella" 2>&1)
    [ "$esito" = ok ] || ko "web/foto.js: $esito"
else
    echo "  (node non c'è: salto)"
fi

richiesta() {   # azione, app, bersaglio, [secondi fa]: scrive una richiesta come la pagina; stampa l'id
    local id n
    n=$(( $(cat "$TMP/n-richieste" 2>/dev/null || echo 0) + 1 ))   # in un file: la si chiama in $(...)
    echo "$n" > "$TMP/n-richieste"
    id=$(date +%s)123-$(printf '%08x' "$n")
    printf 'azione\t%s\napp\t%s\nbersaglio\t%s\nquando\t%s\n' "$1" "$2" "$3" "$(( $(date +%s) - ${4:-0} ))" > "$GUARDIANO_RICHIESTE/$id.richiesta"
    echo "$id"
}
esito() {   # id, esito atteso, [testo nel messaggio]
    prove=$((prove + 1))
    local f=$GUARDIANO_RICHIESTE/$1.esito
    grep -qx "esito	$2" "$f" 2>/dev/null || { ko "esito atteso $2: $(cat "$f" 2>/dev/null || echo 'nessun esito')"; return; }
    [ -z "${3:-}" ] || grep -qF -- "$3" "$f" || ko "il messaggio non contiene [$3]: $(cat "$f")"
    [ ! -e "$GUARDIANO_RICHIESTE/$1.richiesta" ] && [ ! -e "$GUARDIANO_RICHIESTE/$1.presa" ] || ko "la richiesta $1 è ancora lì"
}
pulsanti() { bash "$GUARDIANO" richieste > "$TMP/uscita" 2>&1; }
scena_pulsanti() {
    nuova_scena
    app guardiano web
    echo guardiano >> "$GUARDIANO_ELENCO"
    contenitore logoapp logoapp running unhealthy
    contenitore meteo meteo running
    contenitore guardiano web running healthy
}

prova "pulsanti: Riavvia esegue docker restart, scrive l'esito e il registro"
scena_pulsanti
id=$(richiesta riavvia logoapp logoapp-logoapp-1)
pulsanti
chiamate "restart logoapp-logoapp-1"
esito "$id" fatto "riavviato"
registro_contiene "logoapp: dalla pagina: riavvia logoapp-logoapp-1: fatto"

prova "  Ferma: docker stop e pausa, così il giro non lo riaccende"
scena_pulsanti
id=$(richiesta ferma meteo meteo-meteo-1)
pulsanti
chiamate "stop meteo-meteo-1"
esito "$id" fatto "non lo riaccende"
prove=$((prove + 1)); grep -qx "pagina	meteo-meteo-1" "$GUARDIANO_CASA/pausa/meteo" 2>/dev/null || ko "manca la pausa della pagina"
: > "$SCENA/meteo/contenitori"; contenitore meteo meteo exited - unless-stopped 0
: > "$SCENA/logoapp/contenitori"; contenitore logoapp logoapp running healthy
: > "$SCENA/chiamate"
giro
chiamate ""
registro_contiene "meteo: in pausa, non la controllo: dalla pagina hai fermato meteo-meteo-1 (per"
bash "$GUARDIANO" fotografia > /dev/null 2>&1
foto_contiene app/meteo/info "fermati	meteo-meteo-1"
prova "  Avvia: docker compose up -d del suo servizio e via la pausa della pagina"
id=$(richiesta avvia meteo meteo-meteo-1)
pulsanti
chiamate "up meteo meteo"
esito "$id" fatto "avviato"
prove=$((prove + 1)); [ -e "$GUARDIANO_CASA/pausa/meteo" ] && ko "la pausa della pagina doveva sparire"

prova "  una pausa messa a mano resta anche dopo Avvia"
scena_pulsanti
bash "$GUARDIANO" pausa meteo > /dev/null
id=$(richiesta ferma meteo meteo-meteo-1); pulsanti
id=$(richiesta avvia meteo meteo-meteo-1); pulsanti
esito "$id" fatto "resta in pausa"
prove=$((prove + 1)); [ "$(cat "$GUARDIANO_CASA/pausa/meteo" 2>/dev/null)" = mano ] || ko "pausa a mano: $(cat "$GUARDIANO_CASA/pausa/meteo" 2>/dev/null)"

prova "  Avvia di un servizio senza container"
scena_pulsanti; : > "$SCENA/logoapp/contenitori"
id=$(richiesta avvia logoapp logoapp)
pulsanti
chiamate "up logoapp logoapp"
esito "$id" fatto

prova "  Ferma che non riesce: niente pausa, il guardiano continua a controllarlo"
scena_pulsanti; touch "$SCENA/stop-rotto"
id=$(richiesta ferma meteo meteo-meteo-1)
pulsanti
esito "$id" fallito "cannot stop container"
prove=$((prove + 1)); [ -e "$GUARDIANO_CASA/pausa/meteo" ] && ko "la pausa doveva sparire"
registro_contiene "meteo: dalla pagina: ferma meteo-meteo-1: NON riuscito"

prova "  richieste da rifiutare: nessun intervento"
scena_pulsanti
a=$(richiesta cancella logoapp logoapp-logoapp-1)
b=$(richiesta riavvia logoapp meteo)
c=$(richiesta riavvia logoapp 'logoapp;reboot')
d=$(richiesta riavvia sconosciuta logoapp-logoapp-1)
e=$(richiesta riavvia logoapp logoapp-logoapp-1 500)
f=$(richiesta ferma guardiano guardiano-web-1)
g=$(richiesta avvia meteo meteo-che-non-c-e)
echo "azione	riavvia" > "$GUARDIANO_RICHIESTE/../../x.richiesta" 2>/dev/null
echo "azione	riavvia" > "$GUARDIANO_RICHIESTE/non-valida.richiesta"
pulsanti
chiamate ""
esito "$a" rifiutata "azione sconosciuta"
esito "$b" rifiutata "non è un container di logoapp"
esito "$c" rifiutata "nome del container non valido"
esito "$d" rifiutata "app sconosciuta"
esito "$e" scaduta
esito "$f" rifiutata "serve alla pagina stessa"
esito "$g" rifiutata "non è un container di meteo"
prove=$((prove + 1)); [ -e "$GUARDIANO_RICHIESTE/non-valida.richiesta" ] && ko "richiesta con id non valido rimasta"
prove=$((prove + 1)); [ -e "$GUARDIANO_RICHIESTE/non-valida.esito" ] && ko "esito per un id non valido"
prova "  ...ma Riavvia della pagina stessa sì"
h=$(richiesta riavvia guardiano guardiano-web-1)
pulsanti
chiamate "restart guardiano-web-1"
esito "$h" fatto

prova "  un link preparato al posto dell'esito o della richiesta non porta a scrivere altrove"
scena_pulsanti
echo intatto > "$TMP/vittima"
id=$(richiesta riavvia logoapp logoapp-logoapp-1)
ln -s "$TMP/vittima" "$GUARDIANO_RICHIESTE/$id.esito" 2>/dev/null
ln -s "$TMP/vittima" "$GUARDIANO_RICHIESTE/$id.esito.tmp" 2>/dev/null   # un nome temporaneo prevedibile
ln -s "$TMP/vittima" "$GUARDIANO_RICHIESTE/1700000000123-0000beef.richiesta" 2>/dev/null
if [ -L "$GUARDIANO_RICHIESTE/$id.esito" ]; then
    pulsanti
    esito "$id" fatto
    prove=$((prove + 1)); [ "$(cat "$TMP/vittima")" = intatto ] || ko "ha scritto attraverso il link: $(cat "$TMP/vittima")"
    prove=$((prove + 1)); [ -L "$GUARDIANO_RICHIESTE/$id.esito" ] && ko "l'esito è ancora un link"
    prove=$((prove + 1)); [ -e "$GUARDIANO_RICHIESTE/1700000000123-0000beef.richiesta" ] && ko "una richiesta-link non è stata tolta"
    prove=$((prove + 1)); [ -e "$GUARDIANO_RICHIESTE/1700000000123-0000beef.esito" ] && ko "una richiesta-link è stata eseguita"
else
    echo "  (qui ln -s non fa link veri, come in Git Bash: salto; sul Pi e su Linux si prova)"
fi

prova "  al massimo 30 azioni in un'ora"
scena_pulsanti
mkdir -p "$GUARDIANO_CASA/dati"
for i in $(seq 1 30); do date +%s; done > "$GUARDIANO_CASA/dati/_pagina.interventi"
id=$(richiesta riavvia logoapp logoapp-logoapp-1)
pulsanti
chiamate ""
esito "$id" rifiutata "già 30 azioni"

prova "  «pagina» dal cron: fotografia, poi esegue le richieste che arrivano e rifà la fotografia"
scena_pulsanti
GUARDIANO_DURATA_PAGINA=0 bash "$GUARDIANO" pagina > /dev/null 2>&1
foto_contiene docker "ok"
foto_contiene protetti "ingressi-https-guardiano-1"
prima=$(cat "$GUARDIANO_FOTO/attuale")
id=$(richiesta riavvia logoapp logoapp-logoapp-1)
GUARDIANO_DURATA_PAGINA=0 bash "$GUARDIANO" pagina > /dev/null 2>&1
chiamate "restart logoapp-logoapp-1"
esito "$id" fatto
prove=$((prove + 1)); [ "$(cat "$GUARDIANO_FOTO/attuale")" != "$prima" ] || ko "dopo l'azione doveva rifare la fotografia"

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
