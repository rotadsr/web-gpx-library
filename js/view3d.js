/**
 * View3D — MapLibre GL JS 3D terrain route visualisation.
 *
 * Overlays a MapLibre GL map (pitch 55°) directly on top of the Leaflet map.
 * AWS Terrarium DEM tiles provide real terrain extrusion; CARTO Voyager tiles
 * provide the base map texture. The route is drawn as per-segment GeoJSON lines
 * colour-coded from blue (low elevation) to red (high elevation).
 *
 * Toggle: click the 3D button → activates; click again → returns to 2D.
 */

const View3D = (() => {
  let mlMap        = null;
  let active       = false;
  let hoverMarker  = null;

  // Elevation colour ramp: blue → cyan → green → yellow → orange → red
  const RAMP = [
    [59,  130, 246],
    [6,   182, 212],
    [34,  197,  94],
    [250, 204,  21],
    [249, 115,  22],
    [239,  68,  68],
  ];

  function lerpColor(t) {
    const s  = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
    const lo = Math.min(Math.floor(s), RAMP.length - 2);
    const u  = s - lo;
    return RAMP[lo].map((c, i) => Math.round(c + u * (RAMP[lo + 1][i] - c)));
  }

  function toHex(t) {
    return '#' + lerpColor(t).map(c => c.toString(16).padStart(2, '0')).join('');
  }

  function thin(arr, maxPts) {
    if (arr.length <= maxPts) return arr;
    const out  = [];
    const step = (arr.length - 1) / (maxPts - 1);
    for (let i = 0; i < maxPts - 1; i++) out.push(arr[Math.round(i * step)]);
    out.push(arr[arr.length - 1]);
    return out;
  }

  function buildGeoJSON(points) {
    const hasEle  = points.some(p => p.ele !== null && p.ele !== undefined);
    const eles    = points.map(p => (p.ele != null) ? p.ele : 0);
    const minEle  = Math.min(...eles);
    const maxEle  = Math.max(...eles);
    const eleRange = Math.max(maxEle - minEle, 1);

    const features = [];
    for (let i = 0; i < points.length - 1; i++) {
      const t = hasEle ? ((eles[i] + eles[i + 1]) / 2 - minEle) / eleRange : 0.3;
      features.push({
        type: 'Feature',
        properties: { color: toHex(t) },
        geometry: {
          type: 'LineString',
          coordinates: [
            [points[i].lon,     points[i].lat],
            [points[i + 1].lon, points[i + 1].lat],
          ],
        },
      });
    }
    return {
      geojson:  { type: 'FeatureCollection', features },
      hasEle,
      minEle,
      maxEle,
    };
  }

  function show(rawPoints) {
    // Second click → exit 3D
    if (active) { hide(); return; }
    if (!rawPoints || rawPoints.length < 2) return;

    active = true;

    const points = thin(rawPoints, 3000);
    const { geojson, hasEle, minEle, maxEle } = buildGeoJSON(points);
    const vs = MapManager.getViewState();

    document.getElementById('map-3d').style.display = 'block';
    document.getElementById('btn-3d').classList.add('active');

    if (mlMap) { mlMap.remove(); mlMap = null; }

    mlMap = new maplibregl.Map({
      container: 'map-3d',
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          'base': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
              'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
              'https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
            ],
            tileSize: 256,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
          },
          'dem': {
            type: 'raster-dem',
            tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 15,
            encoding: 'terrarium',
            attribution: 'Terrain tiles by <a href="https://github.com/tilezen/joerd">Tilezen/Joerd</a>',
          },
          'route': {
            type: 'geojson',
            data: geojson,
          },
        },
        layers: [
          { id: 'base-layer', type: 'raster', source: 'base' },
          {
            id: 'route-shadow',
            type: 'line',
            source: 'route',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#000000', 'line-width': 9, 'line-opacity': 0.18 },
          },
          {
            id: 'route-line',
            type: 'line',
            source: 'route',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ['get', 'color'], 'line-width': 5 },
          },
        ],
        terrain: { source: 'dem', exaggeration: 1.5 },
        sky: {
          'sky-color': '#b8d4f0',
          'sky-horizon-blend': 0.5,
          'horizon-color': '#e0eaf7',
          'horizon-fog-blend': 0.5,
          'fog-color': '#c8daf0',
          'fog-ground-blend': 0.9,
        },
      },
      center:    [vs.lng, vs.lat],
      zoom:      vs.zoom,
      pitch:     55,
      bearing:   0,
      antialias: true,
    });

    // Elevation legend
    const legend = document.getElementById('view3d-legend');
    if (hasEle) {
      document.getElementById('view3d-ele-min').textContent = `${Math.round(minEle)} m`;
      document.getElementById('view3d-ele-max').textContent = `${Math.round(maxEle)} m`;
      legend.style.display = 'flex';
    } else {
      legend.style.display = 'none';
    }
  }

  function highlightPoint(point) {
    if (!active || !mlMap) return;
    if (!hoverMarker) {
      const el = document.createElement('div');
      el.className = 'view3d-hover-dot';
      hoverMarker = new maplibregl.Marker({ element: el, anchor: 'center' });
    }
    hoverMarker.setLngLat([point.lon, point.lat]).addTo(mlMap);
  }

  function hideHighlight() {
    if (hoverMarker) hoverMarker.remove();
  }

  function hide() {
    if (!active) return;
    active = false;
    hideHighlight();
    document.getElementById('map-3d').style.display          = 'none';
    document.getElementById('view3d-legend').style.display   = 'none';
    document.getElementById('btn-3d').classList.remove('active');
    if (mlMap) { mlMap.remove(); mlMap = null; }
    hoverMarker = null;
    MapManager.invalidateMapSize();
  }

  // Escape key exits 3D
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && active) hide();
  });

  return { show, hide, highlightPoint, hideHighlight };
})();
