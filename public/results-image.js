(function () {
  const d = window.__IMG;
  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const W = 1080, H = 1350;
  const topSel = document.getElementById('topn');
  const nameSel = document.getElementById('names');

  function fit(text, max, size, weight) {
    let s = size;
    do { ctx.font = `${weight} ${s}px Archivo, system-ui, sans-serif`; s -= 2; } while (ctx.measureText(text).width > max && s > 18);
  }

  function wrap(text, x, y, max, lh) {
    const words = String(text).split(' ');
    let line = '', lines = [];
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > max && line) { lines.push(line); line = w; } else line = t;
    }
    lines.push(line);
    lines.slice(0, 3).forEach((l, i) => ctx.fillText(l, x, y + i * lh));
    return Math.min(lines.length, 3) * lh;
  }

  function draw() {
    const n = Number(topSel.value);
    const real = nameSel.value === 'real';
    ctx.fillStyle = '#0f0f12'; ctx.fillRect(0, 0, W, H);
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, d.color + '55'); g.addColorStop(.55, '#0f0f1200');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = d.color; ctx.fillRect(0, 0, W, 16);

    ctx.fillStyle = '#ffffffaa'; ctx.font = '700 30px "Archivo Narrow", Archivo, sans-serif';
    ctx.fillText(d.game.toUpperCase() + '  ·  RESULTADOS', 80, 110);
    ctx.fillStyle = '#fff'; ctx.font = '800 70px Archivo, sans-serif';
    let y = 200;
    y += wrap(d.name, 80, y, W - 160, 78);
    ctx.fillStyle = '#ffffffaa'; ctx.font = '600 32px Archivo, sans-serif';
    ctx.fillText(`${d.date} · ${d.players} jugadores`, 80, y + 10);
    y += 90;

    const rows = d.standings.slice(0, n);
    const medal = ['#f5c542', '#cfd6df', '#d08a4b'];
    const rowH = Math.min(190, Math.floor((H - y - 170) / Math.max(n, 1)));
    rows.forEach((s, i) => {
      const top = y + i * rowH;
      ctx.fillStyle = i === 0 ? d.color + '33' : '#ffffff0d';
      ctx.beginPath(); ctx.roundRect(80, top, W - 160, rowH - 14, 18); ctx.fill();
      ctx.fillStyle = medal[i] || '#ffffff88';
      ctx.font = `800 ${Math.round(rowH * 0.5)}px Archivo, sans-serif`;
      ctx.fillText(String(s.rank), 110, top + rowH * 0.62);
      ctx.fillStyle = '#fff';
      const name = real ? (d.real[i] || s.name) : s.name;
      fit(name, W - 520, Math.round(rowH * (i === 0 ? 0.46 : 0.4)), 800);
      ctx.fillText(name, 220, top + rowH * 0.6);
      ctx.fillStyle = '#ffffffaa'; ctx.font = `600 ${Math.round(rowH * 0.3)}px "Archivo Narrow", Archivo, sans-serif`;
      ctx.textAlign = 'right'; ctx.fillText(s.record || '', W - 110, top + rowH * 0.56); ctx.textAlign = 'left';
    });
    if (!rows.length) { ctx.fillStyle = '#ffffff88'; ctx.font = '600 36px Archivo'; ctx.fillText('Sin clasificación todavía', 80, y + 60); }

    ctx.fillStyle = '#fff'; ctx.font = '800 38px Archivo, sans-serif';
    ctx.fillText(d.store, 80, H - 80);
    ctx.fillStyle = d.accent || d.color; ctx.fillRect(80, H - 60, 120, 6);
  }

  document.fonts && document.fonts.ready.then(draw);
  draw();
  topSel.onchange = draw; nameSel.onchange = draw;
  document.getElementById('dl').onclick = () => {
    const a = document.createElement('a');
    a.download = 'resultados-' + d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '.png';
    a.href = cv.toDataURL('image/png');
    a.click();
  };
})();
