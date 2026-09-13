/* Pilz Prognose – abstrahierte Choropleth.
   Je Wetterstation eine Voronoi-Region, eingefaerbt nach Score, auf die
   Deutschland-Form geclippt; Bundeslaender-Grenzen als Linien darueber.
   Umschalter zwischen Gesamtscore ('g') und Steinpilz ('s'). Benoetigt d3 v7. */

const W = 760, MARGIN = 10;     // Zeichenbreite in viewBox-Einheiten
let MODE = 'g';
let DATA = null, GEO = null;
let cellSel = null, stations = [], shownStation = null;

const svg = d3.select('#mapsvg');
const tooltip = d3.select('#tooltip');

// Score 0..10 -> Farbe (rot -> gelb -> gruen)
function color(score) {
  const t = Math.max(0, Math.min(10, score)) / 10;
  return `hsl(${120 * t} 65% 47%)`;
}
const fmt = x => (Math.round(x * 10) / 10).toFixed(1);

// --- Erklär-Dialog (unabhaengig von den Daten) ---
(function initHelp() {
  const overlay = document.getElementById('help-overlay');
  // Sichtbarkeit per Inline-Style erzwingen -> unabhaengig von CSS/Cache.
  const open = () => { overlay.hidden = false; overlay.style.display = 'flex'; };
  const close = () => { overlay.hidden = true; overlay.style.display = 'none'; };
  document.getElementById('help-btn').addEventListener('click', open);

  // Nur beim ersten Besuch automatisch zeigen; danach nur noch per Button.
  let seen = false;
  try { seen = localStorage.getItem('pk_help_seen') === '1'; } catch (e) { /* ignore */ }
  if (!seen) {
    open();
    try { localStorage.setItem('pk_help_seen', '1'); } catch (e) { /* ignore */ }
  } else {
    close();
  }
  document.getElementById('help-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.getElementById('help-more-btn').addEventListener('click', e => {
    document.getElementById('help-more').hidden = false;
    e.target.hidden = true;
  });

  // Validierungs-Abbildung auch oben in der Kurzfassung zeigen (Klon der unteren,
  // damit nur EINE Quelle gepflegt werden muss).
  const fig = document.getElementById('fig-validierung');
  const slot = document.getElementById('fig-validierung-top');
  if (fig && slot) {
    const clone = fig.cloneNode(true);
    clone.removeAttribute('id');
    slot.appendChild(clone);
  }
})();

Promise.all([
  fetch('data/bundeslaender.geojson').then(r => r.json()),
  fetch('data/scores.json', { cache: 'no-cache' }).then(r => r.json()),
]).then(([geo, data]) => {
  GEO = geo; DATA = data;
  build();
  setMode('g');
}).catch(err => {
  document.getElementById('status').textContent =
    'Daten konnten nicht geladen werden (' + err.message + ').';
});

function build() {
  const proj = d3.geoMercator().fitWidth(W, GEO);
  const path = d3.geoPath(proj);
  const [[x0, y0], [x1, y1]] = path.bounds(GEO);
  const vbW = (x1 - x0) + 2 * MARGIN, vbH = (y1 - y0) + 2 * MARGIN;
  svg.attr('viewBox', `${x0 - MARGIN} ${y0 - MARGIN} ${vbW} ${vbH}`);

  // Unsichtbare Hintergrund-Flaeche: faengt Klicks auf den leeren (schwarzen) Bereich ab
  // -> schliesst das Detail-Fenster. Liegt UNTER den Regionen (zuerst gezeichnet).
  svg.append('rect')
    .attr('x', x0 - MARGIN).attr('y', y0 - MARGIN)
    .attr('width', vbW).attr('height', vbH)
    .attr('fill', 'transparent')
    .attr('pointer-events', 'all')
    .on('click', closeDetail);

  // Stationen projizieren (nur sinnvolle Koordinaten)
  stations = DATA.stations.map(s => ({ st: s, p: proj([s.lon, s.lat]) }))
                          .filter(o => o.p && isFinite(o.p[0]) && isFinite(o.p[1]));
  const pts = stations.map(o => o.p);

  // Voronoi ueber die Stations-Punkte, begrenzt auf die Landflaeche
  const delaunay = d3.Delaunay.from(pts);
  const voro = delaunay.voronoi([x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN]);

  // Clip-Pfad = Deutschland-Umriss (alle Bundeslaender zusammen)
  const defs = svg.append('defs');
  defs.append('clipPath').attr('id', 'clip-de')
      .append('path').attr('d', path(GEO));

  // 1) Regionen, auf die Landflaeche geclippt
  const gCells = svg.append('g').attr('clip-path', 'url(#clip-de)');
  cellSel = gCells.selectAll('path').data(stations).join('path')
    .attr('d', (_d, i) => voro.renderCell(i))
    .attr('stroke', 'rgba(255,255,255,0.18)')
    .attr('stroke-width', 0.4)
    .style('cursor', 'pointer')
    .on('mousemove', onHover)
    .on('mouseleave', () => tooltip.attr('hidden', true))
    .on('click', (e, o) => { e.stopPropagation(); showDetail(o.st); });

  // 2) Bundeslaender-Grenzen als Linien
  svg.append('path').attr('d', path(GEO))
    .attr('fill', 'none')
    .attr('stroke', '#0b0f0c')
    .attr('stroke-width', 0.9)
    .attr('stroke-linejoin', 'round')
    .attr('pointer-events', 'none');

  document.getElementById('btn-g').addEventListener('click', () => setMode('g'));
  document.getElementById('btn-s').addEventListener('click', () => setMode('s'));
  document.getElementById('detail-close').addEventListener('click', closeDetail);
  // Klick auf die freie Flaeche (schwarzer Bereich / Karte) schliesst das Detail-Fenster;
  // Klicks im Fenster selbst nicht (stopPropagation), Regionen-Klicks oeffnen es weiterhin.
  document.getElementById('map').addEventListener('click', closeDetail);
  document.getElementById('detail').addEventListener('click', e => e.stopPropagation());
}

function closeDetail() {
  document.getElementById('detail').hidden = true;
  shownStation = null;
}

function block(st) { return st[MODE]; }

// Karte wird nach der Wetter-Komponente (0-5) eingefaerbt; Farbe auf 0-10 skaliert.
function recolor() {
  cellSel.attr('fill', o => {
    const b = block(o.st);
    return b ? color(b.wetter * 2) : '#5b5b5b';
  });
}

function onHover(event, o) {
  const b = block(o.st);
  tooltip.attr('hidden', null)
    .style('left', event.clientX + 'px')
    .style('top', event.clientY + 'px')
    .html(`<strong>${o.st.name}</strong>` +
          (b ? ` — Wetter ${fmt(b.wetter)}/5` : ' — keine Daten'));
}

function showDetail(st) {
  shownStation = st;
  const d = document.getElementById('detail');
  document.getElementById('d-name').textContent = st.name;
  const modeLabel = MODE === 'g' ? 'Alle Pilze' : 'Steinpilz';
  document.getElementById('d-bl').textContent =
    [st.bl, modeLabel].filter(Boolean).join(' · ');
  const active = block(st);
  // Saison (0-5) und Wetter (0-5) getrennt, untereinander; Farbe auf 0-10 skaliert
  const row = (label, val) => `
    <div class="d-row">
      <div class="d-head"><span class="d-lab">${label}</span>
        <span class="d-val" style="color:${color(val * 2)}">${fmt(val)}<small>/5</small></span></div>
      <span class="d-bar"><i style="width:${Math.max(0, Math.min(100, val / 5 * 100))}%;background:${color(val * 2)}"></i></span>
    </div>`;
  document.getElementById('d-scores').innerHTML = active
    ? row('Saison', active.saison) + row('Wetter', active.wetter)
    : '<p class="d-na-msg">Für dieses Modell liegen an dieser Station keine ausreichenden Wetterdaten vor.</p>';
  document.getElementById('d-txt').textContent = active ? active.txt : '';
  d.hidden = false;
}

function setMode(mode) {
  MODE = mode;
  for (const [id, m] of [['btn-g', 'g'], ['btn-s', 's']]) {
    const el = document.getElementById(id);
    el.classList.toggle('active', mode === m);
    el.setAttribute('aria-selected', mode === m);
  }
  if (cellSel) recolor();
  if (shownStation && !document.getElementById('detail').hidden) showDetail(shownStation);
  updateStatus();
}

function updateStatus() {
  if (!DATA) return;
  const label = MODE === 'g' ? 'Alle Pilze' : 'Steinpilz';
  const shown = DATA.stations.filter(s => s[MODE]).length;
  const gen = DATA.generated ? new Date(DATA.generated).toLocaleString('de-DE') : '';
  document.getElementById('status').textContent =
    `${label} · Stand ${DATA.target_date} · ${shown} Regionen` +
    (gen ? ` · aktualisiert ${gen}` : '');
}
