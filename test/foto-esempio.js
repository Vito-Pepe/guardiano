'use strict';
// Una fotografia d'esempio, nello stesso formato di "guardiano.sh fotografia", per
// test/test-web.js e per l'anteprima (test/anteprima.js). Situazione: quasi tutto a posto,
// LogoApp che non risponde, Impasti appena ripartita, Impostore in pausa.

const fs = require('fs');
const path = require('path');

function stato(s, opz = {}) {
  const st = {
    Status: s,
    Running: s === 'running',
    ExitCode: opz.uscita || 0,
    Error: '',
    StartedAt: new Date(Date.now() - (opz.da || 3 * 86400e3)).toISOString(),
    FinishedAt: opz.finito ? new Date(Date.now() - opz.finito).toISOString() : '0001-01-01T00:00:00Z'
  };
  if (opz.salute) {
    st.Health = {
      Status: opz.salute,
      FailingStreak: opz.salute === 'unhealthy' ? 4 : 0,
      Log: [{
        Start: new Date(Date.now() - 30e3).toISOString(),
        End: new Date(Date.now() - 25e3).toISOString(),
        ExitCode: opz.salute === 'unhealthy' ? 1 : 0,
        Output: opz.salute === 'unhealthy' ? 'wget: download timed out\n' : ''
      }]
    };
  }
  return JSON.stringify(st);
}

function c(nome, servizio, immagine, st, riavvii = 0, politica = 'unless-stopped') {
  return `/${nome}|${servizio}|False|${politica}|${immagine}|${riavvii}|${st}`;
}

function log(nome, righe) {
  const ora = Date.now() - righe.length * 61e3;
  return righe.map((r, i) => `${new Date(ora + i * 61e3).toISOString().replace('Z', '123456Z')} ${r}`).join('\n') + '\n';
}

const ts = n => c(`ingressi-https-${n}-1`, n, 'tailscale/tailscale:stable', stato('running'));

const APP = [
  ['ingressi-https', 'ingressi-https', [], ['sillabe', 'parole', 'minigiochi', 'chess', 'meteo', 'retro', 'impostore', 'pizzapp', 'logoapp', 'infernotuffatori', 'guardiano'].map(ts)],
  ['sillabe', 'sillabe', [], [c('sillabe-sillabe-1', 'sillabe', 'sillabe-sillabe', stato('running'))]],
  ['homepage', 'homepage', [], [
    c('homepage-homepage-1', 'homepage', 'homepage-homepage', stato('running')),
    c('homepage-giochi-1', 'giochi', 'homepage-giochi', stato('running'))]],
  ['parole', 'parole', [], [
    c('parole-parole-1', 'parole', 'parole-parole', stato('running')),
    c('parole-tailscale-public-1', 'tailscale-public', 'tailscale/tailscale:stable', stato('running'))]],
  ['meteo', 'parole/meteo', [], [c('meteo', 'meteo', 'meteo:latest', stato('running'))]],
  ['Chess', 'Chess', [], [
    c('chess-web-1', 'web', 'chess-web', stato('running')),
    c('chess-stockfish-1', 'stockfish', 'chess-stockfish', stato('running'))]],
  ['minigiochi', 'minigiochi', [], [
    c('minigiochi-minigiochi-1', 'minigiochi', 'minigiochi-minigiochi', stato('running')),
    c('minigiochi-giochi-1', 'giochi', 'minigiochi-giochi', stato('running'))]],
  ['onlineEmu', 'onlineEmu', [], [
    c('onlineemu-romm-1', 'romm', 'rommapp/romm:5.4.1', stato('running')),
    c('onlineemu-db-1', 'db', 'mariadb:11.8', stato('running', { salute: 'healthy' }))]],
  ['impostore', 'impostore', ['pausa\t1', 'fermati\timpostore-impostore-1 '], [c('impostore-impostore-1', 'impostore', 'impostore-impostore', stato('exited', { uscita: 0, finito: 20 * 60e3 }))]],
  ['pizzapp', 'pizzapp', ['interventi\t1'], [c('pizzapp-pizzapp-1', 'pizzapp', 'pizzapp-pizzapp', stato('running', { salute: 'starting', da: 40e3 }), 1)]],
  ['infernotuffatori', 'infernotuffatori', [], [c('infernotuffatori-infernotuffatori-1', 'infernotuffatori', 'infernotuffatori-infernotuffatori', stato('running'))]],
  ['logoapp', 'logoapp', ['interventi\t3'], [c('logoapp-logoapp-1', 'logoapp', 'logoapp-logoapp', stato('running', { salute: 'unhealthy', da: 9 * 60e3 }), 3)]],
  ['guardiano', 'guardiano', [], [c('guardiano-web-1', 'web', 'guardiano-web', stato('running', { salute: 'healthy', da: 2 * 3600e3 }))]]
];

const REGISTRO = [
  'pizzapp: pizzapp-pizzapp-1 non risponde (unhealthy) → docker restart pizzapp-pizzapp-1: fatto',
  'logoapp: logoapp-logoapp-1 non risponde (unhealthy) → docker restart logoapp-logoapp-1: fatto',
  'logoapp: logoapp-logoapp-1 non risponde (unhealthy) → docker restart logoapp-logoapp-1: fatto',
  'impostore: dalla pagina: ferma impostore-impostore-1: fatto',
  'logoapp: logoapp-logoapp-1 non risponde (unhealthy) → docker restart logoapp-logoapp-1: fatto',
  "logoapp: non rispondono: logoapp-logoapp-1. L'ho già fatta ripartire 3 volte nell'ultima ora: la lascio stare, serve un controllo a mano (cd /home/pepe/logoapp && docker compose logs --tail 50)"
];

function scrivi(base, { nome = 'foto-1', ora = Date.now() } = {}) {
  const dir = path.join(base, nome);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'log'), { recursive: true });
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
  w('ora', `${Math.floor(ora / 1000)}\n`);
  w('docker', 'ok\n');
  w('protetti', 'guardiano-web-1\ningressi-https-guardiano-1\n');
  w('giro', '2026-11-07 10:02:01 — completo\n');
  w('pause', 'impostore\n');
  w('elenco', APP.map(a => a[0]).join('\n') + '\n');
  w('problemi', [
    'impostore\tin pausa, non la controllo: dalla pagina hai fermato impostore-impostore-1 (per ricominciare: Avvia nella pagina, o ./guardiano.sh riprendi impostore)',
    'pizzapp\tintervento',
    `logoapp\t${REGISTRO[5].slice('logoapp: '.length)}`,
    'progetti\tprogetti compose che non controllo: prova (/home/pepe/prova). Se vanno tenuti accesi, aggiungili ad app.conf'
  ].join('\n') + '\n');
  const t0 = new Date(ora - REGISTRO.length * 300e3);
  w('registro', REGISTRO.map((r, i) => {
    const d = new Date(t0.getTime() + i * 300e3);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} — ${r}`;
  }).join('\n') + '\n');
  for (const [app, cartella, info, contenitori] of APP) {
    w(`app/${app}/info`, [`cartella\t${cartella}`, ...(info.some(i => i.startsWith('interventi')) ? [] : ['interventi\t0']), ...info].join('\n') + '\n');
    w(`app/${app}/servizi`, [...new Set(contenitori.map(r => r.split('|')[1]))].join('\n') + '\n');
    w(`app/${app}/contenitori`, contenitori.join('\n') + '\n');
    for (const r of contenitori) {
      const n = r.split('|')[0].slice(1);
      const righe = n === 'logoapp-logoapp-1'
        ? ['LogoApp su :3000, dati in /data', 'GET /api/archivio 200 4ms', 'Archivio: backup del giorno scritto (14 tenuti)', '\x1b[33mattenzione\x1b[0m: risposta lenta da /data (2300 ms)', 'GET /api/salute 200 2301ms', 'Errore: EIO: i/o error, read', '<script>alert("non deve partire")</script>']
        : [`${n} avviato`, 'pronto a ricevere richieste', 'GET / 200 3ms'];
      w(`log/${n}`, log(n, righe));
    }
  }
  fs.writeFileSync(path.join(base, 'attuale'), `${nome}\n`);
  return dir;
}

module.exports = { scrivi };
