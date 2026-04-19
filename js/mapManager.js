/**
 * Map Manager — Leaflet map, tile layers, and map controls.
 * All tile providers are free and require no API key.
 */

const MapManager = (() => {

  // ── State ───────────────────────────────────────────────────────────────────
  let map             = null;
  let currentLayerKey = 'roadmap';
  let currentTile     = null;
  let trackLine       = null;
  let startMarker     = null;
  let endMarker       = null;
  let hoverMarker     = null;
  let locationMarker  = null;
  let locationCircle  = null;
  let queryMode       = false;
  let queryPopup      = null;
  let lastQueryMs     = 0;

  // ── Tile layer catalogue ────────────────────────────────────────────────────
  // All sources: free, open, no API key required.
  const LAYERS = [
    {
      id: 'terrain',
      label: 'Topographic',
      source: 'OpenTopoMap',
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      opts: {
        maxZoom: 17,
        attribution:
          'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors, '
          + '<a href="http://viewfinderpanoramas.org">SRTM</a> | '
          + 'Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> '
          + '(<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
      },
    },
    {
      id: 'roadmap',
      label: 'Street Map',
      source: 'OpenStreetMap',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      opts: {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    {
      id: 'satellite',
      label: 'Satellite',
      source: 'Esri World Imagery',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      opts: {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri — Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP',
      },
    },
    {
      id: 'esri-topo',
      label: 'Esri Topo',
      source: 'Esri World Topo Map',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
      opts: {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri — Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong)',
      },
    },
    {
      id: 'cyclosm',
      label: 'Cycling',
      source: 'CyclOSM',
      url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      opts: {
        maxZoom: 20,
        attribution:
          '<a href="https://github.com/cyclosm/cyclosm-cartocss-style/releases">CyclOSM</a> | '
          + '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors',
      },
    },
    {
      id: 'hot',
      label: 'Humanitarian',
      source: 'OpenStreetMap HOT',
      url: 'https://tile-{s}.openstreetmap.fr/hot/{z}/{x}/{y}.png',
      opts: {
        subdomains: 'abc',
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors | '
          + 'Style by <a href="https://www.hotosm.org/">HOT</a>',
      },
    },
    {
      id: 'carto-light',
      label: 'Light',
      source: 'CartoDB Positron',
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      opts: {
        subdomains: 'abcd',
        maxZoom: 20,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors '
          + '&copy; <a href="https://carto.com/attributions">CARTO</a>',
      },
    },
    {
      id: 'carto-dark',
      label: 'Dark',
      source: 'CartoDB Dark Matter',
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      opts: {
        subdomains: 'abcd',
        maxZoom: 20,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors '
          + '&copy; <a href="https://carto.com/attributions">CARTO</a>',
      },
    },
  ];

  // ── Initialisation (lazy — called on first showRoute) ───────────────────────

  function ensureMap() {
    if (map) return;

    map = L.map('map', {
      zoomControl: false,       // custom zoom buttons in toolbar
      attributionControl: true,
    });

    const layer = LAYERS.find(l => l.id === currentLayerKey);
    currentTile = L.tileLayer(layer.url, layer.opts).addTo(map);

    // Query-mode click handler
    map.on('click', e => {
      if (queryMode) handleQueryClick(e.latlng);
    });
  }

  // ── Route rendering ─────────────────────────────────────────────────────────

  function showRoute(points, stats) {
    ensureMap();
    map.invalidateSize();
    clearRoute();

    const latlngs = points.map(p => [p.lat, p.lon]);

    trackLine = L.polyline(latlngs, { color: '#3b82f6', weight: 4, opacity: 0.9 }).addTo(map);

    startMarker = L.circleMarker(latlngs[0], dot('#22c55e'))
      .addTo(map).bindTooltip('Start');

    endMarker = L.circleMarker(latlngs[latlngs.length - 1], dot('#ef4444'))
      .addTo(map).bindTooltip('End');

    map.fitBounds(trackLine.getBounds(), { padding: [32, 32] });

    // Hover dot — added to map only when chart is hovered
    hoverMarker = L.circleMarker(latlngs[0], { ...dot('#f59e0b'), radius: 7, zIndexOffset: 500 });
  }

  function clearRoute() {
    [trackLine, startMarker, endMarker, hoverMarker].forEach(m => { if (m) m.remove(); });
    trackLine = startMarker = endMarker = hoverMarker = null;
  }

  function dot(color, radius = 8) {
    return { radius, fillColor: color, fillOpacity: 1, color: '#fff', weight: 2 };
  }

  // ── Layer control ───────────────────────────────────────────────────────────

  function setMapType(id) {
    const layer = LAYERS.find(l => l.id === id);
    if (!map || !layer) return;
    if (currentTile) map.removeLayer(currentTile);
    currentLayerKey = id;
    currentTile = L.tileLayer(layer.url, layer.opts).addTo(map);
    if (trackLine) trackLine.bringToFront();
  }

  const getLayers     = () => LAYERS.map(({ id, label, source }) => ({ id, label, source }));
  const getCurrentLayer = () => currentLayerKey;

  // ── Zoom controls ───────────────────────────────────────────────────────────

  function zoomIn()  { if (map) map.zoomIn(); }
  function zoomOut() { if (map) map.zoomOut(); }

  // ── User location ───────────────────────────────────────────────────────────

  function locateUser(onStart, onDone, onFail) {
    ensureMap();
    if (onStart) onStart();

    map.once('locationfound', e => {
      // Remove previous location layer
      if (locationCircle) locationCircle.remove();
      if (locationMarker) locationMarker.remove();

      locationCircle = L.circle(e.latlng, {
        radius: e.accuracy,
        color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.08, weight: 1.5,
      }).addTo(map);

      locationMarker = L.circleMarker(e.latlng, dot('#3b82f6'))
        .addTo(map)
        .bindPopup('You are here<br><small>' +
          e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5) + '</small>')
        .openPopup();

      map.flyTo(e.latlng, Math.max(map.getZoom(), 14), { animate: true, duration: 1.2 });
      if (onDone) onDone();
    });

    map.once('locationerror', e => {
      if (onFail) onFail(e.message);
    });

    map.locate({ setView: false });
  }

  // ── Query / inspect mode ────────────────────────────────────────────────────

  function setQueryMode(enabled) {
    queryMode = enabled;
    if (!map) return;
    map.getContainer().style.cursor = enabled ? 'crosshair' : '';
    if (!enabled && queryPopup) {
      map.closePopup(queryPopup);
      queryPopup = null;
    }
  }

  async function handleQueryClick(latlng) {
    // Respect Nominatim's 1 req/sec usage policy
    const now = Date.now();
    if (now - lastQueryMs < 1200) return;
    lastQueryMs = now;

    const { lat, lng } = latlng;
    const coordText = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

    // Show loading state immediately
    if (queryPopup) map.closePopup(queryPopup);
    queryPopup = L.popup({ className: 'query-popup', maxWidth: 260, minWidth: 180 })
      .setLatLng(latlng)
      .setContent('<div class="qp-loading">Querying…</div>')
      .openOn(map);

    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1`,
        { headers: { 'Accept-Language': 'en' } }
      );
      if (!resp.ok) throw new Error('Nominatim error ' + resp.status);
      const d = await resp.json();

      const addr = d.address || {};
      const rows = [
        ['📍', `<code>${coordText}</code>`],
        addr.road       && ['🛣️', addr.road],
        addr.suburb     && ['🏘️', addr.suburb],
        (addr.city || addr.town || addr.village) && ['🏙️', addr.city || addr.town || addr.village],
        (addr.state || addr.county) && ['📌', addr.state || addr.county],
        addr.country    && ['🌍', addr.country],
      ].filter(Boolean);

      queryPopup.setContent(
        `<div class="qp-body">${rows.map(([icon, text]) =>
          `<div class="qp-row"><span class="qp-icon">${icon}</span><span>${text}</span></div>`
        ).join('')}</div>`
      );
    } catch (_) {
      queryPopup.setContent(
        `<div class="qp-body"><div class="qp-row"><span class="qp-icon">📍</span><code>${coordText}</code></div></div>`
      );
    }
  }

  // ── Chart → map sync ────────────────────────────────────────────────────────

  function highlightPoint(point) {
    if (!map || !hoverMarker) return;
    hoverMarker.setLatLng([point.lat, point.lon]);
    if (!map.hasLayer(hoverMarker)) hoverMarker.addTo(map);
  }

  function hideHighlight() {
    if (hoverMarker && map && map.hasLayer(hoverMarker)) map.removeLayer(hoverMarker);
  }

  function invalidateMapSize() {
    if (map) map.invalidateSize();
  }

  return {
    showRoute, clearRoute,
    setMapType, getLayers, getCurrentLayer,
    zoomIn, zoomOut,
    locateUser,
    setQueryMode,
    invalidateMapSize,
    highlightPoint, hideHighlight,
  };
})();
