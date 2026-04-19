/**
 * Activity catalogue — definitions, emoji icons, and category helpers.
 * Each route in library.json can carry an `activity` key matching one entry here.
 */

/* eslint-disable */
const ACTIVITIES = {

  // ── Hiking & Walking ──────────────────────────────────────────────────────
  hike:             { name: 'Hike',             emoji: '🥾', category: 'hiking' },
  trailWalking:     { name: 'Trail Walking',     emoji: '🚶', category: 'hiking' },
  ultralightHiking: { name: 'Ultralight Hiking', emoji: '🎒', category: 'hiking' },
  fellRunning:      { name: 'Fell Running',      emoji: '🏃', category: 'hiking' },

  // ── Mountain Sports ───────────────────────────────────────────────────────
  mountaineering:    { name: 'Mountaineering',      emoji: '⛰️', category: 'mountainSports' },
  climbing:          { name: 'Rock Climbing',        emoji: '🧗', category: 'mountainSports' },
  viaFerrata:        { name: 'Via Ferrata',          emoji: '🧗', category: 'mountainSports' },
  alpineSki:         { name: 'Alpine Skiing',        emoji: '⛷️', category: 'mountainSports' },
  skiMountaineering: { name: 'Ski Mountaineering',   emoji: '⛷️', category: 'mountainSports' },

  // ── Cycling ───────────────────────────────────────────────────────────────
  roadBike:     { name: 'Road Bike',            emoji: '🚴', category: 'cycling' },
  gravelBike:   { name: 'Gravel Bike',          emoji: '🚴', category: 'cycling' },
  cycling:      { name: 'Cycling',              emoji: '🚲', category: 'cycling' },
  trailCycling: { name: 'Trail Cycling',        emoji: '🚵', category: 'cycling' },
  mtb:          { name: 'Mountain Biking (MTB)',emoji: '🚵', category: 'cycling' },
  eMtb:         { name: 'E-MTB',               emoji: '⚡', category: 'cycling' },
  enduroBike:   { name: 'Enduro Bike',          emoji: '🚵', category: 'cycling' },
  downhillBike: { name: 'Downhill Bike',        emoji: '🚵', category: 'cycling' },
  bikepacking:  { name: 'Bikepacking',          emoji: '🧳', category: 'cycling' },

  // ── Snow ──────────────────────────────────────────────────────────────────
  touringSki:     { name: 'Touring Ski',        emoji: '🎿', category: 'snow' },
  backcountrySki: { name: 'Backcountry Skiing', emoji: '🎿', category: 'snow' },
  snowshoeing:    { name: 'Snowshoeing',        emoji: '❄️', category: 'snow' },

  // ── Running ───────────────────────────────────────────────────────────────
  running:      { name: 'Running',       emoji: '🏃', category: 'running' },
  trailRunning: { name: 'Trail Running', emoji: '🏃', category: 'running' },

  // ── Water Sports ──────────────────────────────────────────────────────────
  kayaking:    { name: 'Kayaking / Paddling', emoji: '🛶', category: 'water' },
  packrafting: { name: 'Packrafting',         emoji: '⛵', category: 'water' },
};

const CATEGORIES = {
  hiking:         { name: 'Hiking & Walking', emoji: '🥾' },
  mountainSports: { name: 'Mountain Sports',  emoji: '⛰️' },
  cycling:        { name: 'Cycling',          emoji: '🚴' },
  snow:           { name: 'Snow',             emoji: '❄️' },
  running:        { name: 'Running',          emoji: '🏃' },
  water:          { name: 'Water Sports',     emoji: '🛶' },
};

/**
 * Semantic keyword → category mapping for the search bar.
 * A query that starts with (or equals) a keyword expands to those categories.
 * Only applied for queries of 3+ characters.
 */
const SEARCH_KEYWORDS = {
  // Winter / snow
  winter:   ['snow', 'mountainSports'],
  snow:     ['snow'],
  ski:      ['snow', 'mountainSports'],
  skiing:   ['snow', 'mountainSports'],
  nordic:   ['snow'],
  snowshoe: ['snow'],
  // Water
  water:    ['water'],
  paddle:   ['water'],
  kayak:    ['water'],
  river:    ['water'],
  raft:     ['water'],
  // Cycling
  bike:     ['cycling'],
  cycl:     ['cycling'],
  mtb:      ['cycling'],
  gravel:   ['cycling'],
  enduro:   ['cycling'],
  downhill: ['cycling'],
  bikepack: ['cycling'],
  electric: ['cycling'],
  ebike:    ['cycling'],
  // Hiking / walking
  hike:     ['hiking'],
  hiking:   ['hiking'],
  walk:     ['hiking'],
  trail:    ['hiking', 'running', 'cycling'],
  trek:     ['hiking'],
  backpack: ['hiking'],
  // Mountain
  mountain: ['mountainSports', 'hiking'],
  alpine:   ['mountainSports'],
  climb:    ['mountainSports'],
  ferrata:  ['mountainSports'],
  // Running
  run:      ['running'],
};

/**
 * Returns category keys that match a search query via SEARCH_KEYWORDS.
 * Only activates for queries ≥ 3 characters.
 */
function getKeywordCategories(query) {
  if (!query || query.length < 3) return [];
  const cats = new Set();
  Object.entries(SEARCH_KEYWORDS).forEach(([kw, categories]) => {
    if (kw.startsWith(query) || query.startsWith(kw)) {
      categories.forEach(c => cats.add(c));
    }
  });
  return [...cats];
}

/** Emoji icon for a given activity key (falls back to 🗺️). */
function getActivityEmoji(key) {
  return ACTIVITIES[key]?.emoji ?? '🗺️';
}

/** Display name for a given activity key. */
function getActivityName(key) {
  return ACTIVITIES[key]?.name ?? (key || '');
}

/** Category key for a given activity key (or null). */
function getActivityCategory(key) {
  return ACTIVITIES[key]?.category ?? null;
}

/** Display name for a category key. */
function getCategoryName(catKey) {
  return CATEGORIES[catKey]?.name ?? (catKey || '');
}
