(function () {
  const root = document.getElementById('life');
  if (!root) return;
  const { esc, norm, store } = window.UI;
  const B = window.__BASE || '';
  const S = window.__LSNAP;
  const id = S.id;
  let me = null, pod = null, st = null, ver = 0, info = {}, busy = 0, err = '';
  let rot = store.get('mt_life_rot') !== '0';
  let turnPref = store.get('mt_life_turn') !== '0'; // apaisado aunque el móvil esté en vertical
  const dismissed = new Set();
  const bubbles = {};
  let menu = false, sheet = null, artSheet = null, hist = null;
  let arts = {}; // pid → { name, def, all? }
  let arrange = false, pick = null, turnSheet = false, skew = 0, installEv = null;
  let tip10 = store.get('mt_life_tip10') !== '1';
  // Sitio de cada jugador en ESTE aparato (cada uno en su esquina) y giro de cada panel
  let lay = {};
  const LK = () => `mt_life_layout_${pod.id}`;
  function loadLay() { try { lay = JSON.parse(store.get(LK()) || '{}') || {}; } catch (e) { lay = {}; } lay.order = lay.order || []; lay.rot = lay.rot || {}; }
  const saveLay = () => store.set(LK(), JSON.stringify(lay));
  function ordered() {
    const idx = pid => { const i = lay.order.indexOf(pid); return i < 0 ? 1e3 : i; };
    return st.players.slice().sort((a, b) => idx(a.id) - idx(b.id) || a.seat - b.seat);
  }

  function resolveMe() {
    const acc = window.__ME;
    if (acc) { const m = S.roster.find(p => p.pkey && p.pkey === acc.key); if (m) return m; }
    const saved = store.get('mt_me_user');
    return saved ? S.roster.find(p => norm(p.username) === norm(saved) || norm(p.name) === norm(saved)) || null : null;
  }
  me = resolveMe();
  pod = S.pods.find(p => p.id === S.pod) || (me && S.pods.find(p => p.players.some(x => x.id === me.id))) || null;
  const mine = () => !!(me && pod && pod.players.some(x => x.id === me.id));
  const nm = pid => esc(((st && st.players.find(p => p.id === pid)) || {}).name || '—');
  const dead = p => !p.out && (p.life <= 0 || p.poison >= 10 || Object.values(p.cmd).some(v => v >= 21));
  const HOW = { dano: 'daño', comandante: 'daño de comandante', veneno: 'veneno', concede: 'se rindió', desempate: 'perdió el desempate', otro: 'otra forma' };
  const artOf = p => (p.artOff ? null : p.art || (arts[p.id] && arts[p.id].def) || null);

  async function post(body) {
    const tk = `mt_tok_${id}_${me.id}`;
    const t = store.get(tk);
    const r = await fetch(`${B}/commander/${id}/vidas/${pod.id}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...body, by: me.id, ...(t ? { tok: t } : {}) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'No se pudo guardar');
    if (j.tok) store.set(tk, j.tok);
    return j;
  }
  function take(j) { if (j && j.state && j.version >= ver) { st = j.state; ver = j.version; info = j; if (j.now) skew = j.now - Date.now(); } }
  async function act(body, optimistic) {
    if (!mine()) { err = 'Para anotar, di quién eres (arriba).'; render(); return; }
    if (optimistic) { optimistic(); render(); }
    busy++;
    try { take(await post(body)); err = ''; } catch (e) { err = e.message; await load(true); }
    busy--; render();
  }
  async function load(force) {
    if (!pod) return;
    try {
      const r = await fetch(`${B}/commander/${id}/vidas/${pod.id}.json`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) { err = j.error || 'Error'; render(); return; }
      if (j.now) skew = j.now - Date.now();
      if (force || (!busy && j.version !== ver)) { const changed = j.version !== ver; st = j.state; ver = j.version; info = j; render(); if (changed && hist) loadHist(); }
    } catch (e) { /* sin conexión: se reintenta */ }
  }
  async function loadArts(pid) {
    try {
      const j = await (await fetch(`${B}/commander/${id}/vidas/${pod.id}/artes.json${pid ? `?pid=${pid}` : ''}`, { cache: 'no-store' })).json();
      if (j.arts) { for (const k of Object.keys(j.arts)) arts[k] = { ...(arts[k] || {}), ...j.arts[k] }; render(); }
    } catch (e) { /* sin fondos */ }
  }

  // Toques: un toque es ±1; si mantienes pulsado, ±10 y repite mientras sigas pulsando
  function bump(pid, d) {
    const p = st.players.find(x => x.id === pid);
    if (!p || p.out || st.done) return;
    p.life += d;
    const b = bubbles[pid] = bubbles[pid] || { v: 0, t: null };
    b.v += d; clearTimeout(b.t); b.t = setTimeout(() => { delete bubbles[pid]; render(); }, 1400);
    if (navigator.vibrate) navigator.vibrate(6);
    if (p.life > 0) dismissed.delete(pid);
    act({ op: 'life', pid, d });
  }
  // El estado es global porque la pantalla se repinta con cada cambio y el botón pulsado puede ya no existir al soltar
  const step = { fn: null, t: null, iv: null, long: false };
  function stepStop(fire) {
    if (fire && step.fn && !step.long && step.t) step.fn(1);
    clearTimeout(step.t); clearInterval(step.iv); step.t = step.iv = null; step.fn = null;
  }
  function bindStep(el, fn) {
    el.addEventListener('pointerdown', e => {
      e.preventDefault(); stepStop(false);
      step.fn = fn; step.long = false;
      step.t = setTimeout(() => {
        step.t = null; step.long = true; fn(10);
        if (tip10) { tip10 = false; store.set('mt_life_tip10', '1'); }
        step.iv = setInterval(() => step.fn && step.fn(10), 600);
      }, 450);
    });
    el.addEventListener('contextmenu', e => e.preventDefault());
  }
  window.addEventListener('pointerup', () => stepStop(true));
  window.addEventListener('pointercancel', () => stepStop(false));
  let hold = null;
  function bindHold(el, fn) {
    const stop = () => { clearTimeout(hold); clearInterval(hold); hold = null; };
    el.addEventListener('pointerdown', e => { e.preventDefault(); fn(); hold = setTimeout(() => { hold = setInterval(fn, 140); }, 450); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => el.addEventListener(ev, stop));
  }

  function pickPodView() {
    return `<div class="lf-pick"><h1>Contador de vidas</h1><p>${esc(S.name)} · ronda ${S.round || '—'}</p>
      ${S.status !== 'running' ? '<p class="lf-note">El contador se abre cuando el torneo está en juego.</p>' : ''}
      ${S.pods.length ? `<p>¿Qué mesa quieres ver?</p><div class="lf-pods">${S.pods.map(p => `<a href="?mesa=${p.id}" class="${p.reported ? 'done' : ''}"><b>Mesa ${p.table}</b><span>${p.players.map(x => esc(x.name)).join(' · ')}</span></a>`).join('')}</div>` : ''}
      <a class="lf-back" href="${B}/commander/${id}">← Volver al torneo</a></div>`;
  }
  function whoView() {
    return `<div class="lf-who"><span>¿Juegas aquí? Eres:</span>${pod.players.map(x => `<button data-me="${x.id}">${esc(x.name)}</button>`).join('')}</div>`;
  }
  const mmss = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const turnOn = () => !!(st.turn && !st.done);
  function arrangePanel(p, i, rotd) {
    return `<section class="lf-p c${i} ${rotd ? 'rot' : ''} arr ${pick === p.id ? 'picked' : ''}" data-swap="${p.id}">
      <div class="lf-in"><div class="lf-arr"><b>${esc(p.name)}</b>
        <span>${pick === p.id ? 'Ahora toca el sitio donde lo quieres' : pick ? 'Toca para cambiarlo de sitio' : 'Toca para moverlo'}</span>
        <button data-prot="${p.id}">Girar 180º</button></div></div></section>`;
  }
  function panel(p, i, rotd) {
    if (arrange) return arrangePanel(p, i, rotd);
    const isDead = dead(p) && !dismissed.has(p.id);
    const cmdMax = Math.max(0, ...Object.values(p.cmd));
    const bub = bubbles[p.id];
    const others = st.players.filter(x => x.id !== p.id);
    const art = artOf(p);
    const own = mine() && me.id === p.id;
    const myTurn = turnOn() && st.turn.pid === p.id && !p.out;
    const pass = myTurn && mine() && !isDead ? '<button class="lf-pass" data-pass>Pasar turno</button>' : '';
    return `<section class="lf-p c${i} ${rotd ? 'rot' : ''} ${myTurn ? 'turn' : ''} ${p.out ? 'out' : ''} ${isDead ? 'dying' : ''} ${art ? 'art' : ''}" ${art ? `style="--art:url('${art.replace(/'/g, '%27')}')"` : ''}>
      <div class="lf-in">
        <header><b>${esc(p.name)}</b>${myTurn ? `<span class="lf-tt">Turno ${st.turn.n} · <time data-tt>${mmss(Date.now() + skew - st.turn.at)}</time></span>` : p.deck ? `<small>${esc(p.deck)}</small>` : ''}</header>
        ${p.out ? `<div class="lf-out"><b>Eliminado</b><span>${p.killer ? `por ${nm(p.killer)}` : esc(HOW[p.how] || '')}</span>${!st.done && mine() ? `<button data-revive="${p.id}">Deshacer</button>` : ''}</div>`
        : isDead ? `<div class="lf-kill"><b>¿Quién ha eliminado a ${esc(p.name)}?</b><div>${others.map(o => `<button data-kill="${p.id}" data-by="${o.id}">${esc(o.name)}</button>`).join('')}
            <button data-kill="${p.id}" data-by="" class="ghost">Se rinde</button></div><button data-alive="${p.id}" class="link">Aún sigue vivo</button></div>`
        : st.sudden ? `<div class="lf-sudden"><span>¿Quién le hace daño?</span><div>${others.filter(o => !o.out).map(o => `<button data-kill="${p.id}" data-by="${o.id}" data-how="dano">${esc(o.name)}</button>`).join('')}</div></div>`
        : `<div class="lf-life"><button class="lz minus" data-z="${p.id}" data-d="-1" aria-label="Quitar una vida a ${esc(p.name)}"><span>−</span></button>
            <b aria-live="polite">${p.life}</b>${bub ? `<em class="${bub.v > 0 ? 'up' : 'down'}">${bub.v > 0 ? '+' : ''}${bub.v}</em>` : tip10 && mine() ? '<small class="lf-tip">Mantén pulsado: ±10</small>' : ''}
            <button class="lz plus" data-z="${p.id}" data-d="1" aria-label="Sumar una vida a ${esc(p.name)}"><span>+</span></button></div>`}
        ${st.sudden && !p.out ? `<footer>${pass}</footer>` : `<footer>${pass}<button data-sheet="${p.id}">Cmdte${cmdMax ? ` <i>${cmdMax}</i>` : ''}</button><button data-sheet="${p.id}">Veneno${p.poison ? ` <i>${p.poison}</i>` : ''}</button>
          ${own ? `<button data-art="${p.id}">Fondo</button>` : ''}
          ${!p.out && !isDead && mine() ? `<button data-kill-open="${p.id}" class="ghost">Eliminar</button>` : ''}</footer>`}
      </div></section>`;
  }
  function sheetView() {
    const p = st.players.find(x => x.id === sheet);
    if (!p) return '';
    const row = (label, op, extra, val, max) => `<div class="lf-row"><span>${label}</span><button data-op="${op}" ${extra} data-d="-1">−</button><b class="${val >= max ? 'lethal' : ''}">${val}</b><button data-op="${op}" ${extra} data-d="1">+</button></div>`;
    return `<div class="lf-sheet" role="dialog" aria-label="Daño a ${esc(p.name)}"><div class="lf-sh-in"><h2>Daño que recibe ${esc(p.name)}</h2>
      <h3>Daño de comandante (21 elimina)</h3>${st.players.filter(x => x.id !== p.id).map(o => row(`de ${esc(o.name)}`, 'cmd', `data-pid="${p.id}" data-from="${o.id}"`, p.cmd[o.id] || 0, 21)).join('')}
      <h3>Veneno (10 elimina)</h3>${row('Contadores', 'poison', `data-pid="${p.id}"`, p.poison, 10)}
      <p class="small">El daño de comandante también resta vidas.</p><button class="jbtn big" data-close>Hecho</button></div></div>`;
  }
  function artSheetView() {
    const p = st.players.find(x => x.id === artSheet);
    const a = arts[artSheet] || {};
    const cur = artOf(p);
    return `<div class="lf-sheet" role="dialog" aria-label="Fondo de ${esc(p.name)}"><div class="lf-sh-in"><h2>Tu fondo</h2>
      ${!a.name ? '<p>Primero di cuál es tu comandante en la página del torneo («Tu mazo y comandante»).</p>'
      : !a.all ? '<p>Buscando ilustraciones…</p>'
      : !a.all.length ? `<p>No encuentro ilustraciones de «${esc(a.name)}».</p>`
      : `<p class="small">Ilustraciones de <b>${esc(a.name)}</b>. Todos los de la mesa verán la que elijas.</p>
        <div class="lf-arts">${a.all.map(x => `<button data-pick-art="${esc(x.url)}" class="${cur === x.url ? 'on' : ''}" title="${esc(x.set)} · ${esc(x.artist)}"><img src="${esc(x.url)}" alt="" loading="lazy"><span>${esc(x.set)}</span></button>`).join('')}</div>`}
      <button class="lf-noart ${!cur ? 'on' : ''}" data-pick-art="">Sin ilustración (solo color)</button>
      <button class="jbtn big" data-close-art>Hecho</button></div></div>`;
  }
  function turnSheetView() {
    const alive = st.players.filter(p => !p.out).sort((a, b) => a.seat - b.seat);
    return `<div class="lf-sheet" role="dialog" aria-label="Turnos"><div class="lf-sh-in"><h2>${st.turn ? '¿De quién es el turno?' : '¿Quién empieza?'}</h2>
      <p class="small">Después, «Pasar turno» va al siguiente por orden de asiento. Cada cambio de vidas queda apuntado con el turno en el que pasó.</p>
      <div class="lf-turns">${alive.map(p => `<button data-turn-to="${p.id}" class="${st.turn && st.turn.pid === p.id ? 'on' : ''}">${esc(p.name)}</button>`).join('')}</div>
      ${st.turn ? '<button class="lf-noart" data-turn-off>Quitar los turnos</button>' : ''}
      <button class="jbtn big" data-close-turn>Cerrar</button></div></div>`;
  }
  const hhmmss = t => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  async function loadHist() {
    try { const j = await (await fetch(`${B}/commander/${id}/vidas/${pod.id}/historial.json`, { cache: 'no-store' })).json(); hist = j.items || []; } catch (e) { hist = hist || []; }
    render();
  }
  function histView() {
    const first = (hist || []).find(h => h.canUndo);
    return `<div class="lf-sheet" role="dialog" aria-label="Historial de la mesa"><div class="lf-sh-in"><h2>Historial de la mesa</h2>
      <p class="small">Los toques seguidos sobre el mismo contador se juntan en un apunte (si das 5 y quitas 1, queda −4). Se guarda todo por si hay alguna duda.</p>
      ${!hist ? '<p>Cargando…</p>' : !hist.length ? '<p>Aún no hay cambios.</p>' : `<ol class="lf-hist">${hist.map(h => `<li class="${h.undone ? 'undone' : ''} k-${h.kind}"><time>${hhmmss(h.updated || h.at)}</time><span>${esc(h.txt)}${h.turn ? `<small class="tn">${esc(h.turn)}</small>` : ''}</span><small class="by">${h.by ? esc(h.by) : ''}</small>
        ${mine() && first && h.id === first.id && !st.done ? `<button data-undo="${h.id}">Deshacer</button>` : '<i></i>'}</li>`).join('')}</ol>`}
      <button class="jbtn big" data-close-hist>Cerrar</button></div></div>`;
  }
  function endView() {
    const alive = st.players.filter(p => !p.out);
    if (st.done) {
      const ord = st.done.order.map((pid, i) => `${i + 1}º ${nm(pid)}`).join(' · ');
      return `<div class="lf-end done"><b>${info.reported || st.done.auto ? 'Resultado anotado ✔' : 'Resultado enviado'}</b><span>${ord}</span>${!info.reported && !st.done.auto ? '<small>Falta que lo confirme la tienda.</small>' : ''}
        <a href="${B}/commander/${id}">Volver al torneo</a></div>`;
    }
    if (alive.length === 1 && !st.players.some(p => dead(p) && !dismissed.has(p.id))) {
      return `<div class="lf-end"><b>¡${esc(alive[0].name)} gana la mesa!</b><span>${[alive[0], ...st.players.filter(p => p.out).sort((a, b) => b.ord - a.ord)].map((p, i) => `${i + 1}º ${esc(p.name)}`).join(' · ')}</span>
        ${mine() ? '<button class="jbtn big" data-finish="">Enviar resultado</button>' : '<small>Uno de la mesa tiene que enviar el resultado.</small>'}</div>`;
    }
    if (st.sudden) {
      return `<div class="lf-end sudden"><span><b>Muerte súbita:</b> el primer daño de un rival elimina. Pagar vidas o dañarte a ti mismo no mata.</span>${mine() ? '<button class="link" data-sudden="0">Quitar</button>' : ''}</div>`;
    }
    return '';
  }

  // Apaisado: si el móvil está en vertical, se gira todo 90º (se juega con el móvil de lado en el centro de la mesa)
  function sizeVars() {
    const w = window.innerWidth, h = window.innerHeight;
    const turn = turnPref && h > w;
    root.style.setProperty('--vw', (turn ? h : w) + 'px');
    root.style.setProperty('--vh', (turn ? w : h) + 'px');
    root.classList.toggle('turn', turn);
  }
  window.addEventListener('resize', sizeVars);
  window.addEventListener('orientationchange', () => setTimeout(sizeVars, 150));

  function render() {
    sizeVars();
    if (!pod) { root.innerHTML = pickPodView(); return; }
    if (!st) { root.innerHTML = `<div class="lf-pick"><p>Cargando la mesa ${pod.table}…</p>${err ? `<p class="lf-note">${esc(err)}</p>` : ''}<a class="lf-back" href="${B}/commander/${id}">← Volver al torneo</a></div>`; return; }
    const n = st.players.length;
    const topN = rot && n >= 3 ? Math.floor(n / 2) : 0;
    const ps = ordered();
    const top = ps.slice(0, topN), bot = ps.slice(topN);
    const rotd = (p, def) => (p.id in lay.rot ? lay.rot[p.id] : def);
    const canPlay = mine() && !st.done && !arrange;
    root.innerHTML = `<div class="lf n${n} ${st.sudden ? 'is-sudden' : ''} ${arrange ? 'is-arr' : ''}">
      <div class="lf-bar"><a href="${B}/commander/${id}" aria-label="Volver al torneo">←</a><span>Mesa ${pod.table}${info.round ? ` · ronda ${info.round}` : ''}${!mine() ? ' · mirando' : ''}</span>
        <i class="lf-live" title="En directo"></i>
        ${arrange ? '<button data-arr-reset>Como al principio</button><button data-arr-done class="hot">Listo</button>'
        : `${canPlay ? (st.turn ? '<button data-pass class="go">Pasar turno</button>' : '<button data-turns>Turnos</button>') : ''}<button data-hist>Historial</button>${canPlay && !st.sudden ? '<button data-sudden="1" class="hot">Muerte súbita</button>' : ''}<button data-menu aria-expanded="${menu}">Opciones</button>`}</div>
      ${menu ? `<div class="lf-menu"><button data-arrange>Colocar jugadores</button>${canPlay ? `<button data-turns>${st.turn ? 'Corregir el turno' : 'Empezar turnos'}</button>` : ''}<button data-turn>${turnPref ? 'Usar en vertical' : 'Usar apaisado'}</button><button data-full>Pantalla completa</button><button data-rot>${rot ? 'No girar los de enfrente' : 'Girar los de enfrente'}</button>
        ${mine() && !st.done ? '<button data-reset class="danger">Reiniciar contador</button>' : ''}${st.done && mine() && !info.reported ? '<button data-reopen>Reabrir la mesa</button>' : ''}
        ${installEv ? '<button data-install>Instalar como app</button>' : ''}<button data-whoami>Cambiar quién soy</button>
        <p class="small">Para que la pantalla no se apague, mejor instálalo: menú del navegador › «Añadir a pantalla de inicio».</p></div>` : ''}
      ${!mine() ? whoView() : ''}
      ${err ? `<div class="lf-err" role="alert">${esc(err)}</div>` : ''}
      ${arrange ? '<div class="lf-arrtip">Toca un jugador y luego el sitio donde lo quieres. Solo cambia en este aparato.</div>' : ''}
      <div class="lf-grid">${top.length ? `<div class="lf-r top">${top.map(p => panel(p, st.players.indexOf(p), rotd(p, true))).join('')}</div>` : ''}<div class="lf-r">${bot.map(p => panel(p, st.players.indexOf(p), rotd(p, false))).join('')}</div></div>
      ${arrange ? '' : endView()}${sheet ? sheetView() : ''}${artSheet ? artSheetView() : ''}${hist ? histView() : ''}${turnSheet ? turnSheetView() : ''}</div>`;
    bind();
  }
  function bind() {
    root.querySelectorAll('[data-z]').forEach(b => bindStep(b, k => bump(Number(b.dataset.z), Number(b.dataset.d) * k)));
    const on = (sel, fn) => root.querySelectorAll(sel).forEach(b => { b.onclick = () => fn(b); });
    on('[data-me]', b => { const p = S.roster.find(x => x.id === Number(b.dataset.me)); me = p; store.set('mt_me_user', p.username || p.name); err = ''; render(); });
    on('[data-menu]', () => { menu = !menu; render(); });
    on('[data-rot]', () => { rot = !rot; store.set('mt_life_rot', rot ? '1' : '0'); menu = false; render(); });
    on('[data-turn]', () => { turnPref = !turnPref; store.set('mt_life_turn', turnPref ? '1' : '0'); menu = false; render(); });
    on('[data-full]', async () => {
      menu = false;
      try { await document.documentElement.requestFullscreen(); if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (e) { /* el navegador no lo permite */ }
      render();
    });
    on('[data-whoami]', () => { me = null; store.set('mt_me_user', null); menu = false; render(); });
    on('[data-reset]', () => { if (confirm('¿Reiniciar el contador de esta mesa? Se borran vidas y eliminaciones.')) { menu = false; act({ op: 'reset' }); } });
    on('[data-reopen]', () => { menu = false; act({ op: 'reopen' }); });
    on('[data-sudden]', b => { const on = b.dataset.sudden === '1'; if (on && !confirm('¿Pasar a muerte súbita? El primer daño de un rival elimina.')) return; menu = false; act({ op: 'sudden', on: on ? 1 : 0 }, () => { st.sudden = on; }); });
    on('[data-finish]', () => act({ op: 'finish' }));
    on('[data-sheet]', b => { sheet = Number(b.dataset.sheet); render(); });
    on('[data-close]', () => { sheet = null; render(); });
    on('[data-art]', b => { artSheet = Number(b.dataset.art); render(); loadArts(artSheet); });
    on('[data-close-art]', () => { artSheet = null; render(); });
    on('[data-hist]', () => { hist = []; render(); loadHist(); });
    on('[data-close-hist]', () => { hist = null; render(); });
    on('[data-undo]', b => act({ op: 'undo', id: b.dataset.undo }).then(loadHist));
    on('[data-pick-art]', b => { const p = st.players.find(x => x.id === artSheet); const url = b.dataset.pickArt;
      act({ op: 'art', pid: p.id, art: url }, () => { p.art = url || null; p.artOff = !url; }); });
    root.querySelectorAll('.lf-sheet [data-op]').forEach(b => bindHold(b, () => {
      const p = st.players.find(x => x.id === Number(b.dataset.pid)), d = Number(b.dataset.d);
      if (b.dataset.op === 'cmd') { const f = Number(b.dataset.from), cur = p.cmd[f] || 0, nv = Math.max(0, cur + d); p.cmd[f] = nv; p.life -= nv - cur; act({ op: 'cmd', pid: p.id, from: f, d }); }
      else { p.poison = Math.max(0, p.poison + d); act({ op: 'poison', pid: p.id, d }); }
      if (navigator.vibrate) navigator.vibrate(6);
    }));
    on('[data-kill]', b => { const pid = Number(b.dataset.kill), by = b.dataset.by; const p = st.players.find(x => x.id === pid);
      const how = b.dataset.how === 'desempate' ? 'desempate' : !by ? 'concede' : (p.cmd[by] || 0) >= 21 ? 'comandante' : p.poison >= 10 ? 'veneno' : 'dano';
      act({ op: 'kill', pid, killer: by, how }, () => { p.out = true; p.killer = by ? Number(by) : null; p.how = how; p.ord = st.players.filter(x => x.out).length; }); });
    on('[data-kill-open]', b => { const p = st.players.find(x => x.id === Number(b.dataset.killOpen)); dismissed.delete(p.id); if (p.life > 0) p.life = 0; render(); });
    on('[data-alive]', b => { dismissed.add(Number(b.dataset.alive)); load(true); render(); });
    on('[data-revive]', b => act({ op: 'revive', pid: Number(b.dataset.revive) }));
    // Colocar jugadores (solo en este aparato)
    on('[data-arrange]', () => { menu = false; arrange = true; pick = null; render(); });
    on('[data-arr-done]', () => { arrange = false; pick = null; render(); });
    on('[data-arr-reset]', () => { lay = { order: [], rot: {} }; saveLay(); pick = null; render(); });
    on('[data-swap]', b => {
      const pid = Number(b.dataset.swap);
      if (!pick) { pick = pid; render(); return; }
      if (pick !== pid) {
        const o = ordered().map(p => p.id); const a = o.indexOf(pick), c = o.indexOf(pid);
        [o[a], o[c]] = [o[c], o[a]]; lay.order = o;
        // el giro va con el sitio, no con la persona
        const ra = lay.rot[pick], rc = lay.rot[pid];
        if (rc === undefined) delete lay.rot[pick]; else lay.rot[pick] = rc;
        if (ra === undefined) delete lay.rot[pid]; else lay.rot[pid] = ra;
        saveLay();
      }
      pick = null; render();
    });
    root.querySelectorAll('[data-prot]').forEach(b => { b.onclick = e => {
      e.stopPropagation(); const pid = Number(b.dataset.prot);
      lay.rot[pid] = !b.closest('.lf-p').classList.contains('rot'); saveLay(); render();
    }; });
    // Turnos
    on('[data-turns]', () => { menu = false; turnSheet = true; render(); });
    on('[data-close-turn]', () => { turnSheet = false; render(); });
    on('[data-turn-to]', b => { turnSheet = false; const pid = Number(b.dataset.turnTo);
      act({ op: 'turn', pid }, () => { st.turn = { pid, n: st.turn ? st.turn.n : 1, at: Date.now() + skew }; }); });
    on('[data-turn-off]', () => { turnSheet = false; act({ op: 'turnoff' }, () => { st.turn = null; }); });
    on('[data-pass]', () => act({ op: 'turn' }, () => {
      const all = st.players.slice().sort((a, b) => a.seat - b.seat);
      const i = all.findIndex(q => q.id === st.turn.pid);
      const nx = [...all.slice(i + 1), ...all.slice(0, i + 1)].find(q => !q.out);
      if (nx) st.turn = { pid: nx.id, n: st.turn.n + 1, at: Date.now() + skew };
      if (navigator.vibrate) navigator.vibrate(15);
    }));
    on('[data-install]', async () => { menu = false; try { installEv.prompt(); await installEv.userChoice; } catch (e) { /* nada */ } installEv = null; render(); });
  }

  // En directo: el servidor avisa al momento de cada cambio; si se corta, se vuelve a preguntar cada pocos segundos
  let es = null, lastPush = 0;
  function live() {
    if (!pod || !window.EventSource) return;
    try { es && es.close(); } catch (e) { /* nada */ }
    es = new EventSource(`${B}/commander/${id}/vidas/${pod.id}/stream`);
    es.onmessage = e => { lastPush = Date.now(); if (Number(e.data) !== ver) load(false); };
    es.onopen = () => { lastPush = Date.now(); root.classList.add('pushing'); };
    es.onerror = () => { root.classList.remove('pushing'); };
  }
  // Pantalla siempre encendida mientras se juega
  // Pantalla siempre encendida: Wake Lock y, si el navegador no lo tiene o lo suelta, un vídeo mudo en bucle (los móviles no se apagan mientras hay vídeo)
  let lock = null, vid = null;
  async function wake() {
    if (document.visibilityState !== 'visible') return;
    if ('wakeLock' in navigator) {
      if (lock && !lock.released) return;
      try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; if (document.visibilityState === 'visible') setTimeout(wake, 500); }); return; } catch (e) { /* sin permiso: vídeo */ }
    }
    try {
      if (!vid) {
        vid = document.createElement('video');
        vid.muted = true; vid.loop = true; vid.playsInline = true;
        vid.setAttribute('muted', ''); vid.setAttribute('playsinline', ''); vid.setAttribute('aria-hidden', 'true');
        vid.src = `${B}/static/img/awake.mp4`;
        vid.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1';
        document.body.appendChild(vid);
      }
      if (vid.paused) await vid.play();
    } catch (e) { /* necesita un toque: se reintenta en el siguiente */ }
  }
  document.addEventListener('pointerdown', wake, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { wake(); load(true); if (!es || es.readyState === 2) live(); } });
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEv = e; });
  // Reloj del turno (sin repintar todo)
  setInterval(() => { const t = root.querySelector('[data-tt]'); if (t && st && st.turn) t.textContent = mmss(Date.now() + skew - st.turn.at); }, 1000);
  if (pod) loadLay();
  wake();
  render();
  if (pod) {
    load(true).then(() => loadArts());
    live();
    setInterval(() => { if (!es || es.readyState !== 1) load(false); }, 2000);
    setInterval(() => load(false), 15000);
  }
})();
