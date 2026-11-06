# Istruzioni per Claude (guardiano)

## Lingua

Rispondi sempre in italiano, anche nei commit, nelle PR e nei commenti al codice.

## Raspberry Pi: infrastruttura condivisa

Questo script gira su un Raspberry Pi 5 insieme alle altre app (Docker + Tailscale). L'elenco di tutto ciò che è già occupato sul Pi (porte, cartelle, progetti compose, container, reti e bridge, firewall, volumi, dispositivi e percorsi Tailscale, cron, nomi dei cookie) è nel file **`INFRASTRUTTURA-PI.md` della repo `Vito-Pepe/sillabe`**:
https://raw.githubusercontent.com/Vito-Pepe/sillabe/main/INFRASTRUTTURA-PI.md

- **Leggilo prima** di scegliere o cambiare porte, nomi, reti, volumi, `tailscale serve`/funnel, cron o firewall, e prima di dare comandi da eseguire sul Pi. Non dare per libero niente di ciò che elenca; nel dubbio fai lanciare all'utente i comandi della sua sezione 9 e lavora sul loro output.
- Se non riesci a scaricarlo, aggiungi la repo `Vito-Pepe/sillabe` alla sessione e leggilo da lì.
- **Tienilo aggiornato**: se il tuo lavoro aggiunge, cambia o toglie qualcosa di infrastrutturale sul Pi, aggiorna `INFRASTRUTTURA-PI.md` nella repo `Vito-Pepe/sillabe` (aggiungila alla sessione con accesso in scrittura) con una PR, e dai all'utente il link diretto. Fallo nello stesso lavoro, non "dopo".
- Mai `tailscale serve` sull'host del Pi per una nuova app: gli indirizzi HTTPS si aggiungono nella repo `Vito-Pepe/ingressi-https`.

## Come lavorare con l'utente

- Il Pi segue `main`. Lavora su un branch e apri una PR verso `main`; l'utente la unisce su GitHub con **"Create a merge commit"** e non cancella il branch. Dai sempre il **link diretto** della PR e, prima di chiedere di unirla, verifica che sia ancora aperta.
- Claude non può fare SSH sul Pi: prepara i comandi a blocchi, da incollare uno alla volta, con l'output atteso. Segreti solo nel `.env` sul Pi, mai su git.
- Claude non può creare repo su GitHub (403): se serve una repo nuova, chiedi all'utente di crearla (Public, con "Add a README file").
- Una repo nuova che girerà sul Pi deve avere anche lei un `CLAUDE.md` con queste istruzioni (copialo da una delle repo esistenti).

## Cos'è

`guardiano.sh` tiene accese le app Docker del Pi: il cron lo lancia ogni 5 minuti (minuti 2, 7, 12…), e per ogni cartella di `app.conf` avvia con `docker compose up -d` i servizi fermi o spariti e fa `docker restart` dei container `unhealthy`. Al massimo 3 interventi in un'ora per app, salta il giro durante gli `update.sh`, scrive in `guardiano.log` solo quando succede qualcosa. Comandi `stato`, `prova`, `pausa <app>`, `riprendi <app>`: vedi `README.md`.

- Gira sull'host come utente `pepe`, **senza `sudo`**, dal cron: niente container, porte o rete. `update.sh` fa solo `git pull` (il guardiano non ha immagini da ricostruire).
- Dati fuori da git nella sua cartella: `dati/` (problemi già segnalati, interventi recenti, ultimo giro), `pausa/`, `guardiano.log`.

## Vincoli tecnici (non romperli)

- Solo `bash` (5 sul Pi; deve girare anche con il 4.4 di Git Bash per i test), coreutils, `pgrep`/`ps` di procps, `flock` (se c'è) e `docker compose` v2. Niente `jq`, Python o altre dipendenze da installare sul Pi.
- Mai comandi che cancellano: niente `down`, `rm`, `prune`, volumi. Il guardiano accende e riavvia, non ricostruisce (`up -d` senza `--build`) e non tocca le app in pausa.
- Ogni comando verso Docker passa da `timeout`: un Docker bloccato non deve bloccare il cron.
- Quando sul Pi si aggiunge o si toglie un'app, va aggiunta o tolta in `app.conf` (e in `INFRASTRUTTURA-PI.md`).
- A capo LF (`.gitattributes`) e `guardiano.sh`, `update.sh`, `test/test.sh` e `test/finti/*` eseguibili: da Windows aggiungerli con `git add --chmod=+x`.

## Prove

- `bash test/test.sh` dopo ogni modifica a `guardiano.sh`: prova lo script con il `docker` finto di `test/finti/` (scena per app in `$SCENA`, interventi annotati in `$SCENA/chiamate`). Un comportamento nuovo vuole un caso nuovo nel test.
- Sul Pi, prima di fidarsi di una modifica: `./guardiano.sh prova` dice cosa farebbe senza toccare niente.
