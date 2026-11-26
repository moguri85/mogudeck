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
  let tip10 = store.get('mt_life_tip5') !== '1';
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
  // Modo casual: partida suelta, sin torneo ni resultados; todo vive en este aparato
  const CAS = !!S.casual;
  if (CAS) { me = { id: 0 }; pod = { id: 'casual', table: 0, players: [] }; }
  else {
    me = resolveMe();
    pod = S.pods.find(p => p.id === S.pod) || (me && S.pods.find(p => p.players.some(x => x.id === me.id))) || null;
  }
  const mine = () => CAS || !!(me && pod && pod.players.some(x => x.id === me.id));
  const home = CAS ? `${B}/` : `${B}/commander/${id}`;
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
    if (CAS) return casualAct(body, optimistic);
    if (!mine()) { err = 'Para anotar, di quién eres (arriba).'; render(); return; }
    if (optimistic) { optimistic(); render(); }
    busy++;
    try { take(await post(body)); err = ''; } catch (e) { err = e.message; await load(true); }
    busy--; render();
  }
  async function load(force) {
    if (CAS) {
      if (room) {
        try {
          const r = await fetch(`${B}/vidas/sala/${room}.json`, { cache: 'no-store' });
          if (r.status === 404) { leaveRoom('Esa sala ya no existe: sigues con la partida en este móvil.'); }
          else { const j = await r.json(); if (force || (!roomBusy && j.version > roomVer)) { st = j.state; roomVer = j.version; saveCas(); } }
        } catch (e) { /* sin conexión: seguimos con lo que hay */ }
      }
      if (!st || force) { try { st = (room && st) || JSON.parse(store.get('mt_life_casual') || 'null'); } catch (e) { st = null; } }
      info = casInfo();
      if (hist && st) hist = (st.hist || []).slice();
      render(); return;
    }
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
    if (CAS) {
      if (!st) return;
      for (const p of pid ? st.players.filter(x => x.id === pid) : st.players) {
        if (!p.deck) continue;
        try { const j = await (await fetch(`${B}/vidas/artes.json?q=${encodeURIComponent(p.deck)}`)).json(); arts[p.id] = { name: j.name || p.deck, def: j.all && j.all[0] ? j.all[0].url : null, all: j.all || [] }; } catch (e) { /* sin fondos */ }
      }
      render(); return;
    }
    try {
      const j = await (await fetch(`${B}/commander/${id}/vidas/${pod.id}/artes.json${pid ? `?pid=${pid}` : ''}`, { cache: 'no-store' })).json();
      if (j.arts) { for (const k of Object.keys(j.arts)) arts[k] = { ...(arts[k] || {}), ...j.arts[k] }; render(); }
    } catch (e) { /* sin fondos */ }
  }

  // ---- Motor local del modo casual (mismas acciones que el servidor, guardadas en este aparato) ----
  const saveCas = () => store.set('mt_life_casual', st ? JSON.stringify(st) : null);
  const nameOf = pid => ((st.players.find(p => p.id === Number(pid))) || {}).name || '—';
  const tTag = () => (st.turn ? `Vuelta ${st.turn.lap || 1} · turno de ${nameOf(st.turn.pid)}` : '');
  function hpush(e) {
    st.hist = st.hist || [];
    const now = Date.now();
    st.hist.unshift({ at: now, updated: now, by: '', turn: '', canUndo: false, undone: false, ...e, id: (st.hseq = (st.hseq || 0) + 1) });
    st.hist = st.hist.slice(0, 400);
  }
  function htxt(h) {
    const sg = n => (n > 0 ? `+${n}` : `−${-n}`), n = nameOf(h.pid);
    if (h.kind === 'life') return `${n}: ${sg(h.d)} ${Math.abs(h.d) === 1 ? 'vida' : 'vidas'} (${h.before} → ${h.after})`;
    if (h.kind === 'poison') return `${n}: ${sg(h.d)} veneno (${h.before} → ${h.after})`;
    return `${n}: ${sg(h.d)} de comandante de ${nameOf(h.from)} (${h.before} → ${h.after})`;
  }
  function track(kind, p, from, d, after) {
    if (!d) return;
    const h = st.hist && st.hist[0], now = Date.now();
    if (h && h.kind === kind && h.pid === p.id && (h.from || 0) === (from || 0) && !h.undone && now - h.updated < 4000) {
      h.d += d; h.after = after; h.updated = now;
      if (!h.d) st.hist.shift(); else h.txt = htxt(h);
      return;
    }
    const e = { kind, pid: p.id, from: from || 0, d, before: after - d, after, canUndo: true, turn: tTag() };
    e.txt = htxt(e); hpush(e);
  }
  function casualOp(b, prev) {
    const P = x => st.players.find(q => q.id === Number(x));
    const rd = b.rd != null ? Number(b.rd) : Number(b.d);
    switch (b.op) {
      case 'life': track('life', P(b.pid), 0, rd, P(b.pid).life); break;
      case 'poison': track('poison', P(b.pid), 0, rd, P(b.pid).poison); break;
      case 'cmd': track('cmd', P(b.pid), Number(b.from), rd, P(b.pid).cmd[b.from] || 0); break;
      case 'undo': {
        const h = (st.hist || []).find(x => x.canUndo);
        if (!h) break;
        const p = P(h.pid);
        if (h.kind === 'life') p.life -= h.d;
        else if (h.kind === 'poison') p.poison -= h.d;
        else { p.cmd[h.from] = (p.cmd[h.from] || 0) - h.d; p.life += h.d; }
        h.canUndo = false; h.undone = true;
        hpush({ kind: 'undo', txt: `Deshecho: ${h.txt}` });
        break;
      }
      case 'kill': { const v = P(b.pid); hpush({ kind: 'kill', pid: v.id, turn: tTag(), txt: b.killer ? `${nameOf(b.killer)} elimina a ${v.name}` : `${v.name} se rinde` }); break; }
      case 'revive': {
        const p = P(b.pid); if (!p.out) break;
        p.out = false; p.killer = null; p.how = null; p.ord = null; if (p.life <= 0) p.life = 1;
        st.players.filter(q => q.out).sort((x, y) => x.ord - y.ord).forEach((q, i) => { q.ord = i + 1; });
        hpush({ kind: 'note', txt: `${p.name} vuelve a la partida` });
        break;
      }
      case 'reset':
        st.players.forEach(p => Object.assign(p, { life: st.start, poison: 0, cmd: {}, x: {}, out: false, killer: null, how: null, ord: null }));
        Object.assign(st, { turn: null, tstats: {}, sudden: false, hist: [], log: [], monarch: null, init: null, day: null, done: null, league: null, startedAt: Date.now() });
        dismissed.clear();
        hpush({ kind: 'reset', txt: 'Partida nueva con los mismos jugadores' });
        break;
      case 'sudden': hpush({ kind: 'note', txt: st.sudden ? 'Muerte súbita activada' : 'Muerte súbita quitada' }); break;
      case 'turn': {
        let txt = '';
        if (prev && !b.pid) {
          const ms = Date.now() - prev.at;
          st.tstats = st.tstats || {};
          const t = st.tstats[prev.pid] = st.tstats[prev.pid] || { n: 0, ms: 0, max: 0 };
          t.n++; t.ms += ms; t.max = Math.max(t.max, ms);
          txt = ` (${nameOf(prev.pid)} tardó ${mmss(ms)})`;
        }
        hpush({ kind: 'turn', txt: `Vuelta ${st.turn.lap || 1}: turno de ${nameOf(st.turn.pid)}${txt}` });
        break;
      }
      case 'lap': hpush({ kind: 'note', txt: `Vuelta corregida: ${st.turn.lap}` }); break;
      case 'turnoff': hpush({ kind: 'note', txt: 'Sin turnos' }); break;
      case 'extra': { const p = P(b.pid), v = (p.x || {})[b.key] || 0; if (b.rd) hpush({ kind: 'extra', pid: p.id, turn: tTag(), txt: `${p.name}: ${EXK[b.key].toLowerCase()} ${v - b.rd} → ${v}` }); break; }
      case 'holder': hpush({ kind: 'extra', txt: b.pid ? `${nameOf(b.pid)} tiene ${b.key === 'monarch' ? 'el Monarca' : 'la Iniciativa'}` : `Nadie tiene ${b.key === 'monarch' ? 'el Monarca' : 'la Iniciativa'}` }); break;
      case 'day': hpush({ kind: 'note', txt: st.day === 'night' ? 'Es de noche' : 'Es de día' }); break;
      default: break;
    }
  }
  // ---- Sala compartida: la partida casual se sincroniza entre varios móviles con un código ----
  let room = null, roomVer = 0, roomBusy = false, roomT = null, roomInfo = null, roomEs = null, league = null;
  if (CAS) {
    const q = new URLSearchParams(location.search).get('sala');
    room = (q || store.get('mt_life_room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || null;
    if (q) { store.set('mt_life_room', room); history.replaceState(null, '', location.pathname); }
  }
  function pushRoom() {
    if (!room) return;
    clearTimeout(roomT);
    roomT = setTimeout(async () => {
      roomBusy = true;
      try {
        const r = await fetch(`${B}/vidas/sala/${room}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: st, base: roomVer }) });
        const j = await r.json();
        if (r.status === 409) { st = j.state; roomVer = j.version; saveCas(); err = 'Otro móvil cambió la partida a la vez: revisa el último cambio.'; render(); }
        else if (r.ok) { roomVer = j.version; if (err) { err = ''; render(); } }
        else if (r.status === 400 && /sala/.test(j.error || '')) leaveRoom(j.error);
      } catch (e) { /* sin conexión: se reintenta con el siguiente cambio */ }
      roomBusy = false;
    }, 150);
  }
  async function makeRoom() {
    try {
      const r = await fetch(`${B}/vidas/sala`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: st }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error);
      room = j.code; roomVer = j.version; roomInfo = j; store.set('mt_life_room', room); liveRoom(); render();
    } catch (e) { err = e.message || 'No se pudo compartir'; render(); }
  }
  async function showRoom() { try { roomInfo = { ...(await (await fetch(`${B}/vidas/sala/${room}/qr`)).json()), code: room }; } catch (e) { roomInfo = { code: room }; } render(); }
  function leaveRoom(msg) { room = null; roomVer = 0; roomInfo = null; store.set('mt_life_room', null); try { roomEs && roomEs.close(); } catch (e) { /* nada */ } if (msg) err = msg; render(); }
  function liveRoom() {
    if (!room || !window.EventSource) return;
    try { roomEs && roomEs.close(); } catch (e) { /* nada */ }
    roomEs = new EventSource(`${B}/vidas/sala/${room}/stream`);
    roomEs.onmessage = e => { if (Number(e.data) > roomVer && !roomBusy) load(false); };
    roomEs.onopen = () => root.classList.add('pushing');
    roomEs.onerror = () => root.classList.remove('pushing');
  }
  const roomView = () => `<div class="lf-sheet" role="dialog" aria-label="Partida compartida"><div class="lf-sh-in lf-roomsh"><h2>Partida compartida</h2>
    <p>Desde otro móvil: abre <b>${esc((roomInfo && roomInfo.url) || '')}</b> o escanea el QR. Todos veis y cambiáis la misma partida.</p>
    <div class="lf-code">${esc(room || '')}</div>${roomInfo && roomInfo.qr ? `<img class="lf-qr" src="${esc(roomInfo.qr)}" alt="QR para unirse">` : ''}
    <div class="lf-endb"><button class="jbtn big" data-close-room>Hecho</button><button class="jbtn big ghost" data-leave-room>Salir de la sala</button></div></div></div>`;
  const leagueView = () => `<div class="lf-sheet" role="dialog" aria-label="Registrar para la liga"><div class="lf-sh-in lf-roomsh"><h2>Registrar para la liga</h2>
    ${league.error ? `<p class="lf-cerr">${esc(league.error)}</p>` : !league.url ? '<p>Registrando…</p>' : `<p>Cada jugador abre este enlace o escanea el QR, entra con su cuenta y pulsa «Soy yo». Cuenta cuando lo han confirmado todos.</p>
    <img class="lf-qr" src="${esc(league.qr)}" alt="QR para confirmar"><p class="small"><a href="${esc(league.url)}" target="_blank" rel="noopener">${esc(league.url)}</a></p>`}
    <button class="jbtn big" data-close-league>Hecho</button></div></div>`;
  async function registerLeague() {
    league = {}; render();
    try { const r = await fetch(`${B}/vidas/liga`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: st, room }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); league = j; st.league = j.url; saveCas(); pushRoom(); }
    catch (e) { league = { error: e.message || 'No se pudo registrar' }; }
    render();
  }
  function casualAct(body, optimistic) {
    const prev = st.turn ? { ...st.turn } : null;
    if (optimistic) optimistic();
    casualOp(body, prev);
    saveCas(); pushRoom();
    if (hist) hist = (st.hist || []).slice();
    render();
    return Promise.resolve();
  }
  const casInfo = () => ({ comboLap: (st && st.combo) || 0, comboSeat: 3, comboLabel: 'Combos de 3 o más cartas', turnWarn: 0 });
  function setupCfg() {
    let c = {}; try { c = JSON.parse(store.get('mt_life_casual_cfg') || '{}') || {}; } catch (e) { c = {}; }
    return { n: c.n || 4, start: c.start || 40, names: c.names || [], cmds: c.cmds || [], combo: !!c.combo };
  }
  function setupView() {
    const c = setupCfg();
    return `<div class="lf-pick lf-setup"><h1>Contador de vidas</h1>
      <p>Para partidas sueltas: no cuenta para ningún torneo y se guarda solo en este aparato.</p>
      <form data-setup>
        <fieldset class="lf-seg"><legend>Jugadores</legend>${[2, 3, 4, 5, 6].map(n => `<label><input type="radio" name="n" value="${n}" ${c.n === n ? 'checked' : ''}><b>${n}</b></label>`).join('')}</fieldset>
        <fieldset class="lf-seg"><legend>Vidas</legend>${[20, 30, 40].map(n => `<label><input type="radio" name="start" value="${n}" ${c.start === n ? 'checked' : ''}><b>${n}</b></label>`).join('')}</fieldset>
        <div class="lf-names">${[0, 1, 2, 3, 4, 5].map(i => `<div class="lf-name" data-i="${i}" ${i >= c.n ? 'hidden' : ''}>
          <input name="p${i}" value="${esc(c.names[i] || '')}" placeholder="Jugador ${i + 1}" maxlength="24" aria-label="Nombre del jugador ${i + 1}">
          <input name="c${i}" value="${esc(c.cmds[i] || '')}" placeholder="Comandante" maxlength="120" list="lf-dl" data-sug="cmd" autocomplete="off" aria-label="Comandante del jugador ${i + 1}">
          <p class="lf-cerr" data-cerr="${i}" hidden></p></div>`).join('')}</div>
        <label class="lf-chk"><input type="checkbox" name="combo" ${c.combo ? 'checked' : ''}><span>Avisar de cuándo valen los combos de 3 o más cartas (desde el turno 5 del 3º jugador)</span></label>
        ${room ? `<p class="lf-note">Estás en la sala <b>${esc(room)}</b>: la partida nueva la verán todos los móviles de la sala.</p>` : `<label class="lf-chk"><input type="checkbox" name="share"><span>Compartir con otros móviles (te da un código para que cada uno lleve sus vidas en su móvil)</span></label>`}
        <button class="jbtn big">Empezar partida</button>
      </form>
      ${room ? '' : `<form class="lf-join" data-join><label>¿Te han pasado un código?<span><input name="code" maxlength="4" placeholder="ABCD" autocomplete="off" autocapitalize="characters"><button>Unirme</button></span></label></form>`}
      <a class="lf-back" href="${B}/">← Volver</a></div>`;
  }

  // Toques: un toque es ±1; si mantienes pulsado, ±5 y repite mientras sigas pulsando
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
        step.t = null; step.long = true; fn(5);
        if (tip10) { tip10 = false; store.set('mt_life_tip5', '1'); }
        const t0 = Date.now();
        step.iv = setInterval(() => { if (Date.now() - t0 > 8000) return stepStop(false); if (step.fn) step.fn(5); }, 600);
      }, 450);
    });
    el.addEventListener('contextmenu', e => e.preventDefault());
  }
  window.addEventListener('pointerup', () => stepStop(true));
  window.addEventListener('pointercancel', () => stepStop(false));
  window.addEventListener('blur', () => stepStop(false));
  document.addEventListener('visibilitychange', () => stepStop(false));

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
  const slowT = () => !!(st && st.turn && info.turnWarn && Date.now() + skew - st.turn.at >= info.turnWarn * 60000);
  // Combos de 2 cartas: prohibidos antes de la vuelta que diga el torneo (normalmente la 6)
  // Ejemplo: turno 5 del 3º jugador → en la vuelta 5 el 1º y el 2º aún no, el 3º y siguientes ya sí; desde la vuelta 6, todos
  const comboRule = () => `${info.comboLabel || 'Combos'}: desde el turno ${info.comboLap}${(info.comboSeat || 1) > 1 ? ` del ${info.comboSeat}º jugador` : ''}`;
  const comboTag = () => { const c = info.comboLap, k = info.comboSeat || 1; if (!c || !st.turn) return '';
    const l = st.turn.lap || 1, pos = (st.turn.played || [st.turn.pid]).length;
    const ok = l > c || (l === c && pos >= k);
    return ok ? `<span class="lf-combo ok" title="${esc(comboRule())}">${esc(info.comboLabel || 'Combos')}: sí</span>` : `<span class="lf-combo no" title="${esc(comboRule())}">${esc(info.comboLabel || 'Combos')}: desde T${c}${k > 1 ? ` del ${k}º` : ''}</span>`; };
  // Reloj de la ronda del torneo (el que pone la tienda)
  function clockTxt() {
    if (!info.timerEnd) return null;
    const ms = new Date(info.timerEnd) - (Date.now() + skew);
    return ms >= 0 ? { t: mmss(ms + 999), over: false } : { t: `+${mmss(-ms)}`, over: true };
  }
  // Filas: arriba de izquierda a derecha y abajo de derecha a izquierda
  const topNOf = n => (rot && n >= 3 ? Math.floor(n / 2) : 0);
  const ring = () => ordered(); // la fila de abajo se pinta al revés, así que la lista ya va en el sentido de las agujas del reloj
  function nextPid() {
    const r = ring(), i = r.findIndex(q => q.id === st.turn.pid);
    const nx = [...r.slice(i + 1), ...r.slice(0, i + 1)].find(q => !q.out);
    return nx ? nx.id : null;
  }
  function nextTurn(to) {
    if (!to) return;
    let lap = st.turn.lap || 1, played = st.turn.played || [st.turn.pid];
    if (played.includes(to)) { lap++; played = [to]; } else played = [...played, to];
    st.turn = { ...st.turn, pid: to, n: st.turn.n + 1, lap, played, at: Date.now() + skew };
  }
  function arrangePanel(p, i, rotd) {
    return `<section class="lf-p c${i} ${rotd ? 'rot' : ''} arr ${pick === p.id ? 'picked' : ''}" data-swap="${p.id}">
      <div class="lf-in"><div class="lf-arr"><b>${esc(p.name)}</b>
        <span>${pick === p.id ? 'Ahora toca el sitio donde lo quieres' : pick ? 'Toca para cambiarlo de sitio' : 'Toca para moverlo'}</span>
        <button data-prot="${p.id}">Girar 180º</button></div></div></section>`;
  }
  // ---- Contadores extra (impuesto, energía, experiencia), Monarca/Iniciativa y día/noche ----
  const EXK = { tax: 'Impuesto de comandante', energy: 'Energía', exp: 'Experiencia' };
  const HOLD = { monarch: 'Monarca', init: 'Iniciativa' };
  const exOn = k => (st.ex || []).includes(k);
  // Cambios locales (se ven al momento; el servidor o el motor casual hacen el resto)
  function mut(b) {
    const P = x => st.players.find(q => q.id === Number(x));
    if (b.op === 'extra') { const p = P(b.pid); p.x = p.x || {}; p.x[b.key] = Math.max(0, (p.x[b.key] || 0) + Number(b.d)); }
    else if (b.op === 'holder') st[b.key] = b.pid ? Number(b.pid) : null;
    else if (b.op === 'day') st.day = b.v || null;
    else if (b.op === 'extras') st.ex = String(b.on || '').split(',').filter(Boolean);
  }
  function tagsView(p) {
    const x = p.x || {}, t = [];
    if (exOn('tax') && x.tax) t.push(`<span title="Impuesto de comandante">Imp +${2 * x.tax}</span>`);
    if (exOn('energy') && x.energy) t.push(`<span title="Energía">Energía ${x.energy}</span>`);
    if (exOn('exp') && x.exp) t.push(`<span title="Experiencia">Exp ${x.exp}</span>`);
    if (exOn('monarch') && st.monarch === p.id) t.push('<span class="hold" title="Monarca">♛ Monarca</span>');
    if (exOn('init') && st.init === p.id) t.push('<span class="hold" title="Iniciativa">Iniciativa</span>');
    return t.length ? `<button class="lf-tags" data-sheet="${p.id}">${t.join('')}</button>` : '';
  }
  function panel(p, i, rotd) {
    if (arrange) return arrangePanel(p, i, rotd);
    const isDead = dead(p) && !dismissed.has(p.id);
    const cmdMax = Math.max(0, ...Object.values(p.cmd));
    const bub = bubbles[p.id];
    const others = st.players.filter(x => x.id !== p.id);
    const art = artOf(p);
    const own = CAS || (mine() && me.id === p.id);
    const myTurn = turnOn() && st.turn.pid === p.id && !p.out;
    const pass = myTurn && mine() && !isDead ? '<button class="lf-pass" data-pass>Pasar turno</button>' : '';
    return `<section data-pid="${p.id}" class="lf-p c${i} ${rotd ? 'rot' : ''} ${myTurn ? 'turn' : ''} ${p.out ? 'out' : ''} ${isDead ? 'dying' : ''} ${art ? 'art' : ''}" ${art ? `style="--art:url('${art.replace(/'/g, '%27')}')"` : ''}>
      <div class="lf-in">
        <header><b>${esc(p.name)}</b>${myTurn ? `<span class="lf-tts"><span class="lf-tt ${slowT() ? 'slow' : ''}">Vuelta ${st.turn.lap || 1} · <time data-tt>${mmss(Date.now() + skew - st.turn.at)}</time></span>${comboTag()}${otTag()}</span>` : p.deck ? `<small>${esc(p.deck)}</small>` : ''}${tagsView(p)}</header>
        ${p.out ? `<div class="lf-out"><b>Eliminado</b><span>${p.killer ? `por ${nm(p.killer)}` : esc(HOW[p.how] || '')}</span>${!st.done && mine() ? `<button data-revive="${p.id}">Deshacer</button>` : ''}</div>`
        : isDead ? `<div class="lf-kill"><b>¿Quién ha eliminado a ${esc(p.name)}?</b><div>${others.map(o => `<button data-kill="${p.id}" data-by="${o.id}">${esc(o.name)}</button>`).join('')}
            <button data-kill="${p.id}" data-by="" class="ghost">Se rinde</button></div><button data-alive="${p.id}" class="link">Aún sigue vivo</button></div>`
        : st.sudden ? `<div class="lf-sudden"><span>¿Quién le hace daño?</span><div>${others.filter(o => !o.out).map(o => `<button data-kill="${p.id}" data-by="${o.id}" data-how="dano">${esc(o.name)}</button>`).join('')}</div></div>`
        : `<div class="lf-life"><button class="lz minus" data-z="${p.id}" data-d="-1" aria-label="Quitar una vida a ${esc(p.name)}"><span>−</span></button>
            <b aria-live="polite">${p.life}</b>${bub ? `<em class="${bub.v > 0 ? 'up' : 'down'}">${bub.v > 0 ? '+' : ''}${bub.v}</em>` : tip10 && mine() && !myTurn ? '<small class="lf-tip">Mantén pulsado: ±5</small>' : ''}
            <button class="lz plus" data-z="${p.id}" data-d="1" aria-label="Sumar una vida a ${esc(p.name)}"><span>+</span></button></div>`}
        ${st.sudden && !p.out ? `<footer>${pass}</footer>` : `<footer>${pass}<button data-sheet="${p.id}">Cmdte${cmdMax ? ` <i>${cmdMax}</i>` : ''}</button><button data-sheet="${p.id}">Veneno${p.poison ? ` <i>${p.poison}</i>` : ''}</button>
          ${own ? `<button data-art="${p.id}">Fondo</button>` : ''}
          ${!p.out && !isDead && mine() ? `<button data-kill-open="${p.id}" class="ghost">Eliminar</button>` : ''}</footer>`}
      </div></section>`;
  }
  function sheetView() {
    const p = st.players.find(x => x.id === sheet);
    if (!p) return '';
    // Botones sueltos de 1 y de 5 (sin mantener pulsado: en algunos móviles se quedaba sumando solo)
    const bt = (op, extra, d) => `<button data-op="${op}" ${extra} data-d="${d}" aria-label="${d > 0 ? 'Sumar' : 'Restar'} ${Math.abs(d)}">${d > 0 ? '+' : '−'}${Math.abs(d)}</button>`;
    const row = (label, op, extra, val, max) => `<div class="lf-row"><span>${label}</span>${bt(op, extra, -5)}${bt(op, extra, -1)}<b class="${val >= max ? 'lethal' : ''}">${val}</b>${bt(op, extra, 1)}${bt(op, extra, 5)}</div>`;
    return `<div class="lf-sheet" role="dialog" aria-label="Daño a ${esc(p.name)}"><div class="lf-sh-in"><h2>Daño que recibe ${esc(p.name)}</h2>
      <h3>Daño de comandante (21 elimina)</h3>${st.players.filter(x => x.id !== p.id).map(o => row(`de ${esc(o.name)}`, 'cmd', `data-pid="${p.id}" data-from="${o.id}"`, p.cmd[o.id] || 0, 21)).join('')}
      <h3>Veneno (10 elimina)</h3>${row('Contadores', 'poison', `data-pid="${p.id}"`, p.poison, 10)}
      ${['tax', 'energy', 'exp'].filter(exOn).map(k => `<h3>${EXK[k]}${k === 'tax' ? ` · cuesta +${2 * ((p.x || {}).tax || 0)}` : ''}</h3>${row(k === 'tax' ? 'Veces lanzado' : 'Contadores', 'extra', `data-pid="${p.id}" data-key="${k}"`, (p.x || {})[k] || 0, 999)}`).join('')}
      ${['monarch', 'init'].filter(exOn).map(k => `<h3>${HOLD[k]}</h3><div class="lf-turns">${st[k] === p.id ? `<button class="on" data-holder="${k}" data-hp="">${esc(p.name)} lo tiene · quitar</button>` : `<button data-holder="${k}" data-hp="${p.id}">Dárselo a ${esc(p.name)}</button>`}</div>`).join('')}
      <p class="small">El daño de comandante también resta vidas.${!(st.ex || []).length ? ' Impuesto, energía, experiencia, Monarca, Iniciativa y día/noche se activan en Opciones › Contadores extra.' : ''}</p><button class="jbtn big" data-close>Hecho</button></div></div>`;
  }
  // Fondo: cualquier ilustración (la búsqueda no cambia el comandante). En casual, el comandante va aparte y se comprueba que exista
  let cmdMsg = null;
  function artSheetView() {
    const p = st.players.find(x => x.id === artSheet);
    const a = arts[artSheet] || {};
    const cur = artOf(p);
    const showing = a.q || a.name;
    const sugs = m => (m.sug && m.sug.length ? `<span class="lf-sugs">${m.sug.map(n => `<button type="button" data-cmd-sug="${esc(n)}">${esc(n)}</button>`).join('')}</span>` : '');
    return `<div class="lf-sheet" role="dialog" aria-label="Fondo de ${esc(p.name)}"><div class="lf-sh-in"><h2>${CAS ? esc(p.name) : 'Tu fondo'}</h2>
      ${CAS ? `<h3>Comandante</h3><form class="lf-cmdr" data-cmdr="${p.id}"><input name="cmdr" list="lf-dl" data-sug="cmd" value="${esc(p.deck || '')}" placeholder="Nombre del comandante" maxlength="120" autocomplete="off" aria-label="Comandante"><button>Guardar</button></form>
        ${cmdMsg && cmdMsg.pid === p.id ? `<p class="lf-cerr">${esc(cmdMsg.msg)}${sugs(cmdMsg)}</p>` : ''}` : ''}
      <h3>Ilustración de fondo</h3>
      <form class="lf-cmdr" data-artq="${p.id}"><input name="artq" list="lf-dl" data-sug="any" value="${esc(a.q || '')}" placeholder="Busca cualquier carta" maxlength="120" autocomplete="off" aria-label="Buscar ilustración"><button>Buscar</button></form>
      ${!showing ? `<p class="small">${CAS ? 'Pon el comandante para ver sus ilustraciones, o busca cualquier carta.' : 'Busca cualquier carta, o di tu comandante en la página del torneo («Tu mazo y comandante») para ver las suyas.'}</p>`
      : !a.all ? '<p>Buscando ilustraciones…</p>'
      : !a.all.length ? `<p>No encuentro ilustraciones de «${esc(showing)}».</p>`
      : `<p class="small">Ilustraciones de <b>${esc(showing)}</b>${a.q && a.name && a.q !== a.name ? ` · <button type="button" class="link" data-art-back>ver las de ${esc(a.name)}</button>` : ''}. Todos los de la mesa verán la que elijas.</p>
        <div class="lf-arts">${a.all.map(x => `<button data-pick-art="${esc(x.url)}" class="${cur === x.url ? 'on' : ''}" title="${esc(x.set)} · ${esc(x.artist)}"><img src="${esc(x.url)}" alt="" loading="lazy"><span>${esc(x.set)}</span></button>`).join('')}</div>`}
      <button class="lf-noart ${!cur ? 'on' : ''}" data-pick-art="">Sin ilustración (solo color)</button>
      <button class="jbtn big" data-close-art>Hecho</button></div></div>`;
  }
  async function searchArt(pid, q) {
    arts[pid] = { ...(arts[pid] || {}), q, all: null }; render();
    try { const j = await (await fetch(`${B}/vidas/artes.json?q=${encodeURIComponent(q)}`)).json(); arts[pid].q = j.name || q; arts[pid].all = j.all || []; }
    catch (e) { arts[pid].all = []; }
    render();
  }
  // Comprueba el comandante (o la pareja «A + B») contra la base de cartas; sin conexión se acepta tal cual
  async function checkCmd(txt) {
    const out = [];
    for (const part of txt.split(/\s*\+\s*/).filter(Boolean)) {
      let j;
      try { j = await (await fetch(`${B}/vidas/carta.json?cmd=1&q=${encodeURIComponent(part)}`)).json(); } catch (e) { out.push(part); continue; }
      if (j.name) out.push(j.name);
      else if (j.sug && j.sug.length === 1) out.push(j.sug[0].name);
      else return { ok: false, msg: j.sug && j.sug.length ? `«${part}»: ¿cuál de estos?` : `No encuentro «${part}» como comandante.`, sug: (j.sug || []).slice(0, 5).map(x => x.name) };
    }
    return { ok: true, name: out.join(' + ') };
  }
  let exSheet = false, dice = null, raffle = null, survey = null;
  // Encuesta: ¿el mazo de cada rival cuadraba con el bracket del torneo? (lo ve solo la tienda)
  function surveyView() {
    const opts = [['ok', 'Bien'], ['up', 'Más fuerte'], ['down', 'Más flojo']];
    return `<div class="lf-sheet" role="dialog" aria-label="Encuesta de bracket"><div class="lf-sh-in"><h2>¿Cada mazo era del bracket del torneo?</h2>
      <p class="small">Solo lo ve la tienda, para revisar mazos que no cuadran. No hace falta contestar todo.</p>
      ${st.players.filter(p => p.id !== me.id).map(p => `<div class="lf-svr"><span><b>${esc(p.name)}</b>${p.deck ? `<small>${esc(p.deck)}</small>` : ''}</span>
        <div class="lf-seg2">${opts.map(([v, t]) => `<button data-sv="${p.id}" data-v="${v}" class="${survey[p.id] === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>`).join('')}
      <div class="lf-endb"><button class="jbtn big" data-sv-send>Enviar</button><button class="jbtn big ghost" data-sv-close>Ahora no</button></div></div></div>`;
  }
  function exSheetView() {
    const all = [['tax', 'Impuesto de comandante'], ['energy', 'Energía'], ['exp', 'Experiencia'], ['monarch', 'Monarca'], ['init', 'Iniciativa'], ['day', 'Día y noche']];
    return `<div class="lf-sheet" role="dialog" aria-label="Contadores extra"><div class="lf-sh-in"><h2>Contadores extra</h2>
      <p class="small">Activa solo los que uséis. Salen en el panel de cada jugador (toca para cambiarlos) y todos los de la mesa los ven.</p>
      <div class="lf-exl">${all.map(([k, t]) => `<label class="lf-chk"><input type="checkbox" data-exk="${k}" ${exOn(k) ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>
      <button class="jbtn big" data-close-ex>Hecho</button></div></div>`;
  }
  function diceView() {
    return `<div class="lf-sheet" role="dialog" aria-label="Dados"><div class="lf-sh-in lf-dice"><h2>Dados y moneda</h2>
      <div class="lf-dres ${dice && dice.rolling ? 'rolling' : ''}" aria-live="polite">${dice ? esc(dice.v) : '—'}</div>
      <div class="lf-turns"><button data-roll="20">d20</button><button data-roll="6">d6</button><button data-roll="coin">Moneda</button></div>
      <button class="jbtn big" data-close-dice>Cerrar</button></div></div>`;
  }
  function roll(k) {
    const pick = () => (k === 'coin' ? (Math.random() < 0.5 ? 'Cara' : 'Cruz') : String(1 + Math.floor(Math.random() * Number(k))));
    let n = 0; dice = { v: pick(), rolling: true }; render();
    const it = setInterval(() => {
      n++; const el = root.querySelector('.lf-dres'); if (el) el.textContent = pick();
      if (n >= 12) { clearInterval(it); dice = { v: pick(), rolling: false }; if (navigator.vibrate) navigator.vibrate(20); render(); }
    }, 70);
  }
  // Sorteo de quién empieza: va pasando por los paneles, frena y se queda en uno
  function runRaffle() {
    const alive = ring().filter(p => !p.out);
    if (!alive.length || raffle) return;
    const win = alive[Math.floor(Math.random() * alive.length)];
    const steps = alive.length * 3 + alive.indexOf(win);
    turnSheet = false; render();
    let i = 0;
    raffle = true;
    const tick = () => {
      root.querySelectorAll('.lf-p.raffle').forEach(e => e.classList.remove('raffle'));
      const el = root.querySelector(`.lf-p[data-pid="${alive[i % alive.length].id}"]`); if (el) el.classList.add('raffle');
      if (i >= steps) {
        raffle = null;
        if (navigator.vibrate) navigator.vibrate([30, 40, 60]);
        setTimeout(() => act({ op: 'turn', pid: win.id }, () => { st.turn = { pid: win.id, n: 1, lap: 1, played: [win.id], at: Date.now() + skew }; }), 700);
        return;
      }
      i++;
      setTimeout(tick, 70 + Math.pow(i / steps, 3) * 380);
    };
    tick();
  }
  // Turnos extra cuando se acaba el tiempo de ronda (solo torneo)
  function otInfo() {
    if (CAS || !info.extraTurns || !st.turn) return null;
    const c = clockTxt();
    if (st.ot) { const k = st.turn.n - st.ot.base; return { k, of: info.extraTurns, over: k > info.extraTurns }; }
    return c && c.over ? { k: 0, of: info.extraTurns } : null;
  }
  const otTag = () => { const o = otInfo(); if (!o) return '';
    return `<span class="lf-combo ${o.over ? 'no' : 'ot'}">${o.k === 0 ? `Tiempo: acaba este turno y quedan ${o.of} extra` : o.over ? 'Sin turnos extra: se acaba la partida' : `Turno extra ${o.k} de ${o.of}`}</span>`; };
  // Tarjeta para compartir el resultado
  async function shareCard() {
    const W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const alive = st.players.filter(p => !p.out);
    const order = st.done ? st.done.order.map(id => st.players.find(p => p.id === id)) : [...alive, ...st.players.filter(p => p.out).sort((a, b) => b.ord - a.ord)];
    const win = order[0];
    g.fillStyle = '#0d0d0d'; g.fillRect(0, 0, W, H);
    const art = artOf(win);
    let hasArt = false;
    if (art) {
      try {
        const img = await new Promise((ok, ko) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = ko; im.src = art; setTimeout(ko, 4000); });
        const r = Math.max(W / img.width, 620 / img.height); g.drawImage(img, (W - img.width * r) / 2, 0, img.width * r, img.height * r); hasArt = true;
      } catch (e) { /* sin ilustración */ }
    }
    const gr = g.createLinearGradient(0, 200, 0, 640); gr.addColorStop(0, 'rgba(13,13,13,0)'); gr.addColorStop(1, '#0d0d0d'); g.fillStyle = gr; g.fillRect(0, 0, W, 640);
    g.fillStyle = '#f47700'; g.fillRect(0, 0, W, 14);
    const font = (w, px) => `${w} ${px}px Inter, Roboto, "Segoe UI", Arial, sans-serif`;
    const fit = (txt, w, px, max) => { let s = px; g.font = font(w, s); while (g.measureText(txt).width > max && s > 20) { s -= 2; g.font = font(w, s); } return s; };
    const dy = hasArt ? 0 : -300 + Math.max(0, (6 - order.length) * 40);
    g.fillStyle = '#fff'; fit(`¡${win.name} gana!`, 800, 92, W - 120); g.fillText(`¡${win.name} gana!`, 60, 560 + dy);
    if (win.deck) { g.fillStyle = '#f47700'; fit(win.deck, 600, 40, W - 120); g.fillText(win.deck, 60, 620 + dy); }
    let y = 720 + dy;
    order.forEach((p, i) => {
      g.fillStyle = i ? '#1c1c1c' : '#2a1600'; g.fillRect(60, y - 52, W - 120, 96);
      g.fillStyle = i ? '#999' : '#f47700'; g.font = font(800, 44); g.fillText(`${i + 1}º`, 90, y + 12);
      g.fillStyle = '#fff'; fit(p.name, 700, 40, 520); g.fillText(p.name, 190, y);
      g.fillStyle = '#aaa'; const sub = [p.deck, p.out ? (p.killer ? `eliminado por ${nameOfRaw(p.killer)}` : (HOW[p.how] || 'eliminado')) : `${p.life} vidas`].filter(Boolean).join(' · ');
      fit(sub, 400, 26, W - 260); g.fillText(sub, 190, y + 34);
      y += 116;
    });
    const t0 = st.startedAt, t1 = (st.done && st.done.at) || Date.now();
    const meta = [t0 ? `Duración ${mmss(t1 - t0).replace(/^(\d+):(\d+)$/, (m, a, b) => (a >= 60 ? `${Math.floor(a / 60)} h ${a % 60} min` : `${a} min`))}` : '', st.turn ? `${st.turn.lap || 1} ${(st.turn.lap || 1) === 1 ? 'vuelta' : 'vueltas'}` : ''].filter(Boolean).join(' · ');
    g.fillStyle = '#bbb'; g.font = font(500, 30); g.fillText(meta, 60, H - 110);
    g.fillStyle = '#f47700'; g.font = font(800, 34); g.fillText((window.__STORE || 'Júpiter Juegos'), 60, H - 56);
    g.fillStyle = '#777'; g.font = font(500, 26); const tag = 'Contador de vidas'; g.fillText(tag, W - 60 - g.measureText(tag).width, H - 56);
    const blob = await new Promise(ok => { try { c.toBlob(ok, 'image/png'); } catch (e) { ok(null); } });
    if (!blob) { err = 'No se pudo crear la imagen'; render(); return; }
    const file = new File([blob], 'partida.png', { type: 'image/png' });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: `¡${win.name} gana!` }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'partida.png'; document.body.appendChild(a); a.click(); a.remove();
  }
  const nameOfRaw = pid => ((st.players.find(p => p.id === Number(pid))) || {}).name || '—';
  function statsView() {
    const ts = st.tstats || {};
    const rows = st.players.filter(p => ts[p.id] && ts[p.id].n).map(p => { const t = ts[p.id]; return `<tr><td>${esc(p.name)}</td><td>${t.n}</td><td>${mmss(t.ms / t.n)}</td><td>${mmss(t.max)}</td><td>${mmss(t.ms)}</td></tr>`; });
    return rows.length ? `<h3>Tiempo por jugador</h3><table class="lf-ts"><thead><tr><th></th><th>Turnos</th><th>Media</th><th>Más largo</th><th>Total</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '';
  }
  function turnSheetView() {
    const alive = st.players.filter(p => !p.out).sort((a, b) => a.seat - b.seat);
    return `<div class="lf-sheet" role="dialog" aria-label="Turnos"><div class="lf-sh-in"><h2>${st.turn ? '¿De quién es el turno?' : '¿Quién empieza?'}</h2>
      <p class="small">«Pasar turno» va al siguiente en el sentido de las agujas del reloj, según estéis colocados en la pantalla. La vuelta sube cuando vuelve a tocarle a quien ya ha jugado${info.comboLap ? `. ${esc(comboRule())}` : ''}.</p>
      ${!st.turn ? '<button class="jbtn big lf-raf" data-raffle>Sortear quién empieza</button>' : ''}
      <div class="lf-turns">${alive.map(p => `<button data-turn-to="${p.id}" class="${st.turn && st.turn.pid === p.id ? 'on' : ''}">${esc(p.name)}</button>`).join('')}</div>
      ${st.turn ? `<div class="lf-row"><span>Vuelta</span><button data-lap="-1">−</button><b>${st.turn.lap || 1}</b><button data-lap="1">+</button></div>` : ''}
      ${statsView()}
      ${st.turn ? '<button class="lf-noart" data-turn-off>Quitar los turnos</button>' : ''}
      <button class="jbtn big" data-close-turn>Cerrar</button></div></div>`;
  }
  const hhmmss = t => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  async function loadHist() {
    if (CAS) { hist = (st.hist || []).slice(); render(); return; }
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
        ${mine() && !store.get(`mt_vote_${pod.id}`) ? '<button class="jbtn big lf-raf" data-survey>¿Los mazos eran del bracket? (10 s)</button>' : ''}
        <button class="link" data-share>Compartir imagen</button><a href="${B}/commander/${id}">Volver al torneo</a></div>`;
    }
    if (alive.length === 1 && !st.players.some(p => dead(p) && !dismissed.has(p.id))) {
      return `<div class="lf-end"><b>¡${esc(alive[0].name)} gana ${CAS ? 'la partida' : 'la mesa'}!</b><span>${[alive[0], ...st.players.filter(p => p.out).sort((a, b) => b.ord - a.ord)].map((p, i) => `${i + 1}º ${esc(p.name)}`).join(' · ')}</span>
        ${CAS ? (S.league ? (st.league ? `<p class="small">Registrada para la liga: <a href="${esc(st.league)}" target="_blank" rel="noopener">confirmadla cada uno</a></p>` : '<button class="jbtn big lf-raf" data-league>Registrar para la liga casual</button>') : '') + '<div class="lf-endb"><button class="jbtn big" data-rematch>Revancha</button><button class="jbtn big ghost" data-new>Cambiar jugadores</button><button class="jbtn big ghost" data-share>Compartir</button></div>'
        : mine() ? '<button class="jbtn big" data-finish="">Enviar resultado</button>' : '<small>Uno de la mesa tiene que enviar el resultado.</small>'}</div>`;
    }
    if (st.sudden) {
      return `<div class="lf-end sudden"><span><b>Muerte súbita:</b> el primer daño de un rival elimina. Pagar vidas o dañarte a ti mismo no mata.</span>${mine() ? '<button class="link" data-sudden="0">Quitar</button>' : ''}</div>`;
    }
    return '';
  }

  // Apaisado: si el móvil está en vertical, se gira todo 90º (se juega con el móvil de lado en el centro de la mesa)
  function sizeVars() {
    const w = window.innerWidth, h = window.innerHeight;
    const turn = turnPref && h > w && !!st; // la pantalla de preparar la partida no se gira
    root.style.setProperty('--vw', (turn ? h : w) + 'px');
    root.style.setProperty('--vh', (turn ? w : h) + 'px');
    root.classList.toggle('turn', turn);
  }
  window.addEventListener('resize', sizeVars);
  window.addEventListener('orientationchange', () => setTimeout(sizeVars, 150));

  function render() {
    // Si se está escribiendo en un campo, se conserva al repintar (llegan cambios en directo mientras tanto)
    const ae = document.activeElement;
    if (ae && ae.name && root.contains(ae) && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) {
      const keep = { name: ae.name, v: ae.value, a: ae.selectionStart, b: ae.selectionEnd };
      draw();
      const el = root.querySelector(`[name="${keep.name}"]`);
      if (el) { el.value = keep.v; el.focus(); try { el.setSelectionRange(keep.a, keep.b); } catch (e) { /* nada */ } }
      return;
    }
    draw();
  }
  function draw() {
    sizeVars();
    if (!pod) { root.innerHTML = pickPodView(); return; }
    if (!st && CAS) { root.innerHTML = setupView(); bindSetup(); return; }
    if (!st) { root.innerHTML = `<div class="lf-pick"><p>Cargando la mesa ${pod.table}…</p>${err ? `<p class="lf-note">${esc(err)}</p>` : ''}<a class="lf-back" href="${B}/commander/${id}">← Volver al torneo</a></div>`; return; }
    const n = st.players.length;
    const topN = topNOf(n);
    const ps = ordered();
    const top = ps.slice(0, topN), bot = ps.slice(topN);
    const rotd = (p, def) => (p.id in lay.rot ? lay.rot[p.id] : def);
    const canPlay = mine() && !st.done && !arrange;
    root.innerHTML = `<div class="lf n${n} ${st.sudden ? 'is-sudden' : ''} ${arrange ? 'is-arr' : ''}">
      <div class="lf-bar"><a href="${home}" aria-label="Volver">←</a><span>${CAS ? (room ? `Sala ${room}` : 'Partida casual') : `Mesa ${pod.table}`}${info.round ? ` · ronda ${info.round}` : ''}${!mine() ? ' · mirando' : ''}</span>
        ${clockTxt() ? `<time class="lf-clock ${clockTxt().over ? 'over' : ''}" data-rc title="Tiempo de ronda">${clockTxt().t}</time>` : ''}
        <i class="lf-live" title="En directo"></i>
        ${arrange ? '<button data-arr-reset>Como al principio</button><button data-arr-done class="hot">Listo</button>'
        : `${canPlay ? (st.turn ? '<button data-pass class="go">Pasar turno</button>' : '<button data-turns>Turnos</button>') : ''}${exOn('day') ? `<button data-daynight class="dn">${st.day === 'night' ? '☾ Noche' : st.day === 'day' ? '☀ Día' : 'Día/noche'}</button>` : ''}${!CAS && canPlay ? `<button data-judge class="${info.judge ? 'hot' : ''}">${info.judge ? 'Juez avisado' : 'Juez'}</button>` : ''}<button data-hist>Historial</button>${CAS ? '<button data-reset>Reiniciar</button>' : ''}<button data-menu aria-expanded="${menu}">Opciones</button>`}</div>
      ${menu ? `<div class="lf-menu"><button data-arrange>Colocar jugadores</button><button data-exsheet>Contadores extra</button><button data-dice>Dados y moneda</button>${canPlay ? `<button data-turns>${st.turn ? 'Corregir el turno' : 'Empezar turnos'}</button>` : ''}<button data-turn>${turnPref ? 'Usar en vertical' : 'Usar apaisado'}</button>${document.fullscreenEnabled ? '<button data-full>Pantalla completa</button>' : ''}<button data-rot>${rot ? 'No girar los de enfrente' : 'Girar los de enfrente'}</button>
        ${canPlay && !st.sudden ? '<button data-sudden="1" class="hot">Muerte súbita</button>' : ''}${mine() && !st.done && !CAS ? '<button data-reset class="danger">Reiniciar contador</button>' : ''}${st.done && mine() && !info.reported ? '<button data-reopen>Reabrir la mesa</button>' : ''}
        ${installEv ? '<button data-install>Instalar como app</button>' : ''}${CAS ? `<button data-new>Cambiar jugadores</button>${room ? '<button data-roomsh>Compartir partida (código)</button>' : '<button data-share-room>Compartir con otros móviles</button>'}` : '<button data-whoami>Cambiar quién soy</button>'}
        <p class="small">Para que la pantalla no se apague y se vea a pantalla completa, instálalo: ${/iPhone|iPad|iPod/.test(navigator.userAgent) ? 'botón Compartir › «Añadir a pantalla de inicio» (no funciona en modo privado)' : 'menú del navegador › «Añadir a pantalla de inicio»'}.</p></div>` : ''}
      ${!mine() ? whoView() : ''}
      ${err ? `<div class="lf-err" role="alert">${esc(err)}</div>` : ''}
      ${arrange ? '<div class="lf-arrtip">Toca un jugador y luego el sitio donde lo quieres. Solo cambia en este aparato.</div>' : ''}
      <div class="lf-grid">${top.length ? `<div class="lf-r top">${top.map(p => panel(p, st.players.indexOf(p), rotd(p, true))).join('')}</div>` : ''}<div class="lf-r">${(topN ? bot.slice().reverse() : bot).map(p => panel(p, st.players.indexOf(p), rotd(p, false))).join('')}</div></div>
      ${arrange ? '' : endView()}${sheet ? sheetView() : ''}${artSheet ? artSheetView() : ''}${hist ? histView() : ''}${turnSheet ? turnSheetView() : ''}${exSheet ? exSheetView() : ''}${survey ? surveyView() : ''}${roomInfo ? roomView() : ''}${league ? leagueView() : ''}${dice ? diceView() : ''}${asking ? askView() : ''}</div>`;
    bind();
  }
  function bindSetup() {
    const jf = root.querySelector('[data-join]');
    if (jf) jf.onsubmit = async e => { e.preventDefault(); const c = jf.code.value.toUpperCase().replace(/[^A-Z]/g, ''); if (c.length !== 4) return;
      room = c; roomVer = 0; store.set('mt_life_room', c); await load(true); if (room) { liveRoom(); loadArts(); } };
    const f = root.querySelector('[data-setup]');
    f.querySelectorAll('input[name=n]').forEach(r => { r.onchange = () => f.querySelectorAll('.lf-name').forEach(d => { d.hidden = Number(d.dataset.i) >= Number(r.value); }); });
    f.addEventListener('click', e => { const b = e.target.closest('[data-fill]'); if (!b) return; const i = b.dataset.fill; f['c' + i].value = b.dataset.v; const er = f.querySelector(`[data-cerr="${i}"]`); er.hidden = true; });
    f.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(f), n = Number(fd.get('n')) || 4, start = Number(fd.get('start')) || 40;
      const names = [0, 1, 2, 3, 4, 5].map(i => String(fd.get('p' + i) || '').trim()), cmds = [0, 1, 2, 3, 4, 5].map(i => String(fd.get('c' + i) || '').trim());
      const btn = f.querySelector('.jbtn'); btn.disabled = true; btn.textContent = 'Comprobando comandantes…';
      let bad = false;
      for (let i = 0; i < n; i++) {
        const er = f.querySelector(`[data-cerr="${i}"]`); er.hidden = true;
        if (!cmds[i]) continue;
        const r = await checkCmd(cmds[i]);
        if (r.ok) { cmds[i] = r.name; f['c' + i].value = r.name; continue; }
        bad = true; er.hidden = false;
        er.innerHTML = `${esc(r.msg)}${r.sug.length ? `<span class="lf-sugs">${r.sug.map(x => `<button type="button" data-fill="${i}" data-v="${esc(x)}">${esc(x)}</button>`).join('')}</span>` : ''}`;
      }
      btn.disabled = false; btn.textContent = 'Empezar partida';
      if (bad) return;
      store.set('mt_life_casual_cfg', JSON.stringify({ n, start, names, cmds, combo: !!fd.get('combo') }));
      st = { casual: true, startedAt: Date.now(), start, combo: fd.get('combo') ? 5 : 0, done: null, turn: null, tstats: {}, sudden: false, log: [], hist: [],
        players: Array.from({ length: n }, (_, i) => ({ id: i + 1, seat: i + 1, name: names[i] || `Jugador ${i + 1}`, deck: cmds[i], life: start, poison: 0, cmd: {}, out: false, killer: null, how: null, ord: null })) };
      info = casInfo();
      lay = { order: [], rot: {} }; saveLay(); arts = {}; dismissed.clear();
      saveCas(); render(); loadArts();
      if (room) pushRoom(); else if (fd.get('share')) makeRoom();
    };
  }
  // Confirmaciones dentro de la página: el confirm() del navegador, en iPhone, ofrece «Eliminar cuadros de diálogo» y luego ya no deja confirmar nada
  let asking = null;
  function ask(text, yes, fn, alt) { menu = false; asking = { text, yes, fn, alt }; render(); }
  const askView = () => `<div class="lf-sheet lf-ask" role="alertdialog" aria-label="${esc(asking.text)}"><div class="lf-sh-in"><p>${esc(asking.text)}</p>
    <div class="lf-endb"><button class="jbtn big" data-ask-yes>${esc(asking.yes)}</button>${asking.alt ? `<button class="jbtn big alt" data-ask-alt>${esc(asking.alt.label)}</button>` : ''}<button class="jbtn big ghost" data-ask-no>Cancelar</button></div></div></div>`;
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
    const newGame = () => { st = null; hist = null; saveCas(); render(); };
    on('[data-reset]', () => (CAS
      ? ask('¿Cómo quieres reiniciar?', `Mismos jugadores (${st.start} vidas)`, () => act({ op: 'reset' }), { label: 'Partida nueva (elegir jugadores y vidas)', fn: newGame })
      : ask('¿Reiniciar el contador de esta mesa? Se borran vidas y eliminaciones.', 'Reiniciar', () => act({ op: 'reset' }))));
    on('[data-reopen]', () => { menu = false; act({ op: 'reopen' }); });
    on('[data-sudden]', b => { const on = b.dataset.sudden === '1'; const go = () => act({ op: 'sudden', on: on ? 1 : 0 }, () => { st.sudden = on; });
      if (on) ask('¿Pasar a muerte súbita? El primer daño de un rival elimina.', 'Muerte súbita', go); else { menu = false; go(); } });
    on('[data-finish]', () => act({ op: 'finish' }));
    on('[data-rematch]', () => act({ op: 'reset' }));
    on('[data-new]', () => ask('¿Empezar otra partida con otros jugadores? Se borra la actual.', 'Cambiar jugadores', newGame));
    on('[data-ask-no]', () => { asking = null; render(); });
    on('[data-survey]', () => { survey = {}; render(); });
    on('[data-sv]', b => { survey[b.dataset.sv] = b.dataset.v; render(); });
    on('[data-sv-close]', () => { survey = null; render(); });
    on('[data-sv-send]', async () => { const v = survey; survey = null; store.set(`mt_vote_${pod.id}`, '1'); render();
      try { await post({ op: 'vote', votes: JSON.stringify(v) }); } catch (e) { err = e.message; render(); } });
    on('[data-share-room]', () => { menu = false; makeRoom(); });
    on('[data-roomsh]', () => { menu = false; showRoom(); });
    on('[data-close-room]', () => { roomInfo = null; render(); });
    on('[data-leave-room]', () => ask('¿Salir de la sala? Sigues con la partida en este móvil, pero ya no se sincroniza.', 'Salir', () => leaveRoom()));
    on('[data-league]', () => registerLeague());
    on('[data-close-league]', () => { league = null; render(); });
    on('[data-exsheet]', () => { menu = false; exSheet = true; render(); });
    on('[data-close-ex]', () => { exSheet = false; render(); });
    root.querySelectorAll('[data-exk]').forEach(cb => { cb.onchange = () => {
      const on = [...root.querySelectorAll('[data-exk]')].filter(x => x.checked).map(x => x.dataset.exk).join(',');
      const b = { op: 'extras', on }; act(b, () => mut(b));
    }; });
    on('[data-holder]', b => { const x = { op: 'holder', key: b.dataset.holder, pid: b.dataset.hp }; act(x, () => mut(x)); });
    on('[data-daynight]', () => { const x = { op: 'day', v: st.day === 'day' ? 'night' : 'day' }; act(x, () => mut(x)); });
    on('[data-dice]', () => { menu = false; dice = { v: '—' }; render(); });
    on('[data-close-dice]', () => { dice = null; render(); });
    on('[data-roll]', b => roll(b.dataset.roll));
    on('[data-raffle]', () => runRaffle());
    on('[data-share]', () => shareCard());
    on('[data-judge]', () => (info.judge
      ? ask('¿Ya no hace falta el juez? Se quita el aviso.', 'Quitar aviso', () => act({ op: 'judge', on: 0 }, () => { info.judge = null; }))
      : ask('¿Llamar a un juez a esta mesa? Le sale el aviso a la tienda.', 'Llamar a juez', () => act({ op: 'judge', on: 1 }, () => { info.judge = { at: Date.now() }; }))));
    on('[data-ask-yes]', () => { const a = asking; asking = null; a.fn(); render(); });
    on('[data-ask-alt]', () => { const a = asking; asking = null; a.alt.fn(); render(); });
    root.querySelectorAll('[data-cmdr]').forEach(f => { f.onsubmit = async e => {
      e.preventDefault(); const p = st.players.find(x => x.id === Number(f.dataset.cmdr)); const v = f.cmdr.value.trim();
      if (!v) { p.deck = ''; cmdMsg = null; saveCas(); arts[p.id] = {}; render(); return; }
      const r = await checkCmd(v);
      if (!r.ok) { cmdMsg = { pid: p.id, msg: r.msg, sug: r.sug }; render(); return; }
      cmdMsg = null; p.deck = r.name; p.art = null; p.artOff = false; saveCas(); arts[p.id] = { name: r.name }; render(); loadArts(p.id);
    }; });
    on('[data-cmd-sug]', b => { const f = root.querySelector('[data-cmdr]'); f.cmdr.value = b.dataset.cmdSug; cmdMsg = null; f.requestSubmit(); });
    root.querySelectorAll('[data-artq]').forEach(f => { f.onsubmit = e => { e.preventDefault(); const q = f.artq.value.trim(); if (q) searchArt(Number(f.dataset.artq), q); }; });
    on('[data-art-back]', () => { const a = arts[artSheet]; a.q = null; a.all = null; render(); loadArts(artSheet); });
    on('[data-sheet]', b => { sheet = Number(b.dataset.sheet); render(); });
    on('[data-close]', () => { sheet = null; render(); });
    on('[data-art]', b => { artSheet = Number(b.dataset.art); render(); loadArts(artSheet); });
    on('[data-close-art]', () => { artSheet = null; cmdMsg = null; render(); });
    on('[data-hist]', () => { hist = []; render(); loadHist(); });
    on('[data-close-hist]', () => { hist = null; render(); });
    on('[data-undo]', b => act({ op: 'undo', id: b.dataset.undo }).then(loadHist));
    on('[data-pick-art]', b => { const p = st.players.find(x => x.id === artSheet); const url = b.dataset.pickArt;
      act({ op: 'art', pid: p.id, art: url }, () => { p.art = url || null; p.artOff = !url; }); });
    root.querySelectorAll('.lf-sheet [data-op]').forEach(b => { b.onclick = () => {
      const p = st.players.find(x => x.id === Number(b.dataset.pid)), d = Number(b.dataset.d);
      if (b.dataset.op === 'extra') { const x = { op: 'extra', pid: p.id, key: b.dataset.key, d }; const o = (p.x || {})[x.key] || 0; mut(x); x.rd = ((p.x || {})[x.key] || 0) - o; act(x); }
      else if (b.dataset.op === 'cmd') { const f = Number(b.dataset.from), cur = p.cmd[f] || 0, nv = Math.max(0, cur + d); p.cmd[f] = nv; p.life -= nv - cur; act({ op: 'cmd', pid: p.id, from: f, d, rd: nv - cur }); }
      else { const o = p.poison; p.poison = Math.max(0, p.poison + d); act({ op: 'poison', pid: p.id, d, rd: p.poison - o }); }
      if (navigator.vibrate) navigator.vibrate(6);
    }; });
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
      act({ op: 'turn', pid }, () => { st.turn = st.turn ? { ...st.turn, pid, n: st.turn.n + 1, played: [...new Set([...(st.turn.played || []), pid])], at: Date.now() + skew } : { pid, n: 1, lap: 1, played: [pid], at: Date.now() + skew }; }); });
    on('[data-turn-off]', () => { turnSheet = false; act({ op: 'turnoff' }, () => { st.turn = null; }); });
    on('[data-pass]', () => { const to = nextPid(); act({ op: 'turn', to }, () => { nextTurn(to); if (navigator.vibrate) navigator.vibrate(15); }); });
    on('[data-lap]', b => act({ op: 'lap', lap: (st.turn.lap || 1) + Number(b.dataset.lap) }, () => { st.turn.lap = Math.max(1, (st.turn.lap || 1) + Number(b.dataset.lap)); }));
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
  // Sugerencias de cartas mientras se escribe (comandante o cualquier carta para el fondo)
  const dl = document.createElement('datalist'); dl.id = 'lf-dl'; document.body.appendChild(dl);
  let sugT = null;
  root.addEventListener('input', e => {
    const el = e.target; if (!el.dataset || !el.dataset.sug) return;
    clearTimeout(sugT);
    const q = el.value.split('+').pop().trim();
    if (q.length < 3) return;
    sugT = setTimeout(async () => {
      try {
        const j = await (await fetch(`${B}/vidas/carta.json?q=${encodeURIComponent(q)}${el.dataset.sug === 'cmd' ? '&cmd=1' : ''}`)).json();
        const pre = el.value.includes('+') ? el.value.slice(0, el.value.lastIndexOf('+') + 1) + ' ' : '';
        dl.innerHTML = [...new Set([j.name, ...(j.sug || []).map(x => x.name)].filter(Boolean))].map(n => `<option value="${esc(pre + n)}">`).join('');
      } catch (er) { /* sin sugerencias */ }
    }, 250);
  });
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEv = e; });
  // Reloj del turno (sin repintar todo)
  setInterval(() => {
    const t = root.querySelector('[data-tt]'); if (t && st && st.turn) { t.textContent = mmss(Date.now() + skew - st.turn.at); t.parentNode.classList.toggle('slow', slowT()); }
    const c = root.querySelector('[data-rc]'), k = clockTxt(); if (c && k) { c.textContent = k.t; c.classList.toggle('over', k.over); }
  }, 1000);
  if (pod) loadLay();
  wake();
  render();
  if (CAS) { load(true).then(() => { loadArts(); if (room) liveRoom(); }); setInterval(() => { if (room && (!roomEs || roomEs.readyState !== 1)) load(false); }, 3000); }
  else if (pod) {
    load(true).then(() => loadArts());
    live();
    setInterval(() => { if (!es || es.readyState !== 1) load(false); }, 2000);
    setInterval(() => load(false), 15000);
  }
})();
