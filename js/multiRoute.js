/**
 * MultiRoute — UI for showing several library routes on the map at once:
 * colour legend (show/hide, custom colours, zoom-to), combined stats,
 * overlaid elevation profiles, a comparison table, merge and "save as collection".
 * Drawing the lines themselves is MapManager's job.
 */
const MultiRoute = (() => {
  const esc = Util.escapeHtml;

  let legendEl = null;
  let profileEl = null;
  let profileChart = null;
  let compareEl = null;

  function teardown() {
    if (legendEl) legendEl.hidden = true;
    closeProfile();
    closeCompare();
  }

  function closeProfile() {
    if (profileChart) { profileChart.destroy(); profileChart = null; }
    if (profileEl) profileEl.hidden = true;
  }

  function closeCompare() {
    if (compareEl) { compareEl.remove(); compareEl = null; }
  }

  function ensureLegend() {
    if (legendEl) return legendEl;
    legendEl = document.createElement('div');
    legendEl.id = 'multi-route-legend';
    L.DomEvent.disableClickPropagation(legendEl);
    L.DomEvent.disableScrollPropagation(legendEl);
    MapManager.getMapContainerParent().appendChild(legendEl);
    return legendEl;
  }

  function ensureProfile() {
    if (profileEl) return profileEl;
    profileEl = document.createElement('div');
    profileEl.id = 'multi-route-profile';
    profileEl.innerHTML =
      '<div class="multi-route-legend-head"><strong>Elevation profiles</strong>' +
      '<button type="button" class="multi-route-legend-close" aria-label="Close profiles" title="Close">✕</button></div>' +
      '<div class="multi-route-profile-canvas"><canvas></canvas></div>';
    L.DomEvent.disableClickPropagation(profileEl);
    L.DomEvent.disableScrollPropagation(profileEl);
    profileEl.querySelector('button').onclick = closeProfile;
    MapManager.getMapContainerParent().appendChild(profileEl);
    return profileEl;
  }

  /**
   * items: [{ name, points, profile:[{dist,ele}], distanceKm, gainM, ... }]
   * opts:  formatSummary(visibleItems), distFactor/distLabel, elevFactor/elevLabel,
   *        columns:[{label,get(item)}], onMerge(visibleItems), onSaveCollection(items)
   */
  function show(items, opts = {}) {
    MapManager.onMultiRoutesCleared(teardown);
    const handles = MapManager.showMultiRoutes(items);
    const legend = ensureLegend();
    closeProfile();
    closeCompare();

    legend.innerHTML =
      '<div class="multi-route-legend-head"><strong>Selected routes</strong>' +
      '<button type="button" class="multi-route-legend-close" aria-label="Clear selected routes" title="Clear">✕</button></div>' +
      '<div class="multi-route-summary"></div>' +
      items.map((it, i) =>
        `<div class="multi-route-legend-row" data-i="${i}">` +
        `<input type="checkbox" class="multi-route-toggle" checked aria-label="Show or hide route" title="Show / hide">` +
        `<input type="color" class="multi-route-color" value="${handles[i].color}" aria-label="Route colour" title="Change colour">` +
        `<span class="multi-route-legend-name" title="Zoom to route">${esc(it.name || 'Untitled route')}</span></div>`
      ).join('') +
      '<div class="multi-route-actions">' +
      '<button type="button" data-act="profile">📈 Profiles</button>' +
      '<button type="button" data-act="compare">📋 Compare</button>' +
      '<button type="button" data-act="merge">🔗 Merge</button>' +
      '<button type="button" data-act="collection">⭐ Save set</button></div>';
    legend.hidden = false;

    const visibleItems = () => items.filter((_, i) => handles[i].visible);
    const summaryEl = legend.querySelector('.multi-route-summary');
    const updateSummary = () => {
      summaryEl.textContent = opts.formatSummary ? opts.formatSummary(visibleItems()) : '';
    };
    updateSummary();


    function buildProfile() {
      const panel = ensureProfile();
      panel.hidden = false;
      if (profileChart) { profileChart.destroy(); profileChart = null; }
      const df = opts.distFactor || 1, ef = opts.elevFactor || 1;
      const datasets = items.map((it, i) => ({
        label: it.name || 'Untitled route',
        data: (it.profile || []).map(p => ({ x: p.dist * df, y: p.ele * ef })),
        borderColor: handles[i].color,
        backgroundColor: handles[i].color,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.2,
        hidden: !handles[i].visible,
      }));
      profileChart = new Chart(panel.querySelector('canvas'), {
        type: 'line',
        data: { datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          interaction: { mode: 'nearest', axis: 'x', intersect: false },
          scales: {
            x: { type: 'linear', title: { display: true, text: opts.distLabel || 'km' } },
            y: { title: { display: true, text: opts.elevLabel || 'm' } },
          },
          plugins: { legend: { display: false } },
        },
      });
    }

    function buildCompare() {
      closeCompare();
      const cols = opts.columns || [];
      compareEl = document.createElement('div');
      compareEl.className = 'share-overlay';
      compareEl.innerHTML =
        '<div class="share-dialog multi-compare-dialog"><div class="share-dialog-header">' +
        '<h3>Compare routes</h3><button type="button" class="share-close-btn" aria-label="Close">✕</button></div>' +
        '<div class="multi-compare-scroll"><table class="multi-compare-table"><thead><tr><th></th>' +
        cols.map(c => `<th>${esc(c.label)}</th>`).join('') + '</tr></thead><tbody>' +
        items.map((it, i) =>
          `<tr><td><span class="multi-route-swatch" style="background:${handles[i].color}"></span>${esc(it.name || 'Untitled route')}</td>` +
          cols.map(c => `<td>${esc(c.get(it))}</td>`).join('') + '</tr>'
        ).join('') + '</tbody></table></div></div>';
      document.body.appendChild(compareEl);
      compareEl.querySelector('.share-close-btn').onclick = closeCompare;
      compareEl.addEventListener('click', e => { if (e.target === compareEl) closeCompare(); });
    }

    legend.querySelectorAll('.multi-route-legend-row').forEach(row => {
      const i = Number(row.dataset.i);
      const h = handles[i];
      row.querySelector('.multi-route-toggle').addEventListener('change', ev => {
        h.setVisible(ev.target.checked);
        row.classList.toggle('is-hidden', !h.visible);
        if (profileChart) { profileChart.setDatasetVisibility(i, h.visible); profileChart.update(); }
        updateSummary();
      });
      row.querySelector('.multi-route-color').addEventListener('input', ev => {
        h.setColor(ev.target.value);
        if (profileChart) {
          const ds = profileChart.data.datasets[i];
          ds.borderColor = ds.backgroundColor = ev.target.value;
          profileChart.update();
        }
      });
      row.querySelector('.multi-route-legend-name').addEventListener('click', () => h.zoomTo());
    });

    legend.querySelector('.multi-route-legend-close').onclick = () => MapManager.clearMultiRoutes();
    legend.querySelector('.multi-route-actions').onclick = ev => {
      const act = ev.target.closest('button')?.dataset.act;
      if (act === 'profile') profileChart ? closeProfile() : buildProfile();
      else if (act === 'compare') buildCompare();
      else if (act === 'merge' && opts.onMerge) opts.onMerge(visibleItems());
      else if (act === 'collection' && opts.onSaveCollection) opts.onSaveCollection(items);
    };
  }

  return { show };
})();
