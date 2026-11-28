(function () {
  const root = document.getElementById('cmd');
  if (!root) return;
  const { esc, norm, store, livebar, tickClocks, tabs, seg, formDots, podium, whoami, findPlayer } = window.UI;
  const id = root.dataset.id;
  const B = window.__BASE || '';
  let snap = window.__CSNAP;
  const state = { tab: store.get('mt_ctab') || 'pods', view: 'pods', filter: '', roundSel: null, me: null, order: {}, pickWin: {} };

  function resolveMe() {
    // Con sesión iniciada, la web ya sabe quién eres (salvo que pulses «Cambiar»)
    const acc = window.__ME;
    if (acc && !state.noAuto) { const m = snap.roster.find(p => p.pkey && p.pkey === acc.key); if (m) return m; }
    const saved = store.get('mt_me_user');
    if (!saved) return null;
    return snap.roster.find(p => norm(p.username) === norm(saved) || norm(p.name) === norm(saved)) || null;
  }
  state.me = resolveMe();
  const isMe = pid => state.me && state.me.id === pid;
  const stOf = pid => snap.standings.find(s => s.id === pid);
  const turn = n => (n === 1 ? 'Empieza' : `Turno ${n}`);
  const formChip = f => (f.res === '?' ? '·' : f.res === 'D' ? 'E' : f.place && snap.scoring === 'places' ? `${f.place}º` : f.got ? `+${f.got}` : '0');
  const byPlaces = () => snap.scoring === 'places';
  const winPts = size => (size >= 4 ? snap.pts.win4 : snap.pts.win3);
  const podPts = size => (byPlaces() ? snap.pts.places.slice(0, size).join('-') + ' pts' : `+${winPts(size)} al ganador`);

  function meCard() {
    if (!snap.roster.length) return '';
    if (!state.me) return `<section class="me-card empty">${whoami(snap.roster, '', 'cmd-roster', snap.status === 'finished' ? 'Ver mi resultado' : 'Ver mi mesa')}</section>`;
    const me = state.me;
    const st = stOf(me.id);
    const pod = snap.pods.find(p => p.players.some(x => x.id === me.id));
    let main = '';
    if (snap.status === 'setup') {
      main = '<div class="me-big ok">Apuntado ✔</div><div class="me-sub">Tu mesa aparecerá aquí al empezar.</div>';
    } else if (pod && snap.status !== 'finished') {
      const mine = pod.players.find(x => x.id === me.id);
      let status = '<span class="chip live">Jugando</span>';
      if (pod.reported) {
        status = pod.draw ? `<span class="chip draw">Empate · +${mine.got}</span>`
          : byPlaces() ? `<span class="chip ${mine.place === 1 ? 'win' : 'loss'}">${mine.place ? `Quedaste ${mine.place}º` : 'Sin puesto'} · +${mine.got}</span>`
          : pod.winner === me.id ? `<span class="chip win">¡Ganaste! +${mine.got}</span>`
          : `<span class="chip loss">Ganó ${esc((pod.players.find(x => x.id === pod.winner) || {}).name || '')}</span>`;
      }
      main = `<div class="me-table"><span>Mesa</span><b>${pod.table}</b></div>
        <div class="me-vs"><small>${snap.roundKind === 'final' ? 'Mesa final' : `Ronda ${snap.round}`} · ${mine.seat === 1 ? 'empiezas tú' : `tu turno: ${mine.seat}º de ${pod.size}`}</small>
        <div class="me-rivals">${pod.players.filter(x => x.id !== me.id).map(x => `<span>${turn(x.seat)} · <b>${esc(x.name)}</b> <em>${x.pts} pts${x.deck ? ' · ' + esc(x.deck) : ''}</em></span>`).join('')}</div>${status}</div>`;
      if (!pod.reported && snap.status === 'running') {
        const lv = pod.life ? Object.values(pod.life).filter(x => !x.out).length : 0;
        main += `<a class="lifebtn" href="${B}/commander/${id}/vidas?mesa=${pod.id}">${pod.life ? `Contador de vidas · <b>${lv} en pie</b>` : 'Abrir contador de vidas'}</a>`;
      }
      if (!pod.reported && snap.selfReport && byPlaces()) {
        const nm = id => esc((pod.players.find(x => x.id === id) || {}).name || '');
        const ord = state.order[pod.id] || [];
        const sent = pod.proposed ? (pod.proposedDraw ? 'empate' : (pod.proposedOrder || [pod.proposedWinner]).map((id, i) => `${i + 1}º ${nm(id)}`).join(' · ')) : '';
        const left = pod.players.filter(x => !ord.includes(x.id));
        const full = ord.length >= pod.size - 1;
        main += `<div class="report">${pod.proposed ? `<div class="report-sent">Enviado: <b>${sent}</b>. Falta que lo confirme la tienda. Si hay un error, vuelve a enviarlo.</div>` : ''}
          <div class="report-h">¿Cómo quedó tu mesa? Toca a los jugadores del 1º al último.</div>
          <ol class="slots">${Array.from({ length: pod.size }, (_, i) => { const pid = ord[i] != null ? ord[i] : (full && i === pod.size - 1 && left[0] ? left[0].id : null);
            return `<li class="${pid ? 'set' : ''} ${i === ord.length && !full ? 'next' : ''}"><b>${i + 1}º</b>${pid ? `<button data-place="${pid}" data-pod="${pod.id}" aria-label="Quitar ${nm(pid)} y los siguientes">${nm(pid)}<span aria-hidden="true">×</span></button>` : '<span>—</span>'}</li>`; }).join('')}</ol>
          ${!full ? `<div class="report-b">${left.map(x => `<button data-place="${x.id}" data-pod="${pod.id}">${esc(x.name)}</button>`).join('')}</div>` : ''}
          ${ord.length ? `<div class="report-go">${full ? `<button data-send-order="${pod.id}" class="jbtn big">Enviar resultado</button>` : ''}<button data-reset-order="${pod.id}" class="linkbtn">Empezar de nuevo</button></div>` : ''}
          <div class="report-msg" id="rep-msg" role="alert"></div></div>`;
      } else if (!pod.reported && snap.selfReport) {
        const nm = id => esc((pod.players.find(x => x.id === id) || {}).name || '');
        const pick = state.pickWin[pod.id];
        main += `<div class="report">${pod.proposed ? `<div class="report-sent">Enviado: <b>${pod.proposedDraw ? 'empate' : 'ganó ' + nm(pod.proposedWinner)}</b>. Falta que lo confirme la tienda. Si hay un error, vuelve a enviarlo.</div>` : ''}
          <div class="report-h">¿Quién ganó tu mesa?</div>
          <div class="report-b">${pod.players.map(x => `<button data-pickwin="${x.id}" data-pod="${pod.id}" class="${pick === x.id ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div>
          ${pick ? `<div class="report-go"><button data-report="${pick}" data-pod="${pod.id}" class="jbtn big">Enviar: ganó ${nm(pick)}</button></div>` : ''}
          <div class="report-msg" id="rep-msg" role="alert"></div></div>`;
      }
    } else if (snap.status === 'finished') {
      main = `<div class="me-table"><span>Puesto</span><b>${st ? st.rank : '—'}</b></div><div class="me-vs"><small>Resultado final</small><strong>${st ? st.points + ' puntos' : ''}</strong>${st && st.champion ? '<span class="chip win">Campeón</span>' : ''}</div>`;
    }
    return `<section class="me-card">
      <div class="me-head"><span>Tú: <b>${esc(me.name)}</b></span><button class="link" id="me-change">Cambiar</button></div>
      <div class="me-main">${main}</div>
      ${(() => { const rp = snap.roster.find(p => p.id === me.id) || {}; return snap.tg && snap.status !== 'finished' && rp.pkey
    ? `<a class="tgbtn" href="${B}/avisos/${encodeURIComponent(rp.pkey)}?n=${encodeURIComponent(me.name)}" target="_blank" rel="noopener">${window.UI.bell}Avísame de mi mesa por Telegram</a>` : ''; })()}
      ${snap.status !== 'finished' ? pushUI() : ''}
      ${snap.status === 'running' ? '<details class="me-more"><summary>Tu mazo y comandante</summary>' : ''}
      ${snap.status !== 'finished' ? (() => {
        const v = (snap.roster.find(p => p.id === me.id) || {}).value;
        const over = v != null && snap.budget && v > snap.budget;
        return `<div class="deckrow"><span>${snap.budget ? 'Tu mazo para el presupuesto' : 'Valor de tu mazo'}: <b>${v != null ? (v / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' }) : 'sin validar'}</b></span>
          ${snap.budget ? `<span class="chip ${over ? 'loss' : v != null ? 'win' : ''} sm">Presupuesto ${(snap.budget / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}</span>` : ''}
          ${(() => { const b = (snap.roster.find(p => p.id === me.id) || {}).bracket; if (b == null && !snap.bracketMax) return '';
            const ob = snap.bracketMax && b != null && b > Math.max(snap.bracketMax, 2);
            return `<span class="chip ${ob ? 'loss' : b != null ? 'win' : ''} sm">Bracket ${b != null ? (b === 2 ? '1-2' : b) : '?'}${snap.bracketMax ? ` (máx. ${snap.bracketMax === 2 ? '1-2' : snap.bracketMax})` : ''}</span>`; })()}
          ${snap.deckLocked ? '<span class="small muted">Mazo cerrado: el torneo ya empezó</span>' : `<a class="jbtn${v != null ? '-outline' : ''}" href="${B}/valor-mazo?evento=${id}">${v != null ? 'Cambiar mazo' : 'Validar mi mazo'}</a>`}</div>`;
      })() : ''}
      ${snap.status !== 'finished' ? (() => { const [c1, c2] = String((snap.roster.find(p => p.id === me.id) || {}).deck || '').split(/\s+\+\s+/);
        return `<div class="deckrow"><label for="deck-in">Tu comandante</label><input id="deck-in" value="${esc(c1 || '')}" placeholder="p. ej. Atraxa, Praetors' Voice" maxlength="80" data-cmd-ac autocomplete="off">
        <label for="deck-in2" class="small">Compañero (solo si juegas con dos comandantes)</label><input id="deck-in2" value="${esc(c2 || '')}" placeholder="p. ej. Haldan, Avid Arcanist" maxlength="80" data-cmd-ac autocomplete="off">
        <button class="jbtn-outline" id="deck-ok">Guardar</button><span id="deck-msg" class="small muted"></span></div>`; })() : ''}
      ${snap.status === 'running' ? '</details>' : ''}
      ${st && st.form.length ? `<div class="me-stats"><span><b>${st.rank}º</b> puesto</span><span><b>${st.points}</b> pts</span><span><b>${st.wins}</b> victorias</span>${formDots(st.form, f => `R${f.r} ${formChip(f)}`)}</div>` : ''}
    </section>`;
  }

  // Avisos en el móvil (Web Push): «Ronda 2: mesa 3». En iPhone solo con la web instalada en la pantalla de inicio
  const pushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const pushKey = () => `mt_push_${id}_${state.me.id}`;
  function pushUI() {
    if (!pushOk()) return /iPhone|iPad|iPod/.test(navigator.userAgent) ? '<p class="small muted pushhint">Para que te avise de tu mesa en el iPhone: Compartir › «Añadir a pantalla de inicio» y abre la web desde ese icono.</p>' : '';
    const on = store.get(pushKey()) === '1';
    return `<button class="tgbtn ${on ? 'on' : ''}" id="push-btn">${window.UI.bell}${on ? 'Te avisaremos en este móvil · quitar' : 'Avísame en el móvil cuando salga mi mesa'}</button><span id="push-msg" class="small muted" role="status"></span>`;
  }
  async function pushToggle() {
    const msg = document.getElementById('push-msg');
    try {
      const reg = await navigator.serviceWorker.register(`${B}/sw.js`, { scope: `${B}/` });
      await navigator.serviceWorker.ready;
      if (store.get(pushKey()) === '1') {
        const sub = await reg.pushManager.getSubscription();
        if (sub) { await fetch(`${B}/push/baja`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
        store.set(pushKey(), null); render(); return;
      }
      if ((await Notification.requestPermission()) !== 'granted') { if (msg) msg.textContent = 'Sin permiso para avisar: actívalo en los ajustes del navegador.'; return; }
      const { key } = await (await fetch(`${B}/push/key`)).json();
      const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4));
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, c => c.charCodeAt(0)) });
      const r = await fetch(`${B}/push/alta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sub, event: id, player: state.me.id }) });
      if (!r.ok) throw new Error((await r.json()).error || 'No se pudo activar');
      store.set(pushKey(), '1'); render();
    } catch (e) { if (msg) msg.textContent = e.message || 'No se pudo activar'; }
  }

  function podCard(pod) {
    const mine = pod.players.some(x => isMe(x.id));
    const q = norm(state.filter);
    const hit = q && pod.players.some(x => norm(x.name).includes(q) || norm(x.username).includes(q));
    const status = !pod.reported ? '<span class="chip live sm">Jugando</span>' : pod.draw ? '<span class="chip draw sm">Empate</span>' : '<span class="chip win sm">Terminada</span>';
    return `<div class="podc ${mine ? 'me' : ''} ${hit ? 'hit' : ''} ${pod.reported ? 'done' : ''}">
      <div class="podc-h"><b>Mesa ${pod.table}</b><span>${pod.size} jug. · ${podPts(pod.size)}</span>${status}</div>
      ${pod.players.map(x => { const lv = !pod.reported && pod.life && pod.life[x.id]; return `<div class="podc-p ${pod.winner === x.id ? 'win' : ''} ${isMe(x.id) ? 'me' : ''} ${lv && lv.out ? 'ko' : ''}"><i>${x.seat}º</i><span>${esc(x.name)}${pod.winner === x.id ? ' ' + window.UI.trophy : ''}${x.deck ? `<small class="deck">${esc(x.deck)}</small>` : ''}</span><em>${pod.reported ? `${x.place && byPlaces() ? `${x.place}º · ` : ''}+${x.got}` : lv ? (lv.out ? 'fuera' : `<b class="hp">${lv.life}</b> vidas`) : `${x.pts} pts`}</em></div>`; }).join('')}
      ${!pod.reported && snap.status === 'running' ? `<a class="podc-live" href="${B}/commander/${id}/vidas?mesa=${pod.id}">${pod.life ? 'Ver vidas en directo' : 'Contador de vidas'}</a>` : ''}
    </div>`;
  }

  function podsPanel(pods, controls) {
    const q = norm(state.filter);
    let body;
    if (state.view === 'az' && controls) {
      const az = pods.flatMap(p => p.players.map(x => ({ ...x, table: p.table }))).sort((a, b) => a.name.localeCompare(b.name))
        .filter(x => !q || norm(x.name).includes(q) || norm(x.username).includes(q));
      body = `<div class="azlist">${az.map(x => `<div class="az ${isMe(x.id) ? 'me' : ''}"><span>${esc(x.name)}</span><b>Mesa ${x.table}</b><em>${x.seat === 1 ? 'empieza' : `juega ${x.seat}º`}</em></div>`).join('')}</div>`;
    } else {
      const list = q ? pods.filter(p => p.players.some(x => norm(x.name).includes(q) || norm(x.username).includes(q))) : pods;
      body = list.length ? `<div class="podgrid">${list.map(podCard).join('')}</div>` : '<p class="muted">Nadie coincide con ese nombre.</p>';
    }
    const ctrl = controls ? `<div class="ctrl">${seg('view', [['pods', 'Por mesa'], ['az', 'A–Z']], state.view)}
      <input class="filter" id="flt" placeholder="Filtrar por nombre" value="${esc(state.filter)}" autocomplete="off"></div>` : '';
    return ctrl + body;
  }

  function standingsPanel() {
    const rows = snap.standings.filter(s => s.played || s.form.length);
    if (!rows.length) return '<p class="muted">La clasificación aparecerá tras la primera ronda.</p>';
    return `${snap.status === 'finished' ? podium(rows) : ''}<div class="tablewrap"><table class="tbl stand"><thead><tr><th>#</th><th>Jugador</th><th class="num">Pts</th><th class="num">Victorias</th><th>Rondas</th></tr></thead><tbody>
      ${rows.map(s => `<tr class="${isMe(s.id) ? 'me' : ''} ${s.dropped != null ? 'dim' : ''}"><td class="rk">${s.rank}${s.champion ? ' ' + window.UI.trophy : ''}</td><td>${snap.profiles && s.pkey ? `<a class="plink" href="${B}/jugador/${encodeURIComponent(s.pkey)}">${esc(s.name)}</a>` : esc(s.name)}${s.dropped != null ? ' <small class="muted">(drop)</small>' : ''}${s.deck ? `<small class="deck">${esc(s.deck)}</small>` : ''}</td>
        <td class="num strong">${s.points}</td><td class="num">${s.wins}/${s.played}</td><td>${formDots(s.form, formChip)}</td></tr>`).join('')}
      </tbody></table></div><p class="small muted">Solo cuentan los puntos: ganar en mesa de 4 = 4 pts, en mesa de 3 = 3 pts. Empatados a puntos comparten puesto.</p>`;
  }

  function roundsPanel() {
    if (!snap.rounds.length) return '<p class="muted">Aún no hay rondas.</p>';
    const sel = state.roundSel || snap.round;
    const rd = snap.rounds.find(r => r.round === sel) || snap.rounds[snap.rounds.length - 1];
    return `<div class="chips rchips">${snap.rounds.map(r => `<button data-round="${r.round}" class="${r.round === rd.round ? 'on' : ''}">${r.kind === 'final' ? 'Final' : 'R' + r.round}</button>`).join('')}</div>
      <div class="podgrid">${rd.pods.map(podCard).join('')}</div>`;
  }

  function render() {
    const focus = document.activeElement && document.activeElement.id;
    const pos = focus && document.activeElement.selectionStart;
    let h = '';
    if (snap.round && snap.status !== 'finished') {
      const title = snap.roundKind === 'final' ? '<b>Mesa final</b>' : `Ronda <b>${snap.round}</b>${snap.roundsPlanned ? ` de ${snap.roundsPlanned}` : ''}`;
      h += livebar({ title, end: snap.timerEnd, done: snap.done, total: snap.pods.length, note: 'mesas terminadas' });
    }
    h += meCard();
    if (snap.round) {
      const items = [['pods', snap.status === 'finished' ? 'Última ronda' : 'Mesas'], ['stand', snap.status === 'finished' ? 'Clasificación final' : 'Clasificación'], ['rounds', 'Rondas']];
      const active = !state.picked && snap.status === 'finished' ? 'stand' : items.some(i => i[0] === state.tab) ? state.tab : 'pods';
      h += tabs('main', items, active);
      h += `<div class="panel-pub">${active === 'pods' ? podsPanel(snap.pods, true) : active === 'stand' ? standingsPanel() : roundsPanel()}</div>`;
    } else {
      h += `<section class="roster"><h2 class="sec">Apuntados (${snap.roster.length})</h2><div class="rgrid">${snap.roster.map(p => `<span>${esc(p.name)}</span>`).join('')}</div></section>`;
    }
    root.innerHTML = h;
    bind();
    if (focus) { const el = document.getElementById(focus); if (el) { el.focus(); if (pos != null && el.setSelectionRange) el.setSelectionRange(pos, pos); } }
  }

  function bind() {
    root.querySelectorAll('[data-tabs] button').forEach(b => b.onclick = () => { state.tab = b.dataset.k; state.picked = true; store.set('mt_ctab', state.tab); render(); });
    root.querySelectorAll('[data-seg="view"] button').forEach(b => b.onclick = () => { state.view = b.dataset.k; render(); });
    root.querySelectorAll('[data-round]').forEach(b => b.onclick = () => { state.roundSel = Number(b.dataset.round); render(); });
    const flt = document.getElementById('flt'); if (flt) flt.oninput = e => { state.filter = e.target.value; render(); };
    const post = async (url, body) => {
      const tk = `mt_tok_${id}_${body.by}`;
      const t = store.get(tk); if (t) body.tok = t;
      const r = await fetch(B + url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'No se pudo enviar');
      if (j.tok) store.set(tk, j.tok);
      return j;
    };
    root.querySelectorAll('[data-place]').forEach(b => b.onclick = () => {
      const pod = Number(b.dataset.pod), pid = Number(b.dataset.place);
      const ord = state.order[pod] = state.order[pod] || [];
      const i = ord.indexOf(pid);
      if (i >= 0) ord.splice(i); else ord.push(pid);
      const p = snap.pods.find(x => x.id === pod);
      if (p && ord.length === p.size - 1) ord.push(p.players.find(x => !ord.includes(x.id)).id);
      render();
    });
    root.querySelectorAll('[data-reset-order]').forEach(b => b.onclick = () => { state.order[Number(b.dataset.resetOrder)] = []; render(); });
    root.querySelectorAll('[data-send-order]').forEach(b => b.onclick = async () => {
      const pod = Number(b.dataset.sendOrder);
      const p = snap.pods.find(x => x.id === pod);
      const ord = (state.order[pod] || []).slice();
      if (p && ord.length === p.size - 1) ord.push(p.players.find(x => !ord.includes(x.id)).id);
      const nm = id => (p.players.find(x => x.id === id) || {}).name;
      const msg = document.getElementById('rep-msg');
      b.disabled = true; b.textContent = 'Enviando…';
      try { await post(`/commander/${id}/reportar`, { pod, by: state.me.id, result: 'order:' + ord.join(',') }); state.order[pod] = []; await refresh(); }
      catch (e) { b.disabled = false; b.textContent = 'Enviar resultado'; if (msg) msg.textContent = e.message; }
    });
    root.querySelectorAll('[data-pickwin]').forEach(b => b.onclick = () => { state.pickWin[b.dataset.pod] = Number(b.dataset.pickwin); render(); });
    root.querySelectorAll('[data-report]').forEach(b => b.onclick = async () => {
      const msg = document.getElementById('rep-msg');
      b.disabled = true;
      try { await post(`/commander/${id}/reportar`, { pod: b.dataset.pod, by: state.me.id, result: b.dataset.report }); delete state.pickWin[b.dataset.pod]; await refresh(); }
      catch (e) { b.disabled = false; if (msg) msg.textContent = e.message; }
    });
    const pb = document.getElementById('push-btn'); if (pb) pb.onclick = pushToggle;
    const dk = document.getElementById('deck-ok');
    if (dk) dk.onclick = async () => {
      const m = document.getElementById('deck-msg');
      try { await post(`/commander/${id}/mazo`, { by: state.me.id, deck: [document.getElementById('deck-in').value, (document.getElementById('deck-in2') || {}).value].map(x => (x || '').trim()).filter(Boolean).join(' + ') }); m.textContent = 'Guardado ✔'; await refresh(); }
      catch (e) { m.textContent = e.message; }
    };
    const ch = document.getElementById('me-change'); if (ch) ch.onclick = () => { state.me = null; state.noAuto = true; store.set('mt_me_user', null); render(); };
    window.UI.bindWho(snap.roster, p => { state.me = p; store.set('mt_me_user', p.username || p.name); render(); });
  }

  async function refresh(force = true) {
    try {
      const r = await fetch(`${B}/commander/${id}/estado.json`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      snap = await r.json();
      window.UI.markOk();
      state.me = state.me ? (snap.roster.find(p => p.id === state.me.id) || resolveMe()) : resolveMe();
      if (force || !document.activeElement || !['flt', 'who-in', 'deck-in', 'deck-in2'].includes(document.activeElement.id)) render();
    } catch (e) { window.UI.markFail(); }
  }

  render();
  setInterval(tickClocks, 1000);
  if (snap.status !== 'finished') {
    setInterval(() => refresh(false), snap.status === 'running' ? 6000 : 15000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(false); });
    window.addEventListener('online', () => refresh(false));
  }
})();
