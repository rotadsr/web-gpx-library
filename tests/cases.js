// Shared test cases: run in the browser via tests/index.html or in Node via tests/run-node.js.
// Expects globals: GPXParser, Util, test(name, fn), assert(cond, msg), assertEq(a, b, msg).

const GPX = (trkpts, wpts = '') => `<?xml version="1.0"?>
<gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Sample</name></metadata>
  ${wpts}
  <trk><name>Sample</name><trkseg>${trkpts}</trkseg></trk>
</gpx>`;
const pt = (lat, lon, ele, time) =>
  `<trkpt lat="${lat}" lon="${lon}">${ele !== undefined ? `<ele>${ele}</ele>` : ''}${time ? `<time>${time}</time>` : ''}</trkpt>`;

test('escapeHtml neutralises markup and quotes', () => {
  assertEq(Util.escapeHtml('<img src=x onerror="a()">'), '&lt;img src=x onerror=&quot;a()&quot;&gt;');
  assertEq(Util.escapeHtml("a&b'c"), 'a&amp;b&#39;c');
  assertEq(Util.escapeHtml(5), '5');
});

test('parse reads metadata and points', () => {
  const r = GPXParser.parse(GPX(pt(42, 1, 100) + pt(42.01, 1, 150)));
  assertEq(r.metadata.name, 'Sample');
  assertEq(r.points.length, 2);
});

test('distance of 0.01° latitude is ≈1.11 km', () => {
  const r = GPXParser.parse(GPX(pt(42, 1, 0) + pt(42.01, 1, 0)));
  assert(Math.abs(r.stats.totalDistance - 1.112) < 0.01, 'got ' + r.stats.totalDistance);
});

test('elevation gain counts only climbs', () => {
  const r = GPXParser.parse(GPX(pt(42, 1, 100) + pt(42.001, 1, 150) + pt(42.002, 1, 120) + pt(42.003, 1, 140)));
  assertEq(r.stats.elevationGain, 70); // +50, -30 ignored, +20
  assertEq(r.stats.maxElevation, 150);
  assertEq(r.stats.minElevation, 100);
});

test('malformed elevation becomes null and does not poison stats', () => {
  const r = GPXParser.parse(GPX(pt(42, 1, 100) + pt(42.001, 1, 'abc') + pt(42.002, 1, 130)));
  assertEq(r.points[1].ele, null);
  assert(Number.isFinite(r.stats.elevationGain), 'gain must be finite');
  assertEq(r.stats.maxElevation, 130);
});

test('invalid timestamps become null; valid ones give duration and speed', () => {
  const bad = GPXParser.parse(GPX(pt(42, 1, 0, 'garbage') + pt(42.01, 1, 0, 'nope')));
  assertEq(bad.points[0].time, null);
  assertEq(bad.stats.totalTime, null);
  const ok = GPXParser.parse(GPX(pt(42, 1, 0, '2024-01-01T10:00:00Z') + pt(42.01, 1, 0, '2024-01-01T11:00:00Z')));
  assertEq(ok.stats.totalTime, 3600);
  assert(Math.abs(ok.stats.avgSpeed - 1.112) < 0.01, 'got ' + ok.stats.avgSpeed);
});

test('out-of-range coordinates are dropped', () => {
  const r = GPXParser.parse(GPX(pt(42, 1, 0) + pt(95, 1, 0) + pt(42, 200, 0) + pt(42.01, 1, 0)));
  assertEq(r.points.length, 2);
});

test('waypoints snap to the nearest track point and inherit its elevation', () => {
  const wpt = '<wpt lat="42.01" lon="1"><name>Top</name></wpt>';
  const r = GPXParser.parse(GPX(pt(42, 1, 100) + pt(42.01, 1, 200) + pt(42.02, 1, 300), wpt));
  assertEq(r.waypoints.length, 1);
  assertEq(r.waypoints[0].ele, 200);
  assert(Math.abs(r.waypoints[0].distKm - 1.112) < 0.01, 'got ' + r.waypoints[0].distKm);
});

test('invalid XML throws', () => {
  let threw = false;
  try { GPXParser.parse('<gpx><oops'); } catch (_) { threw = true; }
  assert(threw, 'expected parse error');
});

test('reverseGpxTrack flips point order and drops timestamps', () => {
  const out = GPXEdit.reverseGpxTrack(GPX(pt(42, 1, 100, '2024-01-01T10:00:00Z') + pt(42.01, 1, 200, '2024-01-01T11:00:00Z')));
  const r = GPXParser.parse(out);
  assertEq(r.points[0].lat, 42.01);
  assertEq(r.points[0].time, null);
});

test('trimGpxToRange keeps only the requested index range', () => {
  const out = GPXEdit.trimGpxToRange(GPX(pt(42, 1) + pt(42.01, 1) + pt(42.02, 1) + pt(42.03, 1)), 1, 2);
  const r = GPXParser.parse(out);
  assertEq(r.points.length, 2);
  assertEq(r.points[0].lat, 42.01);
});

test('patchGpxMeta updates name, description and author', () => {
  const out = GPXEdit.patchGpxMeta(GPX(pt(42, 1) + pt(42.01, 1)), { name: 'New', description: 'D', author: 'Me' });
  const r = GPXParser.parse(out);
  assertEq(r.metadata.name, 'New');
  assertEq(r.metadata.description, 'D');
  assertEq(r.metadata.author, 'Me');
});

test('patchGpxWaypoints replaces all waypoints', () => {
  const base = GPX(pt(42, 1, 10) + pt(42.01, 1, 20), '<wpt lat="42" lon="1"><name>Old</name></wpt>');
  const out = GPXEdit.patchGpxWaypoints(base, [{ lat: 42.01, lon: 1, ele: 20, name: 'New', desc: '' }]);
  const r = GPXParser.parse(out);
  assertEq(r.waypoints.length, 1);
  assertEq(r.waypoints[0].name, 'New');
});

test('buildMergedGpx concatenates routes, escapes the name, and keeps one segment per route', () => {
  const a = GPXParser.parse(GPX(pt(42, 1, 10) + pt(42.01, 1, 20)));
  const b = GPXParser.parse(GPX(pt(43, 1, 30) + pt(43.01, 1, 40)));
  const out = GPXEdit.buildMergedGpx([{ points: a.points }, { points: b.points }], 'A <&> B');
  assertEq((out.match(/<trkseg>/g) || []).length, 2);
  const r = GPXParser.parse(out);
  assertEq(r.points.length, 4);
  assertEq(r.metadata.name, 'A <&> B');
});

test('simplifyGpxForSharing leaves short tracks untouched in point count', () => {
  const out = GPXEdit.simplifyGpxForSharing(GPX(pt(42, 1, 1) + pt(42.01, 1, 2) + pt(42.02, 1, 3)));
  assertEq(GPXParser.parse(out).points.length, 3);
});
