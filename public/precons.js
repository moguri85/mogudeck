// Selector de mazos preconstruidos de Commander (todos los publicados): busca, filtra por colores y rellena
// el cuadro de la lista para poder editarla antes de calcular.
(function () {
  const B = window.__BASE || '';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const PIPS = { W: 'Blanco', U: 'Azul', B: 'Negro', R: 'Rojo', G: 'Verde', C: 'Incoloro' };
  // Símbolos de maná de Magic (de mana-font, MIT), en public/img/mana
  const sym = k => `<img class="mana" src="${B}/static/img/mana/${k}.svg" alt="${k}" title="${PIPS[k] || k}" loading="lazy">`;
  const pips = col => (col ? col.split('').map(sym).join('') : '');
  let all = null, loading = null;
  const load = () => loading || (loading = fetch(`${B}/precons.json`).then(r => r.json()).then(j => { all = j; return j; }).catch(() => { all = []; return []; }));

  document.querySelectorAll('[data-precons]').forEach(box => {
    const ta = document.getElementById(box.dataset.precons);
    if (!ta) return;
    box.innerHTML = `<button type="button" class="pc-trigger">
        <span class="pc-art"><span class="pc-ico">⧉</span></span>
        <span class="pc-txt"><b>Empezar desde un mazo preconstruido</b><small>Todos los mazos de Commander publicados · elige uno y edítalo</small></span>
        <span class="pc-go">Elegir</span></button>
      <div class="pc-panel" hidden role="dialog" aria-label="Mazos preconstruidos">
        <div class="pc-head"><div class="pc-search"><span>⌕</span><input type="search" placeholder="Busca por mazo, comandante, colección o año" autocomplete="off" spellcheck="false"></div>
          <button type="button" class="pc-close" aria-label="Cerrar">✕</button></div>
        <div class="pc-filters">${'WUBRGC'.split('').map(k => `<button type="button" data-col="${k}" title="${PIPS[k]}">${sym(k)}</button>`).join('')}
          <span class="pc-count"></span></div>
        <div class="pc-grid" role="listbox"></div></div>
      <div class="pc-msg"></div>`;
    const trig = box.querySelector('.pc-trigger'), panel = box.querySelector('.pc-panel'), inp = panel.querySelector('input');
    const grid = panel.querySelector('.pc-grid'), count = panel.querySelector('.pc-count'), msg = box.querySelector('.pc-msg');
    const cols = new Set();
    let items = [], sel = 0;

    const render = () => {
      const q = norm(inp.value).split(/\s+/).filter(Boolean);
      const res = (all || []).filter(p => {
        const h = norm(`${p.n} ${p.k || ''} ${p.c || ''} ${p.y || ''}`);
        if (!q.every(t => h.includes(t))) return false;
        if (cols.size) { const c = p.col || ''; for (const k of cols) if (!c.includes(k)) return false; if (cols.has('C') && c !== 'C') return false; }
        return true;
      });
      items = res.slice(0, 200);
      sel = Math.min(sel, Math.max(items.length - 1, 0));
      count.textContent = all ? `${res.length} de ${all.length} mazos` : 'Cargando…';
      grid.innerHTML = items.length ? items.map((p, i) => `<button type="button" role="option" class="pc-row ${i === sel ? 'on' : ''}" data-i="${i}">
          <span class="pc-mana">${pips(p.col)}</span>
          <span class="pc-meta"><b>${esc(p.n)}</b><small>${esc(p.k || '')}</small></span>
          <span class="pc-tags">${p.c ? `<em>${esc(p.c)}</em>` : ''}${p.y ? `<span>${esc(p.y)}</span>` : ''}</span></button>`).join('')
        : `<p class="pc-empty">${all && !all.length ? 'No se pudo cargar la lista de mazos. Prueba más tarde.' : 'Ningún mazo coincide con la búsqueda.'}</p>`;
    };
    const focusSel = () => { const el = grid.querySelector('.pc-row.on'); if (el) el.scrollIntoView({ block: 'nearest' }); };
    const open = async () => { panel.hidden = false; box.classList.add('open'); inp.focus(); render(); await load(); render(); };
    const close = () => { panel.hidden = true; box.classList.remove('open'); };
    const pick = async p => {
      if (ta.value.trim() && !confirm(`¿Cambiar la lista que ya hay por «${p.n}»?`)) return;
      close();
      msg.innerHTML = '<span class="pc-loading"></span> Cargando la lista…';
      try {
        const r = await fetch(`${B}/precons/${encodeURIComponent(p.f)}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'No se pudo cargar');
        ta.value = j.text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        trig.classList.add('picked');
        trig.querySelector('.pc-art').innerHTML = p.col ? `<span class="pc-mana big">${pips(p.col)}</span>` : '<span class="pc-ico">⧉</span>';
        trig.querySelector('.pc-txt').innerHTML = `<b>${esc(p.n)}</b><small>${esc(j.commander || p.k || '')} · ${j.cards} cartas${p.c ? ` · ${esc(p.c)}` : ''}${p.y ? ` · ${esc(p.y)}` : ''}</small>`;
        trig.querySelector('.pc-go').textContent = 'Cambiar';
        msg.textContent = 'Lista cargada abajo: cambia las cartas que quieras antes de calcular.';
        ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0;
      } catch (e) { msg.textContent = e.message; }
    };

    trig.addEventListener('click', () => (panel.hidden ? open() : close()));
    panel.querySelector('.pc-close').addEventListener('click', close);
    inp.addEventListener('input', () => { sel = 0; render(); });
    panel.querySelectorAll('[data-col]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.col;
      if (cols.has(k)) cols.delete(k); else cols.add(k);
      b.classList.toggle('on', cols.has(k)); sel = 0; render(); inp.focus();
    }));
    grid.addEventListener('click', e => { const t = e.target.closest('.pc-row'); if (t) pick(items[Number(t.dataset.i)]); });
    panel.addEventListener('keydown', e => {
      const mv = d => { e.preventDefault(); sel = Math.max(0, Math.min(items.length - 1, sel + d)); render(); focusSel(); };
      if (e.key === 'Escape') { close(); trig.focus(); }
      else if (e.key === 'ArrowDown') mv(1);
      else if (e.key === 'ArrowUp') mv(-1);
      else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); pick(items[sel]); }
    });
    document.addEventListener('mousedown', e => { if (!panel.hidden && !box.contains(e.target)) close(); });
  });
})();
