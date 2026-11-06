#!/usr/bin/env bash
# guardiano.sh — controlla che le app Docker del Raspberry Pi girino e, se serve, le fa ripartire.
#
#   ./guardiano.sh                  un giro di controllo (lo lancia il cron ogni 5 minuti)
#   ./guardiano.sh prova            un giro che dice cosa farebbe, senza toccare niente
#   ./guardiano.sh stato            riepilogo: container di ogni app, pause, ultimi interventi
#   ./guardiano.sh pausa <app>      smette di controllare <app> (o "tutto") finché non la riprendi
#   ./guardiano.sh riprendi <app>   torna a controllare <app> (o "tutto")
#
# In un giro, per ogni cartella di app.conf (nell'ordine del file):
#   - servizi del compose senza un container acceso (fermati, spariti, mai partiti)
#       → docker compose up -d   (avvia solo quello che manca, non tocca il resto, niente build)
#   - container "unhealthy" (il loro healthcheck fallisce: acceso ma non risponde)
#       → docker restart
#   - container che si riavvia da solo in continuazione → lo segnala e basta: Docker ci sta già
#     provando, servono i log
# Ogni app viene fatta ripartire al massimo MAX_INTERVENTI volte in un'ora: oltre la lascia stare
# e lo scrive. Salta il giro mentre un update.sh (o un build/pull di compose) è in corso.
# Nel registro (guardiano.log) scrive solo quando interviene o quando qualcosa cambia.
#
# Niente sudo, niente dipendenze: bash, coreutils, procps (pgrep, ps), flock e docker compose.

set -u
PATH="$PATH:/usr/local/bin:/usr/bin:/bin"

QUI=$(cd "$(dirname "$0")" && pwd)
BASE=${GUARDIANO_BASE:-$HOME}            # le cartelle di app.conf sono relative a questa
ELENCO=${GUARDIANO_ELENCO:-$QUI/app.conf}
CASA=${GUARDIANO_CASA:-$QUI}             # dati/, pausa/ e guardiano.log: fuori da git
DATI=$CASA/dati
PAUSA=$CASA/pausa
REGISTRO=$CASA/guardiano.log

MAX_INTERVENTI=3              # per app, nella finestra qui sotto
FINESTRA=3600                 # secondi
AGGIORNAMENTO_BLOCCATO=1800   # un update.sh in giro da più di così non ferma più i controlli
REGISTRO_MAX=1000000          # byte: oltre, guardiano.log diventa guardiano.log.1
PROVA=0

# Una riga per container: servizio|oneoff|stato|salute|politica di riavvio|codice di uscita|nome
FORMATO='{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.ExitCode}}|{{.Name}}'

adesso() { date '+%Y-%m-%d %H:%M:%S'; }

# Una riga nel registro (e sullo schermo, se c'è un terminale). In prova solo sullo schermo.
scrivi() {
    if [ "$PROVA" = 1 ]; then echo "$*"; return 0; fi
    echo "$(adesso) — $*" >> "$REGISTRO"
    if [ -t 1 ]; then echo "$*"; fi
    return 0
}

# Un problema che dura: lo scrive solo la prima volta, o quando cambia
segnala() {
    local chiave=$1 messaggio=$2 file=$DATI/$1.problema
    if [ "$PROVA" = 1 ]; then echo "$chiave: $messaggio"; return 0; fi
    if [ ! -f "$file" ] || [ "$(cat "$file")" != "$messaggio" ]; then
        scrivi "$chiave: $messaggio"
        printf '%s\n' "$messaggio" > "$file"
    fi
}

# Il problema segnalato prima (o l'intervento) non c'è più: lo scrive una volta
risolto() {
    local chiave=$1 messaggio=$2 file=$DATI/$1.problema
    if [ "$PROVA" = 1 ]; then echo "$chiave: $messaggio"; return 0; fi
    if [ -f "$file" ]; then
        scrivi "$chiave: $messaggio"
        rm -f "$file"
    fi
}

# Quante volte l'app è stata fatta ripartire nell'ultima FINESTRA (e dimentica le più vecchie)
interventi_recenti() {
    local file=$DATI/$1.interventi limite t n=0 tenuti=""
    limite=$(( $(date +%s) - FINESTRA ))
    if [ ! -f "$file" ]; then echo 0; return; fi
    while read -r t; do
        case $t in ''|*[!0-9]*) continue ;; esac
        if [ "$t" -gt "$limite" ]; then n=$((n + 1)); tenuti="$tenuti$t"$'\n'; fi
    done < "$file"
    [ "$PROVA" = 1 ] || printf '%s' "$tenuti" > "$file"
    echo "$n"
}

registra_intervento() { [ "$PROVA" = 1 ] || date +%s >> "$DATI/$1.interventi"; }

# Cartelle di app.conf, una per riga, senza commenti né righe vuote
leggi_elenco() {
    tr -d '\r' < "$ELENCO" | sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^$'
}

# Legge un'app: SERVIZI (quelli del compose) e CONTENITORI (righe nel FORMATO qui sopra).
# Se non ci riesce ritorna 1, con il motivo in ERRORE.
esamina() {
    local cartella=$BASE/$1 trovato=0 f servizi ids righe
    SERVIZI=() CONTENITORI=() ERRORE=""
    if [ ! -d "$cartella" ]; then ERRORE="manca la cartella $cartella"; return 1; fi
    for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
        [ -f "$cartella/$f" ] && trovato=1
    done
    if [ "$trovato" = 0 ]; then ERRORE="in $cartella non c'è un docker-compose.yml"; return 1; fi

    if ! servizi=$(cd "$cartella" && timeout 60 docker compose config --services 2>/dev/null) || [ -z "$servizi" ]; then
        ERRORE="docker compose non riesce a leggere il compose (per vedere l'errore: cd $cartella && docker compose config -q)"
        return 1
    fi
    mapfile -t SERVIZI <<< "$servizi"

    if ! ids=$(cd "$cartella" && timeout 60 docker compose ps -a -q 2>/dev/null); then
        ERRORE="docker compose ps non risponde"
        return 1
    fi
    if [ -n "$ids" ]; then
        # Un container sparito tra ps e inspect fa fallire inspect, ma gli altri li stampa lo stesso
        # shellcheck disable=SC2086
        righe=$(timeout 60 docker inspect --format "$FORMATO" $ids 2>/dev/null)
        if [ -z "$righe" ]; then ERRORE="docker inspect non risponde"; return 1; fi
        mapfile -t CONTENITORI <<< "$righe"
    fi
    return 0
}

# Esegue un intervento e scrive com'è andato. In prova dice solo cosa farebbe.
esegui() {   # app, motivo, cartella (vuota = qui), comando...
    local app=$1 motivo=$2 cartella=$3 risultato codice
    shift 3
    if [ "$PROVA" = 1 ]; then echo "$app: $motivo → farei: $*"; return 0; fi
    risultato=$(cd "${cartella:-.}" && timeout 900 "$@" 2>&1)
    codice=$?
    if [ "$codice" = 0 ]; then
        scrivi "$app: $motivo → $*: fatto"
    else
        scrivi "$app: $motivo → $*: NON riuscito (codice $codice): $(printf '%s' "$risultato" | tail -n 3 | tr '\n' ' ')"
    fi
}

controlla_app() {
    local voce=$1 app riga servizio oneoff stato salute politica uscita nome cosa n
    app=$(basename "$voce")
    if [ -e "$PAUSA/$app" ]; then
        segnala "$app" "in pausa, non la controllo (per ricominciare: ./guardiano.sh riprendi $app)"
        return
    fi
    if ! esamina "$voce"; then segnala "$app" "$ERRORE"; return; fi

    local -A acceso=()
    local fermi=() malati=() in_giro=()
    for riga in "${CONTENITORI[@]}"; do
        IFS='|' read -r servizio oneoff stato salute politica uscita nome <<< "$riga"
        [ "$oneoff" = True ] && continue          # container di "docker compose run": non contano
        nome=${nome#/}
        case $stato in
            running)
                acceso[$servizio]=1
                [ "$salute" = unhealthy ] && malati+=("$nome") ;;
            restarting)
                acceso[$servizio]=1
                in_giro+=("$nome") ;;
            paused)
                acceso[$servizio]=1 ;;            # fermato apposta con docker pause
            exited)
                # Un servizio fatto per finire (senza riavvio automatico) che è finito bene
                if [ "$uscita" = 0 ] && case $politica in ''|no|on-failure) true ;; *) false ;; esac; then
                    acceso[$servizio]=1
                fi ;;
        esac
    done
    for servizio in "${SERVIZI[@]}"; do
        [ -n "${acceso[$servizio]:-}" ] || fermi+=("$servizio")
    done

    if [ ${#fermi[@]} -eq 0 ] && [ ${#malati[@]} -eq 0 ] && [ ${#in_giro[@]} -eq 0 ]; then
        risolto "$app" "a posto"
        return
    fi
    if [ ${#fermi[@]} -eq 0 ] && [ ${#malati[@]} -eq 0 ]; then
        segnala "$app" "${in_giro[*]} si riavvia da solo in continuazione: Docker ci sta già provando, guarda i log (cd $BASE/$voce && docker compose logs --tail 50)"
        return
    fi

    cosa=""
    [ ${#fermi[@]} -gt 0 ] && cosa="servizi fermi: ${fermi[*]}"
    [ ${#malati[@]} -gt 0 ] && cosa="${cosa:+$cosa; }non rispondono: ${malati[*]}"
    [ ${#in_giro[@]} -gt 0 ] && cosa="$cosa; si riavvia in continuazione: ${in_giro[*]}"
    n=$(interventi_recenti "$app")
    if [ "$n" -ge "$MAX_INTERVENTI" ]; then
        segnala "$app" "$cosa. L'ho già fatta ripartire $MAX_INTERVENTI volte nell'ultima ora: la lascio stare, serve un controllo a mano (cd $BASE/$voce && docker compose logs --tail 50)"
        return
    fi

    registra_intervento "$app"
    if [ ${#fermi[@]} -gt 0 ]; then
        esegui "$app" "servizi fermi: ${fermi[*]}" "$BASE/$voce" docker compose up -d
    fi
    for nome in "${malati[@]}"; do
        esegui "$app" "$nome non risponde (unhealthy)" "" docker restart "$nome"
    done
    # Così al prossimo giro, se è tutto a posto, il registro lo dice
    [ "$PROVA" = 1 ] || printf 'intervento\n' > "$DATI/$app.problema"
}

# Progetti compose sul Pi che non sono in app.conf (un'app nuova dimenticata?)
controlla_progetti() {
    local voce elenco progetto file cartella note=""
    local -A cartelle=()
    for voce in "${VOCI[@]}"; do cartelle[$BASE/$voce]=1; done
    elenco=$(timeout 60 docker compose ls -a 2>/dev/null | awk 'NR > 1 { print $1 "|" $NF }') || return 0
    while IFS='|' read -r progetto file; do
        [ -n "$progetto" ] || continue
        cartella=$(dirname "${file%%,*}")
        [ -n "${cartelle[$cartella]:-}" ] || note="$note $progetto ($cartella)"
    done <<< "$elenco"
    if [ -n "$note" ]; then
        segnala progetti "progetti compose che non controllo:$note. Se vanno tenuti accesi, aggiungili ad app.conf"
    elif [ "$PROVA" = 0 ]; then
        risolto progetti "tutti i progetti compose sono in app.conf"
    fi
}

# Un update.sh, o un build/pull di compose, partito da meno di AGGIORNAMENTO_BLOCCATO secondi?
aggiornamento_in_corso() {
    local pid eta vecchi=""
    command -v pgrep >/dev/null 2>&1 || return 1
    for pid in $(pgrep -f 'update\.sh|compose.*(build|pull)' 2>/dev/null); do
        eta=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
        case $eta in ''|*[!0-9]*) continue ;; esac
        if [ "$eta" -lt "$AGGIORNAMENTO_BLOCCATO" ]; then return 0; fi
        vecchi="$vecchi $pid"
    done
    if [ -n "$vecchi" ]; then
        segnala aggiornamento "un aggiornamento è in corso da più di $((AGGIORNAMENTO_BLOCCATO / 60)) minuti (pid$vecchi): controllo lo stesso"
    elif [ "$PROVA" = 0 ]; then
        risolto aggiornamento "nessun aggiornamento bloccato"
    fi
    return 1
}

fine_giro() { [ "$PROVA" = 1 ] || echo "$(adesso) — $1" > "$DATI/ultimo-giro"; }

ruota_registro() {
    if [ -f "$REGISTRO" ] && [ "$(( $(wc -c < "$REGISTRO") ))" -gt "$REGISTRO_MAX" ]; then
        mv -f "$REGISTRO" "$REGISTRO.1"
    fi
}

giro() {
    local voce
    mkdir -p "$DATI" "$PAUSA"
    if [ "$PROVA" = 1 ]; then
        echo "Prova: dico cosa farei, senza toccare niente."
    else
        ruota_registro
        if command -v flock >/dev/null 2>&1; then
            exec 9> "$DATI/.blocco"
            flock -n 9 || exit 0      # il giro di prima non è ancora finito
        fi
    fi
    if [ ! -f "$ELENCO" ]; then scrivi "manca l'elenco delle app: $ELENCO"; exit 1; fi

    if ! timeout 30 docker info > /dev/null 2>&1; then
        segnala docker "Docker non risponde: non posso controllare niente (sudo systemctl status docker)"
        fine_giro "Docker non risponde"
        exit 1
    fi
    [ "$PROVA" = 1 ] || risolto docker "di nuovo raggiungibile"

    if [ -e "$PAUSA/tutto" ]; then
        segnala pausa "tutto in pausa, non controllo niente (per ricominciare: ./guardiano.sh riprendi tutto)"
        fine_giro "tutto in pausa"
        exit 0
    fi
    [ "$PROVA" = 1 ] || risolto pausa "pausa generale finita, ricomincio a controllare"

    if aggiornamento_in_corso; then
        if [ "$PROVA" = 1 ]; then
            echo "(Un aggiornamento è in corso: un giro vero adesso aspetterebbe il prossimo.)"
        else
            fine_giro "saltato: aggiornamento in corso"
            exit 0
        fi
    fi

    for voce in "${VOCI[@]}"; do controlla_app "$voce"; done
    controlla_progetti
    fine_giro "completo"
}

descrivi() {   # stato, salute, codice di uscita → a parole
    local d
    case $1 in
        running)    d="acceso" ;;
        restarting) d="si riavvia in continuazione" ;;
        exited)     d="fermo (codice $3)" ;;
        paused)     d="in pausa (docker pause)" ;;
        created)    d="creato ma mai partito" ;;
        *)          d=$1 ;;
    esac
    case $2 in
        healthy)   d="$d, risponde" ;;
        unhealthy) d="$d, NON risponde" ;;
        starting)  d="$d, in avvio" ;;
    esac
    echo "$d"
}

mostra_stato() {
    local voce app n riga servizio oneoff stato salute politica uscita nome pause ultimo="mai"
    local -A visti=()
    mkdir -p "$DATI" "$PAUSA"
    [ -f "$DATI/ultimo-giro" ] && ultimo=$(cat "$DATI/ultimo-giro")
    pause=$(ls -A "$PAUSA" 2>/dev/null | tr '\n' ' ')
    echo "Ultimo giro: $ultimo"
    echo "In pausa: ${pause:-nessuna}"
    echo
    if ! timeout 30 docker info > /dev/null 2>&1; then
        echo "Docker non risponde."
    else
        for voce in "${VOCI[@]}"; do
            app=$(basename "$voce")
            n=$(PROVA=1 interventi_recenti "$app")
            printf '%s' "$app"
            [ -e "$PAUSA/$app" ] && printf ' [in pausa]'
            if [ "$n" = 1 ]; then printf ' (fatta ripartire 1 volta nell'\''ultima ora)'
            elif [ "$n" -gt 1 ]; then printf ' (fatta ripartire %s volte nell'\''ultima ora)' "$n"; fi
            echo
            if ! esamina "$voce"; then echo "  ! $ERRORE"; continue; fi
            visti=()
            for riga in "${CONTENITORI[@]}"; do
                IFS='|' read -r servizio oneoff stato salute politica uscita nome <<< "$riga"
                [ "$oneoff" = True ] && continue
                visti[$servizio]=1
                printf '  %-40s %s\n' "${nome#/}" "$(descrivi "$stato" "$salute" "$uscita")"
            done
            for servizio in "${SERVIZI[@]}"; do
                [ -n "${visti[$servizio]:-}" ] || printf '  %-40s %s\n' "($servizio)" "nessun container"
            done
        done
    fi
    echo
    echo "Ultime righe del registro ($REGISTRO):"
    if [ -s "$REGISTRO" ]; then tail -n 10 "$REGISTRO"; else echo "  (vuoto: finora nessun intervento)"; fi
}

cambia_pausa() {   # pausa|riprendi, app o "tutto"
    local azione=$1 app=$2 voce valide=" tutto"
    for voce in "${VOCI[@]}"; do valide="$valide $(basename "$voce")"; done
    if [ -z "$app" ] || [[ " $valide " != *" $app "* ]]; then
        echo "Uso: ./guardiano.sh $azione <app>   (app:$valide)"
        exit 2
    fi
    mkdir -p "$PAUSA"
    if [ "$azione" = pausa ]; then
        touch "$PAUSA/$app"
        echo "Fatto: il guardiano non tocca più $app finché non lanci ./guardiano.sh riprendi $app"
    else
        rm -f "$PAUSA/$app"
        echo "Fatto: dal prossimo giro (entro 5 minuti) il guardiano controlla di nuovo $app"
    fi
}

VOCI=()
[ -f "$ELENCO" ] && mapfile -t VOCI < <(leggi_elenco)

case ${1:-giro} in
    giro)           giro ;;
    prova)          PROVA=1; giro ;;
    stato)          mostra_stato ;;
    pausa|riprendi) cambia_pausa "$1" "${2:-}" ;;
    aiuto|-h|--help) sed -n '4,8p' "$0" | sed 's/^# \{0,1\}//' ;;
    *)              echo "Comando sconosciuto: $1"; sed -n '4,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
