# guardiano

Tiene accese le app Docker del Raspberry Pi. Ogni 5 minuti il cron lancia `guardiano.sh`, che per ogni app di [`app.conf`](app.conf):

- **servizio fermo, sparito o mai partito** (per esempio dopo un `docker compose stop`, o un avvio fallito dopo un riavvio del Pi) → `docker compose up -d` nella cartella dell'app. Avvia solo quello che manca, non tocca il resto e non ricostruisce niente;
- **container `unhealthy`**: è acceso ma il suo `healthcheck` fallisce, cioè l'app è bloccata → `docker restart`. Docker da solo lo segna `unhealthy` ma non lo riavvia;
- **container che si riavvia in continuazione** → lo scrive e basta. Docker ci sta già provando: il problema è nell'app e servono i suoi log.

I crash veri (il programma si chiude) li gestisce già Docker con `restart: unless-stopped`: il guardiano copre quello che resta.

Precauzioni:

- al massimo **3 interventi in un'ora** per ogni app: oltre la lascia stare e lo scrive, così un'app rotta non finisce in un giro infinito di riavvii;
- **salta il giro** mentre un `update.sh` (o un build/pull di compose) è in corso, per non scontrarsi con un aggiornamento. Se un aggiornamento resta bloccato più di 30 minuti, lo segnala e controlla lo stesso;
- se un giro è ancora in corso quando parte il successivo, il nuovo non parte (`flock`);
- niente `sudo`, niente container, niente porte, niente rete: solo `bash` e `docker` sul Pi.

## Il registro

`guardiano.log` (nella cartella del guardiano, fuori da git) contiene una riga **solo quando succede qualcosa**: un intervento, un problema nuovo, un problema risolto («a posto»). Un problema che dura viene scritto una volta sola, non a ogni giro. Oltre 1 MB il registro diventa `guardiano.log.1`.

```
2026-11-07 10:02:03 — logoapp: logoapp-logoapp-1 non risponde (unhealthy) → docker restart logoapp-logoapp-1: fatto
2026-11-07 10:07:02 — logoapp: a posto
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
```

**Per fermare un'app apposta** (`docker compose stop` o `down`) mettila prima in pausa: altrimenti entro 5 minuti il guardiano la riaccende. Le pause non scadono: `stato` le mostra in cima.

## Installazione sul Pi

Una volta sola, dopo aver unito su GitHub la PR che porta lo script su `main`:

```bash
cd ~ && git clone https://github.com/Vito-Pepe/guardiano.git && cd ~/guardiano && ./guardiano.sh prova
```

`prova` deve elencare le app e dire «a posto» per ognuna (o cosa farebbe). Poi le due righe di cron, come le altre app:

```bash
(crontab -l; echo '*/5 * * * * cd /home/pepe/guardiano && ./update.sh >> /home/pepe/guardiano/update.log 2>&1'; echo '2-59/5 * * * * cd /home/pepe/guardiano && ./guardiano.sh >> /home/pepe/guardiano/guardiano.log 2>&1') | crontab -
```

La prima tiene il guardiano aggiornato a `main`; la seconda fa i controlli ai minuti 2, 7, 12…, sfasati rispetto agli `update.sh` delle app (minuti 0, 5, 10…).

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
bash test/test.sh
```

Prova lo script con un `docker` finto (`test/finti/`), senza toccare Docker: funziona sul Pi, su Linux e con Git Bash su Windows.
