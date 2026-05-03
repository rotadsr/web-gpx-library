/**
 * GPX Library — main application logic.
 * Sources: IndexedDB (My Library, persistent)  |  browser uploads (session-only)
 */

(function () {

  // ── Deploy metadata ──────────────────────────────────────────────────────────
  const DEPLOY_DATE   = 'May 2026'; // update this string on each deploy
  const GITHUB_REPO   = 'https://github.com/rotadsr/web-gpx-library';

  // ── Module state ─────────────────────────────────────────────────────────────
  let savedRoutes    = [];   // persistent — loaded from IndexedDB
  let uploadedRoutes = [];   // session-only — cleared on refresh
  let backupNeeded   = false; // true = library has changes not yet exported
  let searchQuery     = '';
  let elevationChart  = null;
  let currentPoints   = [];
  let activeRouteId   = null;
  let currentGpxText  = null;
  let sharedRouteRef  = null;  // route object loaded from a ?gist= share URL
  let sortMode        = 'alpha-asc'; // 'default'|'alpha-asc'|'alpha-desc'|'newest'|'oldest'|'activity'|'diff-asc'|'diff-desc'
  let overviewMode    = false;
  let difficultyCache = {}; // id → 'easy'|'moderate'|'hard'|'expert'|null
  let locationCache   = {}; // id → lowercase search string (city county state country)
  try { difficultyCache = JSON.parse(localStorage.getItem('gpx-diff-cache') || '{}'); } catch (_) {}
  try { locationCache   = JSON.parse(localStorage.getItem('gpx-loc-cache')  || '{}'); } catch (_) {}

  // Activity / category filter
  let activeCategory  = null;  // null = all, or a CATEGORIES key like 'cycling'
  let activeDifficulty = null; // null = all, or 'easy'|'moderate'|'hard'|'expert'

  // Stats state — stats are always stored in metric internally
  let currentStats     = null;
  let currentMeta      = null;
  let currentActivity  = null;   // resolved activity key for the active route
  let overrideDuration = null;   // user-set seconds; null = use GPX value
  let units            = 'metric'; // 'metric' | 'imperial'

  // User-defined empty folders (names of folders with no routes yet)
  let customFolders = JSON.parse(localStorage.getItem('gpx-library-folders') || '[]');

  function saveCustomFolders() {
    localStorage.setItem('gpx-library-folders', JSON.stringify(customFolders));
  }

  function getAllFolderNames() {
    const fromRoutes = savedRoutes.map(r => r.folder).filter(Boolean);
    return [...new Set([...fromRoutes, ...customFolders])].sort();
  }

  // Fallback speeds (km/h) used when GPX has no timestamps
  const DEFAULT_SPEEDS = {
    hiking:         4,
    mountainSports: 3,
    cycling:        20,
    snow:           5,
    running:        10,
    water:          6,
  };

  function getDefaultSpeed(activityKey) {
    const cat = getActivityCategory(activityKey);
    return DEFAULT_SPEEDS[cat] || DEFAULT_SPEEDS.hiking;
  }

  // Chart view mode
  let chartMode        = 'elevation'; // 'elevation' | 'gradient'
  let chartSegmentData = null;        // { profile, gradients, dFactor, eFactor } for plugin

  // Weather state
  let currentWeatherData = null; // raw daily object from Open-Meteo (metric)

  // ── Unit helpers ─────────────────────────────────────────────────────────────

  const KM_TO_MI  = 0.621371;
  const M_TO_FT   = 3.28084;

  function fmtDist(km) {
    return units === 'imperial'
      ? `${(km * KM_TO_MI).toFixed(2)} mi`
      : `${km.toFixed(2)} km`;
  }

  function fmtElev(m) {
    return units === 'imperial'
      ? `${Math.round(m * M_TO_FT)} ft`
      : `${Math.round(m)} m`;
  }

  function fmtSpeed(kmh) {
    return units === 'imperial'
      ? `${(kmh * KM_TO_MI).toFixed(1)} mph`
      : `${kmh.toFixed(1)} km/h`;
  }

  // ── Duration helpers ──────────────────────────────────────────────────────────

  // Value to prefill in the inline input (H:MM)
  function fmtDurationForEdit(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}:${m.toString().padStart(2, '0')}`;
  }

  // Speed value to prefill in current display units
  function fmtSpeedForEdit(kmh) {
    const v = units === 'imperial' ? kmh * KM_TO_MI : kmh;
    return v.toFixed(1);
  }

  /**
   * Parse a user-typed duration string → seconds.
   * Accepts: "3:24"  "3h24m"  "3h 24m"  "204" (minutes)  "3.5" (hours treated as hours)
   */
  function parseDurationInput(raw) {
    const s = raw.trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return null;

    // H:MM or HH:MM
    const colon = s.match(/^(\d+):(\d{1,2})$/);
    if (colon) {
      const h = parseInt(colon[1], 10);
      const m = parseInt(colon[2], 10);
      return m < 60 ? h * 3600 + m * 60 : null;
    }

    // 3h24m  or  3h24
    const hm = s.match(/^(\d+)h(\d+)m?$/);
    if (hm) return parseInt(hm[1]) * 3600 + parseInt(hm[2]) * 60;

    // 3h
    const h = s.match(/^(\d+\.?\d*)h$/);
    if (h) return Math.round(parseFloat(h[1]) * 3600);

    // 204m or 204min
    const min = s.match(/^(\d+\.?\d*)m(in)?$/);
    if (min) return Math.round(parseFloat(min[1]) * 60);

    // plain number → minutes
    const num = s.match(/^(\d+\.?\d*)$/);
    if (num) return Math.round(parseFloat(num[1]) * 60);

    return null;
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────────

  async function init() {
    setupUploadZone();
    setupExportImport();

    try {
      await Storage.init();
      const routes = await Storage.getAllRoutes();
      savedRoutes = routes.map(r => ({ ...r, source: 'saved' }));
      if (savedRoutes.length > 0) backupNeeded = true;
    } catch (err) {
      console.warn('Storage init failed:', err.message);
    }

    buildCategoryPills();
    renderFileTree();

    checkSharedGistParam();

    document.getElementById('search-input').addEventListener('input', e => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderFileTree();
    });
  }

  // ── Dropdown helpers ──────────────────────────────────────────────────────────

  const SORT_LABELS = {
    'default':    'Sort',
    'alpha-asc':  'A→Z',
    'alpha-desc': 'Z→A',
    'newest':     'Newest',
    'oldest':     'Oldest',
    'activity':   'Activity',
    'diff-asc':   'Easy first',
    'diff-desc':  'Hard first',
  };

  function updateSortBtn() {
    const btn = document.getElementById('btn-sort-lib');
    if (!btn) return;
    btn.textContent = '⇅ ' + (SORT_LABELS[sortMode] || 'Sort');
    btn.classList.toggle('is-active', sortMode !== 'default' && sortMode !== 'alpha-asc');
  }

  function positionDropdown(menu, anchor) {
    const r = anchor.getBoundingClientRect();
    // Right-align with anchor; flip above if not enough space below
    const rightPx = window.innerWidth - r.right;
    menu.style.right = rightPx + 'px';
    menu.style.left  = 'auto';
    menu.style.top   = (r.bottom + 4) + 'px';
    // Flip above after measuring (menu is in DOM but off-screen until next paint)
    requestAnimationFrame(() => {
      const mh = menu.offsetHeight;
      if (r.bottom + 4 + mh > window.innerHeight - 8) {
        menu.style.top = Math.max(4, r.top - mh - 4) + 'px';
      }
    });
  }

  function openDropdown(id, buildFn, anchor) {
    document.getElementById(id)?.remove();
    const menu = document.createElement('div');
    menu.id        = id;
    menu.className = 'lib-dropdown';
    buildFn(menu);
    document.body.appendChild(menu);
    positionDropdown(menu, anchor);
    const dismiss = e => {
      if (!menu.contains(e.target) && e.target !== anchor) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
  }

  function showSortDropdown(anchor) {
    openDropdown('sort-dropdown', menu => {
      [
        { key: 'alpha-asc',  label: 'A → Z' },
        { key: 'alpha-desc', label: 'Z → A' },
        { key: 'newest',     label: 'Newest first' },
        { key: 'oldest',     label: 'Oldest first' },
        { key: 'activity',   label: 'By activity' },
        { key: 'diff-asc',   label: '🟢 Easy first' },
        { key: 'diff-desc',  label: '⚫ Hard first' },
      ].forEach(({ key, label }) => {
        const item = document.createElement('div');
        item.className = 'lib-dropdown-item' + (sortMode === key ? ' is-active' : '');
        item.innerHTML =
          `<span class="lib-dropdown-check">${sortMode === key ? '✓' : ''}</span>${label}`;
        item.addEventListener('click', () => {
          sortMode = key;
          menu.remove();
          updateSortBtn();
          renderFileTree();
        });
        menu.appendChild(item);
      });
    }, anchor);
  }

  function showLibMenu(anchor) {
    openDropdown('lib-menu-dropdown', menu => {
      const addItem = (label, action) => {
        const item = document.createElement('div');
        item.className   = 'lib-dropdown-item';
        item.textContent = label;
        item.addEventListener('click', () => { menu.remove(); action(); });
        menu.appendChild(item);
      };
      const addDivider = () => {
        const d = document.createElement('div');
        d.className = 'lib-dropdown-divider';
        menu.appendChild(d);
      };

      addItem('📁  New Folder', createNewFolder);
      addDivider();
      addItem('⬆  Import…', () => document.getElementById('import-lib-input').click());
      addItem('⬇  Export', doExport);
    }, anchor);
  }

  // ── Export / Import ───────────────────────────────────────────────────────────

  function setupExportImport() {
    const importInput = document.getElementById('import-lib-input');
    document.getElementById('btn-lib-menu')?.addEventListener('click', e => {
      e.stopPropagation();
      showLibMenu(e.currentTarget);
    });
    importInput?.addEventListener('change', async () => {
      const file = importInput.files[0];
      if (file) { await doImport(file); importInput.value = ''; }
    });
  }

  function setupSort() {
    updateSortBtn();
    document.getElementById('btn-sort-lib')?.addEventListener('click', e => {
      e.stopPropagation();
      showSortDropdown(e.currentTarget);
    });
  }

  async function doExport() {
    try {
      const json = await Storage.exportLibrary();
      const blob = new Blob([json], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const a = Object.assign(document.createElement('a'), {
        href: url, download: `gpx-library-${date}.json`,
      });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      backupNeeded = false;
    } catch (err) {
      alert('Export failed: ' + err.message);
    }
  }

  async function doImport(file) {
    let text;
    try { text = await file.text(); } catch { alert('Could not read file.'); return; }

    const run = async (mode) => {
      try {
        const count = await Storage.importLibrary(text, mode);
        savedRoutes = (await Storage.getAllRoutes()).map(r => ({ ...r, source: 'saved' }));
        buildCategoryPills();
        renderFileTree();
        alert(`Imported ${count} route${count !== 1 ? 's' : ''} successfully.`);
      } catch (err) {
        alert('Import failed: ' + err.message);
      }
    };

    if (savedRoutes.length > 0) {
      showImportConfirm(savedRoutes.length, () => run('merge'), () => run('overwrite'));
    } else {
      run('merge');
    }
  }

  function showImportConfirm(existingCount, onMerge, onOverwrite) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <h3>Import Library</h3>
        <p>Your library already has <strong>${existingCount}</strong> route${existingCount !== 1 ? 's' : ''}.<br>
        How would you like to import?</p>
        <div class="confirm-btns">
          <button class="confirm-merge">Merge (add to existing)</button>
          <button class="confirm-overwrite">Overwrite (replace all)</button>
          <button class="confirm-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.confirm-merge').onclick    = () => { overlay.remove(); onMerge(); };
    overlay.querySelector('.confirm-overwrite').onclick = () => { overlay.remove(); onOverwrite(); };
    overlay.querySelector('.confirm-cancel').onclick    = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  // ── Save / Delete library routes ──────────────────────────────────────────────

  async function saveUploadToLibrary(route) {
    try {
      const folder = (route.folder && route.folder !== 'Uploads') ? route.folder : 'My Routes';
      const id = await Storage.saveRoute({
        name:        route.name,
        description: route.description || '',
        activity:    route.activity,
        tags:        route.tags || [],
        folder,
        gpxText:     route.gpxText,
      });
      savedRoutes.push({
        name: route.name, description: route.description || '', activity: route.activity,
        tags: route.tags || [], folder, gpxText: route.gpxText,
        id, source: 'saved', createdAt: new Date().toISOString(),
      });
      uploadedRoutes = uploadedRoutes.filter(r => r.id !== route.id);
      if (activeRouteId === route.id) activeRouteId = id;
      backupNeeded = true;
      buildCategoryPills();
      renderFileTree();
    } catch (err) {
      console.error('Save error:', err);
      alert('Could not save route: ' + err.message);
    }
  }

  async function deleteFromLibrary(id) {
    if (!confirm('Remove this route from your library?')) return;
    try {
      await Storage.deleteRoute(id);
      const wasActive = activeRouteId === id;
      savedRoutes = savedRoutes.filter(r => r.id !== id);
      if (wasActive) {
        document.getElementById('route-view').style.display  = 'none';
        document.getElementById('empty-state').style.display = 'flex';
        activeRouteId = null;
      }
      backupNeeded = savedRoutes.length > 0;
      buildCategoryPills();
      renderFileTree();
    } catch (err) {
      console.error('Delete error:', err);
      alert('Could not delete route: ' + err.message);
    }
  }

  /** Called by the editor when the user clicks "Save to Library". */
  async function handleEditorSave(routeData, originalRoute) {
    try {
      if (originalRoute.source === 'saved' && typeof originalRoute.id === 'number') {
        // Update existing saved route
        const updated = { ...routeData, id: originalRoute.id };
        await Storage.saveRoute(updated);
        const idx = savedRoutes.findIndex(r => r.id === originalRoute.id);
        if (idx >= 0) savedRoutes[idx] = { ...updated, source: 'saved' };
      } else {
        // Save as new library entry
        const folder = (originalRoute.folder && originalRoute.folder !== 'Uploads')
          ? originalRoute.folder : 'My Routes';
        const id = await Storage.saveRoute({ ...routeData, folder });
        savedRoutes.push({ ...routeData, folder, id, source: 'saved' });
        if (originalRoute.source === 'upload') {
          uploadedRoutes = uploadedRoutes.filter(r => r.id !== originalRoute.id);
          if (activeRouteId === originalRoute.id) activeRouteId = id;
        }
      }
      backupNeeded = true;
      buildCategoryPills();
      renderFileTree();
      return true;
    } catch (err) {
      console.error('Editor save error:', err);
      alert('Could not save route: ' + err.message);
      return false;
    }
  }

  // ── Upload zone ───────────────────────────────────────────────────────────────

  function setupUploadZone() {
    const zone  = document.getElementById('upload-zone');
    const input = document.getElementById('file-input');

    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') input.click(); });

    input.addEventListener('change', () => {
      handleFileUpload(Array.from(input.files));
      input.value = '';
    });

    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.gpx'));
      if (files.length) handleFileUpload(files);
    });

    const sidebar = document.getElementById('sidebar');
    sidebar.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    sidebar.addEventListener('dragleave', e => { if (!sidebar.contains(e.relatedTarget)) zone.classList.remove('drag-over'); });
    sidebar.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.gpx'));
      if (files.length) handleFileUpload(files);
    });
  }

  function handleFileUpload(files) {
    let loaded = 0;
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = e => {
        const gpxText = e.target.result;
        let name     = file.name.replace(/\.gpx$/i, '').replace(/[-_]/g, ' ');
        let activity = null;
        try {
          const doc    = new DOMParser().parseFromString(gpxText, 'text/xml');
          const nameEl = doc.querySelector('metadata > name') || doc.querySelector('trk > name');
          if (nameEl && nameEl.textContent.trim()) name = nameEl.textContent.trim();
          const typeEl = doc.querySelector('trk > type');
          if (typeEl && ACTIVITIES[typeEl.textContent.trim()]) activity = typeEl.textContent.trim();
        } catch (_) {}

        const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        uploadedRoutes.push({ id, name, activity, folder: 'Uploads', source: 'upload', gpxText, tags: [], description: `Uploaded: ${file.name}` });

        if (++loaded === files.length) { buildCategoryPills(); renderFileTree(); }
      };
      reader.readAsText(file);
    });
  }

  function removeUpload(id) {
    uploadedRoutes = uploadedRoutes.filter(r => r.id !== id);
    if (activeRouteId === id) {
      document.getElementById('route-view').style.display  = 'none';
      document.getElementById('empty-state').style.display = 'flex';
      activeRouteId = null;
    }
    renderFileTree();
  }

  // ── Activity category pills ───────────────────────────────────────────────────

  function buildCategoryPills() {
    const container = document.getElementById('category-pills');
    container.innerHTML = '';

    const allRoutes = [...savedRoutes, ...uploadedRoutes];
    Object.entries(CATEGORIES).forEach(([key, cat]) => {
      const hasRoutes = allRoutes.some(r => getActivityCategory(r.activity) === key);
      if (!hasRoutes) return;

      const btn = document.createElement('button');
      btn.className = 'category-pill' + (activeCategory === key ? ' active' : '');
      btn.dataset.category = key;
      btn.innerHTML =
        `<span class="category-pill-emoji">${cat.emoji}</span>${cat.name}`;
      btn.title = cat.name;
      btn.addEventListener('click', () => {
        activeCategory = activeCategory === key ? null : key;
        buildCategoryPills();
        renderFileTree();
      });
      container.appendChild(btn);
    });

    buildDifficultyPills();
  }

  const DIFFICULTY_META = [
    { key: 'easy',     label: 'Easy',     circle: '🟢' },
    { key: 'moderate', label: 'Moderate', circle: '🟡' },
    { key: 'hard',     label: 'Hard',     circle: '🔴' },
    { key: 'expert',   label: 'Expert',   circle: '⚫' },
  ];

  function buildDifficultyPills() {
    const section   = document.getElementById('difficulty-filter-section');
    const container = document.getElementById('difficulty-pills');
    if (!container) return;

    const allRoutes = [...savedRoutes, ...uploadedRoutes];
    if (!allRoutes.length) { section.style.display = 'none'; return; }
    section.style.display = '';

    container.innerHTML = '';
    DIFFICULTY_META.forEach(({ key, label, circle }) => {
      const btn = document.createElement('button');
      btn.className = 'difficulty-pill' + (activeDifficulty === key ? ' active' : '');
      btn.dataset.difficulty = key;
      btn.textContent = `${circle} ${label}`;
      btn.addEventListener('click', () => {
        activeDifficulty = activeDifficulty === key ? null : key;
        buildDifficultyPills();
        renderFileTree();
      });
      container.appendChild(btn);
    });
  }

  // ── Sorting ───────────────────────────────────────────────────────────────────

  function getRouteTimestamp(route) {
    if (route.createdAt) return Date.parse(route.createdAt);
    const m = route.id && String(route.id).match(/\b(\d{13})\b/);
    return m ? parseInt(m[1]) : 0;
  }

  function sortRoutes(routes) {
    if (sortMode === 'default') return routes;
    const s = [...routes];
    switch (sortMode) {
      case 'alpha-asc':  return s.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      case 'alpha-desc': return s.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
      case 'newest':     return s.sort((a, b) => getRouteTimestamp(b) - getRouteTimestamp(a));
      case 'oldest':     return s.sort((a, b) => getRouteTimestamp(a) - getRouteTimestamp(b));
      case 'activity':   return s.sort((a, b) => {
        const cA = getActivityCategory(a.activity) || '￿';
        const cB = getActivityCategory(b.activity) || '￿';
        const dc = cA.localeCompare(cB);
        if (dc !== 0) return dc;
        const dn = getActivityName(a.activity).localeCompare(getActivityName(b.activity));
        if (dn !== 0) return dn;
        return (a.name || '').localeCompare(b.name || '');
      });
      case 'diff-asc':
      case 'diff-desc': {
        const DIFF_RANK = { easy: 0, moderate: 1, hard: 2, expert: 3 };
        const dir = sortMode === 'diff-asc' ? 1 : -1;
        return s.sort((a, b) => {
          const ra = DIFF_RANK[difficultyCache[a.id]] ?? 4;
          const rb = DIFF_RANK[difficultyCache[b.id]] ?? 4;
          if (ra !== rb) return (ra - rb) * dir;
          return (a.name || '').localeCompare(b.name || '');
        });
      }
      default: return s;
    }
  }

  function saveDifficultyCache() {
    try { localStorage.setItem('gpx-diff-cache', JSON.stringify(difficultyCache)); } catch (_) {}
  }

  // ── Location geocoding ────────────────────────────────────────────────────────

  let _geocodeQueue = [];
  let _geocodeTimer = null;

  function enqueueGeocode(id, lat, lon) {
    if (locationCache[id] !== undefined) return;
    if (_geocodeQueue.some(q => q.id === id)) return;
    _geocodeQueue.push({ id, lat, lon });
    if (!_geocodeTimer) _drainGeocodeQueue();
  }

  function _drainGeocodeQueue() {
    _geocodeTimer = null;
    if (!_geocodeQueue.length) return;
    const { id, lat, lon } = _geocodeQueue.shift();
    fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&zoom=10`,
      { headers: { 'Accept-Language': 'en' } }
    )
      .then(r => r.json())
      .then(d => {
        const a = d.address || {};
        const parts = [
          a.city || a.town || a.village || a.municipality || '',
          a.county || a.district || '',
          a.state || a.region || '',
          a.country || '',
          (a.country_code || '').toUpperCase(),
        ].filter(Boolean);
        locationCache[id] = parts.join(' ').toLowerCase();
        try { localStorage.setItem('gpx-loc-cache', JSON.stringify(locationCache)); } catch (_) {}
        if (searchQuery) renderFileTree();
      })
      .catch(() => { locationCache[id] = ''; })
      .finally(() => {
        if (_geocodeQueue.length) _geocodeTimer = setTimeout(_drainGeocodeQueue, 1100);
      });
  }

  // ── File tree ─────────────────────────────────────────────────────────────────

  function renderFileTree() {
    const tree = document.getElementById('file-tree');
    tree.innerHTML = '';

    const filteredSaved   = sortRoutes(filterRoutes(savedRoutes));
    const filteredUploads = sortRoutes(filterBySearch(uploadedRoutes));

    if (!filteredSaved.length && !filteredUploads.length) {
      // Different message if library is just empty vs no search match
      if (!searchQuery && !activeCategory && !savedRoutes.length && !uploadedRoutes.length) {
        tree.innerHTML = '<p class="empty-msg" style="line-height:1.7">No routes yet.<br><span style="font-size:11px;color:#475569">Upload a GPX below to get started.</span></p>';
      } else {
        tree.innerHTML = '<p class="empty-msg">No routes match your search.</p>';
      }
      return;
    }

    // ── My Library (saved routes) ──
    if (filteredSaved.length) {
      appendFolderGroups(tree, filteredSaved);
    }

    // ── Uploaded Routes (session-only) ──
    if (filteredUploads.length) {
      if (filteredSaved.length) {
        const divider = document.createElement('div');
        divider.className = 'tree-divider';
        tree.appendChild(divider);
      }

      const section = document.createElement('div');
      section.className = 'uploads-section';

      const label = document.createElement('div');
      label.className = 'uploads-label';
      label.innerHTML = `<span>📤 Uploaded Routes</span>
        <button class="clear-uploads-btn" title="Remove all uploads">Clear all</button>`;
      label.querySelector('.clear-uploads-btn').addEventListener('click', e => {
        e.stopPropagation();
        const wasViewing = activeRouteId && uploadedRoutes.some(r => r.id === activeRouteId);
        uploadedRoutes = [];
        if (wasViewing) {
          document.getElementById('route-view').style.display  = 'none';
          document.getElementById('empty-state').style.display = 'flex';
          activeRouteId = null;
        }
        renderFileTree();
      });
      section.appendChild(label);

      const list = document.createElement('ul');
      list.className = 'route-list';
      filteredUploads.forEach(route => list.appendChild(buildRouteItem(route)));
      section.appendChild(list);
      tree.appendChild(section);
    }

    if (overviewMode) enterOverview();
  }

  function appendFolderGroups(container, routes) {
    const byFolder = {};
    routes.forEach(r => (byFolder[r.folder] = byFolder[r.folder] || []).push(r));
    customFolders.forEach(f => { if (!byFolder[f]) byFolder[f] = []; });

    Object.keys(byFolder).sort().forEach(folder => {
      const group = document.createElement('div');
      group.className = 'folder-group';
      const isEmpty = byFolder[folder].length === 0;

      const header = document.createElement('div');
      header.className = 'folder-header';

      const iconSpan = document.createElement('span');
      iconSpan.className = 'folder-icon';
      iconSpan.textContent = getFolderIcon(folder);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'folder-name';
      nameSpan.textContent = folder;

      const countSpan = document.createElement('span');
      countSpan.className = 'folder-count';
      countSpan.textContent = byFolder[folder].length;

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'folder-actions';

      const renameBtn = document.createElement('button');
      renameBtn.className = 'folder-action-btn';
      renameBtn.title = 'Rename folder';
      renameBtn.innerHTML = SVG_PENCIL;
      renameBtn.addEventListener('click', e => {
        e.stopPropagation();
        startFolderRename(nameSpan, folder, iconSpan);
      });
      actionsDiv.appendChild(renameBtn);

      if (isEmpty) {
        const delBtn = document.createElement('button');
        delBtn.className = 'folder-action-btn';
        delBtn.title = 'Delete empty folder';
        delBtn.innerHTML = SVG_TRASH;
        delBtn.addEventListener('click', e => {
          e.stopPropagation();
          customFolders = customFolders.filter(f => f !== folder);
          saveCustomFolders();
          renderFileTree();
        });
        actionsDiv.appendChild(delBtn);
      }

      header.appendChild(iconSpan);
      header.appendChild(nameSpan);
      header.appendChild(countSpan);
      header.appendChild(actionsDiv);
      header.addEventListener('click', () => group.classList.toggle('collapsed'));
      group.appendChild(header);

      const list = document.createElement('ul');
      list.className = 'route-list';
      byFolder[folder].forEach(route => list.appendChild(buildRouteItem(route)));
      if (isEmpty) {
        const hint = document.createElement('li');
        hint.className = 'folder-empty-hint';
        hint.textContent = 'No routes yet';
        list.appendChild(hint);
      }
      group.appendChild(list);
      container.appendChild(group);
    });
  }

  function startFolderRename(nameSpan, currentName, iconSpan) {
    const input = document.createElement('input');
    input.className = 'folder-name-input';
    input.value = currentName;

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      nameSpan.textContent = newName || currentName;
      input.replaceWith(nameSpan);
      if (newName && newName !== currentName) {
        iconSpan.textContent = getFolderIcon(newName);
        await renameFolder(currentName, newName);
      }
    };

    nameSpan.replaceWith(input);
    input.focus();
    input.select();
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { committed = true; input.replaceWith(nameSpan); }
    });
  }

  async function renameFolder(oldName, newName) {
    const toUpdate = savedRoutes.filter(r => r.folder === oldName);
    for (const route of toUpdate) {
      route.folder = newName;
      await Storage.saveRoute(route);
    }
    const ci = customFolders.indexOf(oldName);
    if (ci >= 0) { customFolders[ci] = newName; saveCustomFolders(); }
    if (toUpdate.length > 0) backupNeeded = true;
    renderFileTree();
  }

  function createNewFolder() {
    const existing = getAllFolderNames();
    let name = 'New Folder';
    let i = 2;
    while (existing.includes(name)) name = `New Folder ${i++}`;
    customFolders.push(name);
    saveCustomFolders();
    renderFileTree();
    requestAnimationFrame(() => {
      const tree = document.getElementById('file-tree');
      for (const span of tree.querySelectorAll('.folder-name')) {
        if (span.textContent === name) {
          startFolderRename(span, name, span.previousElementSibling);
          break;
        }
      }
    });
  }

  let activeFolderPicker = null;

  function showFolderPicker(anchorEl, route) {
    if (activeFolderPicker) { activeFolderPicker.remove(); activeFolderPicker = null; }

    const picker = document.createElement('div');
    picker.className = 'folder-picker';
    activeFolderPicker = picker;

    const hdr = document.createElement('div');
    hdr.className = 'folder-picker-header';
    hdr.textContent = 'Move to folder';
    picker.appendChild(hdr);

    getAllFolderNames().forEach(f => {
      const item = document.createElement('div');
      item.className = 'folder-picker-item' + (route.folder === f ? ' current' : '');
      item.innerHTML = `<span>${getFolderIcon(f)}</span><span>${f}</span>`;
      if (route.folder !== f) {
        item.addEventListener('click', () => {
          picker.remove(); activeFolderPicker = null;
          moveRouteToFolder(route, f);
        });
      }
      picker.appendChild(item);
    });

    const div = document.createElement('div');
    div.className = 'folder-picker-divider';
    picker.appendChild(div);

    const newItem = document.createElement('div');
    newItem.className = 'folder-picker-item folder-picker-new';
    newItem.innerHTML = '<span>+</span><span>New folder…</span>';
    newItem.addEventListener('click', () => {
      picker.remove(); activeFolderPicker = null;
      const existing = getAllFolderNames();
      let name = 'New Folder';
      let i = 2;
      while (existing.includes(name)) name = `New Folder ${i++}`;
      customFolders.push(name);
      saveCustomFolders();
      moveRouteToFolder(route, name);
      requestAnimationFrame(() => {
        const tree = document.getElementById('file-tree');
        for (const span of tree.querySelectorAll('.folder-name')) {
          if (span.textContent === name) {
            startFolderRename(span, name, span.previousElementSibling);
            break;
          }
        }
      });
    });
    picker.appendChild(newItem);

    document.body.appendChild(picker);
    const rect = anchorEl.getBoundingClientRect();
    picker.style.left = Math.min(rect.left, window.innerWidth - 190) + 'px';
    const spaceBelow = window.innerHeight - rect.bottom;
    picker.style.top = spaceBelow >= picker.offsetHeight + 8
      ? (rect.bottom + 4) + 'px'
      : (rect.top - picker.offsetHeight - 4) + 'px';

    const close = e => {
      if (!picker.contains(e.target)) {
        picker.remove(); activeFolderPicker = null;
        document.removeEventListener('mousedown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  }

  async function moveRouteToFolder(route, newFolder) {
    if (route.folder === newFolder) return;
    try {
      route.folder = newFolder;
      await Storage.saveRoute(route);
      backupNeeded = true;
      renderFileTree();
    } catch (err) {
      console.error('Move error:', err);
      alert('Could not move route: ' + err.message);
    }
  }

  const SVG_PENCIL      = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
  const SVG_TRASH       = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
  const SVG_SAVE        = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
  const SVG_MOVE_FOLDER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><polyline points="9 14 12 17 15 14"/></svg>`;

  function buildRouteItem(route) {
    const li = document.createElement('li');
    li.className = 'route-item' + (route.id === activeRouteId ? ' active' : '');
    li.dataset.id = route.id;
    const icon   = route.activity ? getActivityEmoji(route.activity) : getFolderIcon(route.folder);
    const actTip = route.activity
      ? `${getActivityName(route.activity)} · click to change`
      : 'Click to set activity';
    li.innerHTML = `
      <span class="route-icon route-icon-btn" title="${actTip}">${icon}</span>
      <span class="route-item-content">
        <span class="route-name">${route.name}</span>
        <div class="route-tags">
          ${(route.tags || []).slice(0, 3).map(t => `<span class="route-tag">${t}</span>`).join('')}
        </div>
      </span>`;

    const actions = document.createElement('div');
    actions.className = 'route-actions';

    // Yellow save button — uploaded routes only
    if (route.source === 'upload') {
      const saveBtn = document.createElement('button');
      saveBtn.className = 'route-action-btn btn-route-save';
      saveBtn.title = 'Save to My Library';
      saveBtn.innerHTML = SVG_SAVE;
      saveBtn.addEventListener('click', e => { e.stopPropagation(); saveUploadToLibrary(route); });
      actions.appendChild(saveBtn);
    }

    // Blue move-to-folder button — saved routes only
    if (route.source === 'saved') {
      const moveBtn = document.createElement('button');
      moveBtn.className = 'route-action-btn btn-route-move';
      moveBtn.title = 'Move to folder';
      moveBtn.innerHTML = SVG_MOVE_FOLDER;
      moveBtn.addEventListener('click', e => { e.stopPropagation(); showFolderPicker(moveBtn, route); });
      actions.appendChild(moveBtn);
    }

    // Green edit button — all routes
    const editBtn = document.createElement('button');
    editBtn.className = 'route-action-btn btn-route-edit';
    editBtn.title = 'Edit route';
    editBtn.innerHTML = SVG_PENCIL;
    editBtn.addEventListener('click', e => { e.stopPropagation(); openEditor(route); });
    actions.appendChild(editBtn);

    // Red delete button — saved library routes; uploaded routes use their own remove
    if (route.source === 'saved') {
      const trashBtn = document.createElement('button');
      trashBtn.className = 'route-action-btn btn-route-remove';
      trashBtn.title = 'Remove from library';
      trashBtn.innerHTML = SVG_TRASH;
      trashBtn.addEventListener('click', e => { e.stopPropagation(); deleteFromLibrary(route.id); });
      actions.appendChild(trashBtn);
    } else if (route.source === 'upload') {
      const trashBtn = document.createElement('button');
      trashBtn.className = 'route-action-btn btn-route-remove';
      trashBtn.title = 'Remove upload';
      trashBtn.innerHTML = SVG_TRASH;
      trashBtn.addEventListener('click', e => { e.stopPropagation(); removeUpload(route.id); });
      actions.appendChild(trashBtn);
    }

    li.querySelector('.route-icon').addEventListener('click', e => {
      e.stopPropagation();
      showActivityPicker(e.currentTarget, route);
    });

    li.appendChild(actions);
    li.addEventListener('click', () => loadRoute(route, li));
    return li;
  }

  async function openEditor(route) {
    try {
      let gpxText;
      if (route.gpxText) {
        gpxText = route.gpxText;
      } else if (route.file) {
        const resp = await fetch(route.file);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        gpxText = await resp.text();
      } else {
        throw new Error('No GPX data available');
      }
      Editor.open(route, gpxText, {
        onSaveToLibrary: (routeData) => handleEditorSave(routeData, route),
      });
    } catch (err) {
      console.error('Editor load error:', err);
      alert('Could not load route for editing:\n' + err.message);
    }
  }

  // Converts a country flag emoji (e.g. 🇫🇷) to its 2-letter ISO code ("FR"), or null
  function flagToCountryCode(str) {
    const pts = [...str].map(c => c.codePointAt(0));
    const BASE = 0x1F1E6; // Regional Indicator Symbol Letter A
    if (pts.length !== 2 || pts.some(p => p < BASE || p > BASE + 25)) return null;
    return pts.map(p => String.fromCharCode(p - BASE + 65)).join('');
  }

  function filterRoutes(routes) {
    // Expand the query to categories via semantic keywords (e.g. "winter" → snow)
    const kwCats    = getKeywordCategories(searchQuery);
    const flagCC    = flagToCountryCode(searchQuery); // e.g. "FR" if query is 🇫🇷

    return routes.filter(r => {
      const activityName = getActivityName(r.activity).toLowerCase();
      const catName      = getCategoryName(getActivityCategory(r.activity)).toLowerCase();

      // Keyword match: query maps to one or more categories that include this route's activity
      const matchKeyword = kwCats.length > 0
        && r.activity
        && kwCats.includes(getActivityCategory(r.activity));

      const diffKw = ['easy', 'moderate', 'hard', 'expert'].find(d => d === searchQuery);

      const matchSearch = !searchQuery
        || r.name.toLowerCase().includes(searchQuery)
        || (r.description || '').toLowerCase().includes(searchQuery)
        || (r.tags || []).some(t => t.toLowerCase().includes(searchQuery))
        || activityName.includes(searchQuery)
        || catName.includes(searchQuery)
        || matchKeyword
        || (locationCache[r.id] || '').includes(searchQuery)
        || (diffKw !== undefined && difficultyCache[r.id] === diffKw)
        || (flagCC !== null && (locationCache[r.id] || '').includes(flagCC.toLowerCase()));

      const matchCategory   = !activeCategory   || getActivityCategory(r.activity) === activeCategory;
      const matchDifficulty = !activeDifficulty || difficultyCache[r.id] === activeDifficulty;

      return matchSearch && matchCategory && matchDifficulty;
    });
  }

  // Filter for uploads: text search + difficulty + same keyword expansion as library routes
  function filterBySearch(routes) {
    const kwCats = getKeywordCategories(searchQuery);
    const flagCC = flagToCountryCode(searchQuery);
    return routes.filter(r => {
      if (activeDifficulty && difficultyCache[r.id] !== activeDifficulty) return false;
      if (!searchQuery) return true;
      const diffKw       = ['easy', 'moderate', 'hard', 'expert'].find(d => d === searchQuery);
      const matchKeyword = kwCats.length > 0 && r.activity && kwCats.includes(getActivityCategory(r.activity));
      return r.name.toLowerCase().includes(searchQuery)
        || (r.description || '').toLowerCase().includes(searchQuery)
        || getActivityName(r.activity).toLowerCase().includes(searchQuery)
        || matchKeyword
        || (locationCache[r.id] || '').includes(searchQuery)
        || (diffKw !== undefined && difficultyCache[r.id] === diffKw)
        || (flagCC !== null && (locationCache[r.id] || '').includes(flagCC.toLowerCase()));
    });
  }

  function getFolderIcon(folder) {
    const f = (folder || '').toLowerCase();
    if (f.includes('upload'))                              return '📤';
    if (f.includes('hik') || f.includes('trail') || f.includes('walk')) return '🥾';
    if (f.includes('cycl') || f.includes('bike'))         return '🚴';
    if (f.includes('run'))                                 return '🏃';
    if (f.includes('ski'))                                 return '⛷️';
    return '📁';
  }

  // ── Overview mode (show all filtered routes on map) ──────────────────────────

  const DIFFICULTY_COLORS = {
    easy:     '#22c55e',
    moderate: '#eab308',
    hard:     '#ef4444',
    expert:   '#64748b',
  };

  let skiOverlayActive = false;

  async function enterOverview() {
    const filteredSaved   = sortRoutes(filterRoutes(savedRoutes));
    const filteredUploads = sortRoutes(filterBySearch(uploadedRoutes));
    const allFiltered     = [...filteredSaved, ...filteredUploads];

    if (!allFiltered.length) {
      showShareToast('No routes to display.');
      overviewMode = false;
      const btn = document.getElementById('btn-overview');
      if (btn) { btn.classList.remove('is-active'); btn.title = 'Show all routes on map'; }
      return;
    }

    showRouteView();
    document.getElementById('route-view').classList.add('overview-active');
    document.getElementById('details-panel').classList.remove('mobile-expanded');
    MapManager.invalidateMapSize();

    const routeById = {};
    const items     = [];

    for (const route of allFiltered) {
      try {
        let xmlText = route.gpxText;
        if (!xmlText && route.file) {
          const resp = await fetch(route.file);
          if (resp.ok) xmlText = await resp.text();
        }
        if (!xmlText) continue;
        const parsed   = GPXParser.parse(xmlText);
        if (!parsed.points || parsed.points.length < 2) continue;
        const activity = route.activity || parsed.metadata?.activity || null;
        const diff     = calcDifficulty(parsed.stats, activity);
        if (difficultyCache[route.id] !== diff) { difficultyCache[route.id] = diff; saveDifficultyCache(); }
        items.push({
          id:      route.id,
          name:    route.name,
          latlngs: parsed.points.map(p => [p.lat, p.lon]),
          stats:   parsed.stats,
          color:   DIFFICULTY_COLORS[diff] || '#64748b',
        });
        routeById[route.id] = route;
      } catch (e) {
        console.warn('Overview: skipping', route.name, e);
      }
    }

    // Geocode all items for location search (skips already-cached ones)
    items.forEach(item => {
      const ll = item.latlngs;
      if (!ll.length) return;
      const cLat = ll.reduce((s, p) => s + p[0], 0) / ll.length;
      const cLon = ll.reduce((s, p) => s + p[1], 0) / ll.length;
      enqueueGeocode(item.id, cLat, cLon);
    });

    if (!items.length) {
      showShareToast('No routes with valid track data.');
      overviewMode = false;
      const btn = document.getElementById('btn-overview');
      if (btn) { btn.classList.remove('is-active'); btn.title = 'Show all routes on map'; }
      return;
    }

    MapManager.showOverview(items, {
      onHover: item => showOverviewTooltip(item),
      onMove:  e    => positionOverviewTooltip(e),
      onLeave: ()   => hideOverviewTooltip(),
      onClick: id   => {
        const route = routeById[id];
        if (!route) return;
        const li = document.querySelector(`.route-item[data-id="${route.id}"]`);
        if (li) loadRoute(route, li);
      },
    });
  }

  function exitOverview() {
    overviewMode = false;
    MapManager.clearOverview();
    document.getElementById('route-view').classList.remove('overview-active');
    hideOverviewTooltip();

    if (currentPoints.length >= 2) {
      MapManager.showRoute(currentPoints, currentStats);
    } else if (!activeRouteId) {
      document.getElementById('route-view').style.display  = 'none';
      document.getElementById('empty-state').style.display = 'flex';
    }

    MapManager.invalidateMapSize();
    const btn = document.getElementById('btn-overview');
    if (btn) { btn.classList.remove('is-active'); btn.title = 'Show all routes on map'; }
  }

  async function toggleOverview() {
    overviewMode = !overviewMode;
    const btn = document.getElementById('btn-overview');
    if (overviewMode) {
      if (btn) { btn.classList.add('is-active'); btn.title = 'Exit map overview'; }
      await enterOverview();
    } else {
      exitOverview();
    }
  }

  function showOverviewTooltip(item) {
    const tooltip = document.getElementById('overview-tooltip');
    if (!tooltip) return;
    const s    = item.stats || {};
    const dist = s.totalDistance      ? fmtDist(s.totalDistance)                  : null;
    const gain = s.elevationGain      ? `+${fmtElev(s.elevationGain)}`            : null;
    const grad = s.avgUphillGradient != null ? `${s.avgUphillGradient.toFixed(1)}%` : null;
    const statsLine = [dist, gain, grad].filter(Boolean).join(' · ');
    tooltip.innerHTML =
      `<div class="ovt-name">${item.name}</div>` +
      (statsLine ? `<div class="ovt-stats">${statsLine}</div>` : '');
    tooltip.style.display = 'block';
  }

  function positionOverviewTooltip(domEvent) {
    const tooltip = document.getElementById('overview-tooltip');
    if (!tooltip || tooltip.style.display === 'none') return;
    const cont = document.getElementById('map-container');
    const rect = cont.getBoundingClientRect();
    let x = domEvent.clientX - rect.left + 14;
    let y = domEvent.clientY - rect.top  - 12;
    const tw = tooltip.offsetWidth  || 200;
    const th = tooltip.offsetHeight || 50;
    if (x + tw > rect.width  - 8) x = domEvent.clientX - rect.left - tw - 14;
    if (y + th > rect.height - 8) y = domEvent.clientY - rect.top  - th - 14;
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    tooltip.style.left = x + 'px';
    tooltip.style.top  = y + 'px';
  }

  function hideOverviewTooltip() {
    const el = document.getElementById('overview-tooltip');
    if (el) el.style.display = 'none';
  }

  // ── Track simplification ─────────────────────────────────────────────────────

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

  // ── Share via GitHub Gist ─────────────────────────────────────────────────────

  const PAT_KEY = 'gpxlib-gist-token';
  function getPat()    { return localStorage.getItem(PAT_KEY) || null; }
  function setPat(tok) { localStorage.setItem(PAT_KEY, tok.trim()); }
  function clearPat()  { localStorage.removeItem(PAT_KEY); }

  async function validatePat(pat) {
    const resp = await fetch('https://api.github.com/user', {
      headers: { Authorization: 'token ' + pat, Accept: 'application/vnd.github+json' },
    });
    if (resp.status === 401) throw new Error('Invalid token — authentication failed.');
    if (!resp.ok) throw new Error('GitHub API error (' + resp.status + ')');
    const scopes = (resp.headers.get('X-OAuth-Scopes') || '').split(',').map(s => s.trim());
    if (!scopes.includes('gist')) throw new Error('Token missing "gist" scope. Create a token with the gist scope enabled.');
  }

  async function createGist(gpxText, routeName) {
    const pat = getPat();
    if (!pat) throw new Error('no_pat');
    const resp = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        Authorization: 'token ' + pat,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        description: routeName || 'Shared GPX route',
        public: true,
        files: { 'route.gpx': { content: gpxText } },
      }),
    });
    if (resp.status === 401) throw new Error('token_rejected');
    if (!resp.ok) throw new Error('Gist creation failed (' + resp.status + ')');
    const data = await resp.json();
    return data.id;
  }

  async function shareRoute() {
    if (!currentGpxText) return;
    if (!getPat()) { openPatModal(); return; }
    await doShare();
  }

  async function doShare() {
    const btn   = document.getElementById('btn-share-route');
    const label = document.getElementById('btn-share-label');
    btn.disabled = true;
    label.textContent = 'Sharing…';

    try {
      const origCount    = (currentGpxText.match(/<trkpt/g) || []).length;
      const gpxToShare   = simplifyGpxForSharing(currentGpxText);
      const newCount     = (gpxToShare.match(/<trkpt/g) || []).length;
      const simplifyInfo = origCount !== newCount
        ? `Track simplified from ${origCount.toLocaleString()} to ${newCount.toLocaleString()} points for sharing.`
        : null;

      const routeName = document.getElementById('route-name').textContent || 'Shared Route';
      const gistId    = await createGist(gpxToShare, routeName);
      const shareUrl  = window.location.origin + window.location.pathname + '?gist=' + gistId;

      openShareModal(shareUrl, simplifyInfo);

    } catch (err) {
      if (err.message === 'token_rejected' || err.message === 'no_pat') {
        clearPat();
        showShareToast('Token rejected — please re-enter your PAT.');
        openPatModal();
      } else {
        showShareToast('Could not create share link: ' + err.message);
      }
    } finally {
      btn.disabled = false;
      label.textContent = 'Share';
    }
  }

  function openPatModal() {
    const modal = document.getElementById('pat-modal');
    document.getElementById('pat-token-input').value = '';
    document.getElementById('pat-error').textContent = '';
    const saveBtn = document.getElementById('pat-save-btn');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save & Share';
    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('pat-token-input').focus(), 50);
  }

  function closePatModal() {
    document.getElementById('pat-modal').style.display = 'none';
    document.getElementById('btn-share-route').disabled = false;
    document.getElementById('btn-share-label').textContent = 'Share';
  }

  async function handlePatSave() {
    const input   = document.getElementById('pat-token-input');
    const errEl   = document.getElementById('pat-error');
    const saveBtn = document.getElementById('pat-save-btn');
    const pat     = input.value.trim();

    if (!pat) { errEl.textContent = 'Please enter a token.'; return; }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Validating…';
    errEl.textContent = '';

    try {
      await validatePat(pat);
      setPat(pat);
      closePatModal();
      doShare();
    } catch (err) {
      errEl.textContent = err.message;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & Share';
    }
  }

  function openShareModal(url, simplifyInfo) {
    const modal   = document.getElementById('share-modal');
    const input   = document.getElementById('share-url-input');
    const copyBtn = document.getElementById('share-copy-btn');
    const info    = document.getElementById('share-simplify-info');

    input.value = url;
    copyBtn.textContent = 'Copy';
    copyBtn.classList.remove('copied');

    if (simplifyInfo) {
      info.textContent = simplifyInfo;
      info.style.display = 'block';
    } else {
      info.style.display = 'none';
    }

    modal.style.display = 'flex';
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  function closeShareModal() {
    document.getElementById('share-modal').style.display = 'none';
  }

  function writeToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  function showShareToast(msg) {
    let toast = document.getElementById('share-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'share-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function showSharedRouteBanner(route) {
    sharedRouteRef = route;
    document.getElementById('shared-route-banner').style.display = 'flex';
  }

  function hideSharedRouteBanner() {
    sharedRouteRef = null;
    document.getElementById('shared-route-banner').style.display = 'none';
  }

  async function checkSharedGistParam() {
    const gistId = new URLSearchParams(window.location.search).get('gist');
    if (!gistId || !/^[0-9a-f]{20,40}$/i.test(gistId)) return;

    try {
      const resp = await fetch('https://api.github.com/gists/' + gistId, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();

      const gpxFile = Object.values(data.files).find(f => f.filename.endsWith('.gpx'));
      if (!gpxFile) throw new Error('No GPX file in gist');

      let gpxText = (!gpxFile.truncated && gpxFile.content) ? gpxFile.content : null;
      if (!gpxText) {
        const rawResp = await fetch(gpxFile.raw_url);
        if (!rawResp.ok) throw new Error('Failed to fetch GPX content (' + rawResp.status + ')');
        gpxText = await rawResp.text();
      }

      const parsed      = GPXParser.parse(gpxText);
      const routeName   = parsed.metadata?.name || data.description || 'Shared Route';
      const sharedRoute = {
        id:      'shared-' + Date.now(),
        name:    routeName,
        gpxText,
        source:  'upload',
        tags:    [],
        folder:  null,
      };

      uploadedRoutes.push(sharedRoute);
      buildCategoryPills();
      renderFileTree();

      const li = document.querySelector(`.route-item[data-id="${sharedRoute.id}"]`);
      if (li) {
        try {
          await loadRoute(sharedRoute, li);
        } catch (loadErr) {
          console.warn('loadRoute error for shared route:', loadErr);
        }
      }

      showSharedRouteBanner(sharedRoute);

    } catch (err) {
      console.warn('Failed to load shared route:', err);
      showShareToast('Could not load shared route: ' + err.message);
    }
  }

  // ── Route loading ─────────────────────────────────────────────────────────────

  async function loadRoute(route, listItem) {
    // Second click on the already-active route → show all routes in overview
    if (route.id === activeRouteId && !overviewMode) {
      await toggleOverview();
      return;
    }

    View3D.hide();
    hideSharedRouteBanner();
    document.querySelectorAll('.route-item').forEach(el => el.classList.remove('active'));
    listItem.classList.add('active');
    activeRouteId = route.id;

    showRouteView();
    document.getElementById('route-name').textContent = route.name;
    document.getElementById('route-description').textContent = route.description || '';
    clearStats();

    try {
      let xmlText;
      if (route.gpxText) {
        xmlText = route.gpxText;
      } else if (route.file) {
        const resp = await fetch(route.file);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        xmlText = await resp.text();
      } else {
        throw new Error('No GPX data available');
      }

      currentGpxText = xmlText;
      const parsed = GPXParser.parse(xmlText);
      currentPoints = parsed.points;

      if (!route.name && parsed.metadata.name)
        document.getElementById('route-name').textContent = parsed.metadata.name;
      if (!route.description && parsed.metadata.description)
        document.getElementById('route-description').textContent = parsed.metadata.description;

      // Activity icon: prefer route definition, fall back to GPX <trk><type>
      const resolvedActivity = route.activity || parsed.metadata.activity || null;
      currentActivity = resolvedActivity;
      setActivityIcon(resolvedActivity);

      // Difficulty badge
      const routeDiff = calcDifficulty(parsed.stats, resolvedActivity);
      if (difficultyCache[route.id] !== routeDiff) { difficultyCache[route.id] = routeDiff; saveDifficultyCache(); }
      setDifficultyBadge(routeDiff);

      // Geocode centroid for location search (lazy, rate-limited)
      if (parsed.points.length) {
        const cLat = parsed.points.reduce((s, p) => s + p.lat, 0) / parsed.points.length;
        const cLon = parsed.points.reduce((s, p) => s + p.lon, 0) / parsed.points.length;
        enqueueGeocode(route.id, cLat, cLon);
      }

      renderStats(parsed.metadata, parsed.stats);
      if (overviewMode) {
        // Exit overview: clear all other tracks, restore UI, then show this one alone
        overviewMode = false;
        MapManager.clearOverview();
        document.getElementById('route-view').classList.remove('overview-active');
        hideOverviewTooltip();
        const ovBtn = document.getElementById('btn-overview');
        if (ovBtn) { ovBtn.classList.remove('is-active'); ovBtn.title = 'Show all routes on map'; }
        MapManager.invalidateMapSize();
      }
      MapManager.showRoute(parsed.points, parsed.stats);
      renderElevationChart(parsed.points, parsed.stats);
      loadWeatherForecast(parsed.points);

      // On mobile: close the sidebar and collapse the bottom sheet to peek mode
      if (isMobile()) {
        closeMobileSidebar();
        document.getElementById('details-panel').classList.remove('mobile-expanded');
      }

    } catch (err) {
      showError('Failed to load route: ' + err.message);
    }
  }

  // ── Stats display ─────────────────────────────────────────────────────────────

  // Called once per route load; stores state and resets any pace override.
  function renderStats(meta, stats) {
    currentMeta      = meta;
    currentStats     = stats;
    overrideDuration = null;
    chartMode        = 'elevation';
    document.querySelectorAll('.chart-mode-btn').forEach(b =>
      b.classList.toggle('is-active', b.dataset.mode === 'elevation')
    );
    updateStatDisplay();
  }

  // Re-renders all stat values from state (called on override change or unit toggle).
  function updateStatDisplay() {
    if (!currentStats) return;

    const dist  = currentStats.totalDistance;
    let secs  = overrideDuration !== null ? overrideDuration : currentStats.totalTime;
    let speed = secs && secs > 0 ? (dist / secs) * 3600 : currentStats.avgSpeed;

    if (!secs && dist) {
      speed = getDefaultSpeed(currentActivity);
      secs  = (dist / speed) * 3600;
    }

    document.getElementById('stat-distance').textContent =
      fmtDist(dist);
    document.getElementById('stat-duration').textContent =
      GPXParser.formatDuration(secs);
    document.getElementById('stat-elevation-gain').textContent =
      currentStats.elevationGain ? `+${fmtElev(currentStats.elevationGain)}` : '—';
    document.getElementById('stat-elevation-range').textContent =
      currentStats.elevationRange !== null ? fmtElev(currentStats.elevationRange) : '—';
    document.getElementById('stat-max-elevation').textContent =
      currentStats.maxElevation  ? fmtElev(currentStats.maxElevation)  : '—';
    document.getElementById('stat-min-elevation').textContent =
      currentStats.minElevation  !== null ? fmtElev(currentStats.minElevation) : '—';

    const grad = currentStats.avgUphillGradient;
    document.getElementById('stat-gradient').textContent =
      grad !== null ? `${grad.toFixed(1)}%` : '—';

    document.getElementById('stat-avg-speed').textContent =
      speed ? fmtSpeed(speed) : '—';
    document.getElementById('stat-author').textContent = currentMeta.author || '—';

    // Override indicator
    const isOverridden = overrideDuration !== null;
    document.querySelectorAll('[data-editable]').forEach(card => {
      card.classList.toggle('is-overridden', isOverridden);
    });
    document.getElementById('override-bar').style.display = isOverridden ? 'flex' : 'none';
  }

  function clearStats() {
    currentActivity = null;
    setActivityIcon(null);
    setDifficultyBadge(null);
    ['stat-distance','stat-duration','stat-elevation-gain','stat-elevation-range',
     'stat-max-elevation','stat-min-elevation','stat-gradient','stat-avg-speed','stat-author']
      .forEach(id => { document.getElementById(id).textContent = '…'; });
    document.getElementById('override-bar').style.display = 'none';
    document.querySelectorAll('[data-editable]').forEach(c => c.classList.remove('is-overridden'));
    // Reset weather
    currentWeatherData = null;
    selectedDayIndex   = null;
    document.getElementById('weather-section').style.display = 'none';
    document.getElementById('weather-days').innerHTML = '';
    document.getElementById('weather-hourly').style.display = 'none';
    document.getElementById('weather-location').textContent = '';
  }

  // ── Editable stat cards (Duration ↔ Speed) ───────────────────────────────────

  function setupEditableStats() {
    const durationCard = document.querySelector('[data-editable="duration"]');
    const speedCard    = document.querySelector('[data-editable="speed"]');

    // Duration card: click → edit in H:MM; commit → update speed
    durationCard.addEventListener('click', () => {
      if (!currentStats || durationCard.classList.contains('editing')) return;
      let secs = overrideDuration !== null ? overrideDuration : currentStats.totalTime;
      if (!secs && currentStats.totalDistance)
        secs = (currentStats.totalDistance / getDefaultSpeed(currentActivity)) * 3600;
      if (!secs) return;

      startEditing(
        durationCard,
        document.getElementById('stat-duration'),
        fmtDurationForEdit(secs),
        'e.g. 3:24 or 204 (min)',
        input => {
          const parsed = parseDurationInput(input);
          if (parsed && parsed > 0) {
            overrideDuration = parsed;
            updateStatDisplay();
            // Refresh chart axes — duration doesn't affect X axis, no need to re-render
          }
        }
      );
    });

    // Speed card: click → edit in current units; commit → update duration
    speedCard.addEventListener('click', () => {
      if (!currentStats || speedCard.classList.contains('editing')) return;
      let baseSecs  = overrideDuration !== null ? overrideDuration : currentStats.totalTime;
      if (!baseSecs && currentStats.totalDistance)
        baseSecs = (currentStats.totalDistance / getDefaultSpeed(currentActivity)) * 3600;
      const baseSpeed = baseSecs ? (currentStats.totalDistance / baseSecs) * 3600 : currentStats.avgSpeed;
      if (!baseSpeed) return;

      const speedUnit = units === 'imperial' ? 'mph' : 'km/h';
      startEditing(
        speedCard,
        document.getElementById('stat-avg-speed'),
        fmtSpeedForEdit(baseSpeed),
        `speed in ${speedUnit}`,
        input => {
          const displaySpeed = parseFloat(input);
          if (isNaN(displaySpeed) || displaySpeed <= 0) return;
          const speedKmh = units === 'imperial' ? displaySpeed / KM_TO_MI : displaySpeed;
          if (!currentStats.totalDistance || !speedKmh) return;
          overrideDuration = (currentStats.totalDistance / speedKmh) * 3600;
          updateStatDisplay();
        }
      );
    });

    // Reset button
    document.getElementById('reset-override-btn').addEventListener('click', () => {
      overrideDuration = null;
      updateStatDisplay();
    });
  }

  function startEditing(cardEl, valueEl, initialVal, placeholder, onCommit) {
    cardEl.classList.add('editing');
    const input = document.createElement('input');
    input.type        = 'text';
    input.className   = 'stat-edit-input';
    input.value       = initialVal;
    input.placeholder = placeholder;
    valueEl.style.display = 'none';
    cardEl.appendChild(input);
    input.focus();
    input.select();

    let done = false;

    function commit() {
      if (done) return;
      done = true;
      onCommit(input.value.trim());
      input.remove();
      valueEl.style.display = '';
      cardEl.classList.remove('editing');
    }

    function cancel() {
      if (done) return;
      done = true;
      input.remove();
      valueEl.style.display = '';
      cardEl.classList.remove('editing');
    }

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
  }

  // ── Elevation chart ───────────────────────────────────────────────────────────

  // ── Gradient color scale ──────────────────────────────────────────────────────

  function gradientSegmentColor(pct) {
    if (pct === null || pct === undefined) return 'rgba(100,116,139,0.3)';
    if (pct < -0.5) return '#22c55e';   // downhill — green
    if (pct <= 0.5) return '#93c5fd';   // flat — light blue

    // Uphill: interpolate through yellow → orange → red → dark red (0.5% … 15%+)
    const t = Math.min((pct - 0.5) / 14.5, 1);
    const stops = [
      [254, 240, 138],   // #fef08a  light yellow  (~0.5 %)
      [251, 191,  36],   // #fbbf24  amber          (~5 %)
      [249, 115,  22],   // #f97316  orange         (~10 %)
      [239,  68,  68],   // #ef4444  red            (~13 %)
      [127,  29,  29],   // #7f1d1d  dark red       (≥15 %)
    ];
    const seg = t * (stops.length - 1);
    const lo  = Math.floor(seg);
    const hi  = Math.min(lo + 1, stops.length - 1);
    const u   = seg - lo;
    const r   = Math.round(stops[lo][0] + u * (stops[hi][0] - stops[lo][0]));
    const g   = Math.round(stops[lo][1] + u * (stops[hi][1] - stops[lo][1]));
    const b   = Math.round(stops[lo][2] + u * (stops[hi][2] - stops[lo][2]));
    return `rgb(${r},${g},${b})`;
  }

  // Chart.js plugin — draws gradient-colored trapezoids in gradient mode
  Chart.register({
    id: 'gradientBands',
    beforeDatasetsDraw(chart) {
      if (chartMode !== 'gradient' || !chartSegmentData) return;
      const { ctx, chartArea, scales } = chart;
      const { profile, gradients, dFactor, eFactor } = chartSegmentData;
      const xScale = scales.x;
      const yScale = scales.y;
      const yBase  = yScale.getPixelForValue(yScale.min);

      ctx.save();
      ctx.beginPath();
      ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
      ctx.clip();

      for (let i = 1; i < profile.length; i++) {
        const x0 = xScale.getPixelForValue(parseFloat((profile[i - 1].dist * dFactor).toFixed(2)));
        const x1 = xScale.getPixelForValue(parseFloat((profile[i].dist     * dFactor).toFixed(2)));
        const y0 = yScale.getPixelForValue(Math.round(profile[i - 1].ele   * eFactor));
        const y1 = yScale.getPixelForValue(Math.round(profile[i].ele       * eFactor));

        ctx.fillStyle = gradientSegmentColor(gradients[i]);
        ctx.beginPath();
        ctx.moveTo(x0, yBase);
        ctx.lineTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.lineTo(x1, yBase);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    },
  });

  function renderElevationChart(points, stats) {
    const profile = GPXParser.buildElevationProfile(points, stats);
    if (!profile.length) {
      document.getElementById('chart-container').style.display = 'none';
      return;
    }
    document.getElementById('chart-container').style.display = 'block';

    const isImperial = units === 'imperial';
    const dFactor    = isImperial ? KM_TO_MI : 1;
    const eFactor    = isImperial ? M_TO_FT  : 1;
    const distUnit   = isImperial ? 'mi' : 'km';
    const elevUnit   = isImperial ? 'ft' : 'm';

    const labels  = profile.map(p => parseFloat((p.dist * dFactor).toFixed(2)));
    const values  = profile.map(p => Math.round(p.ele * eFactor));

    // Gradient at each profile point (always in %, computed from raw metric data)
    const gradients = profile.map((p, i) => {
      if (i === 0) return null;
      const dElev = p.ele - profile[i - 1].ele;                  // m
      const dDist = (p.dist - profile[i - 1].dist) * 1000;       // km → m
      return dDist > 0.5 ? (dElev / dDist) * 100 : null;
    });
    const maxDist = parseFloat((stats.totalDistance * dFactor).toFixed(2));

    // Expose segment data for the gradient-bands plugin
    chartSegmentData = { profile, gradients, dFactor, eFactor };

    if (elevationChart) { elevationChart.destroy(); elevationChart = null; }

    const ctx = document.getElementById('elevation-chart').getContext('2d');
    const isGradient = chartMode === 'gradient';

    const areaGradient = ctx.createLinearGradient(0, 0, 0, 200);
    areaGradient.addColorStop(0, 'rgba(59,130,246,0.35)');
    areaGradient.addColorStop(1, 'rgba(59,130,246,0.02)');

    const profileIndices = profile.map(p => {
      const cumDists = stats.cumulativeDistances;
      let closest = 0, minDiff = Infinity;
      cumDists.forEach((cd, i) => {
        const diff = Math.abs(cd - p.dist);
        if (diff < minDiff) { minDiff = diff; closest = i; }
      });
      return closest;
    });

    elevationChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: `Elevation (${elevUnit})`,
          data: values,
          fill: !isGradient,
          backgroundColor: isGradient ? 'transparent' : areaGradient,
          borderColor: isGradient ? 'rgba(255,255,255,0.55)' : '#3b82f6',
          borderWidth: isGradient ? 1.5 : 2,
          tension: 0.35,
          pointRadius: 0,
          pointHitRadius: 12,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => `${items[0].label} ${distUnit}`,
              label: item  => `${item.raw} ${elevUnit}`,
              afterLabel: item => {
                const g = gradients[item.dataIndex];
                if (g === null || g === undefined) return null;
                const sign  = g >= 0 ? '+' : '';
                const arrow = g >  1 ? ' ↑' : g < -1 ? ' ↓' : ' →';
                return `${sign}${g.toFixed(1)}%${arrow}`;
              },
            },
            backgroundColor: 'rgba(15,23,42,0.85)',
            titleColor: '#94a3b8',
            bodyColor: '#f1f5f9',
            padding: 10,
            cornerRadius: 6,
          }
        },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: maxDist,
            title: { display: true, text: `Distance (${distUnit})`, color: '#64748b', font: { size: 11 } },
            ticks: {
              color: '#64748b',
              maxTicksLimit: 8,
              callback: v => v % 1 === 0 ? v : parseFloat(v.toFixed(1)),
            },
            grid: { color: 'rgba(100,116,139,0.1)' },
          },
          y: {
            title: { display: true, text: `Elevation (${elevUnit})`, color: '#64748b', font: { size: 11 } },
            ticks: { color: '#64748b' },
            grid: { color: 'rgba(100,116,139,0.1)' },
          }
        },
        onHover: (event, elements) => {
          if (elements.length > 0) {
            const pointIdx = profileIndices[elements[0].index];
            const pt = currentPoints[pointIdx];
            if (pt) {
              MapManager.highlightPoint(pt);
              View3D.highlightPoint(pt);
            }
          } else {
            MapManager.hideHighlight();
            View3D.hideHighlight();
          }
        }
      }
    });
  }

  // ── Weather forecast (Open-Meteo, no API key required) ───────────────────────

  async function loadWeatherForecast(points) {
    if (!points || !points.length) return;

    // Use geographic centroid for better accuracy across the whole route
    const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;

    const section   = document.getElementById('weather-section');
    const daysEl    = document.getElementById('weather-days');
    const hourlyEl  = document.getElementById('weather-hourly');
    const locEl     = document.getElementById('weather-location');

    section.style.display   = 'block';
    hourlyEl.style.display  = 'none';
    daysEl.innerHTML = '<p class="weather-loading">Loading forecast…</p>';
    locEl.textContent = '';

    // Location name via Nominatim (zoom 10 → municipality level)
    try {
      const nr = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&zoom=10`,
        { headers: { 'Accept-Language': 'en' } }
      );
      const nd = await nr.json();
      const a  = nd.address || {};
      const place = a.city || a.town || a.village || a.municipality || a.county || a.state || '';
      const country = a.country_code ? a.country_code.toUpperCase() : '';
      locEl.textContent = [place, country].filter(Boolean).join(', ');
    } catch (_) {
      locEl.textContent = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    }

    // Weather forecast — daily + hourly in one request
    try {
      const params = new URLSearchParams({
        latitude:      lat.toFixed(4),
        longitude:     lon.toFixed(4),
        daily:         'weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max',
        hourly:        'temperature_2m,apparent_temperature,precipitation_probability,weathercode,windspeed_10m',
        timezone:      'auto',
        forecast_days: 7,
      });
      const wr = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
      if (!wr.ok) throw new Error('HTTP ' + wr.status);
      const wd = await wr.json();
      currentWeatherData = { daily: wd.daily, hourly: wd.hourly };
      renderWeatherDays(currentWeatherData.daily);
    } catch (err) {
      daysEl.innerHTML = '<p class="weather-error">Could not load forecast.</p>';
    }
  }

  let selectedDayIndex = null;

  function dayConditionScore(code, precip, wind) {
    let score = 0;
    if      (code === 0)  score += 0;
    else if (code <= 3)   score += 10;
    else if (code <= 48)  score += 35;  // fog
    else if (code <= 57)  score += 50;  // drizzle
    else if (code <= 65)  score += 65;  // rain
    else if (code <= 67)  score += 75;  // freezing rain
    else if (code <= 77)  score += 80;  // snow
    else if (code <= 82)  score += 60;  // rain showers
    else if (code <= 86)  score += 75;  // snow showers
    else                  score += 100; // thunderstorm
    score += Math.min(precip * 4, 40);
    if (wind > 60)      score += 30;
    else if (wind > 40) score += 15;
    else if (wind > 25) score += 5;
    return score;
  }

  function renderWeatherDays(daily) {
    const daysEl   = document.getElementById('weather-days');
    const hourlyEl = document.getElementById('weather-hourly');
    if (!daysEl || !daily) return;

    const { time, weathercode, temperature_2m_max, temperature_2m_min,
            precipitation_sum, windspeed_10m_max } = daily;

    const isImperial = units === 'imperial';

    selectedDayIndex = null;
    hourlyEl.style.display = 'none';
    daysEl.innerHTML = '';

    // Score each day; identify best and not-recommended days
    const scores = time.map((_, i) =>
      dayConditionScore(weathercode[i], precipitation_sum[i], windspeed_10m_max[i])
    );
    const minScore = Math.min(...scores);
    const bestIdx  = minScore < 30 ? scores.indexOf(minScore) : -1;

    time.forEach((dateStr, i) => {
      const date    = new Date(dateStr + 'T12:00:00');
      const dow     = date.toLocaleDateString('en', { weekday: 'short' });
      const dayNum  = date.getDate();
      const monAbbr = date.toLocaleDateString('en', { month: 'short' });

      const code = weathercode[i];
      const icon = wmoIcon(code);
      const desc = wmoDesc(code);

      const tHi = isImperial
        ? Math.round(temperature_2m_max[i] * 9 / 5 + 32)
        : Math.round(temperature_2m_max[i]);
      const tLo = isImperial
        ? Math.round(temperature_2m_min[i] * 9 / 5 + 32)
        : Math.round(temperature_2m_min[i]);
      const tUnit = isImperial ? '°F' : '°C';

      const precip = precipitation_sum[i];
      const precipStr = isImperial
        ? `${(precip * 0.0394).toFixed(2)}"`
        : `${precip.toFixed(1)} mm`;

      const wind = windspeed_10m_max[i];
      const windStr = isImperial
        ? `${Math.round(wind * 0.621371)} mph`
        : `${Math.round(wind)} km/h`;

      const score = scores[i];
      const card = document.createElement('div');
      card.className = 'weather-day' +
        (i === bestIdx      ? ' is-best' : '') +
        (score >= 70        ? ' is-bad'  : '');
      card.title = desc + ' — click for hourly';
      card.innerHTML = `
        <div class="wd-row1">
          <span class="wd-dow">${dow}</span>
          <span class="wd-date">${dayNum}<span class="wd-mon">${monAbbr}</span></span>
          <span class="wd-icon">${icon}</span>
        </div>
        <div class="wd-row2">
          <span class="wd-hi">${tHi}${tUnit}</span>
          <span class="wd-lo">${tLo}${tUnit}</span>
        </div>
        <div class="wd-row3">
          <span>💧${precipStr}</span>
          <span>💨${windStr}</span>
        </div>`;

      card.addEventListener('click', () => {
        const wasSelected = selectedDayIndex === i;
        daysEl.querySelectorAll('.weather-day').forEach(c => c.classList.remove('is-selected'));
        if (wasSelected) {
          selectedDayIndex = null;
          hourlyEl.style.display = 'none';
        } else {
          selectedDayIndex = i;
          card.classList.add('is-selected');
          renderHourlyForecast(dateStr);
        }
      });

      daysEl.appendChild(card);
    });
  }

  function renderHourlyForecast(dateStr) {
    const hourlyEl = document.getElementById('weather-hourly');
    if (!hourlyEl || !currentWeatherData?.hourly) return;

    const { time, temperature_2m, apparent_temperature,
            precipitation_probability, weathercode, windspeed_10m } = currentWeatherData.hourly;

    const isImperial = units === 'imperial';
    const tUnit      = isImperial ? '°F' : '°C';

    const toF = c => Math.round(c * 9 / 5 + 32);
    const toMph = k => Math.round(k * 0.621371);

    // Compute scores for all hours of this day
    const dayIndices = time.reduce((acc, ts, j) => { if (ts.startsWith(dateStr)) acc.push(j); return acc; }, []);
    const hourScores = dayIndices.map(j =>
      dayConditionScore(weathercode[j], (precipitation_probability[j] ?? 0) / 10, windspeed_10m[j])
    );
    const minHourScore = Math.min(...hourScores);
    const bestHourIdx  = minHourScore < 30 ? dayIndices[hourScores.indexOf(minHourScore)] : -1;

    hourlyEl.innerHTML = '';
    const scroll = document.createElement('div');
    scroll.className = 'wh-scroll';

    time.forEach((ts, j) => {
      if (!ts.startsWith(dateStr)) return;

      const hour = ts.slice(11, 16); // "HH:MM"
      const code = weathercode[j];

      const temp = isImperial ? toF(temperature_2m[j]) : Math.round(temperature_2m[j]);
      const feel = isImperial ? toF(apparent_temperature[j]) : Math.round(apparent_temperature[j]);
      const wind = isImperial ? toMph(windspeed_10m[j]) : Math.round(windspeed_10m[j]);
      const windUnit = isImperial ? 'mph' : 'km/h';
      const prob = precipitation_probability[j] ?? 0;
      const hScore = dayConditionScore(code, prob / 10, windspeed_10m[j]);

      const chip = document.createElement('div');
      chip.className = 'weather-hour' +
        (j === bestHourIdx ? ' is-best' : '') +
        (hScore >= 70      ? ' is-bad'  : '');
      chip.innerHTML = `
        <span class="wh-time">${hour}</span>
        <span class="wh-icon">${wmoIcon(code)}</span>
        <span class="wh-temp">${temp}${tUnit}</span>
        <span class="wh-feel">feels ${feel}${tUnit}</span>
        <span class="wh-prob">💧${prob}%</span>
        <span class="wh-wind">💨${wind} ${windUnit}</span>`;
      scroll.appendChild(chip);
    });

    hourlyEl.appendChild(scroll);
    hourlyEl.style.display = 'block';
  }

  // WMO weather interpretation codes → emoji + description
  function wmoIcon(code) {
    if (code === 0)                       return '☀️';
    if (code === 1)                       return '🌤️';
    if (code === 2)                       return '⛅';
    if (code === 3)                       return '☁️';
    if (code === 45 || code === 48)       return '🌫️';
    if (code >= 51 && code <= 55)         return '🌦️';
    if (code >= 56 && code <= 57)         return '🌧️';
    if (code >= 61 && code <= 65)         return '🌧️';
    if (code >= 66 && code <= 67)         return '🌨️';
    if (code >= 71 && code <= 77)         return '❄️';
    if (code >= 80 && code <= 82)         return '🌧️';
    if (code === 85 || code === 86)       return '🌨️';
    if (code === 95)                      return '⛈️';
    if (code === 96 || code === 99)       return '⛈️';
    return '🌡️';
  }

  function wmoDesc(code) {
    const map = {
      0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
      45: 'Fog', 48: 'Icy fog',
      51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
      56: 'Freezing drizzle', 57: 'Heavy freezing drizzle',
      61: 'Slight rain', 63: 'Rain', 65: 'Heavy rain',
      66: 'Freezing rain', 67: 'Heavy freezing rain',
      71: 'Slight snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
      80: 'Slight showers', 81: 'Showers', 82: 'Heavy showers',
      85: 'Snow showers', 86: 'Heavy snow showers',
      95: 'Thunderstorm', 96: 'Thunderstorm + hail', 99: 'Thunderstorm + heavy hail',
    };
    return map[code] ?? 'Unknown';
  }

  // ── Mobile helpers ────────────────────────────────────────────────────────────

  function isMobile() {
    return window.innerWidth < 768;
  }

  function openMobileSidebar() {
    document.getElementById('sidebar').classList.add('mobile-open');
    const bd = document.getElementById('mobile-backdrop');
    if (bd) bd.classList.add('visible');
  }

  function closeMobileSidebar() {
    document.getElementById('sidebar').classList.remove('mobile-open');
    const bd = document.getElementById('mobile-backdrop');
    if (bd) bd.classList.remove('visible');
  }

  function setupMobileUI() {
    // Floating "Routes" button opens the sidebar drawer
    document.getElementById('mobile-lib-btn')?.addEventListener('click', openMobileSidebar);

    // Backdrop tap closes the sidebar drawer
    document.getElementById('mobile-backdrop')?.addEventListener('click', closeMobileSidebar);

    // Sheet handle tap toggles the details panel between peek and expanded
    document.getElementById('mobile-sheet-handle')?.addEventListener('click', () => {
      document.getElementById('details-panel').classList.toggle('mobile-expanded');
    });

    // Keyboard: Enter/Space on sheet handle
    document.getElementById('mobile-sheet-handle')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        document.getElementById('details-panel').classList.toggle('mobile-expanded');
      }
    });

    // Reset mobile state on resize to desktop
    window.addEventListener('resize', () => {
      if (!isMobile()) closeMobileSidebar();
    });
  }

  // ── Sidebar toggle ────────────────────────────────────────────────────────────

  function setupSidebarToggle() {
    const sidebar   = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle-btn');

    toggleBtn.addEventListener('click', () => {
      if (isMobile()) {
        closeMobileSidebar();
        return;
      }
      const collapsed = sidebar.classList.toggle('collapsed');
      toggleBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      setTimeout(() => MapManager.invalidateMapSize(), 260);
    });
  }

  // ── Sidebar drag-to-resize ────────────────────────────────────────────────────

  function setupSidebarResize() {
    const handle  = document.getElementById('sidebar-resize-handle');
    const sidebar = document.getElementById('sidebar');
    if (!handle || !sidebar) return;

    let dragging  = false;
    let startX    = 0;
    let startW    = 0;
    let lastPress = 0;

    handle.addEventListener('mousedown', e => {
      if (sidebar.classList.contains('collapsed')) return;
      const now = Date.now();
      if (now - lastPress < 300) {
        // Double-click: reset to default width
        lastPress = 0;
        sidebar.style.width    = '';
        sidebar.style.minWidth = '';
        MapManager.invalidateMapSize();
        return;
      }
      lastPress = now;
      e.preventDefault();
      dragging  = true;
      startX    = e.clientX;
      startW    = sidebar.offsetWidth;
      sidebar.style.transition = 'none';
      document.body.classList.add('is-col-resizing');
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const newW = Math.max(200, Math.min(520, startW + e.clientX - startX));
      sidebar.style.width    = newW + 'px';
      sidebar.style.minWidth = newW + 'px';
      MapManager.invalidateMapSize();
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      sidebar.style.transition = '';
      document.body.classList.remove('is-col-resizing');
      MapManager.invalidateMapSize();
    });
  }

  // ── Resizable split panel ─────────────────────────────────────────────────────

  function setupSplitHandle() {
    const handle       = document.getElementById('split-handle');
    const mapCont      = document.getElementById('map-container');
    const routeView    = document.getElementById('route-view');
    const detailsPanel = document.getElementById('details-panel');

    if (!handle) return;

    let dragging    = false;
    let startY      = 0;
    let startHeight = 0;
    let lastPressAt = 0;  // timestamp of last press, used to detect double-click

    // Size the map so the details panel shows all its content without scrolling.
    //
    // WHY NOT scrollHeight: when the panel has no overflow, scrollHeight === offsetHeight
    // (the current allocated size), so every snap would just keep growing by the buffer.
    //
    // Instead we sum the heights of the panel's visible children directly — that value
    // is stable and doesn't change based on how much space the panel has been given.
    function snapToShowAll() {
      const cs      = window.getComputedStyle(detailsPanel);
      const padTop  = parseFloat(cs.paddingTop)    || 0;
      const padBot  = parseFloat(cs.paddingBottom) || 0;
      const gap     = parseFloat(cs.gap || cs.rowGap) || 16;

      const visible  = Array.from(detailsPanel.children).filter(
        el => window.getComputedStyle(el).display !== 'none'
      );
      const childrenH = visible.reduce((sum, el) => sum + el.offsetHeight, 0);
      // +8 covers the panel's border-top and any sub-pixel rounding
      const needed   = padTop + childrenH + gap * Math.max(0, visible.length - 1) + padBot + 8;

      const total = routeView.offsetHeight - handle.offsetHeight;
      const mapH  = Math.max(80, total - needed);
      mapCont.style.flex   = 'none';
      mapCont.style.height = mapH + 'px';
      MapManager.invalidateMapSize();
    }

    function startDrag(y) {
      const now = Date.now();

      // Two presses within 300 ms → treat as double-click, don't start a drag
      if (now - lastPressAt < 300) {
        lastPressAt = 0;
        snapToShowAll();
        return;
      }

      lastPressAt = now;
      dragging    = true;
      startY      = y;
      startHeight = mapCont.offsetHeight;
      document.body.classList.add('is-resizing');
    }

    function doDrag(y) {
      if (!dragging) return;
      const dy    = y - startY;
      const total = routeView.offsetHeight - handle.offsetHeight;
      const newH  = Math.max(80, Math.min(total - 80, startHeight + dy));
      mapCont.style.flex   = 'none';
      mapCont.style.height = newH + 'px';
      MapManager.invalidateMapSize();
    }

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('is-resizing');
      MapManager.invalidateMapSize();
    }

    // Mouse
    handle.addEventListener('mousedown', e => { e.preventDefault(); startDrag(e.clientY); });
    document.addEventListener('mousemove', e => doDrag(e.clientY));
    document.addEventListener('mouseup', endDrag);

    // Touch — same double-tap logic via startDrag
    handle.addEventListener('touchstart', e => { e.preventDefault(); startDrag(e.touches[0].clientY); }, { passive: false });
    document.addEventListener('touchmove', e => { if (dragging) { e.preventDefault(); doDrag(e.touches[0].clientY); } }, { passive: false });
    document.addEventListener('touchend', endDrag);
  }

  // ── Activity picker (inline icon click) ──────────────────────────────────────

  function showActivityPicker(anchor, route) {
    document.getElementById('activity-picker')?.remove();

    const picker = document.createElement('div');
    picker.id    = 'activity-picker';
    picker.className = 'activity-picker';

    // "No activity" option
    const noBtn = makePickerBtn('— No activity —', !route.activity, () => setRouteActivity(route, null));
    picker.appendChild(noBtn);

    // Grouped activity options
    Object.entries(CATEGORIES).forEach(([catKey, cat]) => {
      const label = document.createElement('div');
      label.className = 'ap-cat-label';
      label.textContent = `${cat.emoji} ${cat.name}`;
      picker.appendChild(label);

      Object.entries(ACTIVITIES)
        .filter(([, a]) => a.category === catKey)
        .forEach(([key, a]) => {
          picker.appendChild(
            makePickerBtn(`${a.emoji}  ${a.name}`, route.activity === key, () => setRouteActivity(route, key))
          );
        });
    });

    document.body.appendChild(picker);

    // Position: prefer below anchor, flip above if no space
    const rect  = anchor.getBoundingClientRect();
    const ph    = picker.offsetHeight;
    const pw    = picker.offsetWidth;
    const top   = (window.innerHeight - rect.bottom >= ph + 8)
      ? rect.bottom + 4
      : rect.top - ph - 4;
    picker.style.left = `${Math.min(rect.left, window.innerWidth - pw - 8)}px`;
    picker.style.top  = `${Math.max(8, top)}px`;

    // Close when clicking outside
    const dismiss = ev => {
      if (!picker.contains(ev.target)) {
        picker.remove();
        document.removeEventListener('click', dismiss, true);
      }
    };
    setTimeout(() => document.addEventListener('click', dismiss, true), 0);
  }

  function makePickerBtn(label, selected, onClick) {
    const btn = document.createElement('button');
    btn.className = 'ap-opt' + (selected ? ' is-sel' : '');
    btn.textContent = label;
    btn.addEventListener('click', e => { e.stopPropagation(); onClick(); });
    return btn;
  }

  function setRouteActivity(route, activityKey) {
    route.activity = activityKey || undefined;
    document.getElementById('activity-picker')?.remove();
    if (route.source === 'saved' && typeof route.id === 'number') {
      Storage.saveRoute(route).catch(err => console.warn('Activity persist failed:', err));
    }
    buildCategoryPills();
    renderFileTree();
    if (route.id === activeRouteId) setActivityIcon(activityKey);
  }

  // ── Panel helpers ─────────────────────────────────────────────────────────────

  function togglePanel(id) {
    const panel = document.getElementById(id);
    if (!panel) return;
    const wasHidden = panel.hidden;
    document.querySelectorAll('.map-panel').forEach(p => { p.hidden = true; });
    if (wasHidden) panel.hidden = false;
  }

  function renderLayerList() {
    const container = document.getElementById('layer-list');
    if (!container) return;
    const layers  = MapManager.getLayers();
    const current = MapManager.getCurrentLayer();
    container.innerHTML = '';

    layers.forEach(layer => {
      const item = document.createElement('div');
      item.className = 'layer-option' + (layer.id === current ? ' is-active' : '');
      item.innerHTML = `
        <span class="layer-option-check"></span>
        <span class="layer-option-info">
          <span class="layer-option-name">${layer.label}</span>
          <span class="layer-option-src">${layer.source}</span>
        </span>`;
      item.addEventListener('click', () => {
        MapManager.setMapType(layer.id);
        document.getElementById('layer-panel').hidden = true;
        renderLayerList();
      });
      container.appendChild(item);
    });
  }

  // ── Difficulty badge ──────────────────────────────────────────────────────────

  // Per-category formula config: gradNorm = gradient % that doubles the elevation score,
  // distFactor = points added per km of distance, thresholds = [easy, moderate, hard] boundaries.
  const DIFFICULTY_CFG = {
    hiking:         { gradNorm: 15, distFactor: 0.5,  thresholds: [5,  12, 25] },
    mountainSports: { gradNorm: 12, distFactor: 0.4,  thresholds: [6,  15, 30] },
    cycling:        { gradNorm: 18, distFactor: 0.2,  thresholds: [4,  12, 28] },
    snow:           { gradNorm: 15, distFactor: 0.4,  thresholds: [5,  12, 25] },
    running:        { gradNorm: 15, distFactor: 0.6,  thresholds: [4,  10, 20] },
    water:          { gradNorm: 20, distFactor: 0.25, thresholds: [3,   8, 15] },
  };

  const DIFFICULTY_LEVELS = {
    easy:     { circle: '🟢', label: 'Easy'     },
    moderate: { circle: '🟡', label: 'Moderate' },
    hard:     { circle: '🔴', label: 'Hard'      },
    expert:   { circle: '⚫', label: 'Expert'   },
  };

  function calcDifficulty(stats, activityKey) {
    const dist     = stats.totalDistance || 0;
    const gain     = stats.elevationGain || 0;
    const gradient = stats.avgUphillGradient || 0;

    if (dist < 0.1) return null;

    const cat = getActivityCategory(activityKey) || 'hiking';
    const cfg = DIFFICULTY_CFG[cat] || DIFFICULTY_CFG.hiking;

    const gradFactor = 1 + gradient / cfg.gradNorm;
    const score      = (gain / 100) * gradFactor + dist * cfg.distFactor;
    const [t1, t2, t3] = cfg.thresholds;

    if (score < t1) return 'easy';
    if (score < t2) return 'moderate';
    if (score < t3) return 'hard';
    return 'expert';
  }

  function setDifficultyBadge(difficulty) {
    const el = document.getElementById('route-difficulty-badge');
    if (!el) return;
    if (difficulty && DIFFICULTY_LEVELS[difficulty]) {
      const d = DIFFICULTY_LEVELS[difficulty];
      el.textContent   = d.circle;
      el.title         = d.label;
      el.style.display = '';
    } else {
      el.textContent   = '';
      el.style.display = 'none';
    }
  }

  // ── Activity icon ─────────────────────────────────────────────────────────────

  function setActivityIcon(activityKey) {
    const el = document.getElementById('route-activity-icon');
    if (!el) return;
    const known = activityKey && ACTIVITIES[activityKey];
    if (known) {
      el.textContent = known.emoji;
      el.title       = known.name;
      el.style.display = '';
    } else {
      el.textContent   = '';
      el.style.display = 'none';
    }
  }

  // ── UI helpers ────────────────────────────────────────────────────────────────

  function showRouteView() {
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('route-view').style.display  = 'flex';
  }

  function showError(msg) {
    console.error(msg);
    const el = document.getElementById('route-name');
    if (el) el.textContent = '⚠ ' + msg;
  }

  // ── DOMContentLoaded: wire all interactive elements ───────────────────────────

  document.addEventListener('DOMContentLoaded', () => {

    // Deploy date + GitHub link
    document.getElementById('deploy-date').textContent = DEPLOY_DATE;
    document.querySelector('.sidebar-info-btn').href = GITHUB_REPO;

    // Sort
    setupSort();

    // Overview mode
    document.getElementById('btn-overview').addEventListener('click', toggleOverview);

    // Layout controls
    setupMobileUI();
    setupSidebarToggle();
    setupSidebarResize();
    setupSplitHandle();

    // GPX editor
    Editor.setup();

    // Editable stats
    setupEditableStats();

    // Chart mode toggle (Elevation | Gradient)
    document.querySelectorAll('.chart-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        chartMode = btn.dataset.mode;
        document.querySelectorAll('.chart-mode-btn').forEach(b =>
          b.classList.toggle('is-active', b.dataset.mode === chartMode)
        );
        if (currentPoints.length && currentStats) renderElevationChart(currentPoints, currentStats);
      });
    });

    // Unit toggle (km | mi)
    document.querySelectorAll('.unit-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        units = btn.dataset.unit;
        document.querySelectorAll('.unit-opt').forEach(b =>
          b.classList.toggle('is-active', b.dataset.unit === units)
        );
        updateStatDisplay();
        if (currentPoints.length && currentStats) renderElevationChart(currentPoints, currentStats);
        if (currentWeatherData) renderWeatherDays(currentWeatherData.daily);
      });
    });

    // Share route button
    document.getElementById('btn-share-route').addEventListener('click', shareRoute);

    // Share modal
    document.getElementById('share-modal-close').addEventListener('click', closeShareModal);
    document.getElementById('share-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeShareModal();
    });
    document.getElementById('share-url-input').addEventListener('click', e => e.target.select());
    document.getElementById('share-copy-btn').addEventListener('click', () => {
      const url    = document.getElementById('share-url-input').value;
      const btn    = document.getElementById('share-copy-btn');
      writeToClipboard(url)
        .then(() => {
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
        })
        .catch(() => showShareToast('Could not copy — select the link and copy manually.'));
    });
    document.getElementById('share-change-token-btn').addEventListener('click', () => {
      closeShareModal();
      openPatModal();
    });

    // PAT modal
    document.getElementById('pat-modal-close').addEventListener('click', closePatModal);
    document.getElementById('pat-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closePatModal();
    });
    document.getElementById('pat-save-btn').addEventListener('click', handlePatSave);
    document.getElementById('pat-token-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') handlePatSave();
    });

    // Shared-route expiration banner
    document.getElementById('banner-save-btn').addEventListener('click', async () => {
      if (sharedRouteRef) {
        await saveUploadToLibrary(sharedRouteRef);
        hideSharedRouteBanner();
      }
    });
    document.getElementById('banner-dismiss-btn').addEventListener('click', hideSharedRouteBanner);

    // Map toolbar
    document.getElementById('btn-zoom-in') .addEventListener('click', () => MapManager.zoomIn());
    document.getElementById('btn-zoom-out').addEventListener('click', () => MapManager.zoomOut());

    const locateBtn = document.getElementById('btn-locate');
    locateBtn.addEventListener('click', () => {
      locateBtn.classList.add('locating');
      MapManager.locateUser(
        null,
        ()  => locateBtn.classList.remove('locating'),
        msg => { locateBtn.classList.remove('locating'); alert('Could not get your location:\n' + msg); }
      );
    });

    document.getElementById('btn-layers').addEventListener('click', () => {
      togglePanel('layer-panel');
      if (!document.getElementById('layer-panel').hidden) renderLayerList();
    });

    document.getElementById('btn-legend').addEventListener('click', () => {
      togglePanel('legend-panel');
    });

    const queryBtn = document.getElementById('btn-query');
    queryBtn.addEventListener('click', () => {
      const active = queryBtn.classList.toggle('active');
      MapManager.setQueryMode(active);
    });

    document.getElementById('btn-3d').addEventListener('click', () => {
      if (currentPoints.length >= 2) View3D.show(currentPoints);
    });

    // Ski piste overlay — load on demand for current viewport
    document.getElementById('btn-ski').addEventListener('click', async e => {
      const btn = e.currentTarget;
      if (skiOverlayActive) {
        skiOverlayActive = false;
        MapManager.clearSkiResort();
        btn.classList.remove('active');
        btn.title       = 'Show ski resort pistes for this area';
        btn.textContent = '❄️';
        return;
      }
      skiOverlayActive  = true;
      btn.classList.add('active');
      btn.textContent   = '⏳';
      btn.title         = 'Loading piste data…';
      try {
        const count = await MapManager.showSkiForViewport();
        btn.textContent = '❄️';
        btn.title       = 'Hide ski resort pistes';
        if (!count) showShareToast('No ski piste data found in this area. Try zooming to a resort.');
      } catch (err) {
        skiOverlayActive  = false;
        btn.classList.remove('active');
        btn.textContent   = '❄️';
        btn.title         = 'Show ski resort pistes for this area';
        if (err.message === 'zoom-too-low') {
          showShareToast('Zoom in to a ski resort area first.');
        } else {
          showShareToast('Could not load ski piste data.');
        }
      }
    });

    // ESC hides the piste legend
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const legend = document.getElementById('piste-legend');
        if (legend && legend.style.display !== 'none') legend.style.display = 'none';
      }
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('#map-toolbar') && !e.target.closest('.map-panel')) {
        document.querySelectorAll('.map-panel').forEach(p => { p.hidden = true; });
      }
    }, true);

    // Backup reminder — prompt before leaving if library has unexported changes
    window.addEventListener('beforeunload', e => {
      if (backupNeeded) {
        e.preventDefault();
        e.returnValue = ''; // required for Chrome/Edge to show the dialog
      }
    });

    init();
  });

})();
