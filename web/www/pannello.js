// Pagina di stato del guardiano: legge api/stato ogni 30 secondi e api/log/<container> quando
// si apre un log. Due viste: #/ (tutte le app) e #/app/<nome> (container e log di un'app).
// Il DOM si costruisce solo con createElement e textContent: i log possono contenere di tutto.
(function () {
  'use strict';

  var AGGIORNA_OGNI = 30000;     // ms
  var VECCHIA_DOPO = 180;        // s: oltre, la fotografia è vecchia (il cron non gira?)

  var contenuto = document.getElementById('contenuto');
  var aggiornato = document.getElementById('aggiornato');

  var stato = null;              // ultima risposta di api/stato
  var erroreRete = null;         // messaggio se l'ultima lettura è fallita
  var disegnato = '';            // vista + ora della fotografia già disegnate
  var logAperti = new Map();     // container → { testo, ora } dei log aperti
  var azioni = new Map();        // "app/container" → { id, stato, messaggio, quando } dei pulsanti premuti
  var ETICHETTA_AZIONE = { riavvia: 'Riavvia', ferma: 'Ferma', avvia: 'Avvia' };
  var CONFERMA_AZIONE = { riavvia: 'Sicuro? Riavvia', ferma: 'Sicuro? Ferma' };

  var ESITO_APP = {
    ok: 'Tutto bene', attenzione: 'Da tenere d\u2019occhio', errore: 'Problemi',
    pausa: 'In pausa', sconosciuto: 'Sconosciuto'
  };
  var ESITO_CONTENITORE = {
    ok: 'Funziona', avvio: 'In avvio', errore: 'Non funziona', pausa: 'In pausa', finito: 'Finito',
    fermato: 'Fermato da te'
  };

  // ---- Utilità ----

  function el(tag, classe, testo) {
    var e = document.createElement(tag);
    if (classe) e.className = classe;
    if (testo !== undefined && testo !== null) e.textContent = testo;
    return e;
  }

  function pillola(esito, etichette) {
    return el('span', 'pillola esito-' + esito, etichette[esito] || esito);
  }

  function plurale(n, uno, tanti) { return n + ' ' + (n === 1 ? uno : tanti); }

  function durata(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return 'meno di un minuto';
    var m = Math.floor(s / 60);
    if (m < 60) return plurale(m, 'minuto', 'minuti');
    var h = Math.floor(m / 60);
    if (h < 48) return plurale(h, 'ora', 'ore');
    return plurale(Math.floor(h / 24), 'giorno', 'giorni');
  }

  function dueCifre(n) { return (n < 10 ? '0' : '') + n; }

  function oraBreve(d) {
    return dueCifre(d.getDate()) + '/' + dueCifre(d.getMonth() + 1) + ' ' +
      dueCifre(d.getHours()) + ':' + dueCifre(d.getMinutes()) + ':' + dueCifre(d.getSeconds());
  }

  function oraMinuti(d) { return dueCifre(d.getHours()) + ':' + dueCifre(d.getMinutes()); }

  function etaFotografia() {
    return stato && stato.pronto ? (Date.now() - stato.ora) / 1000 : null;
  }

  function vista() {
    var m = /^#\/app\/(.+)$/.exec(location.hash);
    if (!m) return { tipo: 'home' };
    try { return { tipo: 'app', nome: decodeURIComponent(m[1]) }; } catch (e) { return { tipo: 'home' }; }
  }

  // ---- Testata: da quanto è aggiornato ----

  function aggiornaTestata() {
    var eta = etaFotografia();
    if (erroreRete) {
      aggiornato.textContent = 'Pagina non raggiungibile';
      aggiornato.className = 'aggiornato vecchio';
    } else if (eta === null) {
      aggiornato.textContent = '';
      aggiornato.className = 'aggiornato';
    } else {
      aggiornato.textContent = eta < 60 ? 'Aggiornata adesso'
        : eta < 3600 ? 'Aggiornata ' + Math.floor(eta / 60) + ' min fa'
        : 'Ferma da ' + durata(eta * 1000);
      aggiornato.className = 'aggiornato' + (eta > VECCHIA_DOPO ? ' vecchio' : '');
    }
  }

  // ---- Descrizioni ----

  function descriviStato(c) {
    switch (c.stato) {
      case 'running': return 'Acceso';
      case 'restarting': return 'Si riavvia in continuazione';
      case 'exited': return 'Fermo (codice di uscita ' + c.uscita + ')';
      case 'paused': return 'In pausa (docker pause)';
      case 'created': return 'Creato ma mai partito';
      case 'mancante': return 'Nessun container: il servizio non è partito';
      case 'dead': return 'Morto (Docker non è riuscito a fermarlo)';
      default: return c.stato;
    }
  }

  function descriviSalute(c) {
    switch (c.salute) {
      case 'healthy': return 'Risponde';
      case 'unhealthy': return 'NON risponde';
      case 'starting': return 'In corso (appena partito)';
      default: return 'Nessun controllo nel compose';
    }
  }

  function problemaBreve(c) {
    if (c.stato === 'mancante') return c.servizio + ' non è partito';
    if (c.salute === 'unhealthy') return c.nome + ' non risponde';
    if (c.salute === 'starting') return c.nome + ' sta partendo';
    if (c.stato === 'restarting') return c.nome + ' si riavvia in continuazione';
    if (c.stato === 'exited') return c.nome + ' è fermo';
    return c.nome + ': ' + descriviStato(c).toLowerCase();
  }

  function rigaRegistro(r) {
    var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d:\d\d):\d\d — (.*)$/.exec(r);
    return m ? { quando: m[3] + '/' + m[2] + ' ' + m[4], testo: m[5] } : { quando: '', testo: r };
  }

  function listaRegistro(righe) {
    var ul = el('ul', 'registro');
    righe.slice().reverse().forEach(function (r) {
      var x = rigaRegistro(r);
      var li = el('li');
      if (x.quando) li.append(el('span', 'quando', x.quando));
      li.append(document.createTextNode(x.testo));
      ul.append(li);
    });
    return ul;
  }

  // ---- Avvisi generali ----

  function avvisiGenerali() {
    var lista = [];
    var eta = etaFotografia();
    if (erroreRete) lista.push({ grave: true, testo: 'Non riesco a leggere lo stato (' + erroreRete + '). Mostro l\u2019ultimo letto.' });
    if (eta !== null && eta > VECCHIA_DOPO) {
      lista.push({ grave: true, testo: 'La fotografia ha ' + durata(eta * 1000) + ': la fotografia del guardiano non gira (crontab -l sul Pi).' });
    }
    if (stato && stato.pronto) {
      if (stato.docker !== 'ok') lista.push({ grave: true, testo: 'Docker non risponde sul Pi: non so niente dei container.' });
      stato.avvisi.forEach(function (a) {
        if (a.chiave === 'docker' && stato.docker !== 'ok') return;
        lista.push({ grave: a.chiave === 'docker', testo: a.testo });
      });
    }
    if (!lista.length) return null;
    var ul = el('ul', 'avvisi');
    lista.forEach(function (a) { ul.append(el('li', a.grave ? 'grave' : '', a.testo)); });
    return ul;
  }

  // ---- Vista: tutte le app ----

  function riassuntoApp(a) {
    if (a.errore) return { testo: a.errore, problema: true };
    if (a.esito === 'pausa' && a.fermati.length) return { testo: 'Fermato da te: ' + a.fermati.join(', ') };
    if (a.esito === 'pausa') return { testo: 'Il guardiano non la controlla (guardiano.sh riprendi ' + a.nome + ')' };
    var brutti = a.contenitori.filter(function (c) { return c.esito === 'errore' || c.esito === 'avvio'; });
    if (brutti.length) return { testo: brutti.map(problemaBreve).join(', '), problema: a.esito === 'errore' };
    var n = a.contenitori.length;
    return { testo: n === 1 ? '1 container, funziona' : n + ' container, funzionano tutti' };
  }

  function disegnaHome() {
    document.title = 'Guardiano';
    var frammento = document.createDocumentFragment();
    if (!stato.pronto) {
      frammento.append(el('p', 'vuoto', stato.motivo));
      return frammento;
    }

    var problemi = stato.app.filter(function (a) { return a.esito === 'errore'; }).length;
    var attenzione = stato.app.filter(function (a) { return a.esito === 'attenzione'; }).length;
    var esito = stato.docker !== 'ok' ? 'errore' : problemi ? 'errore' : attenzione ? 'attenzione' : 'ok';
    var riepilogo = el('div', 'riepilogo esito-' + esito);
    if (stato.docker !== 'ok') {
      riepilogo.append(el('span', null, 'Docker non risponde'));
    } else if (problemi || attenzione) {
      riepilogo.append(el('span', 'numero', String(problemi || attenzione)));
      riepilogo.append(el('span', null, problemi
        ? (problemi === 1 ? 'app ha problemi' : 'app hanno problemi') + (attenzione ? ', ' + plurale(attenzione, 'da tenere d\u2019occhio', 'da tenere d\u2019occhio') : '')
        : (attenzione === 1 ? 'app da tenere d\u2019occhio' : 'app da tenere d\u2019occhio')));
    } else {
      riepilogo.append(el('span', null, 'Tutte le ' + stato.app.length + ' app funzionano'));
    }
    frammento.append(riepilogo);
    var avvisi = avvisiGenerali();
    if (avvisi) frammento.append(avvisi);

    frammento.append(el('h2', null, 'App'));
    var griglia = el('ul', 'griglia');
    stato.app.forEach(function (a) {
      var li = el('li');
      var link = el('a', 'scheda-app bordo-' + a.esito);
      link.href = '#/app/' + encodeURIComponent(a.nome);
      var riga = el('span', 'riga');
      riga.append(el('span', 'nome', a.nome), pillola(a.esito, ESITO_APP));
      link.append(riga);
      var r = riassuntoApp(a);
      link.append(el('span', 'sotto' + (r.problema ? ' problema' : ''), r.testo));
      // Il messaggio intero del guardiano è nella pagina dell'app: qui solo se ha smesso di provarci
      if (a.problema && /lascio stare/.test(a.problema)) {
        link.append(el('span', 'sotto problema', 'Il guardiano ha smesso di riavviarla: serve un controllo a mano'));
      } else if (a.problema && !a.errore && r.problema !== true && a.esito !== 'pausa') {
        link.append(el('span', 'sotto', a.problema));
      }
      if (a.interventi) link.append(el('span', 'sotto', 'Fatta ripartire ' + plurale(a.interventi, 'volta', 'volte') + ' nell\u2019ultima ora'));
      li.append(link);
      griglia.append(li);
    });
    frammento.append(griglia);

    if (stato.registro.length) {
      frammento.append(el('h2', null, 'Ultimi interventi del guardiano'));
      frammento.append(listaRegistro(stato.registro.slice(-15)));
    }
    if (stato.giro) frammento.append(el('p', 'cartella', 'Ultimo giro: ' + stato.giro));
    return frammento;
  }

  // ---- Vista: un'app ----

  function fatto(dl, etichetta, valore, mono) {
    if (valore === null || valore === undefined || valore === '') return;
    var d = el('div');
    d.append(el('dt', null, etichetta), el('dd', mono ? 'mono' : null, valore));
    dl.append(d);
  }

  // Sopra il log: da dove viene, quando è stato letto e, se è corto, che non c'è altro
  function notaLog(nome, testo, ora) {
    var righe = testo.trim() ? testo.replace(/\n$/, '').split('\n').length : 0;
    var t = 'È il log del container, lo stesso di «docker logs --tail 200 ' + nome + '»' +
      (ora ? ', letto alle ' + oraMinuti(new Date(ora)) : '') + '.';
    if (!righe) t += ' Il container non ha scritto niente.';
    else if (righe < 200 && testo.length < 190000) t += ' ' + (righe === 1 ? 'È l’unica riga' : 'Sono tutte le ' + righe + ' righe') + ' che ha scritto: non c’è altro.';
    else t += ' Sono le ultime 200 righe.';
    return t;
  }

  function disegnaLog(pre, testo, ora) {
    if (pre.nota) {
      pre.nota.textContent = notaLog(pre.dataset.nome, testo, ora);
      pre.nota.hidden = false;
    }
    var inFondo = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    var vecchioScroll = pre.scrollTop;
    pre.textContent = '';
    if (!testo.trim()) { pre.textContent = '(nessuna riga di log)'; return; }
    var frammento = document.createDocumentFragment();
    testo.replace(/\n$/, '').split('\n').forEach(function (r, i) {
      if (i) frammento.append('\n');
      var m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/.exec(r);
      var d = m ? new Date(m[1]) : null;
      if (d && !isNaN(d)) {
        frammento.append(el('span', 'ora', oraBreve(d) + ' '), m[2]);
      } else {
        frammento.append(r);
      }
    });
    pre.append(frammento);
    pre.scrollTop = inFondo || pre.dataset.nuovo ? pre.scrollHeight : vecchioScroll;
    delete pre.dataset.nuovo;
  }

  function caricaLog(nome, pre) {
    return fetch('api/log/' + encodeURIComponent(nome), { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return '(nessun log nella fotografia: il container è nuovo o è appena sparito)';
        if (!r.ok) throw new Error('errore ' + r.status);
        return r.text();
      })
      .then(function (t) {
        var ora = stato && stato.ora;
        logAperti.set(nome, { testo: t, ora: ora });
        if (pre.isConnected) disegnaLog(pre, t, ora);
      })
      .catch(function (e) {
        if (pre.isConnected) pre.textContent = 'Non riesco a leggere il log: ' + e.message;
      });
  }

  // ---- Pulsanti: Riavvia, Ferma, Avvia ----
  // La pagina non tocca Docker: lascia una richiesta, il guardiano sul Pi la ricontrolla e la esegue.

  function testoAzione(x) {
    switch (x.stato) {
      case 'invio': return 'Invio la richiesta…';
      case 'attesa':
        return Date.now() - x.quando > 20000
          ? 'Il guardiano non l’ha ancora presa: sul Pi deve girare «guardiano.sh pagina» dal cron.'
          : 'Richiesta inviata: la esegue il guardiano tra pochi secondi…';
      case 'fatto': return 'Fatto: ' + x.messaggio + '.';
      case 'fallito': return 'Non riuscito: ' + x.messaggio;
      case 'rifiutata': return 'Rifiutata: ' + x.messaggio;
      case 'scaduta': return 'Scaduta: ' + x.messaggio;
      default: return x.messaggio || '';
    }
  }

  // Aggiorna pulsanti e messaggio di un container dentro radice (la pagina, o la scheda appena fatta)
  function applicaAzione(radice, chiave) {
    var x = azioni.get(chiave);
    var occupato = !!x && (x.stato === 'invio' || x.stato === 'attesa');
    Array.prototype.forEach.call(radice.querySelectorAll('[data-azione-di]'), function (b) {
      if (b.dataset.azioneDi === chiave) b.disabled = occupato;
    });
    Array.prototype.forEach.call(radice.querySelectorAll('[data-esito-di]'), function (p) {
      if (p.dataset.esitoDi !== chiave) return;
      p.textContent = x ? testoAzione(x) : '';
      p.className = 'esito-azione' + (x ? ' esito-azione-' + x.stato : '');
    });
  }

  function seguiAzione(chiave, voce) {
    setTimeout(function controlla() {
      if (azioni.get(chiave) !== voce) return;
      fetch('api/azione/' + encodeURIComponent(voce.id), { cache: 'no-store' })
        .then(function (r) {
          if (r.ok) return r.json();
          if (r.status === 404) return { stato: 'fallito', messaggio: 'la richiesta non c’è più' };
          return null;   // per esempio la pagina stessa che riparte: si riprova
        })
        .catch(function () { return null; })
        .then(function (e) {
          if (azioni.get(chiave) !== voce) return;
          if (e && e.stato !== 'attesa') {
            voce.stato = e.stato;
            voce.messaggio = e.messaggio;
            applicaAzione(document, chiave);
            // Il guardiano rifà la fotografia pochi secondi dopo l'azione
            if (e.stato === 'fatto') { setTimeout(leggiStato, 5000); setTimeout(leggiStato, 12000); }
            setTimeout(function () {
              if (azioni.get(chiave) === voce) { azioni.delete(chiave); applicaAzione(document, chiave); }
            }, 120000);
            return;
          }
          applicaAzione(document, chiave);
          if (Date.now() - voce.quando < 150000) {
            setTimeout(controlla, 1500);
          } else {
            voce.stato = 'fallito';
            voce.messaggio = 'nessuna risposta dal guardiano';
            applicaAzione(document, chiave);
          }
        });
    }, 1200);
  }

  function chiediAzione(app, bersaglio, azione) {
    var chiave = app + '/' + bersaglio;
    var voce = { id: null, stato: 'invio', messaggio: '', quando: Date.now() };
    azioni.set(chiave, voce);
    applicaAzione(document, chiave);
    fetch('api/azione', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: app, bersaglio: bersaglio, azione: azione })
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, codice: r.status, d: d }; });
      })
      .then(function (x) {
        if (azioni.get(chiave) !== voce) return;
        if (!x.ok) {
          voce.stato = 'rifiutata';
          voce.messaggio = x.d.errore || 'errore ' + x.codice;
        } else {
          voce.id = x.d.id;
          voce.stato = 'attesa';
          seguiAzione(chiave, voce);
        }
        applicaAzione(document, chiave);
      })
      .catch(function (e) {
        voce.stato = 'fallito';
        voce.messaggio = 'la pagina non risponde (' + e.message + ')';
        applicaAzione(document, chiave);
      });
  }

  function pulsantiAzione(a, c) {
    var bersaglio = c.nome || c.servizio;
    var chiave = a.nome + '/' + bersaglio;
    var barra = el('div', 'barra-azioni');
    c.azioni.forEach(function (azione) {
      var b = el('button', 'bottone' + (azione === 'ferma' ? ' pericolo' : ''), ETICHETTA_AZIONE[azione]);
      b.type = 'button';
      b.dataset.azioneDi = chiave;
      var attesa = null;
      function annulla() {
        clearTimeout(attesa);
        b.classList.remove('conferma');
        b.textContent = ETICHETTA_AZIONE[azione];
      }
      b.addEventListener('click', function () {
        // Riavvia e Ferma vogliono un secondo tocco entro 4 secondi
        if (CONFERMA_AZIONE[azione] && !b.classList.contains('conferma')) {
          b.classList.add('conferma');
          b.textContent = CONFERMA_AZIONE[azione];
          attesa = setTimeout(annulla, 4000);
          return;
        }
        annulla();
        chiediAzione(a.nome, bersaglio, azione);
      });
      barra.append(b);
    });
    if (c.azioni.indexOf('ferma') >= 0) {
      barra.append(el('span', 'nota', 'Ferma lo lascia spento: il guardiano non lo riaccende finché non premi Avvia'));
    }
    var esito = el('p', 'esito-azione');
    esito.dataset.esitoDi = chiave;
    esito.setAttribute('role', 'status');
    barra.append(esito);
    applicaAzione(barra, chiave);
    return barra;
  }

  function schedaContenitore(a, c) {
    var li = el('li', 'scheda-contenitore');
    var testa = el('div', 'intestazione');
    testa.append(el('span', 'nome', c.nome || c.servizio), pillola(c.esito, ESITO_CONTENITORE));
    li.append(testa);

    var dl = el('dl', 'fatti');
    fatto(dl, 'Servizio', c.servizio);
    fatto(dl, 'Stato', descriviStato(c));
    if (c.stato !== 'mancante') {
      fatto(dl, 'Controllo di salute', descriviSalute(c));
      if (c.stato === 'running' && c.avviato) fatto(dl, 'Acceso da', durata(Date.now() - Date.parse(c.avviato)));
      if (c.stato === 'exited' && c.finito) fatto(dl, 'Fermo da', durata(Date.now() - Date.parse(c.finito)));
      fatto(dl, 'Riavvii di Docker', String(c.riavvii));
      fatto(dl, 'Immagine', c.immagine, true);
      if (c.errore) fatto(dl, 'Errore di Docker', c.errore);
    }
    li.append(dl);

    if (c.salute === 'unhealthy' && c.controllo) {
      var box = el('div', 'controllo', 'Ultimo controllo di salute fallito (codice ' + c.controllo.uscita + ')');
      if (c.controllo.testo) box.append(el('pre', null, c.controllo.testo));
      li.append(box);
    }

    if (stato.azioniAttive && c.azioni && c.azioni.length) li.append(pulsantiAzione(a, c));
    if (!c.nome) return li;
    var barra = el('div', 'barra-log');
    var bottone = el('button', 'bottone', 'Mostra log');
    bottone.type = 'button';
    bottone.setAttribute('aria-expanded', 'false');
    var aggiorna = el('button', 'bottone', 'Aggiorna');
    aggiorna.type = 'button';
    aggiorna.hidden = true;
    barra.append(bottone, aggiorna, el('span', 'nota', 'Ultime 200 righe, rilette ogni minuto'));
    li.append(barra);
    var nota = el('p', 'nota-log');
    nota.hidden = true;
    li.append(nota);
    var pre = el('pre', 'log');
    pre.hidden = true;
    pre.tabIndex = 0;
    pre.dataset.nome = c.nome;
    pre.nota = nota;
    li.append(pre);

    function apri(daCache) {
      bottone.textContent = 'Nascondi log';
      bottone.setAttribute('aria-expanded', 'true');
      aggiorna.hidden = false;
      pre.hidden = false;
      var salvato = logAperti.get(c.nome);
      if (daCache && salvato) {
        disegnaLog(pre, salvato.testo, salvato.ora);
        if (salvato.ora !== stato.ora) caricaLog(c.nome, pre);
      } else {
        pre.dataset.nuovo = '1';
        pre.textContent = 'Carico il log…';
        caricaLog(c.nome, pre);
      }
    }
    bottone.addEventListener('click', function () {
      if (pre.hidden) {
        logAperti.set(c.nome, null);
        apri(false);
      } else {
        logAperti.delete(c.nome);
        pre.hidden = true;
        nota.hidden = true;
        aggiorna.hidden = true;
        bottone.textContent = 'Mostra log';
        bottone.setAttribute('aria-expanded', 'false');
      }
    });
    aggiorna.addEventListener('click', function () { caricaLog(c.nome, pre); });
    if (logAperti.has(c.nome)) apri(true);
    return li;
  }

  function disegnaApp(nome) {
    document.title = nome + ' · Guardiano';
    var frammento = document.createDocumentFragment();
    var indietro = el('a', 'indietro', '\u2190 Tutte le app');
    indietro.href = '#/';
    frammento.append(indietro);

    var a = stato.pronto ? stato.app.filter(function (x) { return x.nome === nome; })[0] : null;
    if (!a) {
      frammento.append(el('p', 'vuoto', stato.pronto ? 'Non conosco un\u2019app «' + nome + '».' : stato.motivo));
      return frammento;
    }

    var titolo = el('div', 'titolo-app');
    titolo.append(el('h1', null, a.nome), pillola(a.esito, ESITO_APP));
    frammento.append(titolo);
    frammento.append(el('p', 'cartella', '~/' + a.cartella));

    var avvisi = [];
    if (stato.docker !== 'ok') avvisi.push({ grave: true, testo: 'Docker non risponde sul Pi.' });
    if (a.errore) avvisi.push({ grave: true, testo: a.errore });
    if (a.pausa && a.fermati.length) {
      avvisi.push({ testo: 'Hai fermato ' + a.fermati.join(', ') + ' da qui: il guardiano non controlla ' + a.nome + ' finché non lo riaccendi con Avvia.' });
    } else if (a.pausa) {
      avvisi.push({ testo: 'In pausa: il guardiano non la controlla. Per ricominciare: ~/guardiano/guardiano.sh riprendi ' + a.nome });
    }
    if (a.problema) avvisi.push({ grave: a.esito === 'errore', testo: a.problema });
    if (a.interventi) avvisi.push({ testo: 'Il guardiano l\u2019ha fatta ripartire ' + plurale(a.interventi, 'volta', 'volte') + ' nell\u2019ultima ora.' });
    if (avvisi.length) {
      var ul = el('ul', 'avvisi');
      avvisi.forEach(function (x) { ul.append(el('li', x.grave ? 'grave' : '', x.testo)); });
      frammento.append(ul);
    }

    frammento.append(el('h2', null, plurale(a.contenitori.length, 'container', 'container')));
    var lista = el('ul', 'contenitori');
    a.contenitori.forEach(function (c) { lista.append(schedaContenitore(a, c)); });
    frammento.append(lista);

    var mie = stato.registro.filter(function (r) { return rigaRegistro(r).testo.indexOf(a.nome + ': ') === 0; });
    frammento.append(el('h2', null, 'Interventi del guardiano su ' + a.nome));
    frammento.append(mie.length ? listaRegistro(mie.slice(-20)) : el('p', 'cartella', 'Nessuno nelle ultime righe del registro.'));
    return frammento;
  }

  // ---- Disegno e aggiornamento ----

  function disegna(forza) {
    aggiornaTestata();
    if (!stato) return;
    var v = vista();
    var chiave = v.tipo + ':' + (v.nome || '') + ':' + (stato.ora || '') + ':' + (erroreRete || '');
    if (!forza && chiave === disegnato) return;
    var stessaVista = disegnato.split(':').slice(0, 2).join(':') === v.tipo + ':' + (v.nome || '');
    if (!stessaVista) logAperti.clear();
    disegnato = chiave;
    var x = window.scrollX, y = window.scrollY;
    contenuto.textContent = '';
    contenuto.append(v.tipo === 'app' ? disegnaApp(v.nome) : disegnaHome());
    if (stessaVista) window.scrollTo(x, y); else window.scrollTo(0, 0);
  }

  function leggiStato() {
    return fetch('api/stato', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('errore ' + r.status);
        return r.json();
      })
      .then(function (s) { stato = s; erroreRete = null; })
      .catch(function (e) { erroreRete = e.message || 'rete'; })
      .then(function () {
        if (!stato && erroreRete) {
          contenuto.textContent = '';
          contenuto.append(el('p', 'vuoto', 'Non riesco a leggere lo stato (' + erroreRete + ').'));
          aggiornaTestata();
          return;
        }
        disegna(false);
      });
  }

  window.addEventListener('hashchange', function () { disegna(true); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) leggiStato(); });
  setInterval(function () { if (!document.hidden) leggiStato(); }, AGGIORNA_OGNI);
  setInterval(aggiornaTestata, 10000);
  leggiStato();
})();
