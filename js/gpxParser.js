/**
 * GPX Parser — parses GPX XML and computes route statistics.
 */

const GPXParser = (() => {

  function parse(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');

    if (doc.querySelector('parsererror')) {
      throw new Error('Invalid GPX file');
    }

    const ns = 'http://www.topografix.com/GPX/1/1';

    function getText(parent, tag) {
      const el = parent.getElementsByTagNameNS(ns, tag)[0]
                 || parent.getElementsByTagName(tag)[0];
      return el ? el.textContent.trim() : null;
    }

    // --- Metadata ---
    const metaEl = doc.getElementsByTagNameNS(ns, 'metadata')[0]
                || doc.getElementsByTagName('metadata')[0];

    const authorEl = metaEl
      ? (metaEl.getElementsByTagNameNS(ns, 'author')[0]
      || metaEl.getElementsByTagName('author')[0])
      : null;

    const metadata = {
      name: getText(doc, 'name'),
      description: getText(doc, 'desc'),
      author: authorEl ? getText(authorEl, 'name') : null,
      time: getText(doc, 'time'),
      keywords: getText(doc, 'keywords'),
    };

    // Prefer metadata name over track name; also read <trk><type> as activity hint
    const trkNameEl = doc.getElementsByTagNameNS(ns, 'trk')[0]
                   || doc.getElementsByTagName('trk')[0];
    if (!metadata.name && trkNameEl) {
      metadata.name = getText(trkNameEl, 'name');
    }
    if (trkNameEl) {
      const trkType = getText(trkNameEl, 'type');
      if (trkType) metadata.activity = trkType;
    }

    // --- Track points ---
    const trkptEls = Array.from(
      doc.getElementsByTagNameNS(ns, 'trkpt').length
        ? doc.getElementsByTagNameNS(ns, 'trkpt')
        : doc.getElementsByTagName('trkpt')
    );

    const points = trkptEls.map(el => {
      const eleEl = el.getElementsByTagNameNS(ns, 'ele')[0]
                 || el.getElementsByTagName('ele')[0];
      const timeEl = el.getElementsByTagNameNS(ns, 'time')[0]
                  || el.getElementsByTagName('time')[0];
      return {
        lat: parseFloat(el.getAttribute('lat')),
        lon: parseFloat(el.getAttribute('lon')),
        ele: eleEl ? parseFloat(eleEl.textContent) : null,
        time: timeEl ? new Date(timeEl.textContent) : null,
      };
    }).filter(p => !isNaN(p.lat) && !isNaN(p.lon));

    const stats = computeStats(points);

    return { metadata, points, stats };
  }

  // Haversine distance in km between two lat/lon pairs
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function computeStats(points) {
    if (points.length < 2) {
      return { totalDistance: 0, elevationGain: 0, elevationLoss: 0,
               maxElevation: null, minElevation: null, totalTime: null,
               avgSpeed: null, cumulativeDistances: [] };
    }

    let totalDistance    = 0;
    let elevationGain    = 0;
    let elevationLoss    = 0;
    let uphillDistance   = 0;   // km while ascending
    let downhillDistance = 0;   // km while descending
    const cumulativeDistances = [0];
    const ELE_THRESHOLD = 2; // metres — ignore noise below this

    for (let i = 1; i < points.length; i++) {
      const d = haversine(points[i - 1].lat, points[i - 1].lon,
                          points[i].lat, points[i].lon);
      totalDistance += d;
      cumulativeDistances.push(totalDistance);

      const e1 = points[i - 1].ele;
      const e2 = points[i].ele;
      if (e1 !== null && e2 !== null) {
        const diff = e2 - e1;
        if (diff > ELE_THRESHOLD) {
          elevationGain    += diff;
          uphillDistance   += d;
        } else if (diff < -ELE_THRESHOLD) {
          elevationLoss    += Math.abs(diff);
          downhillDistance += d;
        }
      }
    }

    const elevations = points.map(p => p.ele).filter(e => e !== null);
    const maxElevation = elevations.length ? Math.max(...elevations) : null;
    const minElevation = elevations.length ? Math.min(...elevations) : null;

    const times = points.map(p => p.time).filter(Boolean);
    let totalTime = null;
    let avgSpeed = null;
    if (times.length >= 2) {
      totalTime = (times[times.length - 1] - times[0]) / 1000; // seconds
      if (totalTime > 0) avgSpeed = (totalDistance / totalTime) * 3600; // km/h
    }

    const avgUphillGradient   = uphillDistance   > 0
      ? (elevationGain / (uphillDistance   * 1000)) * 100 : null;
    const avgDownhillGradient = downhillDistance > 0
      ? (elevationLoss / (downhillDistance * 1000)) * 100 : null;

    return {
      totalDistance,
      elevationGain: Math.round(elevationGain),
      elevationLoss: Math.round(elevationLoss),
      maxElevation: maxElevation !== null ? Math.round(maxElevation) : null,
      minElevation: minElevation !== null ? Math.round(minElevation) : null,
      uphillDistance,
      downhillDistance,
      avgUphillGradient,
      avgDownhillGradient,
      totalTime,
      avgSpeed,
      cumulativeDistances,
    };
  }

  // Downsample an array to at most maxPoints entries
  function downsample(arr, maxPoints) {
    if (arr.length <= maxPoints) return arr;
    const step = arr.length / maxPoints;
    const result = [];
    for (let i = 0; i < maxPoints; i++) {
      result.push(arr[Math.round(i * step)]);
    }
    result.push(arr[arr.length - 1]);
    return result;
  }

  // Build chart-ready elevation profile (distance vs elevation)
  function buildElevationProfile(points, stats, maxPoints = 300) {
    const paired = points
      .map((p, i) => ({ dist: stats.cumulativeDistances[i], ele: p.ele }))
      .filter(p => p.ele !== null);
    return downsample(paired, maxPoints);
  }

  // Format seconds into h m s string
  function formatDuration(seconds) {
    if (!seconds) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
    if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
    return `${s}s`;
  }

  return { parse, buildElevationProfile, formatDuration };
})();
