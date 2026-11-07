'use strict';
// Anteprima della pagina di stato sul PC, senza Docker: scrive una fotografia d'esempio in una
// cartella temporanea (ogni minuto una nuova, come sul Pi), finge il guardiano per i pulsanti
// (risponde "fatto" senza toccare niente) e avvia web/server.js.
// Uso: node test/anteprima.js   →   http://localhost:8093

const os = require('os');
const path = require('path');
const fs = require('fs');
const esempio = require('./foto-esempio');

const base = path.join(os.tmpdir(), 'guardiano-anteprima');
const richieste = path.join(os.tmpdir(), 'guardiano-anteprima-richieste');
fs.mkdirSync(base, { recursive: true });
fs.mkdirSync(richieste, { recursive: true });
let n = 0;
const nuova = () => esempio.scrivi(base, { nome: `foto-${++n % 2}` });
nuova();
setInterval(nuova, 60e3);

// Il finto guardiano: prende le richieste e dopo un attimo scrive l'esito
const MESSAGGI = { riavvia: 'riavviato', ferma: 'fermato: il guardiano non lo riaccende finché non lo avvii da qui', avvia: 'avviato' };
setInterval(() => {
  for (const f of fs.readdirSync(richieste)) {
    if (!f.endsWith('.richiesta')) continue;
    const id = f.slice(0, -'.richiesta'.length);
    const presa = path.join(richieste, `${id}.presa`);
    fs.renameSync(path.join(richieste, f), presa);
    const azione = (/^azione\t(\w+)/m.exec(fs.readFileSync(presa, 'utf8')) || [])[1];
    setTimeout(() => {
      fs.writeFileSync(path.join(richieste, `${id}.esito`), `esito\tfatto\nmessaggio\t${MESSAGGI[azione] || azione} (anteprima: non è successo niente)\n`);
      fs.unlinkSync(presa);
    }, 2000);
  }
}, 1000);

process.env.FOTO_DIR = base;
process.env.RICHIESTE_DIR = richieste;
process.env.PORT = process.env.PORT || '8093';
const { server } = require('../web/server');
server.listen(Number(process.env.PORT), () => console.log(`Anteprima su http://localhost:${process.env.PORT} (fotografia in ${base})`));
