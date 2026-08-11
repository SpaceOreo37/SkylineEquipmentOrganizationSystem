// Shared UI helpers for the inventory pages: HTML escaping, toasts,
// section accent colors, count caches, and the lazy count-fetch pool.
import { getUnitCounts, getUserProfile } from './firestore.js?v=8';

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Toast ──
let toastTimer = null;
export function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

// ── Section accent (deterministic color per section name) ──
const ACCENT_COUNT = 8;
export function sectionAccent(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return `accent-${hash % ACCENT_COUNT}`;
}

// ── Teacher profile (users doc) — one fetch per session, then sessionStorage ──
const PROFILE_KEY = 'eos:profile:v1';

/**
 * The cached profile for this uid, or null if it isn't there yet. Costs zero
 * reads, so pages that only need the teacher's name/room can degrade
 * gracefully instead of spending a read.
 */
export function readProfileFromSession(uid) {
  try {
    const cached = JSON.parse(sessionStorage.getItem(PROFILE_KEY));
    if (cached && cached.uid === uid) return cached;
  } catch { /* corrupt — treat as absent */ }
  return null;
}

/**
 * The teacher's profile: cached if present, otherwise one users-doc read
 * that is then cached for the rest of the session.
 * Returns { uid, teacherName, roomNumber }.
 */
export async function loadProfile(user) {
  const cached = readProfileFromSession(user.uid);
  if (cached) return cached;

  const p = await getUserProfile(user.uid);
  const profile = {
    uid: user.uid,
    teacherName: p.displayName || user.email,
    roomNumber: p.roomNumber ?? null,
  };
  try { sessionStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* fine */ }
  return profile;
}

// ── equipmentTypes handoff between pages (sessionStorage) ──
const TYPES_KEY = 'eos:types:v1';

export function saveTypesToSession(types) {
  try {
    const slim = types.map(({ id, name, section, category }) => ({ id, name, section, category }));
    sessionStorage.setItem(TYPES_KEY, JSON.stringify({ savedAt: Date.now(), types: slim }));
  } catch { /* storage unavailable — section page falls back to a fetch */ }
}

export function loadTypesFromSession() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(TYPES_KEY));
    if (raw && Array.isArray(raw.types)) return raw.types;
  } catch { /* corrupt — treat as absent */ }
  return null;
}

// ── Total-unit cache (localStorage, 24h TTL) ──
// Totals only change when units are added/removed, never on checkout.
const TOTALS_KEY = 'eos:typeTotals:v1';
const TOTALS_TTL_MS = 24 * 60 * 60 * 1000;
const totalsMap = loadTotals();
let totalsSaveTimer = null;

function loadTotals() {
  try {
    const raw = JSON.parse(localStorage.getItem(TOTALS_KEY));
    if (raw && Date.now() - raw.savedAt < TOTALS_TTL_MS) {
      return new Map(Object.entries(raw.totals));
    }
  } catch { /* corrupt or absent — start fresh */ }
  return new Map();
}

function saveTotalsSoon() {
  clearTimeout(totalsSaveTimer);
  totalsSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        TOTALS_KEY,
        JSON.stringify({ savedAt: Date.now(), totals: Object.fromEntries(totalsMap) })
      );
    } catch { /* storage full — totals just re-fetch next session */ }
  }, 1000);
}

// ── Availability cache (sessionStorage, 5 min TTL) ──
// Keeps back-and-forth navigation between pages from re-spending reads,
// while staying fresh enough for checkout decisions.
const AVAIL_KEY = 'eos:availCounts:v1';
const AVAIL_TTL_MS = 5 * 60 * 1000;

function loadAvail() {
  try {
    return JSON.parse(sessionStorage.getItem(AVAIL_KEY)) ?? {};
  } catch { return {}; }
}

function getCachedAvail(typeId) {
  const entry = loadAvail()[typeId];
  return entry && Date.now() - entry.at < AVAIL_TTL_MS ? entry.n : undefined;
}

function setCachedAvail(typeId, n) {
  try {
    const all = loadAvail();
    all[typeId] = { n, at: Date.now() };
    sessionStorage.setItem(AVAIL_KEY, JSON.stringify(all));
  } catch { /* fine — just means a re-read later */ }
}

/** Drop one type's cached availability (e.g. right after a checkout). */
export function invalidateCachedAvail(typeId) {
  try {
    const all = loadAvail();
    delete all[typeId];
    sessionStorage.setItem(AVAIL_KEY, JSON.stringify(all));
  } catch { /* fine */ }
}

// ── Counts display ──
export function countsHtml(counts) {
  if (!counts) return '<span class="counts-loading">Loading…</span>';
  if (counts.error) return '<button class="counts-retry" data-retry>Couldn’t load — retry</button>';
  const availClass = counts.available === 0
    ? 'count-available count-available--zero'
    : 'count-available';
  return `<span class="${availClass}">${counts.available} available</span>` +
         `<span class="count-total"> / ${counts.total} total</span>`;
}

/**
 * Lazy count loader with a small concurrency pool. Checks the availability
 * and totals caches first; only cache misses hit Firestore (via count()
 * aggregations, 1 read each). onResult(typeId, counts) fires for every
 * resolution, including cache hits and errors ({ error: true }).
 * isStillNeeded(typeId) lets the page drop queued work that scrolled away.
 */
export function createCountPool({ onResult, isStillNeeded = () => true, concurrency = 6 }) {
  const results = new Map(); // typeId -> { available, total } | { error: true }
  const inflight = new Set();
  const queue = [];
  let active = 0;

  function request(typeId) {
    if (results.has(typeId) && !results.get(typeId).error) {
      onResult(typeId, results.get(typeId));
      return;
    }
    if (inflight.has(typeId)) return;

    const cachedAvail = getCachedAvail(typeId);
    const cachedTotal = totalsMap.get(typeId);
    if (cachedAvail !== undefined && cachedTotal !== undefined) {
      results.set(typeId, { available: cachedAvail, total: cachedTotal });
      onResult(typeId, results.get(typeId));
      return;
    }

    inflight.add(typeId);
    queue.push(typeId);
    pump();
  }

  function retry(typeId) {
    results.delete(typeId);
    request(typeId);
  }

  function pump() {
    while (active < concurrency && queue.length > 0) {
      const typeId = queue.shift();
      if (!isStillNeeded(typeId)) {
        inflight.delete(typeId);
        continue;
      }
      active++;
      fetchOne(typeId).finally(() => {
        active--;
        inflight.delete(typeId);
        pump();
      });
    }
  }

  async function fetchOne(typeId) {
    try {
      const knownTotal = totalsMap.get(typeId);
      const res = await getUnitCounts(typeId, knownTotal === undefined);
      const total = knownTotal !== undefined ? knownTotal : res.total;
      if (res.total !== undefined) {
        totalsMap.set(typeId, res.total);
        saveTotalsSoon();
      }
      setCachedAvail(typeId, res.available);
      results.set(typeId, { available: res.available, total });
    } catch (err) {
      console.warn(`Count query failed for type ${typeId}:`, err);
      results.set(typeId, { error: true });
    }
    onResult(typeId, results.get(typeId));
  }

  return { request, retry, get: (typeId) => results.get(typeId) };
}
