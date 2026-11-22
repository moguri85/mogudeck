// Cierra el menú lateral al navegar en móvil
document.addEventListener('click', e => {
  if (e.target.closest('.sidenav a')) document.body.classList.remove('navopen');
});

// Buscador de jugadores (fichas) con sugerencias: rellena un campo oculto con la clave de la ficha elegida
(function () {
  const B = window.__BASE || '';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const G = { StarWarsUnlimited: 'SWU', CyberpunkTCG: 'Cyberpunk', MagicTheGathering: 'Magic', Riftbound: 'Riftbound', commander: 'Commander' };
  document.querySelectorAll('input.person-pick').forEach(inp => {
    const box = inp.closest('.ppick');
    const hid = box.querySelector(`input[type=hidden][name="${inp.dataset.field}"]`);
    const free = inp.dataset.free === '1';
    let list = null, items = [], sel = -1, timer = null, seq = 0;
    const close = () => { if (list) list.remove(); list = null; sel = -1; };
    const choose = it => {
      hid.value = it.key; inp.value = it.name; inp.classList.add('picked'); close();
      inp.title = it.usernames.length ? it.usernames.map(u => '@' + u).join(' ') : '';
    };
    const paint = () => {
      if (!list) { list = document.createElement('ul'); list.className = 'ppick-list'; box.appendChild(list); }
      list.innerHTML = items.map((it, i) => `<li data-i="${i}" class="${i === sel ? 'on' : ''}"><span><b>${esc(it.name)}</b>${it.usernames.length ? ` <small>${it.usernames.map(u => '@' + esc(u)).join(' ')}</small>` : ''}</span>
        <small>${it.events} evento${it.events === 1 ? '' : 's'} · ${it.games.map(g => G[g] || g).join(', ')}${it.score >= 0.75 && it.score < 1 ? ' · ' + esc(it.why) : ''}</small></li>`).join('')
        + (free ? `<li data-i="-1" class="newp ${sel === items.length ? 'on' : ''}">＋ Añadir «${esc(inp.value.trim())}» como jugador nuevo</li>` : '');
      if (!items.length && !free) list.innerHTML = '<li class="newp">Sin resultados</li>';
    };
    inp.addEventListener('input', () => {
      hid.value = ''; inp.classList.remove('picked');
      clearTimeout(timer);
      const q = inp.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        const ex = inp.dataset.exclude ? '&excluir=' + encodeURIComponent(inp.dataset.exclude) : '';
        const r = await fetch(`${B}/admin/api/personas?q=${encodeURIComponent(q)}${ex}`).then(x => x.json()).catch(() => []);
        if (my !== seq) return;
        items = r; sel = -1;
        if (!items.length && free) { close(); return; }
        paint();
      }, 160);
    });
    inp.addEventListener('keydown', e => {
      if (!list) return;
      const max = items.length + (free ? 1 : 0);
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, max - 1); paint(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, -1); paint(); e.preventDefault(); }
      else if (e.key === 'Escape') close();
      else if (e.key === 'Enter' && sel >= 0) {
        e.preventDefault();
        if (sel < items.length) choose(items[sel]); else close();
      }
    });
    box.addEventListener('mousedown', e => {
      const li = e.target.closest('.ppick-list li[data-i]');
      if (!li) return;
      e.preventDefault();
      const i = Number(li.dataset.i);
      if (i >= 0) choose(items[i]); else close();
    });
    inp.addEventListener('blur', () => setTimeout(close, 150));
  });
})();

// Autocompletar línea a línea en el «Añadir varios de golpe»
(function () {
  const B = window.__BASE || '';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const G = { StarWarsUnlimited: 'SWU', CyberpunkTCG: 'Cyberpunk', MagicTheGathering: 'Magic', Riftbound: 'Riftbound', commander: 'Commander' };
  document.querySelectorAll('textarea.person-pick-multi').forEach(ta => {
    const box = ta.closest('.ppick');
    const hid = box.querySelector('input[type=hidden][name=picks]');
    const picks = {};
    let list = null, items = [], sel = -1, timer = null, seq = 0;
    const save = () => {
      // Solo se guardan las elecciones de líneas que siguen igual
      const lines = new Set(ta.value.split('\n').map(s => s.trim().replace(/\s+/g, ' ')));
      for (const k of Object.keys(picks)) if (!lines.has(k)) delete picks[k];
      hid.value = JSON.stringify(picks);
    };
    const cur = () => {
      const pos = ta.selectionStart, v = ta.value;
      const start = v.lastIndexOf('\n', pos - 1) + 1;
      let end = v.indexOf('\n', pos); if (end < 0) end = v.length;
      return { start, end, text: v.slice(start, end), line: v.slice(0, start).split('\n').length - 1 };
    };
    const close = () => { if (list) list.remove(); list = null; sel = -1; };
    const place = line => {
      const cs = getComputedStyle(ta);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45;
      const top = ta.offsetTop + parseFloat(cs.paddingTop) + (line + 1) * lh - ta.scrollTop + 4;
      list.style.top = Math.min(Math.max(top, ta.offsetTop + lh), ta.offsetTop + ta.offsetHeight + 4) + 'px';
    };
    const paint = line => {
      if (!list) { list = document.createElement('ul'); list.className = 'ppick-list'; box.appendChild(list); }
      list.innerHTML = items.map((it, i) => `<li data-i="${i}" class="${i === sel ? 'on' : ''}"><span><b>${esc(it.name)}</b>${it.usernames.length ? ` <small>${it.usernames.map(u => '@' + esc(u)).join(' ')}</small>` : ''}</span>
        <small>${it.events} evento${it.events === 1 ? '' : 's'} · ${it.games.map(g => G[g] || g).join(', ')}${it.score >= 0.75 && it.score < 1 ? ' · ' + esc(it.why) : ''}</small></li>`).join('')
        + '<li class="newp" data-i="-1">Seguir escribiendo = jugador nuevo · Esc para cerrar</li>';
      place(line);
    };
    const choose = it => {
      const c = cur();
      const v = ta.value;
      const after = v.slice(c.end);
      const addNl = after === '' ? '\n' : '';
      ta.value = v.slice(0, c.start) + it.name + addNl + after;
      const caret = c.start + it.name.length + (addNl ? 1 : 0);
      ta.setSelectionRange(caret, caret);
      picks[it.name] = it.key;
      close(); save(); ta.focus();
    };
    ta.addEventListener('input', () => {
      save();
      clearTimeout(timer);
      const c = cur();
      const q = c.text.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        const r = await fetch(`${B}/admin/api/personas?q=${encodeURIComponent(q)}`).then(x => x.json()).catch(() => []);
        if (my !== seq) return;
        items = r; sel = r.length && r[0].score >= 0.95 ? 0 : -1;
        if (!items.length) { close(); return; }
        paint(cur().line);
      }, 160);
    });
    ta.addEventListener('keydown', e => {
      if (!list) return;
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); paint(cur().line); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, -1); paint(cur().line); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); e.preventDefault(); }
      else if (e.key === "Tab" && items.length) { e.preventDefault(); choose(items[Math.max(sel, 0)]); }
      else if (e.key === "Enter" && sel >= 0) { e.preventDefault(); choose(items[sel]); }
      else if (e.key === 'Enter') close();
    });
    box.addEventListener('mousedown', e => {
      const li = e.target.closest('.ppick-list li[data-i]');
      if (!li) return;
      e.preventDefault();
      const i = Number(li.dataset.i);
      if (i >= 0) choose(items[i]); else close();
    });
    ta.addEventListener('blur', () => setTimeout(close, 150));
    ta.addEventListener('scroll', () => { if (list) place(cur().line); });
  });
})();

// Commander por puestos: tocar los nombres por orden de llegada asigna 1º, 2º, 3º…
document.querySelectorAll('form[data-places]').forEach(f => {
  const sels = [...f.querySelectorAll('select[name^="place_"]')];
  const mark = () => f.querySelectorAll('[data-seat]').forEach(s => { const v = s.querySelector('select').value; s.classList.toggle('placed', !!v); s.dataset.place = v ? v + 'º' : ''; });
  f.addEventListener('click', e => {
    const seat = e.target.closest('[data-seat]');
    if (!seat || e.target.closest('select') || seat.querySelector('select').disabled) return;
    const sel = seat.querySelector('select');
    if (sel.value) { sel.value = ''; mark(); return; }
    const used = new Set(sels.map(s => s.value).filter(Boolean).map(Number));
    let n = 1; while (used.has(n)) n++;
    if (n <= sels.length) sel.value = String(n);
    // Si solo falta uno, se le pone el último puesto
    const left = sels.filter(s => !s.value);
    if (left.length === 1) { const u = new Set(sels.map(s => s.value).filter(Boolean).map(Number)); let m = 1; while (u.has(m)) m++; left[0].value = String(m); }
    mark();
  });
  f.addEventListener('change', mark);
  mark();
});

// Vista grande de una carta al pasar el ratón por su nombre o su foto
(function () {
  const tip = document.getElementById('cardtip');
  if (!tip || !window.matchMedia('(hover: hover)').matches) return;
  const img = tip.querySelector('img');
  let cur = null;
  const place = e => {
    const w = tip.offsetWidth || 280, h = tip.offsetHeight || 390;
    let x = e.clientX + 18, y = e.clientY - h / 2;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 18;
    y = Math.max(8, Math.min(y, window.innerHeight - h - 8));
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  };
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-card]');
    if (!el || !el.dataset.card) { if (cur && !e.target.closest('#cardtip')) { tip.hidden = true; cur = null; } return; }
    if (el === cur) return;
    cur = el;
    img.onload = () => { if (cur === el) { tip.hidden = false; place(e); } };
    img.onerror = () => { tip.hidden = true; };
    img.src = el.dataset.card;
    if (img.complete && img.naturalWidth) { tip.hidden = false; place(e); }
  });
  document.addEventListener('mousemove', e => { if (cur && !tip.hidden) place(e); });
  document.addEventListener('scroll', () => { tip.hidden = true; cur = null; }, { passive: true });
})();

// Marca la sección actual en el menú público
(function () {
  const B = window.__BASE || '';
  const here = location.pathname.replace(B, '') || '/';
  const q = location.search;
  const cmdPage = /^\/commander\//.test(here) || /juego=commander/.test(q);
  document.querySelectorAll('.jnav a[data-nav], .tabbar a[data-nav]').forEach(a => {
    const [p, s] = a.dataset.nav.split('?');
    const match = s ? cmdPage
      : p === '/' ? !cmdPage && (here === '/' || /^\/(t|mesa|jugador)\//.test(here))
      : here.startsWith(p);
    if (match) a.setAttribute('aria-current', 'page');
  });
})();

// El aviso de «Deshacer» va directamente en <body> para quedar por encima de todo
document.querySelectorAll('.undo-toast').forEach(t => document.body.appendChild(t));

// Menús ⋯ (details.pmenu): se abren flotando sobre la página para que no los corte una tabla con scroll
(function () {
  function place(d) {
    const box = d.querySelector(':scope > div'); if (!box) return;
    const r = d.querySelector('summary').getBoundingClientRect();
    box.style.position = 'fixed'; box.style.right = 'auto';
    const w = box.offsetWidth, h = box.offsetHeight;
    let left = Math.min(r.right - w, window.innerWidth - w - 8); left = Math.max(8, left);
    let top = r.bottom + 4; if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    box.style.left = left + 'px'; box.style.top = top + 'px';
  }
  document.addEventListener('toggle', e => {
    const d = e.target;
    if (!d.classList || !d.classList.contains('pmenu') || !d.open) return;
    document.querySelectorAll('details.pmenu[open]').forEach(o => { if (o !== d) o.open = false; });
    place(d);
  }, true);
  const closeAll = () => document.querySelectorAll('details.pmenu[open]').forEach(o => { o.open = false; });
  const replace = () => document.querySelectorAll('details.pmenu[open]').forEach(place);
  window.addEventListener('scroll', replace, { passive: true, capture: true });
  window.addEventListener('resize', replace);
  document.addEventListener('click', e => { if (!e.target.closest('details.pmenu')) closeAll(); });
})();
