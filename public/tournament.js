(function () {
  const root = document.getElementById('live');
  if (!root) return;
  const { esc, norm, store, livebar, tickClocks, tabs, seg, formDots, podium, whoami, findPlayer } = window.UI;
  const id = root.dataset.id;
  const B = window.__BASE || '';
  let snap = window.__SNAP;
  const state = {
    tab: store.get('mt_tab') || 'pair', view: 'table', pendingOnly: false, filter: '', roundSel: null,
    me: null,
  };

  // Identidad recordada entre torneos por usuario de Melee
  function resolveMe() {
    // Con sesión iniciada, la web ya sabe quién eres (salvo que pulses «Cambiar»)
    const acc = window.__ME;
    if (acc && !state.noAuto) { const m = snap.roster.find(p => p.pkey && p.pkey === acc.key); if (m) return m; }
    const saved = store.get('mt_me_user');
    if (!saved) return null;
    return snap.roster.find(p => norm(p.username) === norm(saved) || norm(p.name) === norm(saved)) || null;
  }
  state.me = resolveMe();

  const rec = t => snap.records[t] || { w: 0, l: 0, d: 0, form: [] };
  const recStr = t => { const r = rec(t); return `${r.w}-${r.l}-${r.d}`; };
  const nameOf = t => (snap.roster.find(p => p.team === t) || {}).name || '—';
  const isMe = t => state.me && state.me.team === t;

  function meCard() {
    if (!snap.roster.length) return '';
    if (!state.me) return `<section class="me-card empty">${whoami(snap.roster, '', 'roster-list', snap.status === 4 ? 'Ver mi resultado' : 'Ver mi mesa')}</section>`;
    const me = state.me;
    const r = rec(me.team);
    const st = snap.standings.find(s => s.team === me.team);
    const p = snap.pairings.find(x => x.t1 === me.team || x.t2 === me.team);
    let main = '';
    if (snap.status === 1 && !snap.round) {
      main = `<div class="me-big ok">Inscrito ✔</div><div class="me-sub">Las mesas aparecerán aquí al empezar.</div>`;
    } else if (p && snap.status !== 4) {
      const mine1 = p.t1 === me.team;
      const opp = mine1 ? p.t2 : p.t1;
      let status = '<span class="chip live">Jugando</span>';
      if (p.bye) status = '<span class="chip win">Ronda libre</span>';
      else if (p.hasResult) {
        const a = mine1 ? p.w1 : p.w2, b = mine1 ? p.w2 : p.w1;
        status = a > b ? `<span class="chip win">Ganaste ${a}-${b}</span>` : b > a ? `<span class="chip loss">Perdiste ${a}-${b}</span>` : `<span class="chip draw">Empate ${a}-${b}</span>`;
      }
      main = p.bye ? `<div class="me-big">BYE</div><div class="me-sub">${status}</div>`
        : `<div class="me-table"><span>Mesa</span><b>${esc(p.table ?? '?')}</b></div>
           <div class="me-vs"><small>Ronda ${snap.round} · contra</small><strong>${esc(nameOf(opp))}</strong><em>${recStr(opp)}</em>${status}</div>`;
    } else if (snap.status === 4) {
      main = `<div class="me-table"><span>Puesto</span><b>${st ? st.rank : '—'}</b></div><div class="me-vs"><small>Resultado final</small><strong>${st ? st.points + ' puntos' : ''}</strong><em>${recStr(me.team)}</em></div>`;
    }
    return `<section class="me-card">
      <div class="me-head"><span>Tú: <b>${esc(me.name)}</b></span><button class="link" id="me-change">Cambiar</button></div>
      <div class="me-main">${main}</div>
      ${snap.tg && snap.status !== 4 && me.pkey ? `<a class="tgbtn" href="${B}/avisos/${encodeURIComponent(me.pkey)}?n=${encodeURIComponent(me.name)}" target="_blank" rel="noopener">${window.UI.bell}Avísame de mi mesa por Telegram</a>` : ''}
      ${r.form.length ? `<div class="me-stats">${st ? `<span><b>${st.rank}º</b> puesto</span><span><b>${st.points}</b> pts</span>` : ''}<span><b>${recStr(me.team)}</b> V-D-E</span>
        ${formDots(r.form, f => `R${f.r} ${f.res === "B" ? "bye" : window.UI.resLabel[f.res]}`)}</div>` : ''}
    </section>`;
  }

  function pairRow(p) {
    const res = (a, b) => (p.hasResult ? (a > b ? 'w' : a < b ? 'l' : 'd') : '');
    const mine = isMe(p.t1) || isMe(p.t2);
    if (p.bye) {
      return `<div class="prow ${mine ? 'me' : ''} done"><div class="ptab bye">BYE</div><div class="pp w"><span>${esc(p.p1)}</span><em>${recStr(p.t1)}</em></div><div class="pscore">—</div><div class="pp"></div></div>`;
    }
    return `<div class="prow ${mine ? 'me' : ''} ${p.hasResult ? 'done' : ''}">
      <div class="ptab">${esc(p.table ?? '?')}</div>
      <div class="pp ${res(p.w1, p.w2)}"><span>${esc(p.p1)}</span><em>${recStr(p.t1)}</em></div>
      <div class="pscore">${p.hasResult ? `${p.w1 ?? 0}<i>-</i>${p.w2 ?? 0}` : '<span class="chip live sm">Jugando</span>'}</div>
      <div class="pp r ${res(p.w2, p.w1)}"><span>${esc(p.p2)}</span><em>${recStr(p.t2)}</em></div></div>`;
  }

  function pairingsPanel(list, withControls) {
    const q = norm(state.filter);
    let rows = list.filter(p => !q || norm(p.p1).includes(q) || norm(p.p2).includes(q) || norm(p.u1).includes(q) || norm(p.u2).includes(q));
    if (state.pendingOnly) rows = rows.filter(p => !p.bye && !p.hasResult);
    let body;
    if (state.view === 'az' && withControls) {
      const az = [];
      for (const p of list) {
        az.push({ name: p.p1, user: p.u1, team: p.t1, table: p.bye ? 'BYE' : p.table, opp: p.p2 });
        if (p.t2) az.push({ name: p.p2, user: p.u2, team: p.t2, table: p.table, opp: p.p1 });
      }
      az.sort((a, b) => a.name.localeCompare(b.name));
      const fil = az.filter(x => !q || norm(x.name).includes(q) || norm(x.user).includes(q));
      body = `<div class="azlist">${fil.map(x => `<div class="az ${isMe(x.team) ? 'me' : ''}"><span>${esc(x.name)}</span><b>${x.table === 'BYE' ? 'BYE' : 'Mesa ' + esc(x.table ?? '?')}</b><em>${x.opp ? 'vs ' + esc(x.opp) : ''}</em></div>`).join('')}</div>`;
    } else {
      body = rows.length ? `<div class="plist">${rows.map(pairRow).join('')}</div>` : '<p class="muted">No hay partidas que mostrar.</p>';
    }
    const controls = withControls ? `<div class="ctrl">${seg('view', [['table', 'Por mesa'], ['az', 'A–Z']], state.view)}
      <input class="filter" id="flt" placeholder="Filtrar por nombre" value="${esc(state.filter)}" autocomplete="off">
      ${state.view === 'table' ? `<label class="tgl"><input type="checkbox" id="pend" ${state.pendingOnly ? 'checked' : ''}> Solo pendientes</label>` : ''}</div>` : '';
    return controls + body;
  }

  function standingsPanel() {
    if (!snap.standings.length) return '<p class="muted">La clasificación aparecerá tras la primera ronda.</p>';
    const fin = snap.status === 4;
    return `${fin ? podium(snap.standings) : ''}<div class="tablewrap"><table class="tbl stand"><thead><tr><th>#</th><th>Jugador</th><th class="num">Pts</th><th class="num">V-D-E</th><th>Forma</th>
      <th class="num opt" title="% de partidas ganadas de los oponentes">PGO%</th><th class="num opt" title="% de juegos ganados">JGE%</th><th class="num opt" title="% de juegos ganados de los oponentes">JGO%</th></tr></thead><tbody>
      ${snap.standings.map(s => `<tr class="${isMe(s.team) ? 'me' : ''} ${s.dropped ? 'dim' : ''}"><td class="rk">${s.rank}</td><td>${snap.profiles && s.pkey ? `<a class="plink" href="${B}/jugador/${encodeURIComponent(s.pkey)}">${esc(s.name)}</a>` : esc(s.name)}${s.dropped ? ' <small class="muted">(drop)</small>' : ''}</td>
        <td class="num strong">${s.points}</td><td class="num">${esc(s.match_record || '')}</td><td>${formDots(rec(s.team).form)}</td>
        <td class="num opt">${s.omw != null ? (s.omw * 100).toFixed(1) : ''}</td><td class="num opt">${s.gw != null ? (s.gw * 100).toFixed(1) : ''}</td><td class="num opt">${s.ogw != null ? (s.ogw * 100).toFixed(1) : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="legend"><b>V-D-E</b> victorias, derrotas y empates · <b>Forma</b> resultado de cada ronda (V, D, E; B = bye) · Desempates: <b>PGO%</b> partidas ganadas por tus rivales, <b>JGE%</b> juegos que has ganado, <b>JGO%</b> juegos ganados por tus rivales.</p>`;
  }

  function roundsPanel() {
    if (!snap.rounds.length) return '<p class="muted">Aún no hay rondas.</p>';
    const sel = state.roundSel || snap.round;
    const rd = snap.rounds.find(r => r.round === sel) || snap.rounds[snap.rounds.length - 1];
    return `<div class="chips rchips">${snap.rounds.map(r => `<button data-round="${r.round}" class="${r.round === rd.round ? 'on' : ''}">R${r.round}</button>`).join('')}</div>
      <div class="plist">${rd.pairings.map(pairRow).join('')}</div>`;
  }

  function render() {
    const focus = document.activeElement && document.activeElement.id;
    const pos = focus && document.activeElement.selectionStart;
    let h = '';
    if (snap.round && snap.status !== 4) {
      h += livebar({ title: `Ronda <b>${snap.round}</b>${snap.roundsTotal ? ` de ${snap.roundsTotal}` : ''}`, end: snap.timerEnd, done: snap.done, total: snap.tables, note: 'mesas con resultado' });
    }
    h += meCard();
    if (snap.round || snap.standings.length) {
      const items = [['pair', snap.status === 4 ? 'Última ronda' : 'Emparejamientos'], ['stand', snap.status === 4 ? 'Clasificación final' : 'Clasificación'], ['rounds', 'Rondas']];
      const active = !state.picked && snap.status === 4 ? 'stand' : items.some(i => i[0] === state.tab) ? state.tab : 'pair';
      h += tabs('main', items, active);
      h += `<div class="panel-pub">${active === 'pair' ? pairingsPanel(snap.pairings, true) : active === 'stand' ? standingsPanel() : roundsPanel()}</div>`;
    } else if (snap.status === 1) {
      h += `<section class="roster"><h2 class="sec">Inscritos (${snap.roster.length})</h2><div class="rgrid">${snap.roster.map(p => `<span>${esc(p.name)}</span>`).join('')}</div></section>`;
    }
    root.innerHTML = h;
    bind();
    if (focus) { const el = document.getElementById(focus); if (el) { el.focus(); if (pos != null && el.setSelectionRange) el.setSelectionRange(pos, pos); } }
  }

  function bind() {
    root.querySelectorAll('[data-tabs] button').forEach(b => b.onclick = () => { state.tab = b.dataset.k; state.picked = true; store.set('mt_tab', state.tab); render(); });
    root.querySelectorAll('[data-seg="view"] button').forEach(b => b.onclick = () => { state.view = b.dataset.k; render(); });
    root.querySelectorAll('[data-round]').forEach(b => b.onclick = () => { state.roundSel = Number(b.dataset.round); render(); });
    const flt = document.getElementById('flt'); if (flt) flt.oninput = e => { state.filter = e.target.value; render(); };
    const pend = document.getElementById('pend'); if (pend) pend.onchange = e => { state.pendingOnly = e.target.checked; render(); };
    const ch = document.getElementById('me-change'); if (ch) ch.onclick = () => { state.me = null; state.noAuto = true; store.set('mt_me_user', null); render(); };
    window.UI.bindWho(snap.roster, p => { state.me = p; store.set('mt_me_user', p.username || p.name); render(); });
  }

  render();
  setInterval(tickClocks, 1000);
  async function refresh() {
    try {
      const r = await fetch(`${B}/t/${id}/estado.json`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      snap = await r.json();
      window.UI.markOk();
      if (state.me) state.me = snap.roster.find(p => p.team === state.me.team) || resolveMe();
      else state.me = resolveMe();
      if (!document.activeElement || !['flt', 'who-in'].includes(document.activeElement.id)) render();
    } catch (e) { window.UI.markFail(); }
  }
  if (snap.live || snap.status === 1) {
    setInterval(refresh, snap.live ? 20000 : 120000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    window.addEventListener('online', refresh);
  }
})();
