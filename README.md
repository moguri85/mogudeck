# Torneos de la tienda (Melee.gg)

Web de apoyo para organizar torneos de Star Wars: Unlimited, Cyberpunk TCG y cualquier otro juego en Melee.gg.
Lee la API de Melee (solo lectura) y guarda todo en SQLite.

## Qué incluye

**Panel de gestión (`/admin`, con usuarios Admin y Staff)**
- Inicio: botones de plantilla (abren la plantilla en Melee para usar *Duplicate*), torneos en juego con las mesas pendientes, próximos y borradores.
- Ficha de torneo: enlaces al controlador de Melee, inscritos y pagos, clasificación, mesas sin resultado en directo, checklist (antes/durante/después), premios entregados, caja, botón de aviso manual.
- Cartel A4 con QR, QR de cualquier enlace y hoja de QR para las mesas.
- Imagen de resultados 1080×1350 para Instagram.
- Calculadora de premios, rondas de suizo y corte a top.
- Liga por temporadas y juego (puntos configurables, se puede excluir algún torneo), también pública.
- Jugadores: historial, V-D-E, rivales frecuentes, nuevos e inactivos. Ficha editable (nick, otros nombres, notas).
- Vincular: une las fichas de una misma persona (Melee + apuntado a mano), con posibles duplicados, «No son la misma persona» y «Separar» para deshacer. Al apuntar a alguien en Commander sugiere fichas existentes y pregunta «¿Es X?» si hay una parecida.
- Meta por cartas separado en Leyendas, Cartas y Sideboard (o Líderes y Bases en SWU), también público en /meta con imagen pequeña y enlace a la ficha de cyberpunktcg.com en Cyberpunk TCG (activable en Ajustes). A partir de las decklists de Melee (% de mazos, copias, Top 4, % de victorias) y por nombre de mazo; en Commander, por cartas de los mazos validados y por comandante.
- Caja por fechas con exportación CSV.
- Guía rápida de Melee.
- Avisos automáticos a Discord y Telegram: torneo nuevo, emparejamientos de cada ronda, resultados finales.

**Commander (multijugador, sin Melee)**
- Inscripción en Melee (se importan los inscritos con un botón) o a mano; altas tardías y drops.
- Mesas de 4 y 3, nunca de 2 (máximo de mesas de 4; con 5 jugadores, una de 5). Las de 3 van al final de la clasificación (configurable).
- Puntos configurables por evento con patrones: solo el ganador (por defecto 4 en mesa de 4 y 3 en mesa de 3, más puntos por perder) o por puestos (p. ej. 3-2-1-0). Sin empates en las mesas. Con puestos, la tienda toca los nombres por orden de llegada y los jugadores pueden enviar el orden desde el móvil. El turno de salida (quién empieza) va rotando.
- Suizo por puntos evitando repetir rivales; intercambio manual de jugadores; deshacer ronda; mesa final Top 4 opcional.
- Clasificación solo por puntos (empatados comparten puesto). Melee sigue usando sus desempates oficiales PGO%, JGE% y JGO% en el resto de torneos.
- Reloj de ronda, página pública con «¿dónde juego?» (mesa y orden de turno), TV, hoja imprimible y avisos.

**Más**
- Diseño «reverso de carta»: cuero, óvalo azul y dorado; títulos en Young Serif y texto en Atkinson Hyperlegible Next.
- Check-in con QR en Commander (imprimible) y drop de los no presentados antes de la ronda 1.
- Avisos personales por Telegram: el jugador pulsa «Avísame de mi mesa por Telegram» una vez y recibe su mesa en cada ronda (Melee y Commander).
- Legalidad de mazos de Commander (100 cartas, singleton, prohibidas, colores del comandante), opcional por evento.
- Commander: los jugadores pueden enviar el resultado de su mesa desde el móvil (la tienda lo confirma con un clic), apuntar su comandante (meta de Commander), duplicar evento, premios y caja.
- Commander sin cuentas: el primer móvil que actúa como un jugador se queda con él (📱). Desde el panel del evento (⋯) se puede liberar el móvil, borrar el comandante y el mazo, o bloquear los cambios desde el móvil; hay registro de actividad.
- Liga y Jugadores incluyen Commander. Perfil público de cada jugador (/jugador/…) con historial y estadísticas por juego.
- Texto de información (premios, reglas, horario) en cada torneo y evento.
- Imagen por juego subida desde Ajustes (por ejemplo el logo oficial), mostrada como logo sobre fondo oscuro.
- Funciones opcionales en Ajustes: Premios, Caja y Perfiles públicos.
- Bracket estimado de cada mazo (sistema oficial 1-5: Game Changers, destrucción masiva de tierras, turnos extra, combos de dos cartas; datos de Commander Spellbook con respaldo local) y bracket máximo por torneo de Commander, igual que el presupuesto.
- Las tierras básicas no cuentan nunca para el presupuesto, en cualquier idioma.
- Listas a prueba de errores: comandante arriba o abajo, cabeceras con o sin recuento (Moxfield, Archidekt, MTGA, MTGO), marcas *CMDR*/[Commander]; si la lista no dice cuál es, se deduce por tipo, identidad de color, compañeros (Partner, Background…) y posición, y se avisa; si sale 101 por el comandante repetido, no se cuenta dos veces.
- Valor de mazo (/valor-mazo): elige cualquier mazo preconstruido de Commander (lista de MTGJSON, con buscador, filtro por colores e símbolos de maná de cada mazo) y edítalo, pega la lista o sube el CSV de ManaBox; precio de la impresión más barata en Cardmarket (vía Scryfall). La base de precios se descarga entera de Scryfall una vez al día (Ajustes → Precios de cartas). En Commander se guarda en la ficha del jugador y se compara con el presupuesto del evento.
- Copias de seguridad automáticas diarias de la base de datos (Admin → Copias de seguridad).

**Público**
- `/`: torneos en juego, próximos (filtro por juego) y últimos resultados. Enlaza al calendario de eventos de la propia tienda (Ajustes).
- `/t/ID`: página del torneo con botón de inscripción, buscador «¿dónde juego?», emparejamientos, reloj y clasificación (se actualiza sola).
- `/mesa/N`: lo que se juega en la mesa N (para los QR pegados en las mesas).
- `/tv`: pantalla para la tele (emparejamientos, reloj, clasificación y próximos torneos con QR). `/tv/ID` fija un torneo. Doble clic para pantalla completa.
- `/liga`: clasificaciones de liga públicas.
- `/commander/ID` y `/tv/cID`: torneo de Commander.

## Instalación con Docker

```bash
git clone … torneos && cd torneos      # o copia la carpeta al servidor
cp .env.example .env && nano .env       # pon MELEE_CLIENT_ID, MELEE_CLIENT_SECRET y ADMIN_PASSWORD
mkdir -p data && chown 1000:1000 data   # el contenedor corre como usuario node (uid 1000)
docker compose up -d --build            # o docker-compose (v1)
docker compose logs -f torneos          # debe aparecer «Torneo detectado: …»
```

Proxy con nginx + HTTPS: `deploy/nginx.conf.example` (subdominio propio) o `deploy/nginx-subruta.conf.example` (en una ruta como `https://moguri.es/jupiter`, con `BASE_PATH=/jupiter` en el `.env`). Después entra en `/admin`, ve a **Ajustes** y rellena como mínimo
el nombre de la tienda y la **URL pública** (la usan los QR y los avisos).

Copia de seguridad: basta con la carpeta `data/` (`tienda.sqlite`). Con el contenedor parado o usando
`sqlite3 data/tienda.sqlite ".backup data/backup.sqlite"`.

## Puesta en marcha en la tienda

1. En Melee, crea un torneo **sin publicar** por cada tipo de evento (p. ej. «PLANTILLA SWU semanal») con todo configurado.
2. En **Plantillas**, crea una por cada uno y enlaza ese torneo (queda oculto en la web).
3. **QR y mesas** → imprime la hoja de QR de mesas una sola vez.
4. En la tele de la tienda abre `https://…/tv`.
5. **Ajustes** → webhook de Discord y/o bot de Telegram → «Enviar mensaje de prueba».
6. **Usuarios** → crea cuentas *Staff* para quien ayude en los torneos.

## Notas técnicas

- Sincronización: lista de torneos cada 10 min; torneos en juego cada 20 s (`SYNC_*` en `.env`).
- La API no devuelve la fecha de inicio: se lee de la página pública del torneo en Melee.
- Las credenciales de Melee solo viven en `.env`. No se guardan en la base de datos ni se muestran en la web.
- Nombres públicos: por defecto se muestra el usuario de Melee. El nombre real solo en el panel, salvo que se active en Ajustes.
- Desarrollo sin credenciales reales: `npm run mock` (Melee falso en :4010, credenciales `demo:demo`) y en otra terminal `npm run dev`.
