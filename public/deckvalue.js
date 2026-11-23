(function () {
  const { esc, norm, store, whoami, findPlayer } = window.UI;
  const B = window.__BASE || '';
  const cfg = window.__VM || {};
  const ta = document.getElementById('deck');
  const out = document.getElementById('vres');
  const eur = v => (v == null ? '—' : v.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' }));
  let lastJob = null, lastResult = null, event = null;

  try { const saved = store.get('mt_deck'); if (saved && !ta.value) ta.value = saved; } catch (e) { /* nada */ }

  document.getElementById('file').onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { ta.value = r.result; };
    r.readAsText(f);
  };

  async function post(url, body) {
    const r = await fetch(B + url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'No se pudo calcular');
    return j;
  }

  function progress(done, total) {
    const pct = total ? Math.round(done * 100 / total) : 5;
    out.innerHTML = `<div class="vwait"><b>Buscando precios…</b><span>${total ? `${done} de ${total} cartas` : 'leyendo la lista'}</span>
      <div class="lb-bar light"><i style="width:${pct}%"></i></div><small class="muted">La primera vez puede tardar unos segundos; luego va al momento.</small></div>`;
  }

  async function run() {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    store.set('mt_deck', text.slice(0, 20000));
    progress(0, 0);
    try {
      const { job } = await post('/valor-mazo', { text });
      lastJob = job;
      for (;;) {
        await new Promise(r => setTimeout(r, 700));
        const s = await fetch(`${B}/valor-mazo/estado/${job}`, { cache: 'no-store' }).then(r => r.json());
        if (s.status === 'running') { progress(s.done, s.total); continue; }
        if (s.status === 'error') throw new Error(s.error);
        lastResult = s.result;
        render();
        break;
      }
    } catch (e) {
      out.innerHTML = `<div class="vwait err"><b>No se pudo calcular</b><span>${esc(e.message)}</span></div>`;
    }
  }

  const BASIC = /^(snow-covered\s+)?(plains|island|swamp|mountain|forest|wastes)$/i;
  function counted(r) {
    if (!event) return r.total;
    return Math.round(r.lines.reduce((s, l) => s + ((l.basic || BASIC.test(l.name)) || (event.exCommander && l.commander) ? 0 : l.total || 0), 0) * 100) / 100;
  }
  function saveBox() {
    if (!event || !lastResult) return '';
    if (event.locked) return `<div class="vsave"><span>El torneo <b>${esc(event.name)}</b> ya ha empezado: el mazo ya no se puede cambiar.</span></div>`;
    const meName = store.get('mt_me_user');
    const acc = window.__ME;
    const me = (acc && event.roster.find(p => p.pkey && p.pkey === acc.key)) || (meName ? findPlayer(event.roster, meName) : null);
    if (!me) return `<div class="vsave">${whoami(event.roster, '', 'vm-roster', 'Soy yo')}<small class="muted">Para guardar el valor en tu ficha de «${esc(event.name)}».</small></div>`;
    const c = counted(lastResult);
    const over = event.budget && Math.round(c * 100) > event.budget;
    const br = lastResult.bracket ? lastResult.bracket.n : null;
    const overBr = event.bracketMax && br && br > Math.max(event.bracketMax, 2);
    const rules = ['sin tierras básicas', event.exCommander ? 'sin el comandante' : ''].filter(Boolean).join(' y ');
    return `<div class="vsave"><span>Para <b>${esc(event.name)}</b> cuenta <b>${eur(c)}</b>${rules ? ` (${rules})` : ''}${lastResult.cards !== 100 ? ` · <span class="warn">${lastResult.cards} cartas, deberían ser 100</span>` : ''}</span>
      <span>Guardar en la ficha de <b>${esc(me.name)}</b></span>
      ${over ? `<span class="chip loss">Supera el presupuesto del torneo (${eur(event.budget / 100)})</span>` : event.budget ? `<span class="chip win">Dentro del presupuesto (${eur(event.budget / 100)})</span>` : ''}
      ${event.legalCheck && lastResult.legality ? (lastResult.legality.ok ? '<span class="chip win">Mazo legal</span>' : '<span class="chip loss">Mazo no legal: revisa los avisos</span>') : ''}
      ${event.bracketMax && br ? (overBr ? `<span class="chip loss">Bracket ${br}: por encima del máximo (${bLabel(event.bracketMax)})</span>` : `<span class="chip win">Bracket ${bLabel(br)}: permitido</span>`) : ''}
      <button class="jbtn" id="vm-save" data-me="${me.id}">Guardar</button><span id="vm-msg" class="small muted"></span></div>`;
  }

  const bLabel = n => (n === 2 ? '1-2' : String(n));
  const BRN = { 2: 'Exhibition / Core', 3: 'Upgraded', 4: 'Optimized', 5: 'cEDH' };
  // Legalidad en Commander
  function legalNote(r) {
    const l = r.legality;
    if (!l || (!l.checked && l.ok)) return '';
    if (l.ok) return '<div class="vlegal ok">✔ <b>Mazo legal en Commander</b> · 100 cartas, una copia de cada, sin prohibidas y en los colores del comandante</div>';
    return `<div class="vlegal bad"><b>⚠ El mazo no es legal en Commander</b><ul>${l.problems.map(p => `<li>${esc(p.msg)}</li>`).join('')}</ul></div>`;
  }

  // Bracket estimado con sus motivos
  function bracketNote(r) {
    const b = r.bracket;
    if (!b) return '';
    if (b.unknown) return `<div class="vbracket"><div class="vb-n"><span>Bracket</span><b>?</b></div><div>No se ha podido calcular ahora mismo${b.error ? ` (${esc(b.error)})` : ''}. Vuelve a calcular en un rato.</div></div>`;
    const why = b.reasons.length ? b.reasons.map(x => `<li>${esc(x.why)}${x.info ? '' : ` → ${x.to}`}</li>`).join('') : '<li>Sin Game Changers, sin destrucción masiva de tierras, sin combos de dos cartas y sin cadenas de turnos extra.</li>';
    return `<div class="vbracket b${b.n}"><div class="vb-n"><span>Bracket</span><b>${bLabel(b.n)}</b><small>${BRN[b.n] || ''}</small></div>
      <div><ul>${why}</ul>${b.gc && b.gc.length ? `<p><b>Game Changers (${b.gc.length}):</b> ${b.gc.map(esc).join(', ')}</p>` : ''}
      <small class="muted">Estimación automática (${b.source && b.source.includes('spellbook') ? 'Game Changers de Scryfall y combos de Commander Spellbook' : 'Game Changers de Scryfall'}).${b.gc ? '' : ''} El 1 y el 5 dependen de la intención del mazo.</small></div></div>`;
  }

  // Cómo se ha sabido cuál es el comandante, y avisos de la lista
  function cmdNote(r) {
    const notes = [...(r.notes || []), ...(r.translated ? [`${r.translated} carta${r.translated > 1 ? 's' : ''} en otro idioma: se han buscado por su nombre en inglés`] : [])].map(n => `<li>${esc(n)}</li>`).join('');
    let head = '';
    if (r.commander && r.commanderHow === 'deducido') {
      head = `<b>Comandante deducido: ${esc(r.commander)}</b> <span>(por sus colores y su posición en la lista${r.commanderSure ? '' : '; no es seguro'}).</span>
        ${r.commanderAlternatives && r.commanderAlternatives.length ? `<span>Otras opciones: ${r.commanderAlternatives.map(esc).join(', ')}.</span>` : ''}
        <span>Si no es, escribe <code>Commander</code> en la línea de encima del tuyo y vuelve a calcular.</span>`;
    } else if (r.commander && r.commanderHow === 'sideboard') {
      head = `<b>Comandante: ${esc(r.commander)}</b> <span>(estaba en el sideboard, como en las exportaciones de MTGO).</span>`;
    }
    if (!head && !notes) return '';
    return `<div class="vwarn cmdnote ${r.commanderHow === 'deducido' && !r.commanderSure ? 'doubt' : ''}">${head}${notes ? `<ul>${notes}</ul>` : ''}</div>`;
  }

  // Guardar el mazo en la cuenta del jugador
  let currentDeckId = null;
  function myDeckBox() {
    const r = lastResult;
    if (!window.__ME) return `<div class="mydeck"><span>¿Quieres guardar este mazo para otra vez? <a href="${B}/entrar?next=${encodeURIComponent(location.pathname + location.search)}">Entra en tu cuenta</a> o <a href="${B}/registro">créala gratis</a>.</span></div>`;
    return `<div class="mydeck"><label for="md-name">Guardar en mis mazos</label>
      <div class="who-row"><input id="md-name" maxlength="80" value="${esc(r.commander || 'Mi mazo')}"><button class="jbtn" id="md-save">${currentDeckId ? 'Guardar cambios' : 'Guardar'}</button></div>
      <small class="muted" id="md-msg">Lo tendrás en Mi cuenta para analizarlo o validarlo en otro torneo.</small></div>`;
  }
  async function loadMyDecks() {
    if (!window.__ME) return;
    const box = document.querySelector('.vform');
    try {
      const list = await fetch(`${B}/cuenta/mazos.json`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : []));
      if (!list.length) return;
      box.insertAdjacentHTML('afterbegin', `<label class="mdpick">Mis mazos<select id="md-pick"><option value="">— Cargar uno de mis mazos —</option>${list.map(d => `<option value="${d.id}">${esc(d.name)}${d.value != null ? ` · ${eur(d.value / 100)}` : ''}</option>`).join('')}</select></label>`);
      document.getElementById('md-pick').onchange = e => { if (e.target.value) loadDeck(e.target.value); };
    } catch (e) { /* sin mazos */ }
  }
  async function loadDeck(id) {
    try {
      const d = await fetch(`${B}/cuenta/mazos/${encodeURIComponent(id)}.json`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null));
      if (!d) return;
      ta.value = d.list; currentDeckId = d.id;
      const pick = document.getElementById('md-pick'); if (pick) pick.value = String(d.id);
      run();
    } catch (e) { /* nada */ }
  }

  // Interruptores: no contar tierras básicas y/o el comandante (se recuerda en este navegador)
  const opt = { basic: store.get('mt_vm_nobasic') === '1', cmd: store.get('mt_vm_nocmd') === '1' };
  const isBasic = l => l.basic || BASIC.test(l.name);
  const out_ = l => (opt.basic && isBasic(l)) || (opt.cmd && l.commander);
  const shown = r => Math.round(r.lines.reduce((s, l) => s + (out_(l) ? 0 : l.total || 0), 0) * 100) / 100;
  function totalHtml(r) {
    const cmd = r.lines.filter(l => l.commander);
    const v = shown(r), cut = v !== r.total;
    const left = r.lines.reduce((s, l) => s + (out_(l) ? 0 : l.qty), 0);
    const what = [opt.basic && r.lines.some(isBasic) ? 'tierras básicas' : '', opt.cmd && cmd.length ? 'comandante' : ''].filter(Boolean);
    return `<div><span>${what.length ? 'Valor sin ' + what.join(' ni ') : 'Valor del mazo'}</span><b>${eur(v)}</b><small>${cut ? `${left} de ${r.cards} cartas · con todo: ${eur(r.total)}` : `${r.cards} cartas`} · impresión más barata de cada una${r.pricesAt ? ` · precios del ${new Date(r.pricesAt).toLocaleDateString('es-ES')}` : ''}</small></div>
      ${cmd.length ? `<div class="vcmd ${opt.cmd ? 'off' : ''}">${cmd.map(c => c.img ? `<img src="${esc(c.img)}" alt="${esc(c.name)}" loading="lazy">` : '').join('')}<span>${esc(r.commander)}</span></div>` : ''}`;
  }
  function topHtml(r) {
    const top = r.lines.filter(l => l.unit != null && !out_(l)).slice().sort((a, b) => b.total - a.total).slice(0, 10);
    return top.map(l => `<a href="${esc(l.url || '#')}" target="_blank" rel="noopener" class="vcard">${l.img ? `<img src="${esc(l.img)}" alt="" loading="lazy">` : '<div class="noimg"></div>'}
        <span>${esc(l.name)}</span><b>${eur(l.total)}</b>${l.qty > 1 ? `<small>${l.qty} × ${eur(l.unit)}</small>` : ''}</a>`).join('');
  }
  function switchesHtml(r) {
    const hasB = r.lines.some(isBasic), hasC = r.lines.some(l => l.commander);
    if (!hasB && !hasC) return '';
    const sw = (id, on, label) => `<label class="vsw"><input type="checkbox" role="switch" id="${id}" ${on ? 'checked' : ''}><i aria-hidden="true"></i><span>${label}</span></label>`;
    return `<div class="vswitches" role="group" aria-label="Qué contar">${hasB ? sw('vm-nobasic', opt.basic, 'Sin tierras básicas') : ''}${hasC ? sw('vm-nocmd', opt.cmd, 'Sin comandante') : ''}</div>`;
  }
  function refreshTotals() {
    const r = lastResult;
    document.getElementById('vm-total').innerHTML = totalHtml(r);
    document.getElementById('vm-top').innerHTML = topHtml(r);
    document.querySelectorAll('.vtable tr[data-i]').forEach(tr => tr.classList.toggle('vout', out_(r.lines[tr.dataset.i])));
  }

  let autoSaved = false;
  function render() {
    const r = lastResult;
    out.innerHTML = `
      <div class="vtotal" id="vm-total" aria-live="polite">${totalHtml(r)}</div>
      ${switchesHtml(r)}
      ${legalNote(r)}
      ${bracketNote(r)}
      ${cmdNote(r)}
      ${saveBox()}
      ${myDeckBox()}
      ${r.missing.length ? `<div class="vwarn">No encontradas (${r.missing.length}): ${r.missing.map(esc).join(', ')}</div>` : ''}
      ${r.noPrice.length ? `<div class="vwarn">Sin precio en euros (${r.noPrice.length}): ${r.noPrice.map(esc).join(', ')}</div>` : ''}
      <h3 class="vh">Las más caras</h3>
      <div class="vtop" id="vm-top">${topHtml(r)}</div>
      <h3 class="vh">Lista completa</h3>
      <div class="tablewrap"><table class="tbl vtable"><thead><tr><th class="num">Cant.</th><th>Carta</th><th>Edición más barata</th><th class="num">Precio</th><th class="num">Total</th></tr></thead><tbody>
        ${r.lines.map((l, i) => `<tr data-i="${i}" class="${l.commander ? 'cmdrow' : ''} ${out_(l) ? 'vout' : ''}"><td class="num">${l.qty}</td><td><a href="${esc(l.url || '#')}" target="_blank" rel="noopener">${esc(l.name)}</a>${l.from ? ` <small class="muted">(${esc(l.from)})</small>` : ''}${l.commander ? ' <span class="chip sm">Comandante</span>' : ''}</td>
          <td class="muted small">${esc(l.setName || '')} ${l.set ? `(${esc(l.set.toUpperCase())})` : ''}</td><td class="num">${eur(l.unit)}</td><td class="num strong">${eur(l.total)}</td></tr>`).join('')}
      </tbody></table></div>
      <button class="jbtn-outline" id="vm-copy" style="margin-top:14px">Copiar resumen</button>`;
    bind();
    // Viene de «usar uno de mis mazos» en un torneo: se guarda solo en la ficha del torneo
    if (!autoSaved && new URLSearchParams(location.search).get('guardar') === '1') {
      const sv = document.getElementById('vm-save');
      if (sv) { autoSaved = true; sv.click(); sv.scrollIntoView({ block: 'center' }); }
    }
  }

  function bind() {
    for (const [id, k, key] of [['vm-nobasic', 'basic', 'mt_vm_nobasic'], ['vm-nocmd', 'cmd', 'mt_vm_nocmd']]) {
      const el = document.getElementById(id);
      if (el) el.onchange = () => { opt[k] = el.checked; store.set(key, el.checked ? '1' : '0'); refreshTotals(); };
    }
    const sv = document.getElementById('vm-save');
    if (sv) sv.onclick = async () => {
      const m = document.getElementById('vm-msg');
      try {
        const tk = `mt_tok_${cfg.event}_${sv.dataset.me}`;
        const body = { by: sv.dataset.me, job: lastJob };
        if (store.get(tk)) body.tok = store.get(tk);
        const r = await post(`/commander/${cfg.event}/valor`, body);
        if (r.tok) store.set(tk, r.tok);
        m.innerHTML = (r.over || r.overBracket || r.illegal ? `<span class="warn">Guardado, pero ${r.over ? 'supera el presupuesto' : r.overBracket ? 'supera el bracket máximo' : 'no es legal'}: la tienda lo verá</span>` : 'Guardado ✔ Mazo validado')
          + ` · <a href="${B}/commander/${cfg.event}#apuntarse">Volver al torneo</a>`;
      }
      catch (e) { m.textContent = e.message; }
    };
    const ok = document.getElementById('who-ok'), inp = document.getElementById('who-in');
    if (ok && inp) ok.onclick = () => {
      const p = findPlayer(event.roster, inp.value);
      if (!p) { inp.classList.add('bad'); return; }
      store.set('mt_me_user', p.username || p.name); render();
    };
    const ms = document.getElementById('md-save');
    if (ms) ms.onclick = async () => {
      const m = document.getElementById('md-msg');
      const r = lastResult;
      try {
        const j = await post('/cuenta/mazos', { id: currentDeckId || '', name: document.getElementById('md-name').value, commander: r.commander || '', list: ta.value,
          value: Math.round(r.total * 100), bracket: r.bracket && r.bracket.n ? r.bracket.n : '', legal: r.legality ? (r.legality.ok ? 1 : 0) : '' });
        currentDeckId = j.id; ms.textContent = 'Guardar cambios';
        m.innerHTML = `Guardado en <a href="${B}/cuenta">Mi cuenta</a> ✔`;
      } catch (e) { m.textContent = e.message; }
    };
    const cp = document.getElementById('vm-copy');
    if (cp) cp.onclick = () => {
      const r = lastResult;
      const v = shown(r);
      const txt = `Valor del mazo${v !== r.total ? ` (${[opt.basic ? 'sin básicas' : '', opt.cmd ? 'sin comandante' : ''].filter(Boolean).join(', ')})` : ''}: ${eur(v)} (${r.cards} cartas)\n` + r.lines.filter(l => !out_(l)).slice(0, 10).map(l => `${l.qty} ${l.name} — ${eur(l.total)}`).join('\n');
      navigator.clipboard && navigator.clipboard.writeText(txt).then(() => { cp.textContent = 'Copiado ✔'; });
    };
  }

  document.getElementById('go').onclick = run;
  loadMyDecks();
  { const q = new URLSearchParams(location.search).get('mazo'); if (q) loadDeck(q); }
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); });

  if (cfg.event) {
    fetch(`${B}/commander/${cfg.event}/estado.json`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(s => {
      if (!s) return;
      event = { name: s.name, status: s.status, roster: s.roster, budget: s.budget, bracketMax: s.bracketMax, legalCheck: s.legalCheck, exCommander: s.budgetExCommander, locked: s.deckLocked };
      if (s.budget || s.bracketMax) {
        const head = document.querySelector('.vhead');
        const parts = [s.budget ? `presupuesto máximo <b>${eur(s.budget / 100)}</b> · no cuentan las tierras básicas${s.budgetExCommander ? ' · no cuenta el comandante' : ''}` : '',
          s.bracketMax ? `bracket máximo <b>${bLabel(s.bracketMax)}</b>` : ''].filter(Boolean).join(' · ');
        if (head) head.insertAdjacentHTML('beforeend', `<div class="vsave"><span>Torneo <b>${esc(s.name)}</b>: ${parts}</span></div>`);
      }
      if (lastResult) render();
    }).catch(() => {});
  }
})();
