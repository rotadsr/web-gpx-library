/**
 * Util — small shared helpers with no dependencies.
 */
const Util = (() => {
  // Escapes text for safe interpolation into innerHTML / attribute values.
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  /**
   * Small promise-based text prompt (window.prompt() is blocked/ugly in many contexts).
   * Resolves with the trimmed text, or null if cancelled or left empty.
   */
  function promptText(title, defaultValue = '', okLabel = 'Save') {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML =
        `<div class="confirm-box" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">` +
        `<h3>${escapeHtml(title)}</h3>` +
        `<input type="text" class="share-url-input util-prompt-input" maxlength="120" autocomplete="off" spellcheck="false" />` +
        `<div class="confirm-btns"><button type="button" class="confirm-merge">${escapeHtml(okLabel)}</button>` +
        `<button type="button" class="confirm-cancel">Cancel</button></div></div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('input');
      input.value = defaultValue;
      const done = v => { overlay.remove(); resolve(v); };
      const ok = () => { const v = input.value.trim(); done(v || null); };
      overlay.querySelector('.confirm-merge').onclick = ok;
      overlay.querySelector('.confirm-cancel').onclick = () => done(null);
      overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') done(null); });
      input.focus(); input.select();
    });
  }

  /** Yes/no confirmation. Resolves true when the user confirms. */
  function confirmDialog(title, message, okLabel = 'OK') {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML =
        `<div class="confirm-box" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">` +
        `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p>` +
        `<div class="confirm-btns"><button type="button" class="confirm-overwrite">${escapeHtml(okLabel)}</button>` +
        `<button type="button" class="confirm-cancel">Cancel</button></div></div>`;
      document.body.appendChild(overlay);
      const done = v => { overlay.remove(); resolve(v); };
      overlay.querySelector('.confirm-overwrite').onclick = () => done(true);
      overlay.querySelector('.confirm-cancel').onclick = () => done(false);
      overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
    });
  }

  return { escapeHtml, promptText, confirmDialog };
})();
