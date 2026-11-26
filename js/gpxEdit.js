/**
 * GPXEdit — pure GPX text transformations (no app state, no DOM besides DOMParser/XMLSerializer):
 * metadata/waypoint patching, duration baking, trimming, reversing, merging and share-simplification.
 */
const GPXEdit = (() => {
  const escapeHtml = Util.escapeHtml;

  // Haversine distance in metres
  function geoDistM(a, b) {
    const R = 6371000;
    const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
    const Δφ = (b.lat - a.lat) * Math.PI / 180;
    const Δλ = (b.lon - a.lon) * Math.PI / 180;
    const s = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
  }
  // Perpendicular distance (metres) from point p to segment [a,b] — planar approx
  function perpDist(p, a, b) {
    const C = Math.cos((a.lat + b.lat) / 2 * Math.PI / 180) * 111319;
    const D = 111319;
    const px = p.lon*C, py = p.lat*D;
    const ax = a.lon*C, ay = a.lat*D;
    const bx = b.lon*C, by = b.lat*D;
    const dx = bx-ax, dy = by-ay;
    if (dx === 0 && dy === 0) return Math.hypot(px-ax, py-ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / (dx*dx+dy*dy)));
    return Math.hypot(px-ax-t*dx, py-ay-t*dy);
  }
  // Iterative Ramer-Douglas-Peucker (avoids call-stack overflow on large tracks)
  function rdp(points, epsilon) {
    const n = points.length;
    if (n <= 2) return points.slice();
    const keep = new Uint8Array(n);
    keep[0] = keep[n-1] = 1;
    const stack = [[0, n-1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let maxD = 0, maxI = s;
      for (let i = s+1; i < e; i++) {
        const d = perpDist(points[i], points[s], points[e]);
        if (d > maxD) { maxD = d; maxI = i; }
      }
      if (maxD > epsilon) {
        keep[maxI] = 1;
        stack.push([s, maxI], [maxI, e]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }
  // Remove GPS spike points: a point is a spike if going through it is >5× longer
  // than skipping it AND the jump in is >100 m (avoids removing tight switchbacks)
  function removeSpikes(points) {
    if (points.length <= 2) return points.slice();
    const out = [points[0]];
    for (let i = 1; i < points.length-1; i++) {
      const prev = out[out.length-1], curr = points[i], next = points[i+1];
      const dIn = geoDistM(prev, curr), dOut = geoDistM(curr, next);
      const dSkip = geoDistM(prev, next);
      if (dIn > 100 && (dIn + dOut) > 5 * Math.max(dSkip, 1)) continue;
      out.push(curr);
    }
    out.push(points[points.length-1]);
    return out;
  }
  // Target max point count based on route distance
  function targetPointCount(points) {
    let d = 0;
    const step = Math.max(1, Math.floor(points.length / 200));
    for (let i = step; i < points.length; i += step) d += geoDistM(points[i-step], points[i]);
    const km = d / 1000;
    return km < 10 ? 1500 : km < 20 ? 2500 : 4000;
  }
  // De-spike → adaptive RDP until within target
  function simplifyPoints(points) {
    if (points.length <= 100) return points;
    const cleaned = removeSpikes(points);
    const target  = targetPointCount(cleaned);
    if (cleaned.length <= target) return cleaned;
    let epsilon = 5, result = cleaned;
    while (result.length > target && epsilon <= 100) {
      result  = rdp(cleaned, epsilon);
      epsilon *= 2;
    }
    return result;
  }
  // Parse track points from a GPX XML string, simplify them, and return new XML
  function simplifyGpxForSharing(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) return xmlText;

    const ns  = 'http://www.topografix.com/GPX/1/1';
    const get = (el, tag) =>
      (el.getElementsByTagNameNS(ns, tag)[0] || el.getElementsByTagName(tag)[0])
        ?.textContent.trim() ?? null;

    let els = Array.from(doc.getElementsByTagNameNS(ns, 'trkpt'));
    if (!els.length) els = Array.from(doc.getElementsByTagName('trkpt'));
    if (els.length < 2) return xmlText;

    const raw = els.map(el => ({
      lat:  parseFloat(el.getAttribute('lat')),
      lon:  parseFloat(el.getAttribute('lon')),
      ele:  get(el, 'ele'),
      time: get(el, 'time'),
    })).filter(p => !isNaN(p.lat) && !isNaN(p.lon));

    const simplified = simplifyPoints(raw);

    const trkpts = simplified.map(p => {
      let s = `\n      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">`;
      if (p.ele  !== null) s += `<ele>${p.ele}</ele>`;
      if (p.time !== null) s += `<time>${p.time}</time>`;
      return s + '</trkpt>';
    }).join('');

    // Replace trkseg content; first segment gets all points, extras are dropped
    let first = true;
    return xmlText.replace(/(<trkseg[^>]*>)[\s\S]*?(<\/trkseg>)/g, (_, open, close) => {
      if (first) { first = false; return open + trkpts + '\n    ' + close; }
      return '';
    });
  }
  function bakeOverrideDurationIntoGpx(gpxText, durationSeconds) {
    if (!gpxText || !durationSeconds) return gpxText;
    const doc   = new DOMParser().parseFromString(gpxText, 'text/xml');
    const gpxNs = 'http://www.topografix.com/GPX/1/1';
    const ns    = doc.documentElement.namespaceURI || '';

    function getTrkpts() {
      const byNs = doc.getElementsByTagNameNS(gpxNs, 'trkpt');
      return Array.from(byNs.length ? byNs : doc.getElementsByTagName('trkpt'));
    }
    function getTimeEl(trkpt) {
      return trkpt.getElementsByTagNameNS(gpxNs, 'time')[0]
          || trkpt.getElementsByTagName('time')[0]
          || null;
    }

    const trkpts = getTrkpts();
    if (trkpts.length < 2) return gpxText;

    const existingTimes = trkpts.map(el => {
      const t = getTimeEl(el);
      return t ? new Date(t.textContent) : null;
    });
    const hasTimestamps = existingTimes.every(t => t && !isNaN(t.getTime()));

    // Haversine in metres
    function hav(lat1, lon1, lat2, lon2) {
      const R = 6371000, r = Math.PI / 180;
      const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
      const a = Math.sin(dLat / 2) ** 2
              + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Cumulative distances for proportional distribution
    const lats = trkpts.map(el => parseFloat(el.getAttribute('lat')));
    const lons = trkpts.map(el => parseFloat(el.getAttribute('lon')));
    const cumDist = [0];
    for (let i = 1; i < trkpts.length; i++)
      cumDist.push(cumDist[i - 1] + hav(lats[i - 1], lons[i - 1], lats[i], lons[i]));
    const totalDist = cumDist[cumDist.length - 1];

    const durationMs = durationSeconds * 1000;
    // Anchor: use first existing timestamp if available, otherwise "now − duration"
    const startMs = hasTimestamps
      ? existingTimes[0].getTime()
      : Date.now() - durationMs;
    const origSpanMs = hasTimestamps
      ? existingTimes[existingTimes.length - 1].getTime() - existingTimes[0].getTime()
      : 0;

    for (let i = 0; i < trkpts.length; i++) {
      let offsetMs;
      if (hasTimestamps && origSpanMs > 0) {
        // Preserve relative timing, just rescale to new total duration
        offsetMs = Math.round(
          (existingTimes[i].getTime() - existingTimes[0].getTime()) * durationMs / origSpanMs
        );
      } else {
        // No timestamps (or zero-span): distribute proportionally by distance
        offsetMs = totalDist > 0
          ? Math.round((cumDist[i] / totalDist) * durationMs)
          : Math.round((i / (trkpts.length - 1)) * durationMs);
      }

      const iso = new Date(startMs + offsetMs).toISOString();
      let timeEl = getTimeEl(trkpts[i]);
      if (!timeEl) {
        timeEl = ns ? doc.createElementNS(ns, 'time') : doc.createElement('time');
        trkpts[i].insertBefore(timeEl, trkpts[i].firstChild);
      }
      timeEl.textContent = iso;
    }

    return new XMLSerializer().serializeToString(doc);
  }
  // Replaces every top-level <wpt> in gpxText with the given waypoint list
  // (each { lat, lon, ele, name, desc }). Used for add/edit/remove alike —
  // callers always pass the full desired list and this reserializes once.
  function patchGpxWaypoints(gpxText, waypoints) {
    if (!gpxText) return gpxText;
    const doc  = new DOMParser().parseFromString(gpxText, 'text/xml');
    const root = doc.documentElement;
    const ns   = root.namespaceURI || '';

    Array.from(root.children)
      .filter(child => child.localName === 'wpt')
      .forEach(el => root.removeChild(el));

    const trkEl = Array.from(root.children).find(child => child.localName === 'trk') || null;

    waypoints.forEach(wp => {
      const el = ns ? doc.createElementNS(ns, 'wpt') : doc.createElement('wpt');
      el.setAttribute('lat', wp.lat);
      el.setAttribute('lon', wp.lon);
      if (wp.ele !== null && wp.ele !== undefined) {
        const eleEl = ns ? doc.createElementNS(ns, 'ele') : doc.createElement('ele');
        eleEl.textContent = wp.ele;
        el.appendChild(eleEl);
      }
      if (wp.name) {
        const nameEl = ns ? doc.createElementNS(ns, 'name') : doc.createElement('name');
        nameEl.textContent = wp.name;
        el.appendChild(nameEl);
      }
      if (wp.desc) {
        const descEl = ns ? doc.createElementNS(ns, 'desc') : doc.createElement('desc');
        descEl.textContent = wp.desc;
        el.appendChild(descEl);
      }
      root.insertBefore(el, trkEl); // GPX schema requires wpt/rte before trk
    });

    return new XMLSerializer().serializeToString(doc);
  }
  function patchGpxMeta(gpxText, patches) {
    if (!gpxText) return gpxText;
    const doc  = new DOMParser().parseFromString(gpxText, 'text/xml');
    const root = doc.documentElement;
    const ns   = root.namespaceURI || '';

    function childByTag(parent, tag) {
      for (const child of parent.children) {
        if (child.localName === tag) return child;
      }
      return null;
    }
    function setOrCreate(parent, tag, val) {
      let el = childByTag(parent, tag);
      if (!el) {
        el = ns ? doc.createElementNS(ns, tag) : doc.createElement(tag);
        parent.appendChild(el);
      }
      el.textContent = val;
    }

    let meta = childByTag(root, 'metadata');
    function ensureMeta() {
      if (!meta) {
        meta = ns ? doc.createElementNS(ns, 'metadata') : doc.createElement('metadata');
        root.insertBefore(meta, root.firstChild);
      }
      return meta;
    }

    if ('name' in patches) {
      setOrCreate(ensureMeta(), 'name', patches.name ?? '');
      for (const child of Array.from(root.children)) {
        if (child.localName === 'trk') setOrCreate(child, 'name', patches.name ?? '');
      }
    }
    if ('description' in patches) setOrCreate(ensureMeta(), 'desc', patches.description ?? '');
    if ('author' in patches) {
      const m = ensureMeta();
      let a = childByTag(m, 'author');
      if (!a) {
        a = ns ? doc.createElementNS(ns, 'author') : doc.createElement('author');
        m.appendChild(a);
      }
      setOrCreate(a, 'name', patches.author ?? '');
    }

    return new XMLSerializer().serializeToString(doc);
  }
  function trimGpxToRange(xmlText, startIdx, endIdx) {
    const doc  = new DOMParser().parseFromString(xmlText, 'application/xml');
    const ns   = 'http://www.topografix.com/GPX/1/1';
    let els    = Array.from(doc.getElementsByTagNameNS(ns, 'trkpt'));
    if (!els.length) els = Array.from(doc.getElementsByTagName('trkpt'));
    els.forEach((el, i) => { if (i < startIdx || i > endIdx) el.parentNode.removeChild(el); });
    return new XMLSerializer().serializeToString(doc);
  }
  function reverseGpxTrack(gpxText) {
    if (!gpxText) return gpxText;
    const doc   = new DOMParser().parseFromString(gpxText, 'application/xml');
    const ns    = 'http://www.topografix.com/GPX/1/1';

    let segments = Array.from(doc.getElementsByTagNameNS(ns, 'trkseg'));
    if (!segments.length) segments = Array.from(doc.getElementsByTagName('trkseg'));
    if (!segments.length) return gpxText;

    segments.forEach(seg => {
      let pts = Array.from(seg.getElementsByTagNameNS(ns, 'trkpt'));
      if (!pts.length) pts = Array.from(seg.getElementsByTagName('trkpt'));
      pts.forEach(el => {
        const timeEl = el.getElementsByTagNameNS(ns, 'time')[0] || el.getElementsByTagName('time')[0];
        if (timeEl) timeEl.parentNode.removeChild(timeEl);
      });
      for (let i = pts.length - 1; i >= 0; i--) seg.appendChild(pts[i]);
    });

    const parent = segments[0].parentNode;
    for (let i = segments.length - 1; i >= 0; i--) parent.appendChild(segments[i]);

    return new XMLSerializer().serializeToString(doc);
  }
  // Merges routes into one track, one <trkseg> per route in legend order. Keeping the
  // segments separate means no straight line is drawn between one route's end and the next start.
  function buildMergedGpx(items, name) {
    const segs = items.map(it => '<trkseg>' + it.points.map(p =>
      `<trkpt lat="${p.lat}" lon="${p.lon}">` +
      (p.ele != null ? `<ele>${p.ele}</ele>` : '') +
      (p.time ? `<time>${p.time.toISOString()}</time>` : '') +
      '</trkpt>').join('') + '</trkseg>').join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GPX Library" xmlns="http://www.topografix.com/GPX/1/1">` +
      `<metadata><name>${escapeHtml(name)}</name></metadata><trk><name>${escapeHtml(name)}</name>${segs}</trk></gpx>`;
  }

  return {
    simplifyGpxForSharing, bakeOverrideDurationIntoGpx, patchGpxWaypoints, patchGpxMeta,
    trimGpxToRange, reverseGpxTrack, buildMergedGpx, geoDistM,
  };
})();
