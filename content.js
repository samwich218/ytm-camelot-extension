// content.js (overlay layer; FIXED newline handling)

(() => {
  console.log("[YTM Camelot] loaded (overlay layer, fixed)");

  const OVERLAY_ID = "ytm-camelot-overlay";
  const BADGE_CLASS = "ytm-camelot-badge";
  const items = new Map(); // cacheKey -> { anchorEl, badgeEl, title, artist }

  function norm(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function isDuration(s) {
    return /^\d{1,2}:\d{2}$/.test(s) || /^\d{1,2}:\d{2}:\d{2}$/.test(s);
  }

  function isMetaLine(s) {
    const l = (s || "").toLowerCase();
    if (!s) return true;
    if (isDuration(s)) return true;
    if (l === "explicit" || l === "e") return true;
    if (l.includes("plays") || l.includes("views")) return true;
    if (/^\d+(\.\d+)?[kmb]\b/.test(l)) return true;
    return false;
  }

  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;

    Object.assign(overlay.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "100vw",
      height: "100vh",
      pointerEvents: "none",
      zIndex: "2147483647", // max-ish
    });

    const style = document.createElement("style");
    style.textContent = `
      #${OVERLAY_ID} .${BADGE_CLASS} {
        position: absolute;
        transform: translate(-100%, -50%);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        line-height: 16px;
        font-weight: 700;
        background: rgba(255,255,255,0.14);
        color: rgba(255,255,255,0.92);
        border: 1px solid rgba(255,255,255,0.18);
        white-space: nowrap;
      }
      #${OVERLAY_ID} .${BADGE_CLASS}[data-state="loading"] { opacity: 0.75; }
      #${OVERLAY_ID} .${BADGE_CLASS}[data-state="missing"] { opacity: 0.55; }
      #${OVERLAY_ID} .${BADGE_CLASS}[data-state="error"] { opacity: 0.9; }
    `;
    overlay.appendChild(style);

    document.documentElement.appendChild(overlay);
    return overlay;
  }

  // IMPORTANT: do NOT norm() before splitting on \n
  function parseRowText(el) {
    const raw = el.innerText || "";
    if (!raw) return null;

    const lines = raw
      .split("\n")
      .map(norm)
      .filter(Boolean);

    const clean = lines.filter((l) => !isMetaLine(l));
    if (clean.length < 2) return null;

    const title = clean[0];

    // Usually artist is clean[1]; handle "Artist • Album" too
    let artist = "";
    for (const cand of clean.slice(1, 4)) {
      const a = norm(cand.split("•")[0]);
      if (a && a !== title && !isMetaLine(a)) {
        artist = a;
        break;
      }
    }

    if (!title || !artist) return null;
    return { title, artist };
  }

  function requestCamelot({ cacheKey, title, artist }) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "LOOKUP_CAMELot", cacheKey, title, artist },
        (resp) => resolve(resp)
      );
    });
  }

  function makeBadge(overlay) {
    const badge = document.createElement("div");
    badge.className = BADGE_CLASS;
    badge.textContent = "…";
    badge.dataset.state = "loading";
    overlay.appendChild(badge);
    return badge;
  }

  function cacheKeyFor(title, artist) {
    return `ta:${title.toLowerCase()}|${artist.toLowerCase()}`;
  }

  async function ensureItemForAnchor(anchorEl, overlay) {
    const parsed = parseRowText(anchorEl);
    if (!parsed) return;

    const { title, artist } = parsed;
    const cacheKey = cacheKeyFor(title, artist);

    if (!items.has(cacheKey)) {
      const badgeEl = makeBadge(overlay);
      badgeEl.title = `Looking up: ${title} — ${artist}`;
      items.set(cacheKey, { anchorEl, badgeEl, title, artist, cacheKey });

      const resp = await requestCamelot({ cacheKey, title, artist });

      const item = items.get(cacheKey);
      if (!item) return;

      if (!resp || resp.ok === false) {
        item.badgeEl.textContent = "!";
        item.badgeEl.dataset.state = "error";
        item.badgeEl.title = `Lookup error: ${resp?.error || "unknown"}`;
        return;
      }

      const data = resp.data;
      if (!data || !data.camelot) {
        item.badgeEl.textContent = "—";
        item.badgeEl.dataset.state = "missing";
        item.badgeEl.title = "No key found (no MusicBrainz match / no AcousticBrainz data)";
        return;
      }

      item.badgeEl.textContent = data.camelot;
      item.badgeEl.dataset.state = "done";
      item.badgeEl.title = `${data.key} ${data.mode} (Camelot ${data.camelot}) • MB score ${data.score ?? "?"}`;
    } else {
      // Update anchor reference as DOM changes
      const it = items.get(cacheKey);
      if (it) it.anchorEl = anchorEl;
    }
  }

  function positionBadges() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    for (const [, item] of items) {
      const el = item.anchorEl;
      const badge = item.badgeEl;

      if (!el || !badge || !el.isConnected) {
        badge?.remove();
        items.delete(item.cacheKey);
        continue;
      }

      const r = el.getBoundingClientRect();
      if (r.height < 16 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {
        badge.style.display = "none";
        continue;
      }

      badge.style.display = "inline-flex";
      const offset = Math.max(120, Math.min(220, Math.floor(r.width * 0.28))); // tune if you want
      const x = Math.min(vw - 8, r.right - offset);
      const y = r.top + r.height / 2;
      badge.style.left = `${x}px`;
      badge.style.top = `${y}px`;
    }
  }

  function debounce(fn, ms) {
    let t = null;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  const scan = debounce(async () => {
    const overlay = ensureOverlay();

    const candidates = [
      ...document.querySelectorAll("ytmusic-responsive-list-item-renderer"),
      ...document.querySelectorAll("ytmusic-playlist-panel-video-renderer"),
      ...document.querySelectorAll("ytmusic-two-row-item-renderer"),
    ].slice(0, 250);

    for (const el of candidates) {
      const raw = el.innerText || "";
      if (!raw.includes("\n")) continue; // now this works
      ensureItemForAnchor(el, overlay);
    }

    positionBadges();
  }, 250);

  scan();
  new MutationObserver(scan).observe(document.documentElement, { subtree: true, childList: true });
  window.addEventListener("scroll", positionBadges, { passive: true });
  window.addEventListener("resize", positionBadges, { passive: true });
  setInterval(() => { scan(); positionBadges(); }, 2500);
})();
