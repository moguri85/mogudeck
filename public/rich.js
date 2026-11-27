// Formato sencillo para los textos de la tienda (lo usan el servidor y el editor del admin):
// **negrita**, *cursiva*, ## Título, - lista, 1. lista numerada, [texto](https://enlace) y enlaces sueltos
(function (root) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const A = u => `<a href="${u}" rel="noopener nofollow" target="_blank">`;
  function inline(s) {
    return esc(s)
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `${A(u)}${t}</a>`)
      .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (m, p, u) => `${p}${A(u)}${u}</a>`)
      .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>');
  }
  function richMd(t) {
    const out = [];
    let para = [], list = null;
    const flushP = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
    const flushL = () => { if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; };
    for (const raw of String(t || '').replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      let m;
      if (!line) { flushP(); flushL(); continue; }
      if ((m = line.match(/^(#{1,4})\s+(.+)$/))) { flushP(); flushL(); const h = m[1].length > 2 ? 'h4' : 'h3'; out.push(`<${h}>${inline(m[2])}</${h}>`); continue; }
      if ((m = line.match(/^(?:[-•]|\*(?=\s))\s*(.+)$/)) || (m = line.match(/^(\d+)[.)]\s+(.+)$/))) {
        const tag = m.length === 3 ? 'ol' : 'ul', text = m.length === 3 ? m[2] : m[1];
        flushP(); if (list && list.tag !== tag) flushL(); if (!list) list = { tag, items: [] };
        list.items.push(text); continue;
      }
      flushL(); para.push(line);
    }
    flushP(); flushL();
    return out.join('');
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { richMd };
  else root.richMd = richMd;

  // Editor: barra de botones y vista previa para los <textarea class="rich">
  if (typeof document === 'undefined') return;
  function setup(ta) {
    if (ta.dataset.rich) return; ta.dataset.rich = '1';
    const bar = document.createElement('div'); bar.className = 'richbar';
    const prev = document.createElement('div'); prev.className = 'richprev calhtml';
    const wrapSel = (a, b, ph) => { const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e) || ph;
      ta.setRangeText(a + sel + b, s, e, 'end'); if (s === e) { ta.selectionStart = s + a.length; ta.selectionEnd = s + a.length + sel.length; } };
    const lines = pre => { const s = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1, e0 = ta.value.indexOf('\n', ta.selectionEnd); const e = e0 < 0 ? ta.value.length : e0;
      const block = ta.value.slice(s, e).split('\n').map((l, i) => (typeof pre === 'function' ? pre(i) : pre) + l.replace(/^(#{1,4}\s+|[-•*]\s+|\d+[.)]\s+)/, '')).join('\n');
      ta.setRangeText(block, s, e, 'select'); };
    const B = [['Negrita', '<b>N</b>', () => wrapSel('**', '**', 'texto')], ['Cursiva', '<i>C</i>', () => wrapSel('*', '*', 'texto')],
      ['Título', 'Título', () => lines('## ')], ['Lista', '• Lista', () => lines('- ')], ['Lista numerada', '1. Lista', () => lines(i => `${i + 1}. `)],
      ['Enlace', 'Enlace', () => wrapSel('[', '](https://)', 'texto')]];
    for (const [t, h, f] of B) { const b = document.createElement('button'); b.type = 'button'; b.title = t; b.innerHTML = h; b.onclick = () => { ta.focus(); f(); upd(); }; bar.appendChild(b); }
    const tg = document.createElement('button'); tg.type = 'button'; tg.className = 'richtoggle'; tg.textContent = 'Vista previa';
    tg.onclick = () => { prev.hidden = !prev.hidden; tg.classList.toggle('on', !prev.hidden); upd(); }; bar.appendChild(tg);
    prev.hidden = true;
    const upd = () => { if (!prev.hidden) prev.innerHTML = richMd(ta.value) || '<p class="muted">Vacío</p>'; };
    ta.addEventListener('input', upd);
    ta.parentNode.insertBefore(bar, ta); ta.after(prev);
  }
  const go = () => document.querySelectorAll('textarea.rich').forEach(setup);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})(this);
