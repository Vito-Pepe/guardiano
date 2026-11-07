'use strict';
// Pagina di stato del guardiano: https://guardiano.<tailnet>.ts.net (solo tailnet).
// Legge la fotografia che "guardiano.sh pagina" scrive ogni minuto (FOTO_DIR, in sola lettura).
// Il container non ha accesso a Docker: i pulsanti scrivono una richiesta in RICHIESTE_DIR e il
// guardiano, sul Pi, la ricontrolla e la esegue.
//
//   GET  /                   la pagina (index.html, pannello.css, pannello.js, icona.svg)
//   GET  /api/stato          stato di app e container, problemi, registro del guardiano (JSON)
//   GET  /api/log/<nome>     ultime righe di log di un container (testo)
//   POST /api/azione         { app, bersaglio, azione: riavvia|ferma|avvia } → 202 { id }
//   GET  /api/azione/<id>    { stato: attesa|fatto|fallito|rifiutata|scaduta, messaggio }
//   GET  /api/salute         controllo del container

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const foto = require('./foto');

const PORTA = Number(process.env.PORT) || 3000;
const FOTO_DIR = process.env.FOTO_DIR || '/foto';
const RICHIESTE_DIR = process.env.RICHIESTE_DIR || '/richieste';
const WWW = path.join(__dirname, 'www');
const ID_VALIDO = /^[0-9]{13}-[0-9a-f]{8}$/;

const SICUREZZA = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex'
};

// I file della pagina, letti una volta all'avvio
const FILE = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/pannello.css': ['pannello.css', 'text/css; charset=utf-8'],
  '/pannello.js': ['pannello.js', 'text/javascript; charset=utf-8'],
  '/icona.svg': ['icona.svg', 'image/svg+xml']
};
const STATICI = new Map(Object.entries(FILE).map(([url, [file, tipo]]) =>
  [url, { corpo: fs.readFileSync(path.join(WWW, file)), tipo }]));

function rispondi(res, codice, corpo, tipo, extra) {
  const dati = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo));
  res.writeHead(codice, {
    ...SICUREZZA,
    'Content-Type': tipo,
    'Content-Length': dati.length,
    ...extra
  });
  res.end(res.req.method === 'HEAD' ? undefined : dati);
}

function json(res, codice, oggetto) {
  rispondi(res, codice, JSON.stringify(oggetto), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
}

// ── Pulsanti: richieste per il guardiano ──────────────────────────────────────

function azioniAttive() {
  try { fs.accessSync(RICHIESTE_DIR, fs.constants.W_OK); return true; } catch { return false; }
}

function chiaviValori(t) {
  const m = new Map();
  for (const r of String(t).split('\n')) {
    const i = r.indexOf('\t');
    if (i > 0) m.set(r.slice(0, i), r.slice(i + 1));
  }
  return m;
}

function esiste(file) { return fs.existsSync(path.join(RICHIESTE_DIR, file)); }

// attesa (il guardiano non l'ha ancora finita) | fatto | fallito | rifiutata | scaduta | null
function leggiEsito(id) {
  try {
    const m = chiaviValori(fs.readFileSync(path.join(RICHIESTE_DIR, `${id}.esito`), 'utf8'));
    return { stato: m.get('esito') || 'fallito', messaggio: m.get('messaggio') || '' };
  } catch { /* non ancora */ }
  if (esiste(`${id}.richiesta`) || esiste(`${id}.presa`)) return { stato: 'attesa', messaggio: '' };
  return null;
}

// Una richiesta alla volta per container: bersaglio → id
const inCorso = new Map();

function leggiCorpo(req, limite) {
  return new Promise((ok, ko) => {
    let dimensione = 0;
    const pezzi = [];
    const leggi = p => {
      dimensione += p.length;
      if (dimensione > limite) {
        // Si smette di tenere i dati (il resto viene scartato) e si risponde subito
        req.off('data', leggi);
        req.resume();
        ko(Object.assign(new Error('Dati troppo grandi'), { codice: 413 }));
        return;
      }
      pezzi.push(p);
    };
    req.on('data', leggi);
    req.on('end', () => {
      try { ok(JSON.parse(Buffer.concat(pezzi).toString('utf8') || 'null')); } catch { ko(Object.assign(new Error('JSON non valido'), { codice: 400 })); }
    });
    req.on('error', ko);
  });
}

async function nuovaAzione(req, res) {
  // Solo dalla pagina stessa: JSON obbligatorio (da un altro indirizzo il browser chiederebbe
  // prima il permesso, che qui non c'è) e nessuna richiesta segnata come di un altro sito.
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { errore: 'Serve Content-Type: application/json' });
  const sito = req.headers['sec-fetch-site'];
  if (sito && sito !== 'same-origin') return json(res, 403, { errore: 'Richiesta da un altro sito' });
  if (!azioniAttive()) return json(res, 503, { errore: 'I pulsanti non sono attivi: manca la cartella delle richieste' });

  let corpo;
  try { corpo = await leggiCorpo(req, 1024); } catch (e) { return json(res, e.codice || 400, { errore: e.message }); }
  const { app, bersaglio, azione } = corpo && typeof corpo === 'object' ? corpo : {};
  const motivo = foto.controllaAzione(foto.leggiStato(FOTO_DIR), { app, bersaglio, azione });
  if (motivo) return json(res, 409, { errore: motivo });

  const precedente = inCorso.get(bersaglio);
  if (precedente && (leggiEsito(precedente) || {}).stato === 'attesa') {
    return json(res, 409, { errore: 'C\'è già una richiesta in corso per questo container', id: precedente });
  }

  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const contenuto = `azione\t${azione}\napp\t${app}\nbersaglio\t${bersaglio}\nquando\t${Math.floor(Date.now() / 1000)}\n`;
  const tmp = path.join(RICHIESTE_DIR, `${id}.tmp`);
  try {
    fs.writeFileSync(tmp, contenuto, { mode: 0o666 });
    fs.renameSync(tmp, path.join(RICHIESTE_DIR, `${id}.richiesta`));   // il guardiano vede solo file completi
  } catch (e) {
    console.error(e);
    return json(res, 503, { errore: 'Non riesco a scrivere la richiesta' });
  }
  inCorso.set(bersaglio, id);
  return json(res, 202, { id });
}

// ── Indirizzi ────────────────────────────────────────────────────────────────

function gestisci(req, res) {
  let percorso;
  try {
    percorso = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return rispondi(res, 400, 'Indirizzo non valido', 'text/plain; charset=utf-8');
  }

  if (req.method === 'POST' && percorso === '/api/azione') return nuovaAzione(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return rispondi(res, 405, 'Metodo non ammesso', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
  }

  if (percorso === '/api/salute') return json(res, 200, { ok: true });
  if (percorso === '/api/stato') return json(res, 200, { ...foto.leggiStato(FOTO_DIR), azioniAttive: azioniAttive() });
  if (percorso.startsWith('/api/log/')) {
    const nome = percorso.slice('/api/log/'.length);
    if (!foto.NOME_VALIDO.test(nome)) return json(res, 400, { errore: 'nome non valido' });
    const log = foto.leggiLog(FOTO_DIR, nome);
    if (log === null) return json(res, 404, { errore: 'nessun log per questo container' });
    return rispondi(res, 200, log, 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
  }
  if (percorso.startsWith('/api/azione/')) {
    const id = percorso.slice('/api/azione/'.length);
    if (!ID_VALIDO.test(id)) return json(res, 400, { errore: 'id non valido' });
    const esito = leggiEsito(id);
    return esito ? json(res, 200, esito) : json(res, 404, { errore: 'richiesta sconosciuta' });
  }

  const file = STATICI.get(percorso);
  if (file) return rispondi(res, 200, file.corpo, file.tipo, { 'Cache-Control': 'no-cache' });
  return rispondi(res, 404, 'Non trovato', 'text/plain; charset=utf-8');
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => gestisci(req, res))
    .catch(e => {
      console.error(e);
      if (!res.headersSent) json(res, 500, { errore: 'errore interno' });
      else res.end();
    });
});

if (require.main === module) {
  server.listen(PORTA, () => console.log(`Pagina del guardiano su :${PORTA}, fotografia in ${FOTO_DIR}, richieste in ${RICHIESTE_DIR}`));
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)));
}

module.exports = { server };
