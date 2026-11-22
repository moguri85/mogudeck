// Check-in: el jugador elige su nombre y confirma que ha llegado
(function () {
  const { esc, store, whoami, findPlayer } = window.UI;
  const B = window.__BASE || '';
  const root = document.querySelector('.ckin');
  const box = document.getElementById('ckin-box');
  if (!root || !box) return;
  const id = root.dataset.id, code = root.dataset.code;
  const snap = window.__CSNAP;
  let me = null;
  const saved = store.get('mt_me_user');
  if (saved) me = findPlayer(snap.roster, saved);
  function render(msg) {
    if (!me) {
      box.innerHTML = whoami(snap.roster, '', 'ck-roster', 'Soy yo') + '<p class="small muted">¿No sales? Avisa al staff para que te apunte.</p>';
      const ok = document.getElementById('who-ok'), inp = document.getElementById('who-in');
      const go = () => { const p = findPlayer(snap.roster, inp.value); if (!p) { inp.classList.add('bad'); return; } me = p; store.set('mt_me_user', p.username || p.name); render(); };
      ok.onclick = go; inp.onkeydown = e => { if (e.key === 'Enter') go(); };
      return;
    }
    const here = (snap.roster.find(p => p.id === me.id) || {}).here;
    box.innerHTML = here || msg === 'ok'
      ? `<div class="ckin-ok"><span>✓</span><b>¡Hecho, ${esc(me.name)}!</b><p>Ya estás registrado. Tu mesa aparecerá en la página del evento cuando empiece la ronda 1.</p></div>`
      : `<div class="ckin-me"><p>Eres <b>${esc(me.name)}</b> <button class="link" id="ck-change">¿no eres tú?</button></p>
          <button class="jbtn big" id="ck-go">Estoy aquí</button><p class="small" id="ck-msg">${msg ? esc(msg) : ''}</p></div>`;
    const ch = document.getElementById('ck-change'); if (ch) ch.onclick = () => { me = null; store.set('mt_me_user', null); render(); };
    const go = document.getElementById('ck-go');
    if (go) go.onclick = async () => {
      const tk = `mt_tok_${id}_${me.id}`;
      const body = new URLSearchParams({ by: me.id, c: code });
      if (store.get(tk)) body.set('tok', store.get(tk));
      const r = await fetch(`${B}/commander/${id}/checkin`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return render(j.error || 'No se pudo hacer el check-in');
      if (j.tok) store.set(tk, j.tok);
      render('ok');
    };
  }
  render();
})();
