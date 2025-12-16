// background.js (MV3 service worker, ES module)

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MUSICBRAINZ_MIN_SCORE = 60;

// GetSongBPM / GetSongKey API
const GETSONG_BASE = "https://api.getsong.co/";
const GETSONG_KEY_STORAGE = "getsongApiKey";

// Simple 1-request-at-a-time queue so we don't hammer MusicBrainz
let queue = Promise.resolve();
let lastMbRequestAt = 0;
const MB_MIN_INTERVAL_MS = 1100;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeWhitespace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function normForMatch(s) {
  return normalizeWhitespace(s)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9#\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s) {
  return new Set(normForMatch(s).split(" ").filter(Boolean));
}

function tokenOverlapScore(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.max(A.size, B.size);
}

// Minimal Lucene escaping for quotes/backslashes.
function luceneEscapePhrase(s) {
  return normalizeWhitespace(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function keyToCamelot(key, mode) {
  const k = normalizeKeyName(key);
  const m = (mode || "").toLowerCase();

  const MAJOR = {
    "C": "8B", "G": "9B", "D": "10B", "A": "11B", "E": "12B",
    "B": "1B", "F#": "2B", "C#": "3B", "G#": "4B", "D#": "5B",
    "A#": "6B", "F": "7B"
  };

  const MINOR = {
    "A": "8A", "E": "9A", "B": "10A", "F#": "11A", "C#": "12A",
    "G#": "1A", "D#": "2A", "A#": "3A", "F": "4A", "C": "5A",
    "G": "6A", "D": "7A"
  };

  if (m === "major") return MAJOR[k] || null;
  if (m === "minor") return MINOR[k] || null;
  return null;
}

function normalizeKeyName(key) {
  let k = normalizeWhitespace(key);

  const flatsToSharps = {
    "DB": "C#",
    "EB": "D#",
    "GB": "F#",
    "AB": "G#",
    "BB": "A#"
  };

  k = k.replace(/♭/g, "b").replace(/♯/g, "#");

  if (/^[A-Ga-g]b$/.test(k)) {
    const up = k.toUpperCase(); // e.g. "BB"
    return flatsToSharps[up] || up[0];
  }
  if (/^[A-Ga-g]#$/.test(k)) return k[0].toUpperCase() + "#";
  if (/^[A-Ga-g]$/.test(k)) return k.toUpperCase();
  return k; // fallback
}

// Parse GetSongBPM key strings like "Em", "F#m", "Bb", "Bbm"
function parseGetsongKeyOf(keyOfRaw) {
  const raw = normalizeWhitespace(keyOfRaw);
  if (!raw) return null;

  const m1 = raw.match(/^([A-Ga-g])([#b♯♭]?)(m)?$/);
  if (m1) {
    const letter = m1[1].toUpperCase();
    const acc = (m1[2] || "").replace("♯", "#").replace("♭", "b");
    const isMinor = !!m1[3];
    const key = normalizeKeyName(letter + acc);
    const scale = isMinor ? "minor" : "major";
    return { key, scale };
  }

  // More verbose cases like "E minor" / "A major"
  const m2 = raw.match(/^([A-Ga-g])([#b♯♭]?)\s*(major|minor)$/i);
  if (m2) {
    const letter = m2[1].toUpperCase();
    const acc = (m2[2] || "").replace("♯", "#").replace("♭", "b");
    const key = normalizeKeyName(letter + acc);
    const scale = m2[3].toLowerCase();
    return { key, scale };
  }

  return null;
}

async function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
async function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function getGetsongApiKey() {
  const r = await storageGet(GETSONG_KEY_STORAGE);
  return (r?.[GETSONG_KEY_STORAGE] || "").trim();
}

async function rateLimitedMusicBrainzFetch(url) {
  const now = Date.now();
  const wait = Math.max(0, MB_MIN_INTERVAL_MS - (now - lastMbRequestAt));
  if (wait) await sleep(wait);
  lastMbRequestAt = Date.now();

  const res = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json" }
  });
  if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
  return res.json();
}

async function searchMusicBrainzRecordings(title, artist) {
  const t = luceneEscapePhrase(title);
  const a = luceneEscapePhrase(artist);

  const queries = [
    `recording:"${t}" AND artist:"${a}"`,
    `recording:"${t}" AND artist:${a}`,
    `recording:"${t}"`
  ];

  for (const q of queries) {
    const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&limit=10&fmt=json`;
    const data = await rateLimitedMusicBrainzFetch(url);

    const recs = Array.isArray(data.recordings) ? data.recordings : [];
    const ranked = recs
      .map(r => ({ mbid: r.id, score: Number(r.score ?? 0) }))
      .filter(x => x.mbid)
      .sort((x, y) => y.score - x.score)
      .filter(x => x.score >= MUSICBRAINZ_MIN_SCORE)
      .slice(0, 6);

    if (ranked.length) return ranked;
  }

  return [];
}

async function fetchAcousticBrainzKeyAnySubmission(mbid) {
  for (let n = 0; n < 3; n++) {
    const url = `https://acousticbrainz.org/api/v1/${mbid}/low-level?n=${n}`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });

    if (res.status === 404) return null;
    if (!res.ok) return null;

    const data = await res.json();
    const tonal = data?.tonal;

    let key = tonal?.key_key ?? tonal?.chords_key ?? null;
    let scale = tonal?.key_scale ?? tonal?.chords_scale ?? null;

    if (key && scale) return { key, scale };
  }
  return null;
}

// Primary: GetSongBPM search
async function lookupViaGetSongBpm({ title, artist }) {
  const apiKey = await getGetsongApiKey();
  if (!apiKey) {
    console.warn("[YTM Camelot] Missing GetSongBPM API key. Open extension options and set it.");
    return null;
  }

  // GetSongBPM docs: /search/ with type=both and lookup="song:... artist:..." :contentReference[oaicite:3]{index=3}
  const lookup = `song:${normalizeWhitespace(title)} artist:${normalizeWhitespace(artist)}`;
  const url = `${GETSONG_BASE}search/?type=both&lookup=${encodeURIComponent(lookup)}&limit=10`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-API-KEY": apiKey
    }
  });

  if (!res.ok) return null;

  const data = await res.json();
  const items = Array.isArray(data?.search) ? data.search : [];
  if (!items.length) return null;

  // Choose best match by simple title+artist token overlap
  const ranked = items
    .map((s) => {
      const tScore = tokenOverlapScore(s.title || "", title);
      const aScore = tokenOverlapScore(s.artist?.name || "", artist);
      const score = (tScore * 0.7) + (aScore * 0.3);
      return { s, score };
    })
    .sort((a, b) => b.score - a.score);

  for (const { s } of ranked.slice(0, 5)) {
    const parsed = parseGetsongKeyOf(s.key_of);
    if (!parsed) continue;

    const camelot = keyToCamelot(parsed.key, parsed.scale);
    return {
      camelot: camelot || null,
      key: parsed.key,
      mode: parsed.scale,
      provider: "getsongbpm",
      providerId: s.id || null
    };
  }

  return null;
}

async function lookupCamelot({ cacheKey, title, artist }) {
  const now = Date.now();

  // Cache check
  const cache = await storageGet(cacheKey);
  const cached = cache?.[cacheKey];
  if (cached && (now - cached.cachedAt) < CACHE_TTL_MS) return cached;

  // 1) Try GetSongBPM first
  const gsb = await lookupViaGetSongBpm({ title, artist });
  if (gsb) {
    const out = { ...gsb, mbid: null, score: null, cachedAt: now };
    await storageSet({ [cacheKey]: out });
    return out;
  }

  // 2) Fallback: MusicBrainz -> AcousticBrainz
  const candidates = await searchMusicBrainzRecordings(title, artist);
  if (!candidates.length) {
    const miss = { camelot: null, key: null, mode: null, mbid: null, score: null, cachedAt: now };
    await storageSet({ [cacheKey]: miss });
    return miss;
  }

  for (const mb of candidates) {
    const ab = await fetchAcousticBrainzKeyAnySubmission(mb.mbid);
    if (!ab) continue;

    const camelot = keyToCamelot(ab.key, ab.scale);
    const out = {
      camelot: camelot || null,
      key: normalizeKeyName(ab.key),
      mode: ab.scale?.toLowerCase() || null,
      mbid: mb.mbid,
      score: mb.score,
      cachedAt: now
    };
    await storageSet({ [cacheKey]: out });
    return out;
  }

  // Miss
  const miss = {
    camelot: null,
    key: null,
    mode: null,
    mbid: candidates[0].mbid,
    score: candidates[0].score,
    cachedAt: now
  };
  await storageSet({ [cacheKey]: miss });
  return miss;
}

// Listen for requests from content.js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const t = msg?.type;
  if (t !== "LOOKUP_CAMELOT" && t !== "LOOKUP_CAMELot") return;

  queue = queue.then(async () => {
    try {
      const title = normalizeWhitespace(msg.title);
      const artist = normalizeWhitespace(msg.artist);
      const cacheKey = msg.cacheKey;

      if (!title || !artist || !cacheKey) {
        sendResponse({ ok: true, data: null });
        return;
      }

      const data = await lookupCamelot({ cacheKey, title, artist });
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  });

  return true;
});
