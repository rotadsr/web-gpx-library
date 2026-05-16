/**
 * Map Manager — Leaflet map, tile layers, and map controls.
 * All tile providers are free and require no API key.
 */

const MapManager = (() => {

  // ── State ───────────────────────────────────────────────────────────────────
  let map             = null;
  let currentLayerKey = 'carto-light';
  let currentTile     = null;
  let trackLine       = null;
  let startMarker     = null;
  let endMarker       = null;
  let hoverMarker     = null;
  let locationMarker    = null;
  let locationCircle    = null;
  let queryMode         = false;
  let queryPopup        = null;
  let lastQueryMs       = 0;
  let overviewLayers     = [];
  let selectedOverviewId = null;
  let heatLayer              = null;
  let overviewHeatPts        = [];
  let overviewSampledByRoute = [];   // [{ id, pts: [[lat,lng], ...] }]
  let countMarkers           = [];
  let zoomEndHandler         = null;
  let heatClickHandler       = null;
  const HEAT_THRESHOLD       = 9;   // zoom ≤ this → show heatmap instead of polylines
  let privacyZoneLayers      = [];
  let _storedPrivacyZones    = [];

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

    map.createPane('privacyPane');
    map.getPane('privacyPane').style.zIndex = 401; // just above overlayPane(400), below markers(600)
    map.getPane('privacyPane').style.pointerEvents = 'none';

    const layer = LAYERS.find(l => l.id === currentLayerKey);
    currentTile = L.tileLayer(layer.url, layer.opts).addTo(map);

    // Query-mode click handler
    map.on('click', e => {
      if (queryMode) handleQueryClick(e.latlng);
    });

    if (_storedPrivacyZones.length) _renderPrivacyZones();
  }

  // ── Privacy zone circles ────────────────────────────────────────────────────

  function updatePrivacyZones(zones) {
    _storedPrivacyZones = zones;
    if (!map) return;
    _renderPrivacyZones();
  }

  function _renderPrivacyZones() {
    privacyZoneLayers.forEach(l => { try { map.removeLayer(l); } catch (_) {} });
    privacyZoneLayers = [];
    for (const zone of _storedPrivacyZones) {
      const circle = L.circle([zone.lat, zone.lon], {
        pane: 'privacyPane',
        radius: (zone.radius || 2) * 1000,
        color: '#f59e0b',
        fillColor: '#f59e0b',
        fillOpacity: 0.13,
        weight: 2,
        dashArray: '6 4',
        interactive: false,
      }).addTo(map);
      const label = zone.name ? zone.name.split(',')[0] : null;
      if (label) circle.bindTooltip(label, { sticky: true, className: 'privacy-zone-tip' });
      privacyZoneLayers.push(circle);
    }
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

    if (_storedPrivacyZones.length) _renderPrivacyZones();
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

  // ── Overview mode (all filtered routes) ────────────────────────────────────

  function overviewStyle(state, color) {
    const c = color || '#64748b';
    switch (state) {
      case 'hover':    return { color: c, weight: 5, opacity: 1.0  };
      case 'selected': return { color: c, weight: 5, opacity: 1.0  };
      case 'dimmed':   return { color: c, weight: 2, opacity: 0.22 };
      default:         return { color: c, weight: 3, opacity: 0.72 };
    }
  }

  function buildOverviewSamples(items) {
    const heatPts = [];
    const byRoute = [];
    for (const item of items) {
      const ll = item.latlngs;
      if (!ll || ll.length < 2) continue;
      const step = Math.max(1, Math.floor(ll.length / Math.min(60, ll.length)));
      const pts  = [];
      for (let i = 0; i < ll.length; i += step) {
        pts.push(ll[i]);
        heatPts.push([ll[i][0], ll[i][1], 1]);
      }
      byRoute.push({ id: item.id, pts });
    }
    return { heatPts, byRoute };
  }

  function buildCountMarkers() {
    countMarkers.forEach(m => m.remove());
    countMarkers = [];
    if (!map || !overviewSampledByRoute.length) return;

    // Cell size in degrees, doubling for each zoom step below threshold
    const zoom     = map.getZoom();
    const cellSize = Math.pow(2, HEAT_THRESHOLD - zoom) * 0.5;
    const cells    = new Map(); // "lat:lng" → { routes: Set, lat, lng }

    overviewSampledByRoute.forEach(({ id, pts }) => {
      pts.forEach(([lat, lng]) => {
        const cLat = Math.floor(lat / cellSize) * cellSize;
        const cLng = Math.floor(lng / cellSize) * cellSize;
        const key  = `${cLat}:${cLng}`;
        if (!cells.has(key)) cells.set(key, { routes: new Set(), sumLat: 0, sumLng: 0, n: 0 });
        const cell = cells.get(key);
        cell.routes.add(id);
        cell.sumLat += lat;
        cell.sumLng += lng;
        cell.n++;
      });
    });

    cells.forEach(({ routes, sumLat, sumLng, n }) => {
      const marker = L.marker(
        [sumLat / n, sumLng / n],
        {
          icon: L.divIcon({
            className: 'heat-count-marker',
            html: `<span class="hcm-bubble">${routes.size}</span>`,
            iconSize:   [0, 0],
            iconAnchor: [0, 0],
          }),
          interactive: false,
          zIndexOffset: 200,
        }
      ).addTo(map);
      countMarkers.push(marker);
    });
  }

  function updateOverviewDisplay() {
    if (!map || !overviewLayers.length) return;
    const inHeatMode = map.getZoom() <= HEAT_THRESHOLD && overviewHeatPts.length > 0;
    const badge      = document.getElementById('heatmap-badge');

    if (inHeatMode) {
      overviewLayers.forEach(({ polyline }) => {
        polyline.setStyle({ opacity: 0, weight: 0 });
        if (polyline._path) polyline._path.style.pointerEvents = 'none';
      });
      if (!heatLayer && typeof L.heatLayer === 'function') {
        heatLayer = L.heatLayer(overviewHeatPts, {
          radius:   22,
          blur:     28,
          maxZoom:  HEAT_THRESHOLD + 1,
          gradient: { 0.2: '#3b82f6', 0.5: '#22c55e', 0.75: '#f59e0b', 1.0: '#ef4444' },
        });
      }
      if (heatLayer && !map.hasLayer(heatLayer)) heatLayer.addTo(map);
      buildCountMarkers();
      if (badge) {
        const n = overviewLayers.length;
        badge.innerHTML =
          `${n} route${n !== 1 ? 's' : ''}` +
          `<span class="hb-hint">click to zoom in</span>`;
        badge.style.display = 'block';
      }
      map.getContainer().style.cursor = 'zoom-in';
    } else {
      if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
      countMarkers.forEach(m => m.remove());
      countMarkers = [];
      overviewLayers.forEach(({ polyline, color, state }) => {
        polyline.setStyle(overviewStyle(state || 'idle', color));
        if (polyline._path) polyline._path.style.pointerEvents = '';
      });
      if (badge) badge.style.display = 'none';
      map.getContainer().style.cursor = '';
    }
  }

  function showOverview(items, callbacks) {
    ensureMap();
    clearRoute();
    clearOverview();
    if (!items.length) return;

    const samples = buildOverviewSamples(items);
    overviewHeatPts        = samples.heatPts;
    overviewSampledByRoute = samples.byRoute;
    const allLatLngs = [];

    items.forEach(item => {
      if (!item.latlngs || item.latlngs.length < 2) return;

      const poly = L.polyline(item.latlngs, overviewStyle('idle', item.color)).addTo(map);

      poly.on('mouseover', () => {
        if (map.getZoom() <= HEAT_THRESHOLD) return;
        if (item.id !== selectedOverviewId) poly.setStyle(overviewStyle('hover', item.color));
        if (callbacks.onHover) callbacks.onHover(item);
      });
      poly.on('mousemove', e => {
        if (map.getZoom() <= HEAT_THRESHOLD) return;
        if (callbacks.onMove) callbacks.onMove(e.originalEvent);
      });
      poly.on('mouseout', () => {
        if (map.getZoom() <= HEAT_THRESHOLD) return;
        if (item.id !== selectedOverviewId) poly.setStyle(overviewStyle('idle', item.color));
        if (callbacks.onLeave) callbacks.onLeave();
      });
      poly.on('click', () => {
        if (map.getZoom() <= HEAT_THRESHOLD) return;
        selectOverviewRoute(item.id);
        if (callbacks.onClick) callbacks.onClick(item.id);
      });

      overviewLayers.push({ id: item.id, polyline: poly, color: item.color, state: 'idle' });
      allLatLngs.push(...item.latlngs);
    });

    // Click in heatmap mode → zoom in to fit routes in that area
    heatClickHandler = e => {
      if (map.getZoom() > HEAT_THRESHOLD) return;
      const clickPt   = e.latlng;
      const nearBounds = L.latLngBounds();
      overviewLayers.forEach(({ polyline }) => {
        try {
          if (polyline.getBounds().pad(0.1).contains(clickPt)) {
            nearBounds.extend(polyline.getBounds());
          }
        } catch (_) {}
      });
      if (nearBounds.isValid()) {
        map.fitBounds(nearBounds, { padding: [48, 48], maxZoom: HEAT_THRESHOLD + 3 });
      } else {
        map.flyTo(clickPt, Math.min(map.getZoom() + 3, HEAT_THRESHOLD + 2), { duration: 0.6 });
      }
    };
    map.on('click', heatClickHandler);

    zoomEndHandler = updateOverviewDisplay;
    map.on('zoomend', zoomEndHandler);

    if (allLatLngs.length) {
      try { map.fitBounds(L.latLngBounds(allLatLngs), { padding: [32, 32] }); } catch (_) {}
    }

    updateOverviewDisplay();
    if (_storedPrivacyZones.length) _renderPrivacyZones();
  }

  function clearOverview() {
    if (heatClickHandler) { map.off('click', heatClickHandler); heatClickHandler = null; }
    if (zoomEndHandler)   { map.off('zoomend', zoomEndHandler); zoomEndHandler = null; }
    if (heatLayer) {
      if (map && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
      heatLayer = null;
    }
    if (map) map.getContainer().style.cursor = '';
    countMarkers.forEach(m => m.remove());
    countMarkers = [];
    overviewSampledByRoute = [];
    const badge = document.getElementById('heatmap-badge');
    if (badge) badge.style.display = 'none';
    overviewHeatPts = [];
    overviewLayers.forEach(({ polyline }) => polyline.remove());
    overviewLayers = [];
    selectedOverviewId = null;
  }

  function selectOverviewRoute(id) {
    selectedOverviewId = id;
    const inHeat = map && map.getZoom() <= HEAT_THRESHOLD;
    overviewLayers.forEach(layer => {
      if (layer.id === id) {
        layer.state = 'selected';
        if (!inHeat) { layer.polyline.setStyle(overviewStyle('selected', layer.color)); layer.polyline.bringToFront(); }
      } else {
        layer.state = 'dimmed';
        if (!inHeat) layer.polyline.setStyle(overviewStyle('dimmed', layer.color));
      }
    });
  }

  function getViewState() {
    if (!map) return { lat: 46, lng: 8, zoom: 10 };
    const c = map.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
  }

  // ── Ski resort piste overlay ─────────────────────────────────────────────────

  const PISTE_COLORS = {
    novice:       '#22c55e',   // green
    easy:         '#3b82f6',   // blue
    intermediate: '#ef4444',   // red
    advanced:     '#1e293b',   // black
    expert:       '#f97316',   // orange (double-black)
    freeride:     '#a855f7',   // purple
  };

  let skiLayers        = [];
  let skiZoomListening = false;

  // Weight scales with zoom so pistes appear a consistent real-world width.
  function _pisteWeight(zoom, isLift) {
    return Math.max(1, Math.round((isLift ? 1 : 2) * Math.pow(2, zoom - 13)));
  }

  function _updatePisteWeights() {
    const z = map.getZoom();
    skiLayers.forEach(l => l.setStyle({ weight: _pisteWeight(z, l._skiIsLift) }));
  }

  function _hidePisteLegend() {
    const legend = document.getElementById('piste-legend');
    if (legend) legend.style.display = 'none';
  }

  // Load piste + lift data for the current map viewport from Overpass API.
  // Results are cached in localStorage for 24 hours keyed by rounded bounds.
  //
  // Opacity strategy: all segments of the same color are merged into one
  // multi-segment L.polyline so they share a single SVG <path> element.
  // A single path's stroke is painted as one unit — overlapping segments of
  // the same color never compound their opacity.  Different colors remain
  // independent elements and do composite normally.
  async function showSkiForViewport() {
    ensureMap();

    if (map.getZoom() < 10) throw new Error('zoom-too-low');

    if (!skiZoomListening) {
      map.on('zoomend', _updatePisteWeights);
      map.on('click',   _hidePisteLegend);
      skiZoomListening = true;
    }

    const b   = map.getBounds();
    const r   = v => Math.round(v * 100) / 100;
    const s = r(b.getSouth()), w = r(b.getWest()),
          n = r(b.getNorth()), e = r(b.getEast());
    const cacheKey = `ski-vp-${s},${w},${n},${e}`;

    let elements;
    try {
      const hit = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (hit && Date.now() - hit.ts < 86400000) elements = hit.data;
    } catch (_) {}

    if (!elements) {
      const query =
        `[out:json][timeout:30];` +
        `(way["piste:type"](${s},${w},${n},${e});` +
        ` way["aerialway"](${s},${w},${n},${e}););` +
        `out geom;`;
      const resp = await fetch('https://overpass-api.de/api/interpreter', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    'data=' + encodeURIComponent(query),
      });
      if (!resp.ok) throw new Error('Overpass error ' + resp.status);
      const json = await resp.json();
      elements = json.elements;
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: elements }));
      } catch (_) {}
    }

    // Bucket segments by color key; collect named pistes for the tooltip layer
    const colorGroups = new Map(); // colorKey → { color, isLift, segments[] }
    const namedPistes = [];        // { coords, label }

    elements.forEach(el => {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) return;
      const coords = el.geometry.map(g => [g.lat, g.lon]);
      const tags   = el.tags || {};
      const isLift = !!tags.aerialway;
      const color  = isLift ? '#94a3b8' : (PISTE_COLORS[tags['piste:difficulty']] || PISTE_COLORS.easy);
      const key    = isLift ? 'lift' : color;

      if (!colorGroups.has(key)) colorGroups.set(key, { color, isLift, segments: [] });
      colorGroups.get(key).segments.push(coords);

      const name = tags.name || tags['piste:name'] || '';
      if (name) {
        const diff = tags['piste:difficulty'] ? ` (${tags['piste:difficulty']})` : '';
        namedPistes.push({ coords, label: name + diff });
      }
    });

    const zoom = map.getZoom();

    // Visual layer — one multi-segment polyline per color, interactive:false
    colorGroups.forEach(({ color, isLift, segments }) => {
      const line = L.polyline(segments, {
        color,
        weight:      _pisteWeight(zoom, isLift),
        opacity:     0.3,
        dashArray:   isLift ? '12 8' : null,
        interactive: false,
      }).addTo(map);
      line._skiIsLift = isLift;
      skiLayers.push(line);
    });

    // Interaction layer — transparent polylines over named pistes for tooltips
    // and the click-to-show-legend gesture.  SVG pointer-events:'stroke' makes
    // them hittable even at opacity 0.
    namedPistes.forEach(({ coords, label }) => {
      const line = L.polyline(coords, {
        color:       'transparent',
        weight:      _pisteWeight(zoom, false),
        opacity:     0,
        interactive: true,
      }).addTo(map);
      line._skiIsLift = false;
      line.getElement()?.setAttribute('pointer-events', 'stroke');
      line.bindTooltip(label, { sticky: true, className: 'piste-tooltip' });
      line.on('click', e => {
        L.DomEvent.stopPropagation(e);
        const legend = document.getElementById('piste-legend');
        if (legend) legend.style.display = '';
      });
      skiLayers.push(line);
    });

    return colorGroups.size;
  }

  function clearSkiResort() {
    skiLayers.forEach(l => { try { map && map.removeLayer(l); } catch (_) {} });
    skiLayers = [];
    _hidePisteLegend();
  }

  return {
    showRoute, clearRoute,
    setMapType, getLayers, getCurrentLayer,
    zoomIn, zoomOut,
    locateUser,
    setQueryMode,
    invalidateMapSize,
    highlightPoint, hideHighlight,
    getViewState,
    showOverview, clearOverview, selectOverviewRoute,
    showSkiForViewport, clearSkiResort,
    updatePrivacyZones,
  };
})();
