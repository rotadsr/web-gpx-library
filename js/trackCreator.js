/**
 * Track Creator — snap-to-path route building via the BRouter public routing
 * server, with an optional freehand "draw" mode for stretches BRouter can't
 * route (unmapped trails). Waypoints are tagged with the mode active when
 * they were placed, so a single track can mix snapped and drawn segments.
 */

const TrackCreator = (() => {
  const BROUTER_URL = 'https://brouter.de/brouter';
  const DEBOUNCE_MS = 400;
  const NS = 'http://www.topografix.com/GPX/1/1';

  const PROFILES = [
    { value: 'hiking-mountain', label: 'Hiking' },
    { value: 'trekking', label: 'Walking' },
    { value: 'fastbike', label: 'Cycling' },
    { value: 'mtb', label: 'Mountain bike' },
  ];

  let waypoints = [];
  let redoStack = [];
  let currentMode = 'snap';
  let profile = PROFILES[0].value;
  let lastGpxText = null;
  let lastPoints = null;
  let lastStats = null;
  let requestGen = 0;
  let debounceTimer = null;
  let onUpdate = null;

  function notify(status, error) {
    if (!onUpdate) return;
    onUpdate({
      status,
      waypoints: getWaypoints(),
      points: lastPoints,
      stats: lastStats,
      error: error || null,
    });
  }

  function setOnUpdate(callback) {
    onUpdate = callback;
  }

  function getWaypoints() {
    return waypoints.slice();
  }

  function hasRoute() {
    return !!lastGpxText;
  }

  function setMode(mode) {
    currentMode = mode === 'draw' ? 'draw' : 'snap';
  }

  function getMode() {
    return currentMode;
  }

  function canRedo() {
    return redoStack.length > 0;
  }

  function addWaypoint(lat, lon) {
    waypoints.push({ lat, lon, mode: currentMode });
    redoStack = [];
    scheduleRecompute();
  }

  function undoLast() {
    const wp = waypoints.pop();
    if (wp) redoStack.push(wp);
    scheduleRecompute();
  }

  function redoLast() {
    const wp = redoStack.pop();
    if (wp) waypoints.push(wp);
    scheduleRecompute();
  }

  function reset() {
    waypoints = [];
    redoStack = [];
    currentMode = 'snap';
    lastGpxText = null;
    lastPoints = null;
    lastStats = null;
    requestGen++;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function setProfile(newProfile) {
    profile = newProfile;
    if (waypoints.length >= 2) scheduleRecompute();
  }

  function scheduleRecompute() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (waypoints.length < 2) {
      lastGpxText = null;
      lastPoints = null;
      lastStats = null;
      requestGen++;
      notify('idle');
      return;
    }

    notify('pending');
    debounceTimer = setTimeout(recompute, DEBOUNCE_MS);
  }

  // Groups consecutive same-mode segments into runs. Each run boundary point
  // is shared with the adjacent run so the merged path stays continuous.
  function buildRuns(wps) {
    const runs = [];
    let current = null;
    for (let i = 1; i < wps.length; i++) {
      const segMode = wps[i].mode;
      if (!current || current.mode !== segMode) {
        if (current) runs.push(current);
        current = { mode: segMode, points: [wps[i - 1], wps[i]] };
      } else {
        current.points.push(wps[i]);
      }
    }
    if (current) runs.push(current);
    return runs;
  }

  async function processSnapRun(run) {
    const lonlats = run.points.map(w => `${w.lon},${w.lat}`).join('|');
    const url = `${BROUTER_URL}?lonlats=${encodeURIComponent(lonlats)}&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=gpx`;

    let response;
    let text;
    try {
      response = await fetch(url);
      text = await response.text();
    } catch (err) {
      return { error: 'Network error contacting BRouter.' };
    }

    if (!response.ok || !/<gpx[\s>]/i.test(text)) {
      return { error: extractError(text) || 'BRouter could not find a route for these points.' };
    }

    let parsed;
    try {
      parsed = GPXParser.parse(text);
    } catch (err) {
      return { error: 'BRouter returned an unreadable response.' };
    }

    if (!parsed.points || parsed.points.length < 2) {
      return { error: 'BRouter could not find a route for these points.' };
    }

    return { points: parsed.points };
  }

  function processDrawRun(run) {
    return { points: run.points.map(p => ({ lat: p.lat, lon: p.lon, ele: null, time: null })) };
  }

  function extractError(text) {
    const tagMatch = text.match(/<error[^>]*>([^<]*)<\/error>/i);
    if (tagMatch) return tagMatch[1].trim();
    const lineMatch = text.match(/^Error:?\s*(.+)$/im);
    if (lineMatch) return lineMatch[1].trim();
    return null;
  }

  function pointsToGpxString(points) {
    const trkpts = points.map(p => {
      const eleTag = (p.ele !== null && p.ele !== undefined) ? `<ele>${p.ele}</ele>` : '';
      return `<trkpt lat="${p.lat}" lon="${p.lon}">${eleTag}</trkpt>`;
    }).join('');
    return `<?xml version="1.0"?><gpx xmlns="${NS}" version="1.1"><trk><trkseg>${trkpts}</trkseg></trk></gpx>`;
  }

  async function recompute() {
    const gen = ++requestGen;
    const runs = buildRuns(waypoints);

    let results;
    try {
      results = await Promise.all(runs.map(run =>
        run.mode === 'draw' ? processDrawRun(run) : processSnapRun(run)
      ));
    } catch (err) {
      if (gen !== requestGen) return;
      notify('error', 'Error building track.');
      return;
    }

    if (gen !== requestGen) return;

    const failed = results.find(r => r.error);
    if (failed) {
      notify('error', failed.error);
      return;
    }

    let merged = [];
    results.forEach((r, idx) => {
      merged = merged.concat(idx === 0 ? r.points : r.points.slice(1));
    });

    const combinedGpx = pointsToGpxString(merged);

    let parsed;
    try {
      parsed = GPXParser.parse(combinedGpx);
    } catch (err) {
      notify('error', 'Could not build the combined track.');
      return;
    }

    if (!parsed.points || parsed.points.length < 2) {
      notify('error', 'Not enough points to build a track.');
      return;
    }

    lastGpxText = combinedGpx;
    lastPoints = parsed.points;
    lastStats = parsed.stats;

    notify('ok');
  }

  function getGpxText(name, description) {
    if (!lastGpxText) return null;

    const parser = new DOMParser();
    const doc = parser.parseFromString(lastGpxText, 'text/xml');

    const gpxEl = doc.getElementsByTagNameNS(NS, 'gpx')[0] || doc.getElementsByTagName('gpx')[0];

    let metaEl = doc.getElementsByTagNameNS(NS, 'metadata')[0]
              || doc.getElementsByTagName('metadata')[0];

    if (!metaEl) {
      metaEl = doc.createElementNS(NS, 'metadata');
      gpxEl.insertBefore(metaEl, gpxEl.firstChild);
    }

    setChildText(doc, metaEl, 'name', name);
    setChildText(doc, metaEl, 'desc', description);

    return new XMLSerializer().serializeToString(doc);
  }

  function setChildText(doc, parent, tag, value) {
    let el = parent.getElementsByTagNameNS(NS, tag)[0] || parent.getElementsByTagName(tag)[0];
    if (!value) {
      if (el) parent.removeChild(el);
      return;
    }
    if (!el) {
      el = doc.createElementNS(NS, tag);
      parent.appendChild(el);
    }
    el.textContent = value;
  }

  return {
    PROFILES,
    addWaypoint,
    undoLast,
    redoLast,
    canRedo,
    reset,
    setProfile,
    setMode,
    getMode,
    getWaypoints,
    getGpxText,
    hasRoute,
    setOnUpdate,
  };
})();
