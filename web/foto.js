'use strict';
// Legge la fotografia scritta da "guardiano.sh fotografia" (ogni minuto, in /dev/shm/guardiano,
// montata qui in sola lettura) e la trasforma nello stato mostrato dalla pagina.
//
// Struttura della fotografia (vedi guardiano.sh):
//   attuale                     nome della cartella completa più recente
//   <foto>/ora                  quando è stata fatta (secondi epoch)
//   <foto>/docker               "ok" o "giu"
//   <foto>/elenco               le app, una per riga, nell'ordine di app.conf
//   <foto>/giro                 com'è andato l'ultimo giro del guardiano
//   <foto>/pause                app in pausa (o "tutto")
//   <foto>/problemi             chiave<TAB>problema ancora aperto (app o generale)
//   <foto>/registro             ultime righe di guardiano.log
//   <foto>/protetti             container che la pagina non può fermare (servono a lei)
//   <foto>/app/<app>/info       cartella, interventi, pausa, fermati, errore (chiave<TAB>valore)
//   <foto>/app/<app>/servizi    i servizi del compose
//   <foto>/app/<app>/contenitori  nome|servizio|oneoff|politica|immagine|riavvii|.State in JSON
//   <foto>/log/<container>      ultime righe di log, con l'ora di Docker in testa

const fs = require('fs');
const path = require('path');

const NOME_VALIDO = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const DATA_ZERO = '0001-01-01T00:00:00Z';

function testo(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function righe(t) {
  return t ? t.split('\n').map(r => r.replace(/\r$/, '')).filter(r => r.trim() !== '') : [];
}

function chiaviValori(t) {
  const m = new Map();
  for (const r of righe(t)) {
    const i = r.indexOf('\t');
    if (i > 0) m.set(r.slice(0, i), r.slice(i + 1));
  }
  return m;
}

function data(s) {
  if (!s || s.startsWith('0001-')) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// La cartella della fotografia completa più recente, o null se non ce n'è ancora una
function cartellaAttuale(base) {
  const nome = (testo(path.join(base, 'attuale')) || '').trim();
  if (!NOME_VALIDO.test(nome)) return null;
  const dir = path.join(base, nome);
  return fs.existsSync(dir) ? dir : null;
}

// I pulsanti che hanno senso per un container (il guardiano li ricontrolla comunque)
function azioniPossibili(c, protetti) {
  switch (c.stato) {
    case 'running':
    case 'restarting':
      return protetti.includes(c.nome) ? ['riavvia'] : ['riavvia', 'ferma'];
    case 'exited':
    case 'created':
    case 'dead':
    case 'mancante':
      return ['avvia'];
    default:   // paused (docker pause), removing: niente
      return [];
  }
}

// ok | avvio | errore | pausa | finito | fermato
function esitoContenitore(c) {
  switch (c.stato) {
    case 'running':
      if (c.salute === 'unhealthy') return 'errore';
      if (c.salute === 'starting') return 'avvio';
      return 'ok';
    case 'paused':
      return 'pausa';
    case 'exited':
      // Un servizio fatto per finire (senza riavvio automatico) che è finito bene
      return c.uscita === 0 && ['', 'no', 'on-failure'].includes(c.politica) ? 'finito' : 'errore';
    default:   // restarting, created, dead, removing
      return 'errore';
  }
}

function contenitore(riga) {
  const parti = riga.split('|');
  if (parti.length < 7) return null;
  const [nome, servizio, oneoff, politica, immagine, riavvii] = parti;
  let st = {};
  try { st = JSON.parse(parti.slice(6).join('|')) || {}; } catch { /* stato illeggibile */ }
  const salute = st.Health && st.Health.Status ? st.Health.Status : null;
  const log = st.Health && Array.isArray(st.Health.Log) ? st.Health.Log : [];
  const ultimo = log.length ? log[log.length - 1] : null;
  const c = {
    nome: nome.replace(/^\//, ''),
    servizio,
    oneoff: oneoff === 'True',
    politica,
    immagine,
    riavvii: Number(riavvii) || 0,
    stato: st.Status || 'sconosciuto',
    salute,
    uscita: typeof st.ExitCode === 'number' ? st.ExitCode : null,
    errore: st.Error || '',
    avviato: data(st.StartedAt),
    finito: st.FinishedAt === DATA_ZERO ? null : data(st.FinishedAt),
    controllo: ultimo ? {
      uscita: ultimo.ExitCode,
      testo: String(ultimo.Output || '').replace(ANSI, '').trim().slice(-600),
      quando: data(ultimo.End)
    } : null
  };
  c.esito = esitoContenitore(c);
  return c;
}

function leggiApp(dir, nome, problemi, docker, protetti) {
  const base = path.join(dir, 'app', nome);
  const info = chiaviValori(testo(path.join(base, 'info')));
  const servizi = righe(testo(path.join(base, 'servizi')));
  const fermati = (info.get('fermati') || '').split(' ').filter(n => NOME_VALIDO.test(n));
  const tutti = righe(testo(path.join(base, 'contenitori'))).map(contenitore).filter(Boolean);
  // I container di "docker compose run" non contano
  const contenitori = tutti.filter(c => !c.oneoff);
  for (const s of servizi) {
    if (!contenitori.some(c => c.servizio === s)) {
      contenitori.push({ nome: null, servizio: s, stato: 'mancante', esito: 'errore' });
    }
  }
  for (const c of contenitori) {
    // Fermato apposta dalla pagina: non è un guasto
    if (c.nome && fermati.includes(c.nome) && c.stato !== 'running' && c.stato !== 'restarting') c.esito = 'fermato';
    c.azioni = docker === 'ok' ? azioniPossibili(c, protetti) : [];
  }
  const problema = problemi.get(nome);
  const app = {
    nome,
    cartella: info.get('cartella') || nome,
    pausa: info.get('pausa') === '1',
    fermati,
    interventi: Number(info.get('interventi')) || 0,
    errore: info.get('errore') || null,
    // "intervento" vuol dire solo che il guardiano l'ha appena fatta ripartire
    problema: problema && problema !== 'intervento' && !problema.startsWith('in pausa') ? problema : null,
    contenitori
  };
  if (docker !== 'ok') app.esito = 'sconosciuto';
  else if (app.pausa) app.esito = 'pausa';
  else if (app.errore || contenitori.some(c => c.esito === 'errore')) app.esito = 'errore';
  else if (contenitori.some(c => c.esito === 'avvio') || app.interventi > 0 || app.problema) app.esito = 'attenzione';
  else app.esito = 'ok';
  return app;
}

let cache = { dir: null, stato: null };

function leggiStato(base) {
  const dir = cartellaAttuale(base);
  if (!dir) {
    return { pronto: false, motivo: 'Nessuna fotografia: la scrive "guardiano.sh fotografia" dal cron, ogni minuto.' };
  }
  if (cache.dir === dir) return cache.stato;

  const ora = Number((testo(path.join(dir, 'ora')) || '').trim()) || 0;
  const docker = (testo(path.join(dir, 'docker')) || '').trim() || 'giu';
  const nomi = righe(testo(path.join(dir, 'elenco'))).filter(n => NOME_VALIDO.test(n));
  const problemi = chiaviValori(testo(path.join(dir, 'problemi')));
  const protetti = righe(testo(path.join(dir, 'protetti'))).filter(n => NOME_VALIDO.test(n));
  const app = docker === 'ok' ? nomi.map(n => leggiApp(dir, n, problemi, docker, protetti)) : [];
  // Problemi generali: quelli con una chiave che non è un'app
  const avvisi = [...problemi]
    .filter(([chiave]) => !nomi.includes(chiave))
    .map(([chiave, t]) => ({ chiave, testo: t }));

  const stato = {
    pronto: true,
    ora: ora * 1000,
    docker,
    giro: (testo(path.join(dir, 'giro')) || '').trim() || null,
    pause: righe(testo(path.join(dir, 'pause'))),
    avvisi,
    registro: righe(testo(path.join(dir, 'registro'))).slice(-300),
    app
  };
  cache = { dir, stato };
  return stato;
}

// Le ultime righe di log di un container, senza i codici colore; null se non c'è
function leggiLog(base, nome) {
  if (!NOME_VALIDO.test(nome || '')) return null;
  const dir = cartellaAttuale(base);
  if (!dir) return null;
  const t = testo(path.join(dir, 'log', nome));
  return t === null ? null : t.replace(ANSI, '');
}

// Un pulsante premuto ha senso con lo stato attuale? null se sì, altrimenti il motivo.
// bersaglio = nome del container, o del servizio se il container non c'è (solo per Avvia).
function controllaAzione(stato, { app, bersaglio, azione } = {}) {
  if (!['riavvia', 'ferma', 'avvia'].includes(azione)) return 'azione sconosciuta';
  if (typeof app !== 'string' || typeof bersaglio !== 'string' || !NOME_VALIDO.test(bersaglio)) return 'richiesta non valida';
  if (!stato.pronto || stato.docker !== 'ok') return 'Docker non risponde: riprova tra poco';
  const a = stato.app.find(x => x.nome === app);
  if (!a) return 'app sconosciuta';
  const c = a.contenitori.find(x => (x.nome || x.servizio) === bersaglio);
  if (!c) return `${bersaglio} non è un container di ${app}`;
  if (!c.azioni.includes(azione)) return `con il container ${c.stato === 'mancante' ? 'che non c\'è' : 'in questo stato'} non si può`;
  return null;
}

module.exports = { leggiStato, leggiLog, controllaAzione, NOME_VALIDO };
