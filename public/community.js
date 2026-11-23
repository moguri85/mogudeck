(function () {
  const B = window.__BASE || '';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Buscador de jugadores (cara a cara)
  document.querySelectorAll('input.pub-pick').forEach(inp => {
    const hidden = inp.parentElement.querySelector(`input[type=hidden][name="${inp.dataset.field}"]`);
    const box = document.createElement('div');
    box.className = 'pp-list'; box.hidden = true; box.setAttribute('role', 'listbox');
    inp.parentElement.appendChild(box);
    let t = null, items = [], sel = -1;
    const pick = it => { inp.value = it.name; hidden.value = it.key; box.hidden = true; };
    const draw = () => {
      box.innerHTML = items.map((it, i) => `<button type="button" role="option" class="${i === sel ? 'on' : ''}" data-i="${i}">${esc(it.name)}</button>`).join('');
      box.hidden = !items.length;
    };
    box.addEventListener('mousedown', e => { const b = e.target.closest('button'); if (b) { e.preventDefault(); pick(items[Number(b.dataset.i)]); } });
    inp.addEventListener('input', () => {
      hidden.value = '';
      clearTimeout(t);
      const q = inp.value.trim();
      if (q.length < 2) { items = []; draw(); return; }
      t = setTimeout(async () => {
        try { items = await (await fetch(`${B}/personas.json?q=${encodeURIComponent(q)}`)).json(); sel = -1; draw(); } catch (e) { /* nada */ }
      }, 180);
    });
    inp.addEventListener('keydown', e => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
      else if (e.key === 'Enter' && sel >= 0) { pick(items[sel]); e.preventDefault(); }
      else if (e.key === 'Escape') box.hidden = true;
    });
    inp.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
  });
  const vs = document.querySelector('.vsform');
  if (vs) vs.addEventListener('submit', e => {
    const a = vs.querySelector('[name=a]').value, b = vs.querySelector('[name=b]').value;
    if (!a || !b) { e.preventDefault(); alert('Elige a los dos jugadores de la lista'); }
  });

  // Momentos: se reduce la foto en el móvil antes de subirla (y se quitan los datos de ubicación)
  const form = document.getElementById('momform'), file = document.getElementById('momfile'), prev = document.getElementById('momprev');
  if (form && file) {
    let blob = null;
    file.addEventListener('change', () => {
      blob = null;
      const f = file.files[0];
      if (!f) return;
      const img = new Image();
      img.onload = () => {
        const max = 1600, k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => { blob = b; prev.src = URL.createObjectURL(b); prev.hidden = false; }, 'image/jpeg', 0.85);
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(f);
    });
    form.addEventListener('submit', async e => {
      if (!blob) return; // sin reducir (navegador antiguo): se envía tal cual
      e.preventDefault();
      const fd = new FormData(form);
      fd.set('photo', blob, 'momento.jpg');
      const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Enviando…';
      try {
        const r = await fetch(form.action, { method: 'POST', body: fd, redirect: 'follow' });
        location.href = r.url;
      } catch (err) { btn.disabled = false; btn.textContent = 'Enviar a la TV'; alert('No se pudo enviar. Inténtalo de nuevo.'); }
    });
  }
})();
