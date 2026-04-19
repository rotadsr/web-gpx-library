/**
 * GPX Route Editor
 * Full-screen modal for editing route metadata, track points, and raw XML.
 * Exposed API: Editor.open(route, gpxText)  Editor.close()  Editor.setup()
 */

const Editor = (() => {

  // ── State ───────────────────────────────────────────────────────────────────
  let eMap         = null;   // Leaflet map instance inside the editor
  let eLine        = null;   // track polyline
  let eMarkers     = [];     // array of L.marker for each track point
  let editPoints   = [];     // [{lat, lon, ele, time}] — working copy
  let selectedIdx  = null;   // index of the highlighted point, or null
  let saveCallback = null;   // onSaveToLibrary callback from app.js
  let currentRoute = null;   // the original route object passed to open()

  // ── Open / Close ────────────────────────────────────────────────────────────

  function open(route, gpxText, options = {}) {
    currentRoute = route;
    saveCallback = options.onSaveToLibrary || null;
    const modal = document.getElementById('editor-modal');
    modal.classList.add('is-open');

    // Pre-fill form
    document.getElementById('edit-name').value        = route.name        || '';
    document.getElementById('edit-description').value = route.description || '';
    document.getElementById('edit-author').value      = '';
    document.getElementById('edit-xml').value         = gpxText;
    document.getElementById('edit-author').classList.remove('field-required');

    // Parse track points + read activity stored in <trk><type>
    let parsedActivity = null;
    try {
      const parsed = GPXParser.parse(gpxText);
      editPoints = parsed.points.map(p => ({
        lat: p.lat, lon: p.lon, ele: p.ele ?? null, time: p.time ?? null,
      }));
      parsedActivity = parsed.metadata.activity || null;
    } catch (_) { editPoints = []; }

    // Set activity: route definition wins, then GPX <trk><type>, then empty
    const actSelect = document.getElementById('edit-activity');
    if (actSelect) actSelect.value = route.activity || parsedActivity || '';
    selectedIdx = null;

    // Always open on Info tab
    activateTab('info');

    // Map must init after the modal is visible in the DOM
    setTimeout(() => {
      initEditorMap();
      redraw();
      if (eLine) eMap.fitBounds(eLine.getBounds(), { padding: [30, 30] });
    }, 80);
  }

  function close() {
    document.getElementById('editor-modal').classList.remove('is-open');
    if (eMap) { eMap.remove(); eMap = null; }
    eLine = null; eMarkers = []; editPoints = []; selectedIdx = null;
    saveCallback = null; currentRoute = null;
  }

  // ── Editor Map ───────────────────────────────────────────────────────────────

  function initEditorMap() {
    if (eMap) { eMap.remove(); eMap = null; }
    eMap = L.map('editor-map', { zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(eMap);

    // Click on empty map → append point at end of track
    eMap.on('click', e => {
      editPoints.push({ lat: e.latlng.lat, lon: e.latlng.lng, ele: null, time: null });
      selectedIdx = null;
      redraw();
    });
  }

  function redraw() {
    eMarkers.forEach(m => m.remove());
    eMarkers = [];
    if (eLine) { eLine.remove(); eLine = null; }

    if (!editPoints.length) { updateCount(); return; }

    const lls = editPoints.map(p => [p.lat, p.lon]);
    eLine = L.polyline(lls, { color: '#3b82f6', weight: 3, opacity: 0.85 }).addTo(eMap);

    editPoints.forEach((pt, i) => {
      const first   = i === 0;
      const last    = i === editPoints.length - 1;
      const sel     = i === selectedIdx;
      const color   = first ? '#22c55e' : last ? '#ef4444' : '#3b82f6';
      const r       = (first || last) ? 10 : 7;

      const marker = L.marker([pt.lat, pt.lon], {
        draggable: true,
        icon: makeIcon(color, r, sel),
        zIndexOffset: (first || last || sel) ? 300 : 0,
      });

      // Live drag — update polyline without full redraw
      marker.on('drag', e => {
        const { lat, lng } = e.target.getLatLng();
        editPoints[i] = { ...editPoints[i], lat, lon: lng };
        if (eLine) eLine.setLatLngs(editPoints.map(p => [p.lat, p.lon]));
      });

      // Click on a point → select/deselect
      marker.on('click', e => {
        L.DomEvent.stopPropagation(e);
        selectedIdx = selectedIdx === i ? null : i;
        redraw();
      });

      marker.addTo(eMap);
      eMarkers.push(marker);
    });

    updateCount();
  }

  function makeIcon(color, r, selected) {
    const ring = selected
      ? 'box-shadow:0 0 0 3px #f59e0b,0 1px 5px rgba(0,0,0,.4)'
      : 'box-shadow:0 1px 4px rgba(0,0,0,.3)';
    const d = r * 2;
    return L.divIcon({
      className: '',
      html: `<div style="width:${d}px;height:${d}px;border-radius:50%;` +
            `background:${color};border:2.5px solid #fff;${ring};cursor:move"></div>`,
      iconSize:   [d, d],
      iconAnchor: [r, r],
    });
  }

  function updateCount() {
    const n   = editPoints.length;
    const el  = document.getElementById('edit-point-count');
    if (el) el.textContent = n === 0 ? 'No points' : `${n} point${n !== 1 ? 's' : ''}`;
    const del = document.getElementById('tool-delete-pt');
    if (del) del.disabled = selectedIdx === null;
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────────

  function activateTab(name) {
    document.querySelectorAll('.editor-tab').forEach(t =>
      t.classList.toggle('is-active', t.dataset.tab === name)
    );
    document.querySelectorAll('.editor-pane').forEach(p => {
      p.hidden = p.id !== `epane-${name}`;
    });
    if (name === 'xml') syncXML();
  }

  // ── XML sync ─────────────────────────────────────────────────────────────────

  function syncXML() {
    document.getElementById('edit-xml').value = buildGPX(
      document.getElementById('edit-name').value,
      document.getElementById('edit-description').value,
      document.getElementById('edit-author').value,
      editPoints,
    );
  }

  function applyXML() {
    const xml = document.getElementById('edit-xml').value;
    try {
      const parsed = GPXParser.parse(xml);
      editPoints = parsed.points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele ?? null, time: p.time ?? null }));
      if (parsed.metadata.name)
        document.getElementById('edit-name').value        = parsed.metadata.name;
      if (parsed.metadata.description)
        document.getElementById('edit-description').value = parsed.metadata.description;
      if (parsed.metadata.author)
        document.getElementById('edit-author').value      = parsed.metadata.author;
      selectedIdx = null;
      activateTab('info'); // switch to map view
      redraw();
      if (eLine) eMap.fitBounds(eLine.getBounds(), { padding: [30, 30] });
    } catch (e) {
      alert('Could not parse GPX XML:\n' + e.message);
    }
  }

  // ── GPX generation ────────────────────────────────────────────────────────────

  function buildGPX(name, desc, author, pts) {
    const x   = s => String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const now    = new Date().toISOString();
    const actKey = document.getElementById('edit-activity')?.value || '';

    const trkpts = pts.map(p => {
      let s = `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">`;
      if (p.ele != null) s += `\n        <ele>${parseFloat(p.ele).toFixed(1)}</ele>`;
      if (p.time) {
        const t = p.time instanceof Date ? p.time.toISOString() : p.time;
        s += `\n        <time>${t}</time>`;
      }
      s += '\n      </trkpt>';
      return s;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Library Editor"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${x(name)}</name>
    <desc>${x(desc)}</desc>
    <author><name>${x(author)}</name></author>
    <time>${now}</time>
  </metadata>
  <trk>
    <name>${x(name)}</name>${actKey ? `\n    <type>${x(actKey)}</type>` : ''}
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
  }

  // ── Save to Library ───────────────────────────────────────────────────────────

  async function saveToLibrary() {
    if (!saveCallback) return;

    const name   = document.getElementById('edit-name').value.trim() || 'Untitled Route';
    const desc   = document.getElementById('edit-description').value.trim();
    const author = document.getElementById('edit-author').value.trim();
    const actKey = document.getElementById('edit-activity')?.value || '';
    const gpxText = buildGPX(name, desc, author, editPoints);

    const btn = document.getElementById('save-to-library-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    const ok = await saveCallback({
      name,
      description: desc,
      activity:    actKey || undefined,
      tags:        currentRoute?.tags || [],
      gpxText,
    });

    if (ok !== false) {
      btn.textContent = '✓ Saved!';
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = SVG_SAVE_ICON + ' Save to Library';
      }, 1800);
    } else {
      btn.disabled = false;
      btn.innerHTML = SVG_SAVE_ICON + ' Save to Library';
    }
  }

  const SVG_SAVE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;

  // ── Download ──────────────────────────────────────────────────────────────────

  function doDownload() {
    const name   = document.getElementById('edit-name').value.trim()        || 'route';
    const desc   = document.getElementById('edit-description').value.trim() || '';
    const author = document.getElementById('edit-author').value.trim();
    const authEl = document.getElementById('edit-author');

    if (!author) {
      authEl.classList.add('field-required');
      authEl.focus();
      return;
    }
    authEl.classList.remove('field-required');

    const content  = buildGPX(name, desc, author, editPoints);
    const filename = name.replace(/[^a-zA-Z0-9._\- ]/g, '_') + '.gpx';
    const blob     = new Blob([content], { type: 'application/gpx+xml' });
    const url      = URL.createObjectURL(blob);
    const a        = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Setup (called once from DOMContentLoaded) ─────────────────────────────────

  function setup() {
    // Populate activity select from the ACTIVITIES / CATEGORIES catalogue
    const actSelect = document.getElementById('edit-activity');
    if (actSelect) {
      actSelect.innerHTML = '<option value="">— No activity —</option>';
      Object.entries(CATEGORIES).forEach(([catKey, cat]) => {
        const group = document.createElement('optgroup');
        group.label = `${cat.emoji} ${cat.name}`;
        Object.entries(ACTIVITIES)
          .filter(([, a]) => a.category === catKey)
          .forEach(([key, a]) => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = `${a.emoji}  ${a.name}`;
            group.appendChild(opt);
          });
        actSelect.appendChild(group);
      });
    }

    // Close
    document.getElementById('editor-close-btn')
      .addEventListener('click', close);
    document.getElementById('editor-modal')
      .addEventListener('click', e => { if (e.target === e.currentTarget) close(); });

    // Escape key
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !document.getElementById('editor-modal').hidden) close();
    });

    // Tabs
    document.querySelectorAll('.editor-tab').forEach(btn =>
      btn.addEventListener('click', () => activateTab(btn.dataset.tab))
    );

    // Delete selected point
    document.getElementById('tool-delete-pt').addEventListener('click', () => {
      if (selectedIdx === null) return;
      editPoints.splice(selectedIdx, 1);
      selectedIdx = null;
      redraw();
    });

    // Undo — removes selected point or last point
    document.getElementById('tool-undo-pt').addEventListener('click', () => {
      if (!editPoints.length) return;
      if (selectedIdx !== null) {
        editPoints.splice(selectedIdx, 1);
        selectedIdx = null;
      } else {
        editPoints.pop();
      }
      redraw();
    });

    // Clear all
    document.getElementById('tool-clear-pts').addEventListener('click', () => {
      if (!editPoints.length) return;
      if (!confirm('Remove all track points and start fresh?')) return;
      editPoints = []; selectedIdx = null; redraw();
    });

    // XML tab — apply button
    document.getElementById('apply-xml-btn').addEventListener('click', applyXML);

    // Author — clear error on type
    document.getElementById('edit-author').addEventListener('input', () =>
      document.getElementById('edit-author').classList.remove('field-required')
    );

    // Save to Library
    document.getElementById('save-to-library-btn').addEventListener('click', saveToLibrary);

    // Download
    document.getElementById('download-gpx-btn').addEventListener('click', doDownload);
  }

  return { open, close, setup };

})();
