'use strict';
const { html } = require('./html');

const SECTIONS = [
  ['Antes del evento', [
    ['Crear el torneo desde una plantilla', [
      'En esta web, Inicio → pulsa la plantilla. Se abre su página de edición en Melee.',
      'Pulsa «Duplicate» (arriba a la derecha). Cambia nombre, fecha/hora y, si hace falta, el máximo de jugadores.',
      'Guarda y publícalo desde el controlador del torneo. En unos minutos aparece aquí con su QR y cartel.',
    ]],
    ['Eventos que se repiten cada semana', [
      'En Melee: Organization Dashboard → pestaña Tournaments → engranaje del torneo → «Set as Recurring».',
      'Elige semanal/mensual y fecha final (máximo 12 copias por vez). Puedes dejarlos publicados directamente.',
      'Ojo: cada copia es independiente; si te equivocas en el original hay que corregir cada copia.',
    ]],
    ['Compartir la inscripción', [
      'Ficha del torneo → «Cartel + QR» → Imprimir. El QR lleva a la página del torneo con el botón de inscripción.',
      'Si los avisos están configurados, Discord/Telegram reciben el torneo nuevo automáticamente.',
    ]],
  ]],
  ['Durante el evento', [
    ['Inscribir a alguien en mano', [
      'Controlador de Melee → pestaña de jugadores → añadir/registrar jugador (necesita cuenta Melee; para niños o invitados hay cuentas de invitado).',
    ]],
    ['Empezar rondas y temporizador', [
      'Controlador → empareja la ronda → publica emparejamientos → inicia el temporizador.',
      'La TV de la tienda (/tv) muestra emparejamientos, reloj y clasificación sola. Abre /tv en el navegador de la tele y pon pantalla completa (F11).',
      'Los jugadores pueden escanear el QR de su mesa para ver su partida.',
    ]],
    ['Resultados que faltan', [
      'En la ficha del torneo de esta web ves qué mesas no tienen resultado.',
      'Los jugadores pueden reportar desde la app de Melee; si no, introdúcelo tú en el controlador.',
      'Si el torneo no avanza de ronda casi siempre es porque falta algún resultado o confirmación.',
    ]],
    ['Corregir un resultado / drop / penalización', [
      'Controlador → partida → editar resultado (antes de emparejar la siguiente ronda).',
      'Drop: controlador → jugador → drop. No se le empareja en las rondas siguientes.',
      'Penalizaciones: controlador → jugador → penalización (queda en su historial).',
    ]],
  ]],
  ['Después del evento', [
    ['Cerrar y repartir premios', [
      'Termina la última ronda (o el top) en el controlador para que el torneo quede «Finalizado».',
      'En esta web: «Calcular premios» y apunta lo entregado en «Premios entregados» (sale en Caja).',
      '«Imagen resultados» genera la imagen para Instagram. Los resultados se publican solos en Discord/Telegram.',
    ]],
  ]],
];

module.exports = function guide() {
  return html`
    <p class="muted">Chuleta de lo que más se usa. Los nombres de botones pueden variar según el idioma de Melee.</p>
    ${SECTIONS.map(([title, items]) => html`<section class="panel"><h2>${title}</h2>
      ${items.map(([h, steps]) => html`<details><summary>${h}</summary><ol>${steps.map(s => html`<li>${s}</li>`)}</ol></details>`)}</section>`)}
    <section class="panel"><h2>Ayuda oficial</h2><ul>
      <li><a href="https://help.melee.gg/docs/cloning/" target="_blank" rel="noopener">Duplicar y torneos recurrentes</a></li>
      <li><a href="https://help.melee.gg/docs/tournament-setup-key-points/" target="_blank" rel="noopener">Configuración del torneo – puntos clave</a></li>
      <li><a href="https://help.melee.gg/docs/getting-started-with-melee-mobile/" target="_blank" rel="noopener">Gestionar desde el móvil (Melee Mobile)</a></li>
      <li><a href="https://help.melee.gg/docs/" target="_blank" rel="noopener">Toda la documentación de Melee</a></li></ul></section>`;
};
