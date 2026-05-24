// Instagram Unfollowers — Improved & Fast Edition
// Paste into browser console on instagram.com
// ─────────────────────────────────────────────────────────────

(() => {
  "use strict";

  // ── Constants ──────────────────────────────────────────────
  const HOST = "www.instagram.com";
  const WHITELIST_KEY = "iu_whitelist_v2";
  const TIMINGS_KEY      = "iu_timings_v2";
  const DAILY_KEY        = "iu_daily_v2";

  const DEFAULT_TIMINGS = {
    betweenFetches:      800,   // ms between each page fetch
    cooldownEvery:       6,     // pages before cooldown
    cooldownDuration:    8000,  // ms cooldown
    betweenUnfollows:    3500,  // ms between unfollow POSTs
    unfollowBatch:       5,     // unfollow N then pause
    unfollowBatchPause:  60000, // ms pause after each batch
  };

  // ── Guards ─────────────────────────────────────────────────
  if (location.hostname !== HOST) {
    alert("Run this on instagram.com");
    return;
  }

  // ── Helpers ────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const jitter = (base, pct = 0.3) =>
    base + (Math.random() * 2 - 1) * base * pct;

  function getCookie(name) {
    const parts = `; ${document.cookie}`.split(`; ${name}=`);
    return parts.length === 2 ? parts.pop().split(";").shift() : null;
  }

  function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }
  const saveJSON = (key, val) =>
    localStorage.setItem(key, JSON.stringify(val));

  // ── Daily limit tracking ───────────────────────────────────
  function todayKey() { return new Date().toISOString().slice(0, 10); }

  function getDailyCount() {
    const rec = loadJSON(DAILY_KEY, {});
    return rec.date === todayKey() ? (rec.count || 0) : 0;
  }

  function incrementDailyCount() {
    const count = getDailyCount() + 1;
    saveJSON(DAILY_KEY, { date: todayKey(), count });
    return count;
  }

  const DAILY_LIMIT = 150; // safe ceiling for established accounts

  // ── Previously unfollowed memory ───────────────────────────
  const DONE_KEY = "iu_done_v2";
  function loadDone() { return new Set(loadJSON(DONE_KEY, [])); }
  function saveDone(set) { saveJSON(DONE_KEY, [...set]); }

  // ── API ────────────────────────────────────────────────────────
  // Modern Instagram API (replaces deprecated graphql/query endpoint)
  async function fetchFollowingPage(userId, cursor = null) {
    const params = new URLSearchParams({
      count: "200",
      ...(cursor ? { max_id: cursor } : {}),
    });
    const url = `https://www.instagram.com/api/v1/friendships/${userId}/following/?${params}`;
    const res = await fetch(url, {
      headers: {
        "x-ig-app-id": "936619743392459",
        "x-requested-with": "XMLHttpRequest",
      },
      credentials: "include",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json(); // { users: [...], next_max_id?, big_list }
  }

  async function fetchFollowersPage(userId, cursor = null) {
    const params = new URLSearchParams({
      count: "200",
      ...(cursor ? { max_id: cursor } : {}),
    });
    const url = `https://www.instagram.com/api/v1/friendships/${userId}/followers/?${params}`;
    const res = await fetch(url, {
      headers: {
        "x-ig-app-id": "936619743392459",
        "x-requested-with": "XMLHttpRequest",
      },
      credentials: "include",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchCurrentUser() {
    // Method 1: read from Instagram's __additionalData / config injected into the page
    try {
      const scripts = [...document.querySelectorAll("script[type='application/json']")];
      for (const s of scripts) {
        try {
          const json = JSON.parse(s.textContent);
          // Various paths Instagram has used over the years
          const user =
            json?.config?.viewer ||
            json?.data?.user ||
            json?.user;
          if (user?.pk || user?.id) {
            return { pk: String(user.pk || user.id), username: user.username, full_name: user.full_name };
          }
        } catch {}
      }
    } catch {}

    // Method 2: window.__initialData or window._sharedData (older IG)
    try {
      const shared = window._sharedData?.config?.viewer;
      if (shared?.id) return { pk: String(shared.id), username: shared.username };
    } catch {}

    // Method 3: grab userId from the ds_user_id cookie (always present when logged in)
    const cookieId = getCookie("ds_user_id");
    if (cookieId) {
      // We have the ID but not the username — fetch profile info with a lighter endpoint
      try {
        const res = await fetch(`https://www.instagram.com/api/v1/users/${cookieId}/info/`, {
          headers: { "x-ig-app-id": "936619743392459", "x-requested-with": "XMLHttpRequest" },
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          const u = data.user;
          return { pk: String(u.pk), username: u.username, full_name: u.full_name,
                   following_count: u.following_count };
        }
      } catch {}
      // Even if that fails, return just the ID — enough to scan following list
      return { pk: cookieId, username: "(you)", full_name: "" };
    }

    throw new Error("Could not detect your user ID. Make sure you are logged in to Instagram.");
  }

  async function unfollowUser(userId) {
    const csrf = getCookie("csrftoken");
    const res = await fetch(
      `https://www.instagram.com/api/v1/friendships/destroy/${userId}/`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-csrftoken": csrf,
          "x-ig-app-id": "936619743392459",
        },
        credentials: "include",
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ── Scan all following ──────────────────────────────────────
  async function scanAllFollowing(userId, timings, onProgress, isPaused) {
    const users = [];
    let cursor = null;
    let page = 0;

    while (true) {
      while (await isPaused()) await sleep(500);

      let data;
      let retries = 0;
      while (true) {
        try {
          data = await fetchFollowingPage(userId, cursor);
          break;
        } catch (err) {
          retries++;
          if (retries > 4) throw new Error(`Scan failed after ${retries} retries: ${err.message}`);
          const wait = jitter(2000 * Math.pow(2, retries)); // 4s, 8s, 16s, 32s with jitter
          console.warn(`Fetch error (attempt ${retries}), retrying in ${Math.round(wait/1000)}s:`, err);
          await sleep(wait);
        }
      }

      users.push(...(data.users ?? []));
      page++;
      onProgress(users, cursor, !!data.next_max_id);

      if (!data.next_max_id) break;
      cursor = data.next_max_id;

      // Cooldown every N pages
      if (page % timings.cooldownEvery === 0) {
        await sleep(jitter(timings.cooldownDuration));
      } else {
        await sleep(jitter(timings.betweenFetches));
      }
    }

    return users;
  }

  // ── UI ─────────────────────────────────────────────────────
  const CSS = `
    #iu-root * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #iu-root { position: fixed; inset: 0; z-index: 99999; background: #0a0a0a; color: #e0e0e0;
               display: flex; flex-direction: column; overflow: hidden; }
    #iu-header { display: flex; align-items: center; gap: 12px; padding: 12px 16px;
                 background: #111; border-bottom: 1px solid #222; flex-shrink: 0; }
    #iu-header h1 { font-size: 15px; font-weight: 600; margin: 0; color: #fff; letter-spacing: .02em; }
    #iu-header h1 span { color: #00e5ff; }
    .iu-pill { background: #1e1e1e; border: 1px solid #333; border-radius: 20px;
               padding: 4px 12px; font-size: 12px; color: #aaa; }
    .iu-pill b { color: #fff; }
    #iu-body { display: flex; flex: 1; overflow: hidden; }
    #iu-sidebar { width: 220px; flex-shrink: 0; background: #0d0d0d; border-right: 1px solid #1e1e1e;
                  display: flex; flex-direction: column; padding: 12px; gap: 8px; overflow-y: auto; }
    #iu-sidebar h3 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em;
                     color: #555; margin: 8px 0 4px; }
    .iu-stat { font-size: 13px; color: #aaa; }
    .iu-stat b { color: #fff; }
    .iu-filters { display: flex; flex-direction: column; gap: 5px; }
    .iu-filters label { display: flex; align-items: center; gap: 7px; font-size: 13px;
                        cursor: pointer; color: #ccc; user-select: none; }
    .iu-filters input[type=checkbox] { width: 14px; height: 14px; accent-color: #00e5ff; }
    #iu-search { width: 100%; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px;
                 color: #fff; padding: 7px 10px; font-size: 13px; outline: none; }
    #iu-search:focus { border-color: #00e5ff44; }
    .iu-btn { display: flex; align-items: center; justify-content: center; gap: 5px;
              border: 1px solid #333; border-radius: 8px; background: #1a1a1a; color: #ccc;
              font-size: 12px; cursor: pointer; padding: 7px 10px; transition: all .15s;
              white-space: nowrap; }
    .iu-btn:hover { background: #242424; color: #fff; border-color: #444; }
    .iu-btn:disabled { opacity: .4; cursor: not-allowed; }
    .iu-btn.danger { border-color: #ff3b3044; color: #ff6b6b; }
    .iu-btn.danger:hover { background: #ff3b3018; color: #ff4d4d; border-color: #ff3b3088; }
    .iu-btn.primary { border-color: #00e5ff44; color: #00e5ff; }
    .iu-btn.primary:hover { background: #00e5ff11; }
    .iu-btn.action { border-color: #00e5ff; background: #00e5ff; color: #000;
                     font-weight: 600; font-size: 13px; }
    .iu-btn.action:hover { background: #00cfee; }
    .iu-btn-row { display: flex; gap: 5px; flex-wrap: wrap; }
    #iu-unfollow-btn { width: 100%; padding: 10px; font-size: 14px; margin-top: auto;
                       border-radius: 10px; background: #c0392b; border-color: #c0392b; color: #fff;
                       font-weight: 700; }
    #iu-unfollow-btn:hover:not(:disabled) { background: #e74c3c; border-color: #e74c3c; }
    #iu-progress-bar { height: 3px; background: #1e1e1e; flex-shrink: 0; }
    #iu-progress-inner { height: 100%; background: #00e5ff; width: 0%; transition: width .3s; }
    #iu-list { flex: 1; overflow-y: auto; padding: 6px; }
    #iu-list::-webkit-scrollbar { width: 5px; }
    #iu-list::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
    .iu-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
               border-radius: 8px; cursor: pointer; transition: background .12s; }
    .iu-item:hover { background: #1a1a1a; }
    .iu-item.selected { background: #00e5ff0d; }
    .iu-avatar { width: 42px; height: 42px; border-radius: 50%; object-fit: cover;
                 flex-shrink: 0; background: #222; }
    .iu-info { flex: 1; min-width: 0; }
    .iu-username { font-size: 13px; font-weight: 600; color: #fff;
                   white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .iu-fullname { font-size: 12px; color: #777;
                   white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .iu-badges { display: flex; gap: 4px; flex-shrink: 0; }
    .iu-badge { font-size: 10px; padding: 2px 6px; border-radius: 12px; font-weight: 600; }
    .iu-badge.verified { background: #1d6fa4; color: #b3dfff; }
    .iu-badge.private  { background: #2d5a1a; color: #a3e07a; }
    .iu-badge.follows  { background: #3a2d00; color: #ffd060; }
    .iu-check { width: 18px; height: 18px; accent-color: #00e5ff; flex-shrink: 0; }
    .iu-alpha { font-size: 11px; font-weight: 700; color: #444; text-transform: uppercase;
                padding: 10px 10px 4px; letter-spacing: .06em; }
    #iu-status { padding: 8px 16px; font-size: 12px; color: #666;
                 background: #0d0d0d; border-top: 1px solid #1a1a1a; flex-shrink: 0; }
    #iu-status b { color: #00e5ff; }
    .iu-center { display: flex; flex-direction: column; align-items: center;
                 justify-content: center; flex: 1; gap: 16px; }
    #iu-start-btn { font-size: 18px; font-weight: 700; padding: 20px 40px;
                    border-radius: 50px; border: 2px solid #00e5ff;
                    background: transparent; color: #00e5ff; cursor: pointer;
                    letter-spacing: .05em; transition: all .2s; }
    #iu-start-btn:hover { background: #00e5ff; color: #000; }
    .iu-hint { font-size: 13px; color: #444; text-align: center; max-width: 280px; }
    .iu-unfollow-log { flex: 1; overflow-y: auto; padding: 12px 16px; font-size: 13px; }
    .iu-log-entry { padding: 5px 0; border-bottom: 1px solid #1a1a1a; color: #aaa; }
    .iu-log-entry.ok  { color: #4ade80; }
    .iu-log-entry.err { color: #f87171; }
    #iu-pagination { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
                     font-size: 13px; color: #666; border-top: 1px solid #1e1e1e; flex-shrink: 0; }
    #iu-pagination b { color: #fff; }
    .iu-overlay { position: absolute; inset: 0; background: #0a0a0a88;
                  display: flex; align-items: center; justify-content: center; z-index: 10; }
    .iu-modal { background: #111; border: 1px solid #2a2a2a; border-radius: 14px;
                padding: 24px; max-width: 420px; width: 90%; }
    .iu-modal h2 { font-size: 16px; margin: 0 0 12px; color: #fff; }
    .iu-modal p  { font-size: 13px; color: #888; line-height: 1.6; margin: 0 0 16px; }
    .iu-toast { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
                background: #1a1a1a; border: 1px solid #333; border-radius: 10px;
                padding: 10px 18px; font-size: 13px; color: #ccc; white-space: nowrap;
                animation: iu-fadein .3s ease; z-index: 20; }
    @keyframes iu-fadein { from { opacity:0; transform: translateX(-50%) translateY(8px) } }
  `;

  // ── State ──────────────────────────────────────────────────
  const state = {
    phase: "idle",       // idle | scanning | done | unfollowing
    currentUser: null,
    following: [],
    followers: new Set(),  // PKs of people who follow you back
    filtered: [],
    selected: new Set(),
    whitelist: new Set(loadJSON(WHITELIST_KEY, [])),
    timings: { ...DEFAULT_TIMINGS, ...loadJSON(TIMINGS_KEY, {}) },
    paused: false,
    progress: 0,
    page: 1,
    filter: {
      search: "",
      showFollowers: false,
      showNonFollowers: true,
      showVerified: true,
      showPrivate: true,
    },
    unfollowLog: [],
  };

  const PER_DISPLAY = 60;

  function saveWhitelist() {
    saveJSON(WHITELIST_KEY, [...state.whitelist]);
  }

  // ── Build UI ────────────────────────────────────────────────
  document.title = "Instagram Unfollowers";
  document.body.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "iu-root";
  document.body.appendChild(root);

  root.innerHTML = `
    <div id="iu-header">
      <h1>Instagram <span>Unfollowers</span></h1>
      <div style="flex:1"></div>
      <div class="iu-pill" id="iu-count-pill">Ready</div>
    </div>
    <div id="iu-progress-bar"><div id="iu-progress-inner"></div></div>
    <div id="iu-body">
      <div id="iu-content" style="flex:1;display:flex;overflow:hidden;position:relative;"></div>
    </div>
    <div id="iu-status">Waiting to start…</div>
  `;

  const body        = root.querySelector("#iu-body");
  const content     = root.querySelector("#iu-content");
  const progressBar = root.querySelector("#iu-progress-inner");
  const countPill   = root.querySelector("#iu-count-pill");
  const statusEl    = root.querySelector("#iu-status");

  function setStatus(msg) { statusEl.innerHTML = msg; }
  function setProgress(pct) { progressBar.style.width = pct + "%"; }

  function toast(msg, duration = 2500) {
    const el = document.createElement("div");
    el.className = "iu-toast";
    el.textContent = msg;
    content.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  // ── Phase: Idle ────────────────────────────────────────────
  function renderIdle() {
    content.innerHTML = `
      <div class="iu-center">
        <button id="iu-start-btn">▶ SCAN</button>
        <p class="iu-hint">Scans everyone you follow and shows who doesn't follow back.</p>
      </div>
    `;
    content.querySelector("#iu-start-btn").onclick = startScan;
  }

  // ── Phase: Scanning ────────────────────────────────────────
  let sidebar, listEl, paginationEl;

  function renderScanning() {
    content.innerHTML = `
      <div id="iu-sidebar">
        <h3>Filters</h3>
        <div class="iu-filters">
          <label><input type="checkbox" id="f-nonfollowers" checked> Non-followers</label>
          <label><input type="checkbox" id="f-followers"> Followers too</label>
          <label><input type="checkbox" id="f-verified" checked> Verified</label>
          <label><input type="checkbox" id="f-private" checked> Private</label>
        </div>
        <h3>Search</h3>
        <input id="iu-search" placeholder="Search username…" type="text">
        <h3>Select</h3>
        <div class="iu-btn-row">
          <button class="iu-btn" id="btn-all">All</button>
          <button class="iu-btn" id="btn-page">Page</button>
          <button class="iu-btn danger" id="btn-none">Clear</button>
        </div>
        <div style="display:flex;gap:5px;align-items:center;margin-top:4px;">
          <input id="btn-first-n-input" type="number" min="1" value="200"
            style="width:64px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;
                   color:#fff;padding:6px 8px;font-size:13px;outline:none;">
          <button class="iu-btn primary" id="btn-first-n" style="flex:1">Select first N</button>
        </div>
        <h3>Whitelist</h3>
        <div class="iu-btn-row">
          <button class="iu-btn primary" id="btn-wl-add">+ Add selected</button>
          <button class="iu-btn danger"  id="btn-wl-rem">− Remove selected</button>
        </div>
        <div style="flex:1"></div>
        <h3>Stats</h3>
        <div class="iu-stat">Following: <b id="st-total">—</b></div>
        <div class="iu-stat">Non-followers: <b id="st-nf">—</b></div>
        <div class="iu-stat">Whitelisted: <b id="st-wl">${state.whitelist.size}</b></div>
        <div class="iu-stat">Selected: <b id="st-sel">0</b></div>
        <div class="iu-stat">Today's unfollows: <b id="st-daily">0</b> / 150</div>
        <div style="margin-top:8px;display:flex;gap:6px;">
          <button class="iu-btn" id="btn-pause" style="flex:1">⏸ Pause</button>
          <button class="iu-btn primary" id="btn-export" style="flex:1">↓ CSV</button>
        </div>
        <button class="iu-btn danger" id="iu-unfollow-btn" disabled>UNFOLLOW (0)</button>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
        <div id="iu-list"></div>
        <div id="iu-pagination">
          <button class="iu-btn" id="pg-prev">‹</button>
          <span>Page <b id="pg-cur">1</b> / <b id="pg-max">1</b></span>
          <button class="iu-btn" id="pg-next">›</button>
        </div>
      </div>
    `;

    sidebar     = content.querySelector("#iu-sidebar");
    listEl      = content.querySelector("#iu-list");
    paginationEl = content.querySelector("#iu-pagination");

    // Filter listeners
    ["f-nonfollowers","f-followers","f-verified","f-private"].forEach(id => {
      content.querySelector("#" + id).onchange = e => {
        const map = { "f-nonfollowers": "showNonFollowers", "f-followers": "showFollowers",
                      "f-verified": "showVerified", "f-private": "showPrivate" };
        state.filter[map[id]] = e.target.checked;
        state.page = 1;
        applyFilter();
      };
    });

    content.querySelector("#iu-search").oninput = e => {
      state.filter.search = e.target.value;
      state.page = 1;
      applyFilter();
    };

    content.querySelector("#btn-all").onclick = () => {
      state.filtered.forEach(u => state.selected.add(u.pk));
      updateSidebarStats(); renderList();
    };
    content.querySelector("#btn-page").onclick = () => {
      getPage().forEach(u => state.selected.add(u.pk));
      updateSidebarStats(); renderList();
    };
    content.querySelector("#btn-none").onclick = () => {
      state.selected.clear();
      updateSidebarStats(); renderList();
    };

    content.querySelector("#btn-first-n").onclick = () => {
      const n = parseInt(content.querySelector("#btn-first-n-input").value, 10);
      if (!n || n < 1) return;
      const sorted = [...state.filtered].sort((a,b) => a.username.localeCompare(b.username));
      sorted.slice(0, n).forEach(u => state.selected.add(u.pk));
      updateSidebarStats(); renderList();
      toast(`Selected first ${Math.min(n, sorted.length)} users`);
    };

    content.querySelector("#btn-wl-add").onclick = () => {
      state.selected.forEach(id => state.whitelist.add(id));
      saveWhitelist(); applyFilter();
      toast(`${state.selected.size} user(s) whitelisted`);
    };
    content.querySelector("#btn-wl-rem").onclick = () => {
      state.selected.forEach(id => state.whitelist.delete(id));
      saveWhitelist(); applyFilter();
      toast("Removed from whitelist");
    };

    content.querySelector("#btn-pause").onclick = togglePause;

    content.querySelector("#btn-export").onclick = exportCSV;

    content.querySelector("#iu-unfollow-btn").onclick = () => {
      if (state.selected.size === 0) return;
      if (!confirm(`Unfollow ${state.selected.size} user(s)? This cannot be undone.`)) return;
      startUnfollow();
    };

    content.querySelector("#pg-prev").onclick = () => {
      if (state.page > 1) { state.page--; renderList(); }
    };
    content.querySelector("#pg-next").onclick = () => {
      const max = Math.ceil(state.filtered.length / PER_DISPLAY);
      if (state.page < max) { state.page++; renderList(); }
    };
  }

  function applyFilter() {
    const { search, showFollowers, showNonFollowers, showVerified, showPrivate } = state.filter;
    const q = search.toLowerCase();
    state.filtered = state.following.filter(u => {
      if (state.whitelist.has(u.pk)) return false;
      const followsBack = state.followers.has(u.pk);
      if (!showFollowers && followsBack) return false;       // hide mutual follows by default
      if (!showNonFollowers && !followsBack) return false;
      if (!showVerified && u.is_verified) return false;
      if (!showPrivate && u.is_private) return false;
      if (q && !u.username.includes(q) && !(u.full_name || "").toLowerCase().includes(q)) return false;
      return true;
    });
    renderList();
    updateSidebarStats();
  }

  function getPage() {
    const sorted = [...state.filtered].sort((a,b) => a.username.localeCompare(b.username));
    return sorted.slice((state.page - 1) * PER_DISPLAY, state.page * PER_DISPLAY);
  }

  function renderList() {
    if (!listEl) return;
    const sorted = [...state.filtered].sort((a,b) => a.username.localeCompare(b.username));
    const total  = sorted.length;
    const maxPage = Math.max(1, Math.ceil(total / PER_DISPLAY));
    if (state.page > maxPage) state.page = maxPage;
    const page = sorted.slice((state.page - 1) * PER_DISPLAY, state.page * PER_DISPLAY);

    content.querySelector("#pg-cur").textContent = state.page;
    content.querySelector("#pg-max").textContent = maxPage;

    let html = "";
    let lastLetter = "";
    page.forEach(u => {
      const letter = (u.username[0] || "#").toUpperCase();
      if (letter !== lastLetter) {
        html += `<div class="iu-alpha">${letter}</div>`;
        lastLetter = letter;
      }
      const sel = state.selected.has(u.pk) ? "selected" : "";
      const vBadge = u.is_verified ? `<span class="iu-badge verified">✓ Verified</span>` : "";
      const pBadge = u.is_private  ? `<span class="iu-badge private">🔒 Private</span>` : "";
      const followsBack = state.followers.has(u.pk);
      const fBadge = followsBack ? `<span class="iu-badge follows">Follows you</span>` : "";
      html += `
        <div class="iu-item ${sel}" data-pk="${u.pk}">
          <img class="iu-avatar" src="${u.profile_pic_url}" alt="" loading="lazy">
          <div class="iu-info">
            <div class="iu-username">${u.username}</div>
            <div class="iu-fullname">${u.full_name || ""}</div>
          </div>
          <div class="iu-badges">${vBadge}${pBadge}${fBadge}</div>
          <input class="iu-check" type="checkbox" ${state.selected.has(u.pk) ? "checked" : ""}>
        </div>`;
    });

    listEl.innerHTML = html || `<div style="padding:24px;color:#555;text-align:center;">No users match filters.</div>`;

    listEl.querySelectorAll(".iu-item").forEach(el => {
      const pk = el.dataset.pk;
      el.onclick = (e) => {
        if (e.target.type === "checkbox") return;
        toggleSelect(pk, el);
      };
      el.querySelector(".iu-check").onchange = (e) => {
        toggleSelect(pk, el, e.target.checked);
      };
    });
  }

  function toggleSelect(pk, el, force) {
    const checked = force !== undefined ? force : !state.selected.has(pk);
    if (checked) state.selected.add(pk); else state.selected.delete(pk);
    el.classList.toggle("selected", checked);
    el.querySelector(".iu-check").checked = checked;
    updateSidebarStats();
  }

  function updateSidebarStats() {
    const nf = state.following.filter(u => !state.followers.has(u.pk)).length;
    const st = content.querySelector("#st-total");
    const sn = content.querySelector("#st-nf");
    const sw = content.querySelector("#st-wl");
    const ss = content.querySelector("#st-sel");
    const ub = content.querySelector("#iu-unfollow-btn");
    if (st) st.textContent = state.following.length;
    if (sn) sn.textContent = nf;
    if (sw) sw.textContent = state.whitelist.size;
    if (ss) ss.textContent = state.selected.size;
    if (ub) {
      ub.textContent = `UNFOLLOW (${state.selected.size})`;
      ub.disabled = state.selected.size === 0;
    }
    const sd = content.querySelector("#st-daily");
    if (sd) sd.textContent = getDailyCount();
    const cp = root.querySelector("#iu-count-pill");
    if (cp) cp.innerHTML = `Following: <b>${state.following.length}</b>`;
  }

  // ── Scan logic ─────────────────────────────────────────────
  async function startScan() {
    state.phase = "scanning";
    renderScanning();
    setStatus("Fetching your profile…");

    try {
      state.currentUser = await fetchCurrentUser();
    } catch (e) {
      setStatus(`❌ Error: ${e.message}. Are you logged in?`);
      return;
    }

    setStatus(`Scanning <b>${state.currentUser.username}</b>'s following list…`);

    // ── Step 1: fetch followers (who follows YOU) ──────────────
    setStatus("Fetching your <b>followers</b> list to detect mutuals…");
    try {
      let fCursor = null;
      let fPage = 0;
      while (true) {
        const data = await fetchFollowersPage(state.currentUser.pk, fCursor);
        (data.users || []).forEach(u => state.followers.add(String(u.pk)));
        if (!data.next_max_id) break;
        fCursor = data.next_max_id;
        fPage++;
        setStatus(`Fetched <b>${state.followers.size}</b> followers…`);
        await sleep(jitter(800));
      }
    } catch (e) {
      setStatus(`⚠️ Could not fetch followers (${e.message}). Mutual detection disabled.`);
      await sleep(2000);
    }

    // ── Step 2: fetch following (who YOU follow) ───────────────
    setStatus(`Now scanning who <b>${state.currentUser.username}</b> follows…`);

    let totalEstimate = 0;

    await scanAllFollowing(
      state.currentUser.pk,
      state.timings,
      (users, cursor, hasMore) => {
        state.following = users;
        if (!totalEstimate && state.currentUser?.following_count) {
          totalEstimate = state.currentUser.following_count;
        }
        const pct = totalEstimate > 0 ? Math.min(99, Math.round(users.length / totalEstimate * 100)) : 0;
        setProgress(pct);
        setStatus(`Scanned <b>${users.length}</b> accounts${hasMore ? "…" : " — done!"}`);
        applyFilter();
      },
      () => Promise.resolve(state.paused)
    );

    setProgress(100);
    state.phase = "done";
    setStatus(`✅ Done! Found <b>${state.following.length}</b> accounts you follow. Select users to unfollow.`);
    applyFilter();
  }

  function togglePause() {
    state.paused = !state.paused;
    const btn = content.querySelector("#btn-pause");
    if (btn) btn.textContent = state.paused ? "▶ Resume" : "⏸ Pause";
    setStatus(state.paused ? "⏸ Paused" : "▶ Resumed scanning…");
  }

  // ── Unfollow logic ─────────────────────────────────────────
  async function startUnfollow() {
    state.phase = "unfollowing";
    const targets = state.following.filter(u => state.selected.has(u.pk));

    content.innerHTML = `
      <div id="iu-sidebar">
        <h3>Progress</h3>
        <div class="iu-stat">Total: <b>${targets.length}</b></div>
        <div class="iu-stat">Done: <b id="uf-done">0</b></div>
        <div class="iu-stat">Failed: <b id="uf-fail">0</b></div>
        <div style="flex:1"></div>
        <button class="iu-btn" id="btn-back" style="margin-top:auto">← Back</button>
      </div>
      <div class="iu-unfollow-log" id="uf-log"></div>
    `;

    content.querySelector("#btn-back").onclick = () => {
      if (confirm("Stop unfollowing and go back?")) {
        state.phase = "done";
        renderScanning();
        applyFilter();
      }
    };

    const log = content.querySelector("#uf-log");
    const doneSet = loadDone();
    let done = 0, failed = 0, consecutiveFails = 0;

    for (let i = 0; i < targets.length; i++) {
      const u = targets[i];

      // ── Daily limit check ──────────────────────────────────
      const todayCount = getDailyCount();
      if (todayCount >= DAILY_LIMIT) {
        setStatus(`🛑 Daily limit of <b>${DAILY_LIMIT}</b> unfollows reached. Come back tomorrow!`);
        const entry = document.createElement("div");
        entry.className = "iu-log-entry";
        entry.style.color = "#f59e0b";
        entry.textContent = `⏹ Stopped — daily limit of ${DAILY_LIMIT} reached. Resume tomorrow.`;
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
        break;
      }

      setProgress(Math.round((i / targets.length) * 100));
      setStatus(`Unfollowing <b>${u.username}</b> (${i + 1}/${targets.length}) — today: ${todayCount + 1}/${DAILY_LIMIT}…`);

      const entry = document.createElement("div");
      entry.className = "iu-log-entry";
      entry.textContent = `[${i + 1}/${targets.length}] ${u.username}… `;
      log.appendChild(entry);
      log.scrollTop = log.scrollHeight;

      try {
        await unfollowUser(u.pk);
        entry.textContent += "✓ unfollowed";
        entry.classList.add("ok");
        state.selected.delete(u.pk);
        doneSet.add(u.pk);
        saveDone(doneSet);
        incrementDailyCount();
        done++;
        consecutiveFails = 0;
        content.querySelector("#uf-done").textContent = done;
      } catch (err) {
        const status = err.message.includes("429") ? "rate-limited" : err.message;
        entry.textContent += `✗ failed (${status})`;
        entry.classList.add("err");
        failed++;
        consecutiveFails++;
        content.querySelector("#uf-fail").textContent = failed;

        // ── Auto-stop on rate limit or 2 consecutive failures ──
        if (err.message.includes("429") || consecutiveFails >= 2) {
          setStatus(`🚫 Rate limit hit — stopping to protect your account. Try again in 24h.`);
          const warn = document.createElement("div");
          warn.className = "iu-log-entry";
          warn.style.color = "#f87171";
          warn.textContent = `⛔ Auto-stopped: Instagram is rate-limiting. Wait 24h before continuing.`;
          log.appendChild(warn);
          log.scrollTop = log.scrollHeight;
          break;
        }
      }

      if (i < targets.length - 1) {
        // Batch pause every N unfollows
        if ((i + 1) % state.timings.unfollowBatch === 0) {
          const pause = jitter(state.timings.unfollowBatchPause, 0.1);
          const mins = (pause / 60000).toFixed(1);
          setStatus(`⏳ Cooling down ~${mins} min after ${state.timings.unfollowBatch} unfollows…`);
          await sleep(pause);
        } else {
          await sleep(jitter(state.timings.betweenUnfollows));
        }
      }
    }

    setProgress(100);
    setStatus(`✅ Session complete: <b>${done}</b> unfollowed, <b>${failed}</b> failed. Today's total: <b>${getDailyCount()}</b>/${DAILY_LIMIT}.`);
  }

  // ── Export ─────────────────────────────────────────────────
  function exportCSV() {
    const rows = [["username", "full_name", "is_verified", "is_private", "follows_you", "profile_url"]];
    state.filtered.forEach(u => {
      rows.push([
        u.username,
        `"${(u.full_name || "").replace(/"/g, '""')}"`,
        u.is_verified,
        u.is_private,
        state.followers.has(u.pk),
        `https://instagram.com/${u.username}`,
      ]);
    });
    const csv = rows.map(r => r.join(",")).join("\n");
    const a = Object.assign(document.createElement("a"), {
      href: "data:text/csv;charset=utf-8," + encodeURIComponent(csv),
      download: `instagram_unfollowers_${new Date().toISOString().slice(0,10)}.csv`,
    });
    a.click();
    toast("CSV exported!");
  }

  // ── Start ──────────────────────────────────────────────────
  renderIdle();

})();
