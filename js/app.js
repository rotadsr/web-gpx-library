/**
 * GPX Library — main application logic.
 * Sources: IndexedDB (My Library, persistent)  |  browser uploads (session-only)
 */

(function () {

  // ── Module state ─────────────────────────────────────────────────────────────
  let savedRoutes    = [];   // persistent — loaded from IndexedDB
  let uploadedRoutes = [];   // session-only — cleared on refresh
  let backupNeeded   = false; // true = library has changes not yet exported
  let searchQuery     = '';
  let elevationChart  = null;
  let currentPoints   = [];
  let activeRouteId   = null;

  // Activity / category filter
  let activeCategory = null;   // null = all, or a CATEGORIES key like 'cycling'

  // Stats state — stats are always stored in metric internally
  let currentStats     = null;
  let currentMeta      = null;
  let overrideDuration = null;   // user-set seconds; null = use GPX value
  let units            = 'metric'; // 'metric' | 'imperial'

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

    document.getElementById('search-input').addEventListener('input', e => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderFileTree();
    });
  }

  // ── Export / Import ───────────────────────────────────────────────────────────

  function setupExportImport() {
    const exportBtn   = document.getElementById('btn-export-lib');
    const importBtn   = document.getElementById('btn-import-lib');
    const importInput = document.getElementById('import-lib-input');

    exportBtn?.addEventListener('click', doExport);
    importBtn?.addEventListener('click', () => importInput.click());
    importInput?.addEventListener('change', async () => {
      const file = importInput.files[0];
      if (file) { await doImport(file); importInput.value = ''; }
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

        if (++loaded === files.length) { renderFileTree(); }
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
  }

  // ── File tree ─────────────────────────────────────────────────────────────────

  function renderFileTree() {
    const tree = document.getElementById('file-tree');
    tree.innerHTML = '';

    const filteredSaved   = filterRoutes(savedRoutes);
    const filteredUploads = filterBySearch(uploadedRoutes);

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
  }

  function appendFolderGroups(container, routes) {
    const byFolder = {};
    routes.forEach(r => (byFolder[r.folder] = byFolder[r.folder] || []).push(r));

    Object.keys(byFolder).sort().forEach(folder => {
      const group = document.createElement('div');
      group.className = 'folder-group';

      const header = document.createElement('div');
      header.className = 'folder-header';
      header.innerHTML = `<span class="folder-icon">📁</span>${folder}
        <span class="folder-count">${byFolder[folder].length}</span>`;
      header.addEventListener('click', () => group.classList.toggle('collapsed'));
      group.appendChild(header);

      const list = document.createElement('ul');
      list.className = 'route-list';
      byFolder[folder].forEach(route => list.appendChild(buildRouteItem(route)));
      group.appendChild(list);
      container.appendChild(group);
    });
  }

  const SVG_PENCIL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
  const SVG_TRASH  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
  const SVG_SAVE   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;

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

  function filterRoutes(routes) {
    // Expand the query to categories via semantic keywords (e.g. "winter" → snow)
    const kwCats = getKeywordCategories(searchQuery);

    return routes.filter(r => {
      const activityName = getActivityName(r.activity).toLowerCase();
      const catName      = getCategoryName(getActivityCategory(r.activity)).toLowerCase();

      // Keyword match: query maps to one or more categories that include this route's activity
      const matchKeyword = kwCats.length > 0
        && r.activity
        && kwCats.includes(getActivityCategory(r.activity));

      const matchSearch = !searchQuery
        || r.name.toLowerCase().includes(searchQuery)
        || (r.description || '').toLowerCase().includes(searchQuery)
        || (r.tags || []).some(t => t.toLowerCase().includes(searchQuery))
        || activityName.includes(searchQuery)
        || catName.includes(searchQuery)
        || matchKeyword;

      const matchCategory = !activeCategory
        || getActivityCategory(r.activity) === activeCategory;

      return matchSearch && matchCategory;
    });
  }

  // Filter for uploads: text search + same keyword expansion used for library routes
  function filterBySearch(routes) {
    if (!searchQuery) return routes;
    const kwCats = getKeywordCategories(searchQuery);
    return routes.filter(r => {
      const matchKeyword = kwCats.length > 0
        && r.activity
        && kwCats.includes(getActivityCategory(r.activity));
      return r.name.toLowerCase().includes(searchQuery)
        || (r.description || '').toLowerCase().includes(searchQuery)
        || getActivityName(r.activity).toLowerCase().includes(searchQuery)
        || matchKeyword;
    });
  }

  function getFolderIcon(folder) {
    const f = folder.toLowerCase();
    if (f.includes('upload'))                              return '📤';
    if (f.includes('hik') || f.includes('trail') || f.includes('walk')) return '🥾';
    if (f.includes('cycl') || f.includes('bike'))         return '🚴';
    if (f.includes('run'))                                 return '🏃';
    if (f.includes('ski'))                                 return '⛷️';
    return '🗺️';
  }

  // ── Route loading ─────────────────────────────────────────────────────────────

  async function loadRoute(route, listItem) {
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

      const parsed = GPXParser.parse(xmlText);
      currentPoints = parsed.points;

      if (!route.name && parsed.metadata.name)
        document.getElementById('route-name').textContent = parsed.metadata.name;
      if (!route.description && parsed.metadata.description)
        document.getElementById('route-description').textContent = parsed.metadata.description;

      // Activity icon: prefer route definition, fall back to GPX <trk><type>
      const resolvedActivity = route.activity || parsed.metadata.activity || null;
      setActivityIcon(resolvedActivity);

      // Difficulty badge
      setDifficultyBadge(calcDifficulty(parsed.stats, resolvedActivity));

      renderStats(parsed.metadata, parsed.stats);
      MapManager.showRoute(parsed.points, parsed.stats);
      renderElevationChart(parsed.points, parsed.stats);
      loadWeatherForecast(parsed.points);

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
    updateStatDisplay();
  }

  // Re-renders all stat values from state (called on override change or unit toggle).
  function updateStatDisplay() {
    if (!currentStats) return;

    const dist  = currentStats.totalDistance;
    const secs  = overrideDuration !== null ? overrideDuration : currentStats.totalTime;
    const speed = secs && secs > 0 ? (dist / secs) * 3600 : currentStats.avgSpeed;

    document.getElementById('stat-distance').textContent =
      fmtDist(dist);
    document.getElementById('stat-duration').textContent =
      GPXParser.formatDuration(secs);
    document.getElementById('stat-elevation-gain').textContent =
      currentStats.elevationGain ? `+${fmtElev(currentStats.elevationGain)}` : '—';
    document.getElementById('stat-elevation-loss').textContent =
      currentStats.elevationLoss ? `−${fmtElev(currentStats.elevationLoss)}` : '—';
    document.getElementById('stat-max-elevation').textContent =
      currentStats.maxElevation  ? fmtElev(currentStats.maxElevation)  : '—';

    // ↑ Uphill-only average gradient
    const upGrad = currentStats.avgUphillGradient;
    document.getElementById('stat-avg-gradient-up').textContent =
      upGrad   !== null ? `+${upGrad.toFixed(1)}%`  : '—';

    // ↓ Downhill-only average gradient
    const downGrad = currentStats.avgDownhillGradient;
    document.getElementById('stat-avg-gradient-down').textContent =
      downGrad !== null ? `−${downGrad.toFixed(1)}%` : '—';

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
    setActivityIcon(null);
    setDifficultyBadge(null);
    ['stat-distance','stat-duration','stat-elevation-gain','stat-elevation-loss',
     'stat-max-elevation','stat-avg-gradient-up','stat-avg-gradient-down','stat-avg-speed','stat-author']
      .forEach(id => { document.getElementById(id).textContent = '…'; });
    document.getElementById('override-bar').style.display = 'none';
    document.querySelectorAll('[data-editable]').forEach(c => c.classList.remove('is-overridden'));
    // Reset weather
    currentWeatherData = null;
    document.getElementById('weather-section').style.display = 'none';
    document.getElementById('weather-days').innerHTML = '';
    document.getElementById('weather-location').textContent = '';
  }

  // ── Editable stat cards (Duration ↔ Speed) ───────────────────────────────────

  function setupEditableStats() {
    const durationCard = document.querySelector('[data-editable="duration"]');
    const speedCard    = document.querySelector('[data-editable="speed"]');

    // Duration card: click → edit in H:MM; commit → update speed
    durationCard.addEventListener('click', () => {
      if (!currentStats || durationCard.classList.contains('editing')) return;
      const secs = overrideDuration !== null ? overrideDuration : currentStats.totalTime;
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
      const baseSecs  = overrideDuration !== null ? overrideDuration : currentStats.totalTime;
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

    if (elevationChart) { elevationChart.destroy(); elevationChart = null; }

    const ctx = document.getElementById('elevation-chart').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, 'rgba(59,130,246,0.35)');
    gradient.addColorStop(1, 'rgba(59,130,246,0.02)');

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
          fill: true,
          backgroundColor: gradient,
          borderColor: '#3b82f6',
          borderWidth: 2,
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
            if (currentPoints[pointIdx]) MapManager.highlightPoint(currentPoints[pointIdx]);
          } else {
            MapManager.hideHighlight();
          }
        }
      }
    });
  }

  // ── Weather forecast (Open-Meteo, no API key required) ───────────────────────

  async function loadWeatherForecast(points) {
    if (!points || !points.length) return;

    const { lat, lon } = points[0];
    const section = document.getElementById('weather-section');
    const daysEl  = document.getElementById('weather-days');
    const locEl   = document.getElementById('weather-location');

    section.style.display = 'block';
    daysEl.innerHTML = '<p class="weather-loading">Loading forecast…</p>';
    locEl.textContent = '';

    // Location name via Nominatim (low zoom → city/region level)
    try {
      const nr = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=8`,
        { headers: { 'Accept-Language': 'en' } }
      );
      const nd = await nr.json();
      const a  = nd.address || {};
      const place = a.city || a.town || a.village || a.county || a.state || '';
      const country = a.country_code ? a.country_code.toUpperCase() : '';
      locEl.textContent = [place, country].filter(Boolean).join(', ');
    } catch (_) {
      locEl.textContent = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    }

    // Weather forecast
    try {
      const params = new URLSearchParams({
        latitude:      lat.toFixed(4),
        longitude:     lon.toFixed(4),
        daily:         'weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max',
        timezone:      'auto',
        forecast_days: 7,
      });
      const wr = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
      if (!wr.ok) throw new Error('HTTP ' + wr.status);
      const wd = await wr.json();
      currentWeatherData = wd.daily;
      renderWeatherDays(currentWeatherData);
    } catch (err) {
      daysEl.innerHTML = '<p class="weather-error">Could not load forecast.</p>';
    }
  }

  function renderWeatherDays(daily) {
    const daysEl = document.getElementById('weather-days');
    if (!daysEl || !daily) return;

    const { time, weathercode, temperature_2m_max, temperature_2m_min,
            precipitation_sum, windspeed_10m_max } = daily;

    const isImperial = units === 'imperial';
    const todayStr   = new Date().toISOString().slice(0, 10);

    daysEl.innerHTML = '';

    time.forEach((dateStr, i) => {
      const date    = new Date(dateStr + 'T12:00:00'); // noon avoids timezone date shifts
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

      const card = document.createElement('div');
      card.className = 'weather-day' + (dateStr === todayStr ? ' is-today' : '');
      card.title = desc;
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
      daysEl.appendChild(card);
    });
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

  // ── Sidebar toggle ────────────────────────────────────────────────────────────

  function setupSidebarToggle() {
    const sidebar   = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle-btn');

    toggleBtn.addEventListener('click', () => {
      const collapsed = sidebar.classList.toggle('collapsed');
      toggleBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      // Wait for CSS transition (250 ms) before telling Leaflet to reflow
      setTimeout(() => MapManager.invalidateMapSize(), 260);
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

    // Layout controls
    setupSidebarToggle();
    setupSplitHandle();

    // GPX editor
    Editor.setup();

    // Editable stats
    setupEditableStats();

    // Unit toggle (km | mi)
    document.querySelectorAll('.unit-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        units = btn.dataset.unit;
        document.querySelectorAll('.unit-opt').forEach(b =>
          b.classList.toggle('is-active', b.dataset.unit === units)
        );
        updateStatDisplay();
        if (currentPoints.length && currentStats) renderElevationChart(currentPoints, currentStats);
        if (currentWeatherData) renderWeatherDays(currentWeatherData);
      });
    });

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
