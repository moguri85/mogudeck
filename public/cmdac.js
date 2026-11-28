// Autocompletar comandantes: cualquier <input data-cmd-ac> sugiere cartas que pueden ser comandante mientras se escribe
(function () {
  const B = window.__BASE || '';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let box = null, cur = null, items = [], sel = -1, t = null, seq = 0;
  function close() { if (box) box.remove(); box = null; items = []; sel = -1; }
  function place() {
    if (!box || !cur) return;
    const r = cur.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left + window.scrollX}px`, top: `${r.bottom + window.scrollY + 4}px`, width: `${Math.max(r.width, 220)}px` });
  }
  function show(list) {
    close();
    if (!list.length || document.activeElement !== cur) return;
    items = list;
    box = document.createElement('ul'); box.className = 'cmdac'; box.setAttribute('role', 'listbox');
    box.innerHTML = list.map((n, i) => `<li role="option" data-i="${i}">${esc(n)}</li>`).join('');
    box.addEventListener('mousedown', e => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pick(Number(li.dataset.i)); } });
    document.body.appendChild(box); place();
  }
  function pick(i) {
    if (!cur || items[i] == null) return;
    const v = cur.value, pre = v.includes('+') ? v.slice(0, v.lastIndexOf('+') + 1) + ' ' : '';
    cur.value = pre + items[i]; cur.dispatchEvent(new Event('change', { bubbles: true })); close();
  }
  function mark() { if (!box) return; [...box.children].forEach((li, i) => li.classList.toggle('on', i === sel)); }
  document.addEventListener('input', e => {
    const el = e.target; if (!el.matches || !el.matches('input[data-cmd-ac]')) return;
    cur = el; clearTimeout(t);
    const q = el.value.split('+').pop().trim(); // «A + B»: se busca lo último
    if (q.length < 3) { close(); return; }
    const my = ++seq;
    t = setTimeout(async () => {
      try {
        const j = await (await fetch(`${B}/vidas/carta.json?cmd=1&q=${encodeURIComponent(q)}`)).json();
        if (my !== seq) return;
        show([...new Set([j.name, ...(j.sug || []).map(x => x.name)].filter(Boolean))].slice(0, 8));
      } catch (er) { /* sin sugerencias */ }
    }, 220);
  });
  document.addEventListener('keydown', e => {
    if (!box || e.target !== cur) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); mark(); }
    else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); pick(sel); }
    else if (e.key === 'Escape') close();
  });
  document.addEventListener('focusout', e => { if (e.target === cur) setTimeout(close, 150); });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, { passive: true });
})();
