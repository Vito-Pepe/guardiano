# guardiano

Tiene accese le app Docker del Raspberry Pi, e le mostra in una pagina web con i log e i pulsanti per riavviarle, fermarle e avviarle.

## Il giro: ogni 5 minuti

Ogni 5 minuti il cron lancia `guardiano.sh`, che per ogni app di [`app.conf`](app.conf):

- **servizio fermo, sparito o mai partito** (per esempio dopo un `docker compose stop`, o un avvio fallito dopo un riavvio del Pi) → `docker compose up -d` nella cartella dell'app. Avvia solo quello che manca, non tocca il resto e non ricostruisce niente;
- **container `unhealthy`**: è acceso ma il suo `healthcheck` fallisce, cioè l'app è bloccata → `docker restart`. Docker da solo lo segna `unhealthy` ma non lo riavvia;
- **container che si riavvia in continuazione** → lo scrive e basta. Docker ci sta già provando: il problema è nell'app e servono i suoi log.

I crash veri (il programma si chiude) li gestisce già Docker con `restart: unless-stopped`: il guardiano copre quello che resta.

Precauzioni:

- al massimo **3 interventi in un'ora** per ogni app: oltre la lascia stare e lo scrive, così un'app rotta non finisce in un giro infinito di riavvii;
- **salta il giro** mentre un `update.sh` (o un build/pull di compose) è in corso, per non scontrarsi con un aggiornamento. Se un aggiornamento resta bloccato più di 30 minuti, lo segnala e controlla lo stesso;
- se un giro è ancora in corso quando parte il successivo, il nuovo non parte (`flock`);
- niente `sudo`: gira come `pepe`, con `bash` e `docker`.

## La pagina di stato

`https://guardiano.<tailnet>.ts.net` (solo dalla tailnet; riquadro «Guardiano» della homepage in https):

- **pagina iniziale**: un riquadro per app, verde (tutto bene), giallo (da tenere d'occhio: in avvio, o ripartita da poco), rosso (problemi) o grigio (in pausa), più gli avvisi generali e gli ultimi interventi del guardiano;
- **pagina di un'app** (tocca il riquadro): ogni container con stato, controllo di salute (e il motivo, se fallisce), da quanto è acceso, riavvii, immagine, le **ultime 200 righe di log** e i pulsanti **Riavvia**, **Ferma**, **Avvia**.

Come funziona, senza dare Docker al container della pagina (chi comanda Docker comanda tutto il Pi, come root):

- ogni minuto il cron lancia `guardiano.sh pagina`, che scrive una **fotografia** (stato e log di ogni container) in `/dev/shm/guardiano`, in memoria e non sulla scheda SD. Il container `guardiano-web-1` la legge **in sola lettura**: i dati hanno al massimo un minuto;
- un pulsante lascia una **richiesta** in `/dev/shm/guardiano-richieste`, l'unica cartella in cui il container scrive. `guardiano.sh pagina` resta in ascolto per quasi tutto il minuto, **ricontrolla tutto da capo** (app e container devono essere in `app.conf`, azione tra le tre ammesse, al massimo 30 all'ora), la esegue in pochi secondi, la scrive nel registro e rifà la fotografia;
- **Ferma** mette anche l'app in pausa, altrimenti il giro la riaccenderebbe entro 5 minuti; **Avvia** toglie quella pausa. Una pausa messa a mano (`guardiano.sh pausa`) resta;
- Riavvia e Ferma chiedono un secondo tocco di conferma. La pagina non può fermare sé stessa (`guardiano-web-1`) né il suo ingresso HTTPS (`ingressi-https-guardiano-1`): resteresti chiuso fuori;
- il dispositivo Tailscale `guardiano` **non va mai condiviso** (Machines → Share): chi lo riceve potrebbe fermare le app.

## Il registro

`guardiano.log` (nella cartella del guardiano, fuori da git) contiene una riga **solo quando succede qualcosa**: un intervento, un pulsante premuto nella pagina, un problema nuovo, un problema risolto («a posto»). Un problema che dura viene scritto una volta sola, non a ogni giro. Oltre 1 MB il registro diventa `guardiano.log.1`.

```
2026-11-07 10:02:03 — logoapp: logoapp-logoapp-1 non risponde (unhealthy) → docker restart logoapp-logoapp-1: fatto
2026-11-07 10:07:02 — logoapp: a posto
2026-11-07 11:15:40 — meteo: dalla pagina: ferma meteo: fatto
```

Scrive anche quando trova sul Pi un progetto compose che non è in `app.conf` (un'app nuova dimenticata).

## Comandi

```bash
cd ~/guardiano
./guardiano.sh stato             # container di ogni app, pause, ultimo giro, ultime righe del registro
./guardiano.sh prova             # cosa farebbe adesso, senza toccare niente
./guardiano.sh pausa logoapp     # non controllare logoapp (per fermarla apposta)
./guardiano.sh riprendi logoapp  # controllala di nuovo
./guardiano.sh pausa tutto       # non controllare niente (manutenzione del Pi)
./guardiano.sh riprendi tutto
./guardiano.sh fotografia        # una fotografia per la pagina, subito
```

**Per fermare un'app apposta** dal terminale (`docker compose stop` o `down`) mettila prima in pausa: altrimenti entro 5 minuti il guardiano la riaccende. Dalla pagina, Ferma lo fa da sé. Le pause non scadono: `stato` e la pagina le mostrano.

## Installazione sul Pi

La prima volta (già fatto il 2026-11-07):

```bash
cd ~ && git clone https://github.com/Vito-Pepe/guardiano.git && cd ~/guardiano && ./guardiano.sh prova
```

Le righe di cron, come le altre app:

```
*/5 * * * * cd /home/pepe/guardiano && ./update.sh >> /home/pepe/guardiano/update.log 2>&1
2-59/5 * * * * cd /home/pepe/guardiano && ./guardiano.sh >> /home/pepe/guardiano/guardiano.log 2>&1
* * * * * cd /home/pepe/guardiano && ./guardiano.sh pagina >> /home/pepe/guardiano/guardiano.log 2>&1
```

La prima tiene il guardiano aggiornato a `main` e ricostruisce la pagina quando cambia; la seconda fa i giri ai minuti 2, 7, 12…, sfasati rispetto agli `update.sh` delle app (minuti 0, 5, 10…); la terza tiene aggiornata la pagina e ne esegue i pulsanti.

La pagina gira sulla porta `127.0.0.1:8093` e ci arriva l'ingresso HTTPS `guardiano` della repo `ingressi-https`. Dopo un riavvio del Pi le cartelle in `/dev/shm` non ci sono finché `guardiano.sh pagina` non le ricrea (entro un minuto): intanto il container non parte, e lo accende il giro successivo del guardiano.

Le stesse cartelle spariscono anche **quando esci dal Pi** (l'ultima sessione SSH di `pepe` si chiude): systemd-logind, con l'impostazione predefinita di Debian `RemoveIPC=yes`, cancella i file di `pepe` in `/dev/shm`. `guardiano.sh pagina` le ricrea al minuto dopo, ma il container resterebbe collegato a quelle vecchie («Nessuna fotografia», pulsanti senza risposta): per questo ogni minuto confronta le cartelle del Pi con quelle che vede il container (gli inode) e, se sono diverse, lo riavvia (al massimo 3 volte in un'ora). Nel registro compare «la pagina vedeva cartelle vecchie di /dev/shm».

## Un'app nuova sul Pi

Aggiungi la sua cartella ad [`app.conf`](app.conf) con una PR. Perché il guardiano si accorga anche di quando è bloccata (non solo spenta), dalle un `healthcheck` nel suo `docker-compose.yml`, come LogoApp e Impasti:

```yaml
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3000/api/salute"]
      interval: 60s
      timeout: 5s
      retries: 3
```

## Prove

```bash
bash test/test.sh        # lo script, con un docker finto (test/finti/): giro, fotografia, pulsanti
node test/test-web.js    # la pagina: server, API, sicurezza, pulsanti, con una fotografia d'esempio
node test/anteprima.js   # la pagina sul PC, su http://localhost:8093, con dati d'esempio
```

`test/test.sh` non tocca Docker: funziona sul Pi, su Linux e con Git Bash su Windows. L'anteprima finge anche il guardiano: i pulsanti rispondono «fatto» senza fare niente.
