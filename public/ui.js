// Utilidades compartidas por las páginas públicas de torneo y Commander
window.UI = (function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } },
  };
  function timer(end) {
    if (!end) return '';
    const ms = new Date(end) - Date.now();
    if (ms < -30 * 60e3) return '';
    const neg = ms < 0, a = Math.abs(ms);
    return `<span class="lb-timer ${neg ? 'over' : ms < 5 * 60e3 ? 'warn' : ''}">${neg ? '+' : ''}${Math.floor(a / 60000)}:${String(Math.floor(a / 1000) % 60).padStart(2, '0')}</span><small class="lb-tl">${neg ? 'tiempo extra' : 'quedan'}</small>`;
  }
  function livebar({ title, end, done, total, note }) {
    const pct = total ? Math.round(done * 100 / total) : 0;
    return `<div class="livebar"><div class="lb-round">${title}</div><div class="lb-clock" data-end="${esc(end || '')}">${timer(end)}</div>
      <div class="lb-prog"><div class="lb-prog-t"><span>${done}/${total} ${note}</span><span class="lb-age" aria-live="polite">${ageText()}</span></div><div class="lb-bar"><i style="width:${pct}%"></i></div></div></div>`;
  }
  // Frescura de los datos: cuándo se actualizó por última vez y si hay conexión
  let lastOk = Date.now(), failing = false;
  function markOk() { lastOk = Date.now(); failing = false; }
  function markFail() { failing = true; }
  function ageText() {
    const s = Math.round((Date.now() - lastOk) / 1000);
    if (failing && s > 45) return 'Sin conexión · reintentando';
    return s < 10 ? 'Actualizado ahora' : s < 60 ? `Actualizado hace ${s} s` : `Actualizado hace ${Math.round(s / 60)} min`;
  }
  function tickClocks() {
    document.querySelectorAll('.lb-clock').forEach(el => { el.innerHTML = timer(el.dataset.end); });
    document.querySelectorAll('.lb-age').forEach(el => { el.textContent = ageText(); el.classList.toggle('off', failing && Date.now() - lastOk > 45000); });
  }
  function tabs(id, items, active) {
    return `<div class="tabs" role="tablist" data-tabs="${id}">${items.map(([k, l]) => `<button role="tab" data-k="${k}" class="${k === active ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  }
  function seg(id, items, active) {
    return `<div class="seg" data-seg="${id}">${items.map(([k, l]) => `<button data-k="${k}" class="${k === active ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  }
  const resLabel = { W: 'V', L: 'D', D: 'E', B: 'B', '?': '·' };
  function formDots(form, extra) {
    return `<span class="form">${form.map(f => `<i class="f-${f.res === 'B' ? 'W' : f.res}" title="Ronda ${f.r}">${extra ? extra(f) : resLabel[f.res]}</i>`).join('')}</span>`;
  }
  const trophy = '<svg class="ico-tr" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v3a4 4 0 0 1-8 0V4Z"/><path d="M8 5H5v1a3 3 0 0 0 3 3M16 5h3v1a3 3 0 0 1-3 3M12 11v4M9 20h6M10 15h4v5h-4z"/></svg>';
  const bell = '<svg class="ico-tg" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 4 3 11l6 2 2 6 3-4 5 4 2-15Z"/><path d="m9 13 9-6"/></svg>';
  function podium(rows) {
    const top = rows.slice(0, 3);
    if (!top.length) return '';
    return `<div class="podium">${top.map((r, i) => `<div class="pod-${i + 1}"><span class="pm">${i + 1}º</span><b>${esc(r.name)}</b><small>${r.points} pts · ${esc(r.record || r.match_record || '')}</small></div>`).join('')}</div>`;
  }
  // Selector «¿Quién eres?» con autocompletado
  function whoami(roster, current, listId, cta = 'Ver mi mesa') {
    return `<div class="who"><label for="who-in">¿Quién eres?</label>
      <div class="who-row"><input id="who-in" list="${listId}" placeholder="Escribe tu nombre o usuario de Melee" value="${esc(current || '')}" autocomplete="off">
      <button class="jbtn" id="who-ok">${cta}</button></div>
      <div class="who-msg" id="who-msg" role="alert" hidden></div>
      <datalist id="${listId}">${roster.map(p => `<option value="${esc(p.name)}">${p.username && p.username !== p.name ? esc(p.username) : ''}</option>`).join('')}</datalist></div>`;
  }
  function findPlayer(roster, text) {
    const q = norm(text);
    if (!q) return null;
    return roster.find(p => norm(p.name) === q || norm(p.username) === q)
      || (roster.filter(p => norm(p.name).includes(q) || norm(p.username).includes(q)).length === 1
        ? roster.find(p => norm(p.name).includes(q) || norm(p.username).includes(q)) : null);
  }
  // Nombres parecidos para cuando no encontramos al jugador
  function suggest(roster, text, n = 5) {
    const q = norm(text);
    if (!q) return [];
    const toks = q.split(/\s+/);
    const sc = p => {
      const a = norm(p.name), u = norm(p.username);
      let v = 0;
      for (const t of toks) {
        if (a.startsWith(t) || u.startsWith(t)) v += 3;
        else if (a.split(' ').some(w => w.startsWith(t)) || u.includes(t)) v += 2;
        else if (t.length >= 3 && (a.includes(t.slice(0, 3)) || u.includes(t.slice(0, 3)))) v += 1;
      }
      return v;
    };
    return roster.map(p => [sc(p), p]).filter(x => x[0] > 0).sort((x, y) => y[0] - x[0]).slice(0, n).map(x => x[1]);
  }
  // Conecta el selector «¿Quién eres?»: si no encuentra a nadie, lo dice y ofrece nombres parecidos
  function bindWho(roster, onPick) {
    const ok = document.getElementById('who-ok'), inp = document.getElementById('who-in'), msg = document.getElementById('who-msg');
    if (!ok || !inp) return;
    const go = () => {
      const p = findPlayer(roster, inp.value);
      if (p) return onPick(p);
      inp.classList.add('bad');
      if (!msg) return;
      const sug = suggest(roster, inp.value);
      msg.hidden = false;
      msg.innerHTML = (inp.value.trim() ? `No encuentro a «${esc(inp.value.trim())}» en este torneo.` : 'Escribe tu nombre o tu usuario de Melee.')
        + (sug.length ? ` ¿Eres…?<div class="who-sug">${sug.map((p, i) => `<button type="button" data-i="${i}">${esc(p.name)}${p.username && p.username !== p.name ? ` <small>${esc(p.username)}</small>` : ''}</button>`).join('')}</div>` : ' Prueba con el usuario de Melee con el que te inscribiste.');
      msg.querySelectorAll('[data-i]').forEach(b => b.onclick = () => onPick(sug[Number(b.dataset.i)]));
    };
    ok.onclick = go;
    inp.onkeydown = e => { if (e.key === 'Enter') go(); };
    inp.oninput = () => { inp.classList.remove('bad'); if (msg) msg.hidden = true; };
    inp.onchange = () => { if (findPlayer(roster, inp.value)) go(); };
  }
  return { esc, norm, store, timer, livebar, tickClocks, tabs, seg, formDots, podium, whoami, findPlayer, suggest, bindWho, markOk, markFail, resLabel, trophy, bell };
})();
