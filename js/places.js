/**
 * Places catalogue — built-in point-of-interest categories plus user-defined
 * custom categories, merged at lookup time. Places themselves (the actual pins)
 * are managed in app.js; this module only owns the category catalogue, mirroring
 * how activities.js owns the activity catalogue.
 */

/* eslint-disable */
const PLACE_CATEGORIES = {
  water:     { name: 'Water / Fountain',         emoji: '💧' },
  refuge:    { name: 'Mountain Refuge / Shelter', emoji: '🏠' },
  viewpoint: { name: 'Viewpoint',                 emoji: '🔭' },
  parking:   { name: 'Parking',                   emoji: '🅿️' },
  pumptrack: { name: 'Pumptrack',                 emoji: '🚴' },
  camping:   { name: 'Camping',                   emoji: '⛺' },
  climbing:  { name: 'Climbing / Bouldering',     emoji: '🧗' },
  other:     { name: 'Other',                     emoji: '📍' },
};

const PLACE_CATEGORIES_KEY = 'gpxlib-place-categories';

/** Raw list of user-defined categories: [{ key, name, emoji }]. */
function getCustomPlaceCategories() {
  try { return JSON.parse(localStorage.getItem(PLACE_CATEGORIES_KEY)) || []; } catch { return []; }
}

function saveCustomPlaceCategories(list) {
  localStorage.setItem(PLACE_CATEGORIES_KEY, JSON.stringify(list));
}

/** Add a user-defined category; returns its generated key. */  
function addPlaceCategory(name, emoji) {
  const custom = getCustomPlaceCategories();
  const key = 'custom-' + Date.now();
  custom.push({ key, name, emoji: emoji || '📍' });
  saveCustomPlaceCategories(custom);
  return key;
}

/** Remove a user-defined category. Places referencing it fall back to "other". */
function removePlaceCategory(key) {
  saveCustomPlaceCategories(getCustomPlaceCategories().filter(c => c.key !== key));
}

/** Merged built-in + custom categories, keyed the same way as PLACE_CATEGORIES. */
function getAllPlaceCategories() {
  const merged = { ...PLACE_CATEGORIES };
  getCustomPlaceCategories().forEach(c => {
    merged[c.key] = { name: c.name, emoji: c.emoji };
  });
  return merged;
}

/** Category info for a key, falling back to "other" for unknown/orphaned keys. */
function getPlaceCategory(key) {
  return getAllPlaceCategories()[key] ?? PLACE_CATEGORIES.other;
}

function getPlaceCategoryEmoji(key) { return getPlaceCategory(key).emoji; }
function getPlaceCategoryName(key)  { return getPlaceCategory(key).name; }
