(function () {
  const form = document.getElementById('calc');
  const out1 = document.getElementById('structure');
  const out2 = document.getElementById('split');
  const eur = v => v.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

  const SPLITS = {
    1: [100],
    2: [65, 35],
    4: [40, 25, 17.5, 17.5],
    8: [27, 18, 12, 12, 7.75, 7.75, 7.75, 7.75],
  };

  function structure(n) {
    const rounds = Math.max(2, Math.ceil(Math.log2(n)));
    let cut = 0;
    if (n >= 33) cut = 8; else if (n >= 17) cut = 8; else if (n >= 12) cut = 4;
    return { rounds, cut };
  }

  function calc() {
    const f = Object.fromEntries(new FormData(form));
    const n = Math.max(2, Number(f.players) || 0);
    const price = Number(f.price) || 0;
    const pct = Number(f.pct) || 0;
    const unit = Number(f.unit) || 0;
    const income = n * price;
    const pool = income * pct / 100 + (Number(f.extra) || 0);
    const st = structure(n);
    out1.innerHTML = `<table class="tbl"><tbody>
      <tr><td>Rondas de suizo</td><td class="num strong">${st.rounds}</td></tr>
      <tr><td>Corte a top</td><td class="num strong">${st.cut ? 'Top ' + st.cut : 'Sin corte'}</td></tr>
      <tr><td>Duración aprox. (50 min/ronda)</td><td class="num">${Math.round((st.rounds + (st.cut ? Math.log2(st.cut) : 0)) * 55 / 60 * 10) / 10} h</td></tr>
      <tr><td>Recaudación</td><td class="num">${eur(income)}</td></tr>
      <tr><td>Bote de premios</td><td class="num strong">${eur(pool)}</td></tr></tbody></table>`;

    let mode = f.mode;
    if (mode === 'auto') mode = n < 6 ? '1' : n < 9 ? '4' : n < 17 ? '4' : '8';
    let rows;
    if (mode === 'flat') {
      rows = [['Cada jugador', pool / n]];
    } else {
      const k = Math.min(Number(mode), n);
      const w = SPLITS[k] || SPLITS[4];
      rows = w.map((p, i) => [`${i + 1}º`, pool * p / 100]);
    }
    out2.innerHTML = `<table class="tbl"><thead><tr><th>Puesto</th><th class="num">Valor</th>${unit ? '<th class="num">Unidades</th>' : ''}</tr></thead><tbody>
      ${rows.map(([l, v]) => `<tr><td>${l}</td><td class="num strong">${eur(v)}</td>${unit ? `<td class="num">${Math.floor(v / unit)}</td>` : ''}</tr>`).join('')}</tbody></table>
      ${unit ? `<p class="small muted">Sobran ${eur(pool - rows.reduce((s, [, v]) => s + Math.floor(v / unit) * unit, 0) * (mode === 'flat' ? n : 1))} al redondear a unidades.</p>` : ''}`;
  }
  form.addEventListener('input', calc);
  calc();
})();
