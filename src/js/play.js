// M64 online-table client entry (play.html). Wave 1 stub: the real
// lobby / claim / battle / DM views land in Wave 4 (C5–C9, C11).
// This page must stay independent of main.js — it shares only pure
// modules with the forge, never its delegated document handlers.

/**
 * Render the placeholder table view into the given root element.
 * @param {HTMLElement|null} root
 * @returns {void}
 */
export function mountPlaceholder(root) {
  if (!root) return;
  root.textContent = 'character-forge table — coming in Wave 4';
}

if (typeof document !== 'undefined') {
  mountPlaceholder(document.getElementById('play-root'));
}
