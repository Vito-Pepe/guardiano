'use strict';
// Prova la pagina di stato (web/): server, API, intestazioni di sicurezza e lettura della
// fotografia d'esempio. Uso: node test/test-web.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const esempio = require('./foto-esempio');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guardiano-test-web-'));
const richieste = fs.mkdtempSync(path.join(os.tmpdir(), 'guardiano-test-richieste-'));
process.env.FOTO_DIR = base;
process.env.RICHIESTE_DIR = richieste;
const { server } = require('../web/server');

let prove = 0;
let falliti = 0;
function verifica(condizione, messaggio) {
  prove++;
  if (!condizione) { falliti++; console.log('  FALLITO: ' + messaggio); }
}

function chiedi(porta, metodo, percorso, corpo, intestazioni) {
  return new Promise((ok, ko) => {
    const req = http.request({ host: '127.0.0.1', port: porta, method: metodo, path: percorso, headers: intestazioni }, res => {
      const pezzi = [];
      res.on('data', d => pezzi.push(d));
      res.on('end', () => ok({ codice: res.statusCode, intestazioni: res.headers, corpo: Buffer.concat(pezzi).toString('utf8') }));
    });
    req.on('error', ko);
    req.end(corpo);
  });
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const porta = server.address().port;
  const get = p => chiedi(porta, 'GET', p);

  console.log('· pagina e file statici, con le intestazioni di sicurezza');
  const home = await get('/');
  verifica(home.codice === 200 && home.corpo.includes('pannello.js'), 'GET / non dà la pagina');
  verifica(/default-src 'self'/.test(home.intestazioni['content-security-policy'] || ''), 'manca la CSP');
  verifica(home.intestazioni['x-content-type-options'] === 'nosniff', 'manca nosniff');
  verifica(home.intestazioni['referrer-policy'] === 'no-referrer', 'manca Referrer-Policy');
  verifica(!home.intestazioni['strict-transport-security'], 'HSTS vietato sul Pi');
  for (const [p, tipo] of [['/pannello.js', 'text/javascript'], ['/pannello.css', 'text/css'], ['/icona.svg', 'image/svg+xml']]) {
    const r = await get(p);
    verifica(r.codice === 200 && (r.intestazioni['content-type'] || '').startsWith(tipo), `${p}: ${r.codice} ${r.intestazioni['content-type']}`);
  }

  console.log('· niente stili o script in linea (CSP), niente innerHTML');
  const html = fs.readFileSync(path.join(__dirname, '../web/www/index.html'), 'utf8');
  verifica(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'script in linea in index.html');
  verifica(!/\sstyle=|<style|\son[a-z]+=/i.test(html), 'stile o gestore in linea in index.html');
  const js = fs.readFileSync(path.join(__dirname, '../web/www/pannello.js'), 'utf8');
  verifica(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js), 'pannello.js usa HTML da stringhe');

  console.log('· salute, 404, 405, percorsi non validi');
  const salute = await get('/api/salute');
  verifica(salute.codice === 200 && JSON.parse(salute.corpo).ok === true, 'api/salute');
  verifica((await get('/niente')).codice === 404, '404');
  verifica((await chiedi(porta, 'POST', '/api/stato')).codice === 405, 'POST deve dare 405');
  verifica((await get('/api/log/..%2Fattuale')).codice === 400, 'log con ../ deve dare 400');
  verifica((await get('/api/log/%E0%A4%A')).codice === 400, 'percorso malformato deve dare 400');

  console.log('· senza fotografia: lo dice');
  const vuoto = JSON.parse((await get('/api/stato')).corpo);
  verifica(vuoto.pronto === false && /cron/.test(vuoto.motivo), 'senza fotografia: ' + JSON.stringify(vuoto));

  console.log('· con la fotografia d\'esempio: esiti di app e container');
  esempio.scrivi(base);
  const r = await get('/api/stato');
  verifica(r.intestazioni['cache-control'] === 'no-store', 'api/stato non deve finire in cache');
  const s = JSON.parse(r.corpo);
  const app = n => s.app.find(a => a.nome === n) || {};
  verifica(s.pronto === true && s.docker === 'ok' && s.app.length === 13, 'stato: ' + JSON.stringify({ pronto: s.pronto, n: s.app && s.app.length }));
  verifica(app('logoapp').esito === 'errore', 'logoapp: ' + app('logoapp').esito);
  verifica(/già fatta ripartire 3 volte/.test(app('logoapp').problema || ''), 'logoapp: problema ' + app('logoapp').problema);
  verifica(app('pizzapp').esito === 'attenzione' && app('pizzapp').problema === null, 'pizzapp: ' + JSON.stringify(app('pizzapp')));
  verifica(app('impostore').esito === 'pausa' && app('impostore').problema === null, 'impostore: ' + app('impostore').esito);
  verifica(app('impostore').fermati.join() === 'impostore-impostore-1' && app('impostore').contenitori[0].esito === 'fermato', 'impostore: fermato dalla pagina');
  verifica(app('sillabe').esito === 'ok' && app('meteo').cartella === 'parole/meteo', 'sillabe/meteo');
  verifica(app('ingressi-https').contenitori.length === 11, 'ingressi-https: container');
  const c = app('logoapp').contenitori[0];
  verifica(c.nome === 'logoapp-logoapp-1' && c.salute === 'unhealthy' && c.riavvii === 3 && c.controllo.testo === 'wget: download timed out', 'container logoapp: ' + JSON.stringify(c));
  verifica(s.avvisi.length === 1 && s.avvisi[0].chiave === 'progetti', 'avvisi: ' + JSON.stringify(s.avvisi));
  verifica(s.registro.length === 6 && s.pause[0] === 'impostore', 'registro e pause');

  console.log('· log: testo semplice, senza codici colore');
  const log = await get('/api/log/logoapp-logoapp-1');
  verifica(log.codice === 200 && (log.intestazioni['content-type'] || '').startsWith('text/plain'), 'log: ' + log.codice);
  verifica(log.corpo.includes('Errore: EIO') && !log.corpo.includes('\x1b'), 'log: contenuto');
  verifica((await get('/api/log/nessuno-1')).codice === 404, 'log di un container sconosciuto');

  console.log('· pulsanti: quali per ogni container');
  verifica(s.azioniAttive === true, 'azioniAttive con la cartella delle richieste');
  verifica(c.azioni.join() === 'riavvia,ferma', 'logoapp: ' + c.azioni);
  verifica(app('impostore').contenitori[0].azioni.join() === 'avvia', 'impostore: ' + app('impostore').contenitori[0].azioni);
  verifica(app('guardiano').contenitori[0].azioni.join() === 'riavvia', 'la pagina stessa non si ferma: ' + app('guardiano').contenitori[0].azioni);
  verifica(app('ingressi-https').contenitori.find(x => x.nome === 'ingressi-https-guardiano-1').azioni.join() === 'riavvia', 'il suo ingresso nemmeno');

  console.log('· pulsanti: richieste rifiutate dal server');
  const post = (corpo, extra) => chiedi(porta, 'POST', '/api/azione', typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    { 'Content-Type': 'application/json', ...extra });
  const buona = { app: 'logoapp', bersaglio: 'logoapp-logoapp-1', azione: 'riavvia' };
  verifica((await chiedi(porta, 'POST', '/api/azione', JSON.stringify(buona), { 'Content-Type': 'text/plain' })).codice === 415, 'senza JSON: 415');
  verifica((await post(buona, { 'Sec-Fetch-Site': 'cross-site' })).codice === 403, 'da un altro sito: 403');
  verifica((await post('{rotto')).codice === 400, 'JSON rotto: 400');
  verifica((await post({ ...buona, x: 'y'.repeat(2000) })).codice === 413, 'troppo grande: 413');
  for (const [corpo, motivo] of [
    [{ ...buona, azione: 'cancella' }, 'azione sconosciuta'],
    [{ ...buona, bersaglio: '../x' }, 'richiesta non valida'],
    [{ ...buona, app: 'nessuna' }, 'app sconosciuta'],
    [{ ...buona, bersaglio: 'meteo' }, 'non è un container di logoapp'],
    [{ app: 'guardiano', bersaglio: 'guardiano-web-1', azione: 'ferma' }, 'non si può'],
    [{ app: 'impostore', bersaglio: 'impostore-impostore-1', azione: 'riavvia' }, 'non si può']
  ]) {
    const r = await post(corpo);
    verifica(r.codice === 409 && JSON.parse(r.corpo).errore.includes(motivo), `${JSON.stringify(corpo)} → ${r.codice} ${r.corpo}`);
  }
  verifica(fs.readdirSync(richieste).length === 0, 'una richiesta rifiutata non deve lasciare file');

  console.log('· pulsanti: richiesta accettata, una sola per container, poi l\'esito del guardiano');
  const accettata = await post(buona, { 'Sec-Fetch-Site': 'same-origin' });
  verifica(accettata.codice === 202, 'richiesta buona: ' + accettata.codice + ' ' + accettata.corpo);
  const id = JSON.parse(accettata.corpo).id;
  const file = path.join(richieste, `${id}.richiesta`);
  const scritto = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  verifica(/^azione\triavvia\napp\tlogoapp\nbersaglio\tlogoapp-logoapp-1\nquando\t\d{10}\n$/.test(scritto), 'contenuto della richiesta: ' + JSON.stringify(scritto));
  verifica((await post(buona)).codice === 409, 'seconda richiesta per lo stesso container: 409');
  verifica(JSON.parse((await get(`/api/azione/${id}`)).corpo).stato === 'attesa', 'in attesa del guardiano');
  fs.renameSync(file, path.join(richieste, `${id}.presa`));
  fs.writeFileSync(path.join(richieste, `${id}.esito`), 'esito\tfatto\nmessaggio\triavviato\n');
  fs.unlinkSync(path.join(richieste, `${id}.presa`));
  const esito = JSON.parse((await get(`/api/azione/${id}`)).corpo);
  verifica(esito.stato === 'fatto' && esito.messaggio === 'riavviato', 'esito: ' + JSON.stringify(esito));
  verifica((await post(buona)).codice === 202, 'finita la prima, se ne può chiedere un\'altra');
  verifica((await get('/api/azione/123')).codice === 400 && (await get('/api/azione/1700000000000-deadbeef')).codice === 404, 'id non valido o sconosciuto');
  verifica((await chiedi(porta, 'PUT', '/api/azione')).codice === 405, 'PUT: 405');

  console.log('· fotografia nuova: si legge quella');
  esempio.scrivi(base, { nome: 'foto-2', ora: Date.now() + 60e3 });
  const s2 = JSON.parse((await get('/api/stato')).corpo);
  verifica(s2.ora !== s.ora, 'non ha letto la fotografia nuova');

  console.log('· senza la cartella delle richieste: pulsanti spenti');
  fs.rmSync(richieste, { recursive: true, force: true });
  verifica(JSON.parse((await get('/api/stato')).corpo).azioniAttive === false, 'azioniAttive senza cartella');
  verifica((await post(buona)).codice === 503, 'richiesta senza cartella: 503');

  server.close();
  fs.rmSync(base, { recursive: true, force: true });
  console.log();
  if (falliti) { console.log(`${falliti} controlli falliti su ${prove}.`); process.exit(1); }
  console.log(`Tutto bene: ${prove} controlli superati.`);
})().catch(e => { console.error(e); process.exit(1); });
