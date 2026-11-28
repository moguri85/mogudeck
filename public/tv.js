(function () {
  const el = document.getElementById('tv');
  const fixedId = el.dataset.id;
  const seconds = Number(el.dataset.seconds) || 12;
  const store = window.__STORE || {};
  let state = null;
  let slides = [];
  let idx = 0;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

  function build() {
    const out = [];
    for (const t of state.live) {
      if (t.kind === 'commander') {
        const pp = chunk(t.pods, 6);
        pp.forEach((p, i) => out.push({ kind: 'pods', t, rows: p, page: i + 1, pages: pp.length }));
        if (t.round > 1 || t.status === 'finished') {
          const sp = chunk(t.standings, 16);
          sp.slice(0, 4).forEach((p, i) => out.push({ kind: 'cstand', t, rows: p, page: i + 1, pages: Math.min(sp.length, 4) }));
        }
        if (!t.pods.length) out.push({ kind: 'wait', t: { ...t, players: { total: t.players } } });
        // Mesas en directo (contador de vidas): la más igualada y las que están a punto de acabar
        if (t.status === 'running') { const lv = liveTables(t); if (lv.length) out.splice(out.findIndex(x => x.t === t) + 1, 0, { kind: 'livet', t, rows: lv }); }
        if (t.status === 'finished' && t.night) out.unshift({ kind: 'night', t });
        continue;
      }
      const pages = chunk(t.pairings, 16);
      pages.forEach((p, i) => out.push({ kind: 'pairs', t, rows: p, page: i + 1, pages: pages.length }));
      if (t.standings.length && t.round > 1 || (t.standings.length && t.status === 4)) {
        const sp = chunk(t.standings, 16);
        sp.slice(0, 4).forEach((p, i) => out.push({ kind: 'stand', t, rows: p, page: i + 1, pages: Math.min(sp.length, 4) }));
      }
      if (!t.pairings.length && !t.standings.length) out.push({ kind: 'wait', t });
    }
    // Comunidad: revanchas y «Se busca» de la ronda en juego, carteles de recompensa y momentos de los jugadores
    for (const t of state.live) {
      const rows = t.kind === 'commander'
        ? (t.pods || []).filter(p => !p.reported && (p.rematch || (p.wanted && p.wanted.length))).map(p => ({ table: p.table, rematch: p.rematch, wanted: p.wanted || [], names: p.players.map(x => x.name) }))
        : (t.pairings || []).filter(p => !p.hasResult && !p.bye && (p.rematch || (p.wanted && p.wanted.length))).map(p => ({ table: p.table, rematch: p.rematch && { ...p.rematch, a: p.p1, b: p.p2 }, wanted: p.wanted || [], names: [p.p1, p.p2] }));
      if (rows.length) out.splice(out.findIndex(x => x.t === t) + 1, 0, { kind: 'hot', t, rows: rows.slice(0, 6) });
    }
    if (state.bounties && state.bounties.length) out.push({ kind: 'bounty' });
    if (state.lfg && state.lfg.length) out.push({ kind: 'lfg' });
    (state.moments || []).slice(0, 4).forEach(m => out.push({ kind: 'moment', m }));
    if (!out.some(x => x.t)) out.unshift({ kind: 'upcoming' });
    return out;
  }

  function liveTables(t) {
    const out = [];
    for (const p of t.pods || []) {
      if (p.reported || !p.life) continue;
      const ps = p.players.map(x => ({ ...x, ...(p.life[x.id] || {}) }));
      const alive = ps.filter(x => !x.out && x.life != null);
      if (alive.length < 2 || alive.every(x => x.life === alive[0].life && x.life >= 30)) continue; // sin empezar
      const lifes = alive.map(x => x.life), mean = lifes.reduce((a, b) => a + b, 0) / lifes.length;
      const spread = Math.sqrt(lifes.reduce((a, b) => a + (b - mean) ** 2, 0) / lifes.length);
      const close = alive.length === 2 || Math.min(...lifes) <= 5;
      out.push({ pod: p, ps, spread, close, min: Math.min(...lifes) });
    }
    const closing = out.filter(x => x.close).sort((a, b) => a.min - b.min).slice(0, 3);
    const even = out.filter(x => !x.close).sort((a, b) => a.spread - b.spread)[0];
    return [...(even ? [{ ...even, label: 'La más igualada' }] : []), ...closing.map(x => ({ ...x, label: 'A punto de acabar' }))];
  }
  const mm = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  function clock(t) {
    if (!t.timerEnd) return '';
    const ms = new Date(t.timerEnd) - Date.now();
    if (ms < -30 * 60e3) return '';
    const neg = ms < 0, a = Math.abs(ms);
    const m = Math.floor(a / 60000), s = Math.floor(a / 1000) % 60;
    return `<div class="tv-clock ${neg ? 'over' : ''}"><small>${neg ? 'Tiempo cumplido' : 'Tiempo restante'}</small>${neg ? '+' : ''}${m}:${String(s).padStart(2, '0')}</div>`;
  }

  function progress(t) {
    const total = t.kind === 'commander' ? (t.pods || []).length : t.tables;
    const done = t.done || 0;
    if (!total || t.status === 4 || t.status === 'finished') return '';
    return `<div class="tv-prog"><small>${done}/${total} mesas terminadas</small><div class="lb-bar"><i style="width:${Math.round(done * 100 / total)}%"></i></div></div>`;
  }

  function head(t) {
    return `<div class="tv-head" style="--g:${t.color}">
      <div class="tv-title"><small>${esc(t.gameLabel)} · ${t.roundKind === 'final' ? 'Mesa final' : t.round ? `Ronda ${t.round}${(t.roundsTotal || t.roundsPlanned) ? '/' + (t.roundsTotal || t.roundsPlanned) : ''}` : esc(t.statusDesc || '')}</small>${esc(t.name)}</div>
      ${progress(t)}<div id="clock">${clock(t)}</div><img class="tv-qr" src="${t.qr}" alt=""></div>`;
  }

  const tags = p => (p.rematch && p.rematch.nemesis ? '<b class="tv-tag rm">Revancha</b>' : p.rematch ? '<b class="tv-tag rm">Revancha</b>' : '') + (p.wanted && p.wanted.length ? '<b class="tv-tag wd">Se busca</b>' : '');
  function render() {
    if (!state) return;
    const s = slides[idx % slides.length];
    let body = '';
    if (s.kind === 'pairs') {
      body = head(s.t) + `<div class="tv-body" style="--g:${s.t.color}"><div class="tv-sub"><span>Emparejamientos</span><span>${s.t.pending} pendientes${s.pages > 1 ? ` · ${s.page}/${s.pages}` : ''}</span></div>
        <div class="tv-pairs ${s.rows.length > 8 ? 'dense' : ''}">${s.rows.map(p => `<div class="tv-pair ${p.hasResult ? 'done' : ''}"><div class="tn">${p.bye ? 'BYE' : esc(p.table ?? '?')}</div>
          <div class="who"><span>${esc(p.p1)}</span>${p.p2 ? `<span>${esc(p.p2)}</span>` : '<em>ronda libre</em>'}${tags(p)}</div>
          <div class="st">${p.hasResult && !p.bye ? `${p.w1 ?? 0}-${p.w2 ?? 0}` : p.bye ? '' : 'jugando'}</div></div>`).join('')}</div></div>`;
    } else if (s.kind === 'stand') {
      body = head(s.t) + `<div class="tv-body" style="--g:${s.t.color}"><div class="tv-sub"><span>Clasificación${s.t.status === 4 ? ' final' : ''}</span><span>${s.pages > 1 ? `${s.page}/${s.pages}` : ''}</span></div>
        <table class="tv-stand ${s.rows.length > 12 ? 'dense' : ''}"><thead><tr><th>#</th><th>Jugador</th><th class="num">Pts</th><th class="num">Récord</th><th class="num">PGO</th><th class="num">JGE</th><th class="num">JGO</th></tr></thead><tbody>
        ${s.rows.map(r => `<tr><td>${r.rank}</td><td>${esc(r.name)}</td><td class="num"><b>${r.points}</b></td><td class="num">${esc(r.match_record)}</td><td class="num">${r.omw != null ? (r.omw * 100).toFixed(0) + '%' : ''}</td><td class="num">${r.gw != null ? (r.gw * 100).toFixed(0) + '%' : ''}</td><td class="num">${r.ogw != null ? (r.ogw * 100).toFixed(0) + '%' : ''}</td></tr>`).join('')}
        </tbody></table></div>`;
    } else if (s.kind === 'pods') {
      body = head(s.t) + `<div class="tv-body" style="--g:${s.t.color}"><div class="tv-sub"><span>Mesas · empieza quien aparece 1º</span><span>${s.t.pending} pendientes${s.pages > 1 ? ` · ${s.page}/${s.pages}` : ''}</span></div>
        <div class="tv-pods">${s.rows.map(pod => `<div class="tv-pod ${pod.reported ? 'done' : ''}"><div class="tn">${pod.table}</div><div class="who">
          ${pod.players.map(p => { const lv = !pod.reported && pod.life && pod.life[p.id]; return `<span class="${pod.winner === p.id ? 'win' : ''} ${lv && lv.out ? 'ko' : ''}"><i>${p.seat}º</i>${esc(p.name)}${pod.winner === p.id ? ' 🏆' : ''}${lv ? `<em class="hp">${lv.out ? '✕' : lv.life}</em>` : ''}</span>`; }).join('')}${pod.reported ? '' : tags(pod)}</div></div>`).join('')}</div></div>`;
    } else if (s.kind === 'cstand') {
      body = head(s.t) + `<div class="tv-body" style="--g:${s.t.color}"><div class="tv-sub"><span>Clasificación${s.t.status === 'finished' ? ' final' : ''}</span><span>${s.pages > 1 ? `${s.page}/${s.pages}` : ''}</span></div>
        <table class="tv-stand ${s.rows.length > 12 ? 'dense' : ''}"><thead><tr><th>#</th><th>Jugador</th><th class="num">Pts</th><th class="num">V-D-E</th></tr></thead><tbody>
        ${s.rows.map(r => `<tr><td>${r.rank}${r.champion ? ' 🏆' : ''}</td><td>${esc(r.name)}</td><td class="num"><b>${r.points}</b></td><td class="num">${esc(r.record)}</td>
          </tr>`).join('')}
        </tbody></table></div>`;
    } else if (s.kind === 'az') {
      body = head(s.t) + `<div class="tv-body" style="--g:${s.t.color}"><div class="tv-sub"><span>Busca tu nombre</span><span>${s.rows[0].name.charAt(0).toUpperCase()}–${s.rows[s.rows.length - 1].name.charAt(0).toUpperCase()}${s.pages > 1 ? ` · ${s.page}/${s.pages}` : ''}</span></div>
        <div class="tv-az" style="grid-template-rows:repeat(${Math.ceil(s.rows.length / 3)},auto)">${s.rows.map(r => `<div><span>${esc(r.name)}</span><b>${esc(r.where)}</b>${r.extra ? `<em>${esc(r.extra)}</em>` : ''}</div>`).join('')}</div></div>`;
    } else if (s.kind === 'hot') {
      body = head(s.t) + `<div class="tv-body" style="--g:${s.t.color}"><div class="tv-sub"><span>Mesas calientes · ronda ${s.t.round}</span><span></span></div>
        <div class="tv-hot">${s.rows.map(r => `<div class="hot"><div class="tn">${esc(r.table)}</div><div>
          ${r.rematch ? `<b class="hk rm">¡Revancha!</b><p>${esc(r.rematch.a)} y ${esc(r.rematch.b)} ya se han visto: <b>${r.rematch.w}-${r.rematch.l}${r.rematch.d ? '-' + r.rematch.d : ''}</b>${r.rematch.nemesis ? ` · ${esc(r.rematch.nemesis === 'a' ? r.rematch.b : r.rematch.a)} es su némesis` : ''}</p>` : ''}
          ${r.wanted.map(w => `<b class="hk wd">Se busca</b><p>Si alguien gana a <b>${esc(w.name)}</b> se lleva <b>${esc(w.reward)}</b></p>`).join('')}
          ${!r.rematch && r.names.length > 2 ? `<p class="muted">${r.names.map(esc).join(' · ')}</p>` : ''}</div></div>`).join('')}</div></div>`;
    } else if (s.kind === 'livet') {
      const top = Math.max(40, ...s.rows.flatMap(r => r.ps.map(p => p.life || 0)));
      body = head(s.t) + `<div class="tv-body" style="--g:${s.t.color}"><div class="tv-sub"><span>Mesas en directo</span><span>vidas del contador</span></div>
        <div class="tv-livet">${s.rows.map(r => `<div class="lt ${r.close ? 'close' : ''}"><div class="lt-h"><b>Mesa ${esc(r.pod.table)}</b><span>${r.label}</span></div>
          ${r.ps.map(p => `<div class="lt-p ${p.out ? 'ko' : ''}"><span>${esc(p.name)}</span><i style="--w:${p.out ? 0 : Math.max(2, Math.round((p.life || 0) * 100 / top))}%"></i><b>${p.out ? '✕' : p.life}</b></div>`).join('')}</div>`).join('')}</div></div>`;
    } else if (s.kind === 'night') {
      const n = s.t.night;
      const card = (k, v, sub) => v ? `<div class="nt"><small>${k}</small><b>${esc(v)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>` : '';
      body = head(s.t) + `<div class="tv-body"><div class="tv-sub"><span>Resumen de la noche</span><span>${n.pods} mesas</span></div><div class="tv-night">
        ${s.t.standings && s.t.standings[0] ? card('Campeón', s.t.standings[0].name, `${s.t.standings[0].points} puntos`) : ''}
        ${n.kills ? card('Más eliminaciones', n.kills.name, `${n.kills.n} ${n.kills.n === 1 ? 'jugador' : 'jugadores'}`) : ''}
        ${n.comeback ? card('Remontada', n.comeback.name, `ganó con ${n.comeback.life} ${n.comeback.life === 1 ? 'vida' : 'vidas'} · mesa ${n.comeback.table}`) : ''}
        ${n.longest ? card('Partida más larga', `${n.longest.mins} minutos`, `mesa ${n.longest.table} · ronda ${n.longest.round}`) : ''}
        ${n.cmdDmg ? card('Más daño de comandante', n.cmdDmg.name, `${n.cmdDmg.n} de daño`) : ''}</div></div>`;
    } else if (s.kind === 'lfg') {
      body = `<div class="tv-head" style="--g:#f47700"><div class="tv-title"><small>Busco mesa</small>Hoy se juega casual</div>${state.lfgQr ? `<img class="tv-qr" src="${state.lfgQr}" alt="">` : ''}</div>
        <div class="tv-body"><div class="tv-lfg">${state.lfg.map(l => `<div><b>${esc(l.time || 'Hoy')}</b><span>${l.bracket === 'any' ? 'Cualquier bracket' : 'Bracket ' + esc(l.bracket)} · ${l.n} de ${l.slots}</span>${l.note ? `<em>${esc(l.note)}</em>` : ''}</div>`).join('')}</div>
        <p class="tv-hint">Escanea el QR y apúntate</p></div>`;
    } else if (s.kind === 'bounty') {
      body = `<div class="tv-head" style="--g:#f47700"><div class="tv-title"><small>Recompensas</small>Se busca</div>${state.bountiesQr ? `<img class="tv-qr" src="${state.bountiesQr}" alt="">` : ''}</div>
        <div class="tv-body"><div class="tv-wanted">${state.bounties.map(b => `<div class="tv-poster"><span>Se busca</span><div class="pf">${esc(b.name.charAt(0).toUpperCase())}</div><b>${esc(b.name)}</b>${b.note ? `<p>${esc(b.note)}</p>` : ''}${b.how ? `<small class="how">${esc(b.how)}</small>` : ''}<em>Recompensa<strong>${esc(b.reward)}</strong></em></div>`).join('')}</div>
        <p class="tv-hint">Cúmplelo en un torneo de la tienda y la recompensa es tuya</p></div>`;
    } else if (s.kind === 'moment') {
      const m = s.m;
      body = `<div class="tv-moment"><img src="${m.src}" alt=""><div class="tvm-cap">${m.caption ? `<b>${esc(m.caption)}</b>` : ''}<span>${esc(m.who)}${m.event ? ` · ${esc(m.event)}` : ''}</span></div>
        ${state.momentsQr ? `<div class="tvm-qr"><img src="${state.momentsQr}" alt=""><small>Sube tu momento</small></div>` : ''}</div>`;
    } else if (s.kind === 'wait') {
      body = head(s.t) + `<div class="tv-body"><div class="tv-title" style="text-align:center;margin-top:20vh">${s.t.players.total || 0} jugadores inscritos<small style="margin-top:2vh">Escanea el QR para seguir el torneo en tu móvil</small></div></div>`;
    } else {
      body = `<div class="tv-head"><div class="tv-title"><small>Próximos torneos</small>${esc(store.name)}</div></div>
        <div class="tv-body">${state.upcoming.length ? `<div class="tv-up">${state.upcoming.slice(0, 3).map(u => `<div style="--g:${u.color}">
          <span>${esc(u.gameLabel)}</span><b>${esc(u.name)}</b><span>${esc(u.date)}</span><img src="${u.qr}" alt=""></div>`).join('')}</div>`
          : `<div class="tv-title" style="text-align:center;margin-top:25vh">¡Nos vemos en el próximo torneo!</div>`}</div>`;
    }
    const dots = slides.length > 1 ? `<span class="tv-dots">${slides.map((_, i) => `<span class="${i === idx % slides.length ? 'on' : ''}"></span>`).join('')}</span>` : '';
    el.innerHTML = body + `<div class="tv-foot"><span>${esc(store.name)}</span><span>${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} ${dots}</span></div>`;    fit();
  }
  // Si la tabla o las mesas no caben en la pantalla (tele con otra proporción, ventana sin pantalla completa…), se encogen hasta que quepan
  function fit() {
    const box = el.querySelector('.tv-body');
    const t = box && box.querySelector('.tv-stand, .tv-pairs, .tv-pods');
    if (!t) return;
    let z = 1;
    t.style.zoom = '';
    while (box.scrollHeight > box.clientHeight + 1 && z > 0.55) { z -= 0.04; t.style.zoom = z.toFixed(2); }
  }
  window.addEventListener('resize', () => fit());

  async function load() {
    try {
      const r = await fetch((window.__BASE || '') + '/tv.json' + (fixedId ? '?id=' + encodeURIComponent(fixedId) : ''), { cache: 'no-store' });
      if (!r.ok) return;
      state = await r.json();
      celebrateNew(state);
      judgeBanner(state);
      slides = build();
      if (idx >= slides.length) idx = 0;
      render();
    } catch (e) { /* sin conexión: mantiene lo último */ }
  }

  // ---------- Celebración a pantalla completa cuando se reporta una mesa de Commander ----------
  const seen = new Set();
  let primed = false;
  const queue = [];
  let showing = false;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const seenB = new Set();
  // Avisos de eliminaciones del contador de vidas
  const seenK = new Set();
  let primedK = false;
  function killToasts(st) {
    for (const k of st.kills || []) {
      if (seenK.has(k.id)) continue;
      seenK.add(k.id);
      if (!primedK) continue;
      const d = document.createElement('div');
      d.className = 'tv-toast';
      d.innerHTML = `<b>Mesa ${esc(k.table)}</b>${k.killer ? `<span>${esc(k.killer)}</span> elimina a <span>${esc(k.victim)}</span>` : `<span>${esc(k.victim)}</span> queda fuera`}`;
      document.body.appendChild(d);
      requestAnimationFrame(() => d.classList.add('on'));
      setTimeout(() => { d.classList.remove('on'); setTimeout(() => d.remove(), 600); }, 6500);
    }
    primedK = true;
  }
  // Avisos de turnos largos (uno por turno)
  const seenS = new Set();
  function slowToasts(st) {
    for (const x of st.slow || []) {
      if (seenS.has(x.id)) continue;
      seenS.add(x.id);
      const d = document.createElement('div');
      d.className = 'tv-toast slow';
      d.innerHTML = `<b>Mesa ${esc(x.table)}</b>el turno de <span>${esc(x.name)}</span> ya lleva ${x.mins} min`;
      document.body.appendChild(d);
      requestAnimationFrame(() => d.classList.add('on'));
      setTimeout(() => { d.classList.remove('on'); setTimeout(() => d.remove(), 600); }, 8000);
    }
  }
  function celebrateNew(st) {
    killToasts(st);
    slowToasts(st);
    for (const b of st.claimed || []) {
      if (seenB.has(b.id)) continue;
      seenB.add(b.id);
      if (primed) queue.push({ bounty: b });
    }
    for (const t of st.live) {
      if (t.kind !== 'commander') continue;
      for (const pod of t.pods || []) {
        if (!pod.reported || seen.has(pod.id)) continue;
        seen.add(pod.id);
        if (primed) queue.push({ t, pod });
      }
    }
    primed = true;
    next();
  }
  // Mogudeck: mascota propia, una bola de pelo con su mano de cartas.
  // Todo cuelga del cuerpo: el mechón y los brazos nacen dentro de él y las cartas van en la pata.
  const fluff = (cx, cy, r, n, rr, fill) => Array.from({ length: n }, (_, i) => { const a = i / n * Math.PI * 2; return `<circle cx="${(cx + Math.cos(a) * r).toFixed(1)}" cy="${(cy + Math.sin(a) * r).toFixed(1)}" r="${rr}" fill="${fill}"/>`; }).join('');
  const limb = (d, w) => `<path d="${d}" stroke="#111" stroke-width="${w + 8}" fill="none" stroke-linecap="round"/><path d="${d}" stroke="#fff3e3" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
  const CREAM = '#fff3e3';
  const JUPI = `<svg class="cel-jupi" viewBox="0 20 260 270" aria-hidden="true">
    <defs><radialGradient id="mgfloor"><stop offset="0" stop-color="#f47700" stop-opacity=".55"/><stop offset="1" stop-color="#f47700" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="130" cy="272" rx="150" ry="26" fill="url(#mgfloor)"/>
    <ellipse class="mg-shadow" cx="130" cy="272" rx="74" ry="11" fill="#000" opacity=".55"/>
    <g class="mg-dust in"><circle cx="78" cy="266" r="12"/><circle cx="182" cy="266" r="12"/><circle cx="60" cy="262" r="8"/><circle cx="200" cy="262" r="8"/></g>
    <g class="mg-dust hop"><circle cx="82" cy="266" r="9"/><circle cx="178" cy="266" r="9"/></g>
    <g class="mg-enter"><g class="mg-hop">
      <ellipse cx="100" cy="259" rx="23" ry="13" fill="${CREAM}" stroke="#111" stroke-width="4"/><ellipse cx="160" cy="259" rx="23" ry="13" fill="${CREAM}" stroke="#111" stroke-width="4"/>
      ${fluff(130, 176, 78, 30, 15, '#111')}${fluff(130, 176, 78, 30, 11, CREAM)}<circle cx="130" cy="176" r="79" fill="${CREAM}"/>
      ${fluff(130, 176, 64, 18, 7, '#f6e2c8')}<circle cx="130" cy="180" r="62" fill="${CREAM}"/>
      <g class="mg-tuft"><path d="M118 104 q-4 -22 10 -30 q-6 14 6 18 q2 -16 16 -18 q-10 12 -2 30" fill="${CREAM}" stroke="#111" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/></g>
      <ellipse cx="130" cy="228" rx="32" ry="17" fill="#ffd9b0"/>
      <g class="cel-face"><g class="cel-eyes"><ellipse cx="106" cy="172" rx="12" ry="15" fill="#111"/><ellipse cx="154" cy="172" rx="12" ry="15" fill="#111"/>
        <circle cx="110" cy="166" r="4.5" fill="#fff"/><circle cx="158" cy="166" r="4.5" fill="#fff"/><circle cx="102" cy="178" r="2" fill="#fff"/><circle cx="150" cy="178" r="2" fill="#fff"/></g>
        <path d="M120 188 q5 7 10 0 q5 7 10 0" fill="none" stroke="#111" stroke-width="3.5" stroke-linecap="round"/>
        <ellipse cx="88" cy="190" rx="9" ry="5" fill="#ff8f8f" opacity=".7"/><ellipse cx="172" cy="190" rx="9" ry="5" fill="#ff8f8f" opacity=".7"/></g>
      <g class="mg-arm l">${limb('M84 204 Q60 190 50 160', 20)}</g>
      <g class="mg-arm r"><g class="mg-fan">${[-32, -16, 0, 16, 32].map((r, i) => `<g transform="rotate(${r} 214 150)"><rect x="200" y="96" width="28" height="42" rx="4" fill="${i % 2 ? '#f47700' : '#fff'}" stroke="#111" stroke-width="4"/><circle cx="214" cy="117" r="5" fill="${i % 2 ? '#fff' : '#f47700'}"/></g>`).join('')}</g>
        ${limb('M176 204 Q200 190 212 152', 20)}</g>
    </g></g>
  </svg>`;
  function confetti(box) {
    if (reduce) return;
    const cols = ['#f47700', '#ffd23f', '#ffffff', '#ff9a3c', '#111'];
    let h = '';
    for (let i = 0; i < 90; i++) {
      const w = 0.6 + Math.random() * 0.9;
      h += `<i style="left:${Math.random() * 100}%;width:${w}vh;height:${w * (1.6 + Math.random())}vh;background:${cols[i % cols.length]};animation-delay:${(0.5 + Math.random() * 2.2).toFixed(2)}s;animation-duration:${(2.6 + Math.random() * 2.4).toFixed(2)}s;--x:${(Math.random() * 30 - 15).toFixed(1)}vw;--r:${Math.round(Math.random() * 1080 - 540)}deg"></i>`;
    }
    box.insertAdjacentHTML('beforeend', `<div class="cel-confetti">${h}</div>`);
  }
  function next() {
    if (showing || !queue.length) return;
    showing = true;
    const item = queue.shift();
    if (item.bounty) return showBounty(item.bounty);
    const { t, pod } = item;
    const win = pod.players.find(p => p.id === pod.winner);
    const others = pod.players.filter(p => !win || p.id !== win.id).map(p => esc(p.name));
    const list = others.length > 1 ? others.slice(0, -1).join(', ') + ' y ' + others[others.length - 1] : others.join('');
    const o = document.createElement('div');
    o.className = 'cel' + (win ? '' : ' draw') + (reduce ? ' still' : '');
    o.setAttribute('role', 'status');
    o.innerHTML = `<div class="cel-rays"></div><div class="cel-in">${JUPI}
      <div class="cel-kick">${esc(t.name)} · Mesa ${esc(pod.table)}</div>
      ${win ? `<div class="cel-name">${esc(win.name)}</div><div class="cel-sub">¡gana la mesa!${win.deck ? ` <b>${esc(win.deck)}</b>` : ''}</div><div class="cel-vs">contra ${list}</div>`
        : `<div class="cel-name">¡Empate!</div><div class="cel-vs">${list}</div>`}</div>`;
    document.body.appendChild(o);
    if (win) confetti(o);
    requestAnimationFrame(() => o.classList.add('on'));
    setTimeout(() => { o.classList.remove('on'); o.classList.add('off'); }, queue.length ? 5200 : 7000);
    setTimeout(() => { o.remove(); showing = false; next(); }, queue.length ? 5800 : 7600);
  }
  function showBounty(b) {
    const o = document.createElement('div');
    o.className = 'cel bounty' + (reduce ? ' still' : '');
    o.setAttribute('role', 'status');
    o.innerHTML = `<div class="cel-rays"></div><div class="cel-in">${JUPI}
      <div class="cel-kick">¡Recompensa cobrada!</div><div class="cel-name">${esc(b.winner)}</div>
      <div class="cel-sub">ha derrotado a ${esc(b.target)}</div><div class="cel-vs">y se lleva <b>${esc(b.reward)}</b></div></div>`;
    document.body.appendChild(o);
    confetti(o);
    requestAnimationFrame(() => o.classList.add('on'));
    setTimeout(() => { o.classList.remove('on'); o.classList.add('off'); }, 7000);
    setTimeout(() => { o.remove(); showing = false; next(); }, 7600);
  }
  // Vista previa: /tv?fiesta=1 (mesa) o /tv?fiesta=2 (recompensa)
  if (/[?&]fiesta=2/.test(location.search)) setTimeout(() => { queue.push({ bounty: { winner: 'Luis Mora', target: 'Marta Ruiz', reward: 'Un sobre' } }); next(); }, 1200);
  if (/[?&]fiesta=1/.test(location.search)) setTimeout(() => {
    queue.push({ t: { name: 'Commander de los viernes' }, pod: { id: -1, table: 3, winner: 1, players: [{ id: 1, name: 'Marta Ruiz', deck: "Atraxa, Praetors' Voice" }, { id: 2, name: 'Luis Mora' }, { id: 3, name: 'Bea Gil' }, { id: 4, name: 'Iván Gil' }] } });
    next();
  }, 1200);

  // Llamadas a juez: aviso fijo hasta que la tienda lo marque como atendido
  const jb = document.createElement('div'); jb.className = 'tv-judge'; jb.setAttribute('role', 'alert'); document.body.appendChild(jb);
  function judgeBanner(st) {
    const j = st.judge || [];
    jb.innerHTML = j.length ? `<b>Juez</b>${j.map(x => `<span>Mesa ${esc(x.table)}</span>`).join('')}<em>${j.length === 1 ? 'llama a un juez' : 'llaman a un juez'}</em>` : '';
    jb.classList.toggle('on', !!j.length);
  }
  // Cuenta atrás grande en los últimos 5 minutos y aviso a pantalla completa al llegar a 5:00 y a 0:00
  const bc = document.createElement('div'); bc.className = 'tv-bigclock'; document.body.appendChild(bc);
  const flashed = new Set();
  function flash(txt, cls) {
    const o = document.createElement('div'); o.className = `tv-flash ${cls || ''}`; o.innerHTML = `<b>${txt}</b>`;
    document.body.appendChild(o); requestAnimationFrame(() => o.classList.add('on'));
    setTimeout(() => { o.classList.remove('on'); setTimeout(() => o.remove(), 700); }, 6000);
  }
  function bigClock() {
    const ts = (state ? state.live : []).filter(t => t.timerEnd && t.status !== 'finished' && t.status !== 4);
    let best = null;
    for (const t of ts) { const ms = new Date(t.timerEnd) - Date.now(); if (ms > -60000 && (!best || ms < best.ms)) best = { t, ms }; }
    if (!best || best.ms > 5 * 60000) { bc.classList.remove('on'); return; }
    const k5 = best.t.timerEnd + ':5', k0 = best.t.timerEnd + ':0';
    if (best.ms <= 5 * 60000 && best.ms > 4.5 * 60000 && !flashed.has(k5)) { flashed.add(k5); flash('¡Quedan 5 minutos!'); }
    if (best.ms <= 0 && best.ms > -20000 && !flashed.has(k0)) { flashed.add(k0); flash('¡Tiempo!', 'over'); }
    bc.classList.add('on'); bc.classList.toggle('over', best.ms <= 0);
    bc.innerHTML = `<small>${esc(best.t.name)}</small>${best.ms <= 0 ? 'Tiempo' : mm(best.ms)}`;
  }
  setInterval(bigClock, 1000);
  load();
  setInterval(load, 8000);
  // Pasa sola cada «seconds»; con las flechas izquierda y derecha (o el mando de la tele) se cambia a mano y vuelve a contar desde ahí
  let timer = null;
  const step = d => { const n = Math.max(slides.length, 1); idx = ((idx + d) % n + n) % n; render(); };
  const restart = () => { clearInterval(timer); timer = setInterval(() => step(1), seconds * 1000); };
  restart();
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'MediaTrackNext') { e.preventDefault(); step(1); restart(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'MediaTrackPrevious') { e.preventDefault(); step(-1); restart(); }
  });
  setInterval(() => {
    const c = document.getElementById('clock');
    const s = slides[idx % slides.length];
    if (c && s && s.t) c.innerHTML = clock(s.t);
  }, 1000);
  document.addEventListener('dblclick', () => { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); });
})();
