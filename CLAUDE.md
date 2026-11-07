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

`guardiano.sh` tiene accese le app Docker del Pi: il cron lo lancia ogni 5 minuti (minuti 2, 7, 12…), e per ogni cartella di `app.conf` avvia con `docker compose up -d` i servizi fermi o spariti e fa `docker restart` dei container `unhealthy`. Al massimo 3 interventi in un'ora per app, salta il giro durante gli `update.sh`, scrive in `guardiano.log` solo quando succede qualcosa. Comandi `stato`, `prova`, `pausa <app>`, `riprendi <app>`, `pagina`, `fotografia`: vedi `README.md`.

- Lo script gira sull'host come utente `pepe`, **senza `sudo`**, dal cron.
- La **pagina di stato** (`web/`, container `guardiano-web-1`, `127.0.0.1:8093`, `https://guardiano.<tailnet>.ts.net` dalla repo `ingressi-https`) **non ha accesso a Docker**: legge in sola lettura la fotografia che `guardiano.sh pagina` scrive ogni minuto in `/dev/shm/guardiano`, e i suoi pulsanti (Riavvia, Ferma, Avvia) lasciano richieste in `/dev/shm/guardiano-richieste`, che `guardiano.sh pagina` ricontrolla ed esegue. Formato della fotografia: in testa a `web/foto.js`. `update.sh` fa `git pull` e ricostruisce la pagina.
- **`/dev/shm` si svuota quando `pepe` esce dal Pi** (systemd-logind, `RemoveIPC=yes` di Debian, all'uscita dall'ultima sessione SSH). `guardiano.sh pagina` ricrea le cartelle ogni minuto e, con `controlla_cartelle_pagina`, riavvia il container se vede ancora quelle vecchie (inode diversi). Un bind mount di una cartella cancellata e rifatta resta legato a quella vecchia: vale per qualsiasi cosa nuova messa in `/dev/shm`.
- Dati fuori da git nella sua cartella: `dati/` (problemi già segnalati, interventi recenti, azioni della pagina, ultimo giro), `pausa/` (una riga `mano` per la pausa a mano, `pagina<TAB><container>` per ogni container fermato dalla pagina), `guardiano.log`.

## Vincoli tecnici (non romperli)

- Solo `bash` (5 sul Pi; deve girare anche con il 4.4 di Git Bash per i test), coreutils, `pgrep`/`ps` di procps, `flock` (se c'è) e `docker compose` v2. Niente `jq`, Python o altre dipendenze da installare sul Pi.
- Mai comandi che cancellano: niente `down`, `rm`, `prune`, volumi. Il guardiano accende e riavvia, non ricostruisce (`up -d` senza `--build`) e non tocca le app in pausa.
- Ogni comando verso Docker passa da `timeout`: un Docker bloccato non deve bloccare il cron.
- Quando sul Pi si aggiunge o si toglie un'app, va aggiunta o tolta in `app.conf` (e in `INFRASTRUTTURA-PI.md`).
- A capo LF (`.gitattributes`) e `guardiano.sh`, `update.sh`, `test/test.sh` e `test/finti/*` eseguibili: da Windows aggiungerli con `git add --chmod=+x`.
- **Mai `docker.sock` (né altro accesso a Docker) nel container della pagina**: chi comanda Docker comanda il Pi come root. La pagina chiede, `guardiano.sh` decide: ogni richiesta (`esegui_richiesta`) va ricontrollata lì da capo, perché il suo contenuto viene da un container. Le azioni restano tre (riavvia, ferma, avvia), mai comandi arbitrari, mai `rm`/`down`.
- Nella fotografia niente che possa contenere segreti: niente `.Config.Env` né `docker inspect` completo (vedi `FOTO_FORMATO`).
- `web/`: Node senza dipendenze, CSP rigida (niente stili o script in linea, niente `innerHTML`: il DOM si fa con `createElement`/`textContent`, i log possono contenere di tutto), le scritture solo con JSON e dalla stessa origine, come LogoApp. Colori solo dalle variabili di `:root` in `web/www/pannello.css` (chiaro e scuro). File statici con nomi propri (`pannello.css`, `pannello.js`).
- La pagina deve funzionare a 375 px (telefono), su iPad e su PC.

## Prove

- `bash test/test.sh` dopo ogni modifica a `guardiano.sh`: prova lo script con il `docker` finto di `test/finti/` (scena per app in `$SCENA`, interventi annotati in `$SCENA/chiamate`), compresi fotografia e pulsanti. Un comportamento nuovo vuole un caso nuovo nel test.
- `node test/test-web.js` dopo ogni modifica a `web/`: server, API, intestazioni, pulsanti, con la fotografia d'esempio di `test/foto-esempio.js`.
- Anteprima della pagina: `node test/anteprima.js` (`.claude/launch.json`, porta 8093), con dati d'esempio e un finto guardiano che risponde ai pulsanti.
- Sul Pi, prima di fidarsi di una modifica: `./guardiano.sh prova` dice cosa farebbe senza toccare niente.
