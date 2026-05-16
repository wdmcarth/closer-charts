// Closer Charts — app.js
// State model:
//   state.chart      = parsed chart.json (mutated as the user edits)
//   state.quickhits  = parsed quickhits.json
//   state.rosters    = rosters.json (read-only)
//   state.stats      = stats.json (read-only; null if not yet refreshed)

// Backend URL: CC_BACKEND_URL from config.js, or same-origin if empty. Local
// dev → server.py (same origin); production → Cloudflare Worker URL.
const API = (window.CC_BACKEND_URL || "").replace(/\/$/, "") || location.origin;
// `true` when we're hitting a remote backend (Worker). Drives password auth.
const REMOTE_BACKEND = !!(window.CC_BACKEND_URL && window.CC_BACKEND_URL.trim());
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  chart: null,
  quickhits: null,
  rosters: null,
  stats: null,
  dashboard: null,         // {windowStart, windowEnd, fetchedAt, dates:[], byTeam:{ABBR:[reliever,...]}}
  pitcherIndex: null,      // {mlbamid: {level, teamAbbr, name, hand, ...}} — covers MLB + all MILB affiliates
  pitcherIndexByName: null, // lowercased name -> record (built once at load)
  dirty: false,
  saveTimer: null,
};

// View mode: when set, hides edit affordances (add buttons, chip popovers,
// editable notes, save/refresh buttons). Set by index.html (landing) before
// app.js loads. The editor page (edit.html) does not set this.
const VIEW_MODE = !!window.CC_VIEW_MODE;

// ===== Auth (editor + remote backend only) =====
// Password lives in localStorage. When using a remote backend we POST it in
// the body of every write request; the Worker validates and proxies to GitHub.

const AUTH_KEY = "cc.editorPassword";

function getPassword() {
  try { return localStorage.getItem(AUTH_KEY) || ""; } catch { return ""; }
}
function setPassword(pw) {
  try {
    if (pw) localStorage.setItem(AUTH_KEY, pw);
    else localStorage.removeItem(AUTH_KEY);
  } catch { /* private mode etc. — ignore */ }
}
function needsSignIn() {
  if (VIEW_MODE) return false;
  if (!REMOTE_BACKEND && !window.CC_FORCE_AUTH) return false;
  return !getPassword();
}

function showSignIn(errorMsg = "") {
  const backdrop = $("#signInBackdrop");
  if (!backdrop) return;
  backdrop.hidden = false;
  $("#signInError").textContent = errorMsg;
  setTimeout(() => $("#signInPassword")?.focus(), 0);
}
function hideSignIn() {
  const backdrop = $("#signInBackdrop");
  if (backdrop) backdrop.hidden = true;
}

let qhObserver = null;

// Per-chip color palette (matches build_data.COLOR_PALETTE + Excel legend).
const CHIP_COLORS = ["Blue", "Orange", "Yellow", "Magenta", "Green"];

// ===== load =====

async function loadAll() {
  const noCache = { cache: "no-store" };
  const [chart, quickhits, rosters, statsRes, dashRes, pitcherIdx] = await Promise.all([
    fetch("data/chart.json", noCache).then(r => r.json()),
    fetch("data/quickhits.json", noCache).then(r => r.json()),
    fetch("data/rosters.json", noCache).then(r => r.json()),
    fetch("data/stats.json", noCache).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("data/dashboard.json", noCache).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("data/pitcher_index.json", noCache).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  state.chart = chart;
  state.quickhits = quickhits;
  state.rosters = rosters;
  state.stats = statsRes;
  state.dashboard = dashRes;
  state.pitcherIndex = pitcherIdx;
  if (pitcherIdx) {
    state.pitcherIndexByName = {};
    for (const rec of Object.values(pitcherIdx)) {
      if (rec.name) state.pitcherIndexByName[rec.name.toLowerCase()] = rec;
    }
  }
  // Show only the "last updated" stamp — both pages have the same element.
  // Best-effort: chart.json has no embedded timestamp, so we lean on
  // stats.json's fetchedAt as the canonical freshness.
  const lu = $("#lastUpdated");
  if (lu) {
    const ts = statsRes?.fetchedAt;
    lu.textContent = ts
      ? `last updated ${new Date(ts).toLocaleString()}`
      : "";
  }
  renderChart();
  renderQuickHits();
  // The topbar + tabs heights can change after the chart finishes rendering
  // (legend wrap depends on viewport width). Measure once layout is done.
  recomputeStickyTop();
}

// ===== chart render =====

function renderChart() {
  const al = state.chart.teams.filter(t => t.league === "AL");
  const nl = state.chart.teams.filter(t => t.league === "NL");
  $("#alChart").innerHTML = "";
  appendHead($("#alChart"));
  al.forEach(t => $("#alChart").appendChild(buildTeamRow(t)));
  $("#nlChart").innerHTML = "";
  appendHead($("#nlChart"));
  nl.forEach(t => $("#nlChart").appendChild(buildTeamRow(t)));
}

// Append header cells directly to the grid (no wrapper). A wrapper with
// `display: contents` would block `position: sticky` on the cells, since
// sticky needs a real containing block.
function appendHead(gridEl) {
  ["LEV", "Team", ...state.chart.roleOrder.map(r => state.chart.roleLabels[r]), "Notes"]
    .forEach(label => {
      const d = document.createElement("div");
      d.className = "chart-head-cell";
      d.textContent = label;
      gridEl.appendChild(d);
    });
}

// Set the --sticky-top CSS variable to the y-coordinate where the tabs bar
// ends when stuck (i.e. its sticky `top` offset + its rendered height).
// The chart's column headers then pin FLUSH against that, eliminating the
// gap that previously let scrolling content show between the tabs and the
// headers. Adapts automatically when the legend wraps to multiple lines.
//
// Using tabs.style.top instead of getBoundingClientRect().bottom because
// the latter reports different values depending on whether the tabs is
// currently stuck or in its natural document position — we want the stuck
// value at all times.
function recomputeStickyTop() {
  const tabs = document.querySelector(".tabs");
  if (!tabs) return;
  const cs = getComputedStyle(tabs);
  const tabsStickyTop = parseFloat(cs.top) || 0;
  const tabsHeight = tabs.getBoundingClientRect().height;
  // Math.floor gives a hairline overlap with the tabs bar's bottom edge;
  // the tabs' higher z-index covers it cleanly with no visible seam.
  document.documentElement.style.setProperty(
    "--sticky-top", `${Math.floor(tabsStickyTop + tabsHeight)}px`);
}

function buildTeamRow(team) {
  const row = document.createElement("div");
  row.className = "team-row";
  row.dataset.teamId = team.teamId ?? "";

  // 1. LEVCON rating
  const cellRating = document.createElement("div");
  cellRating.className = "cell-rating";
  if (team.levcon) cellRating.dataset.lev = String(team.levcon);
  if (VIEW_MODE) {
    const pill = document.createElement("span");
    pill.className = "lev-static";
    pill.textContent = team.levcon ?? "—";
    cellRating.appendChild(pill);
  } else {
    const levSel = document.createElement("select");
    ["", "1", "2", "3", "4", "5"].forEach(v => {
      const opt = document.createElement("option");
      opt.value = v; opt.textContent = v || "—";
      if (String(team.levcon ?? "") === v) opt.selected = true;
      levSel.appendChild(opt);
    });
    levSel.addEventListener("change", () => {
      team.levcon = levSel.value ? Number(levSel.value) : null;
      if (team.levcon) cellRating.dataset.lev = String(team.levcon);
      else delete cellRating.dataset.lev;
      markDirty();
    });
    cellRating.appendChild(levSel);
  }
  row.appendChild(cellRating);

  // 2. Team name (with abbr). In editor mode, the cell is clickable to open
  // the RP Dashboard modal. The view-only page omits the modal entirely.
  const cellTeam = document.createElement("div");
  cellTeam.className = "cell-team" + (VIEW_MODE ? "" : " clickable");
  if (!VIEW_MODE) cellTeam.title = "Click to open the RP Dashboard for this team";
  const abbr = team.teamId ? state.rosters[String(team.teamId)]?.abbr : "";
  if (abbr) {
    const ab = document.createElement("span");
    ab.className = "team-abbr";
    ab.textContent = abbr;
    cellTeam.appendChild(ab);
  }
  cellTeam.appendChild(document.createTextNode(team.teamName));
  if (!VIEW_MODE) cellTeam.addEventListener("click", () => openDashboardModal(team));
  row.appendChild(cellTeam);

  // 3-7. Role columns
  state.chart.roleOrder.forEach(role => {
    const cell = document.createElement("div");
    cell.className = "cell-role";
    cell.appendChild(buildChipList(team, role));
    if (!VIEW_MODE) cell.appendChild(buildChipAdd(team, role));
    row.appendChild(cell);
  });

  // 8. Notes
  const cellNotes = document.createElement("div");
  cellNotes.className = "cell-notes";
  if (VIEW_MODE) {
    const p = document.createElement("div");
    p.className = "notes-readonly";
    p.textContent = team.notes || "";
    cellNotes.appendChild(p);
  } else {
    const ta = document.createElement("textarea");
    ta.value = team.notes || "";
    ta.placeholder = "Injury / availability notes…";
    ta.addEventListener("input", () => { team.notes = ta.value; markDirty(); });
    cellNotes.appendChild(ta);
  }
  row.appendChild(cellNotes);

  return row;
}

// ===== chips =====

function buildChipList(team, role) {
  const list = document.createElement("div");
  list.className = "chip-list";
  const chips = team.roles[role] || (team.roles[role] = []);
  chips.forEach((chip, idx) => list.appendChild(buildChip(team, role, chip, idx, list)));
  if (!chips.length && VIEW_MODE) {
    const empty = document.createElement("span");
    empty.className = "chip-empty";
    empty.textContent = "—";
    list.appendChild(empty);
  }
  return list;
}

function lookupPitcher(chip) {
  if (!state.pitcherIndex) return null;
  if (chip.mlbamid && state.pitcherIndex[String(chip.mlbamid)]) {
    return state.pitcherIndex[String(chip.mlbamid)];
  }
  // Fallback: chip is unresolved (no mlbamid). Try exact name match against
  // the full org index so prospects still get a level badge.
  if (state.pitcherIndexByName && chip.name) {
    return state.pitcherIndexByName[chip.name.toLowerCase()] || null;
  }
  return null;
}

// Coerce a chip's color shape into the canonical { explicit: string[], ... }
// model. Backward compat: legacy chip.color (single string) is read as a
// single-element array. The original chip.color field is migrated lazily —
// next save writes the array shape and the legacy string disappears.
function chipExplicitColors(chip) {
  if (Array.isArray(chip.colors)) return chip.colors.filter(Boolean);
  if (chip.color) return [chip.color];
  return [];
}

// Compute the effective set of colors to render on the chip:
//   explicit user picks + auto-magenta (when usageTags exist and the user
//   hasn't dismissed it via chip.noMagenta).
function effectiveChipColors(chip) {
  const explicit = chipExplicitColors(chip);
  const auto = autoMagentaActive(chip);
  if (auto && !explicit.includes("Magenta")) {
    return [...explicit, "Magenta"];
  }
  return explicit;
}

// True iff this chip should be auto-magenta'd (display-only effect that the
// user has not explicitly dismissed via chip.noMagenta).
function autoMagentaActive(chip) {
  if (chip.noMagenta) return false;
  if (!chip.mlbamid) return false;
  const tags = state.stats?.byPlayerId?.[String(chip.mlbamid)]?.usageTags;
  return !!(tags && tags.length);
}

// Mutate chip.colors in place: add (if not present) or remove the color.
// Also migrates the legacy chip.color string into the new array shape on
// first write.
function toggleChipColor(chip, color) {
  if (!Array.isArray(chip.colors)) {
    chip.colors = chipExplicitColors(chip);
  }
  if (chip.color) delete chip.color;  // legacy field, no longer used
  const idx = chip.colors.indexOf(color);
  if (idx >= 0) chip.colors.splice(idx, 1);
  else chip.colors.push(color);
}

function buildChip(team, role, chip, idx, listEl) {
  const el = document.createElement("span");
  el.className = "chip";
  const effColors = effectiveChipColors(chip);
  if (effColors.length) {
    el.classList.add("has-color");
    if (effColors.length === 1) {
      // Single color: simple CSS class with the palette variable.
      el.classList.add("color-" + effColors[0]);
    } else {
      // Multi-color: render as equal vertical stripes via a gradient. Each
      // color gets the same slice width so the chip reads as N tags layered.
      const step = 100 / effColors.length;
      const stops = effColors.map((c, i) =>
        `var(--color-${c}) ${i * step}% ${(i + 1) * step}%`).join(", ");
      el.style.background = `linear-gradient(to right, ${stops})`;
    }
  }

  const pitcher = lookupPitcher(chip);
  // "On the 40-man" = pitcher exists in pitcher_index AND level === MLB.
  // Note: chip.mlbamid alone doesn't tell us 40-man status, because the chip
  // could have been bound via the org-MILB search to a minor leaguer.
  const onFortyMan = !!(pitcher && pitcher.level === "MLB");
  if (!onFortyMan) el.title = "Not on the 40-man roster";
  // Hint when Magenta on display came from auto-default rather than an
  // explicit pick, so the user knows where it came from.
  if (autoMagentaActive(chip) && !chipExplicitColors(chip).includes("Magenta")) {
    el.title = (el.title ? el.title + " · " : "") + "Auto-magenta (usage tag active)";
  }

  const nameSpan = document.createElement("span");
  nameSpan.className = "chip-name";
  nameSpan.textContent = chip.name;
  el.appendChild(nameSpan);

  // "40-man" badge with strike-through when the player isn't on the 40-man.
  // Replaces the older dashed-yellow border on unresolved chips.
  if (!onFortyMan) {
    const nf = document.createElement("span");
    nf.className = "chip-notforty";
    nf.textContent = "40";
    nf.title = "Not on the 40-man roster";
    el.appendChild(nf);
  }

  // MILB level badge — only when the looked-up pitcher is not at the MLB level.
  if (pitcher && pitcher.level && pitcher.level !== "MLB") {
    const lvl = document.createElement("span");
    lvl.className = "chip-level";
    lvl.textContent = pitcher.level;
    lvl.title = `${pitcher.teamAbbr || ""} (${pitcher.level})`;
    el.appendChild(lvl);
  }

  // Derived usage badge from stats.json (auto-populated on Refresh Stats).
  const usageTags = chip.mlbamid
    ? (state.stats?.byPlayerId?.[String(chip.mlbamid)]?.usageTags || [])
    : [];
  if (usageTags.length) {
    const u = document.createElement("span");
    u.className = "chip-usage";
    u.textContent = usageTags.join(", ");
    u.title = "Auto from gameLog — refresh stats to update";
    el.appendChild(u);
  }

  if (chip.statusTag) {
    const t = document.createElement("span");
    t.className = "chip-status";
    t.textContent = chip.statusTag;
    el.appendChild(t);
  }
  if (chip.other) {
    const o = document.createElement("span");
    o.className = "chip-other";
    o.textContent = chip.other;
    el.appendChild(o);
  }

  if (!VIEW_MODE) {
    const x = document.createElement("span");
    x.className = "chip-remove";
    x.textContent = "×";
    x.title = "Remove";
    x.addEventListener("click", e => {
      e.stopPropagation();
      team.roles[role].splice(idx, 1);
      rerenderRoleCell(team, role);
      markDirty();
    });
    el.appendChild(x);
  }

  // hover -> stat tooltip (works in both edit and view modes)
  if (chip.mlbamid) {
    el.addEventListener("mouseenter", e => showStatTooltip(e, chip));
    el.addEventListener("mouseleave", hideStatTooltip);
    el.addEventListener("mousemove", e => moveStatTooltip(e));
  }

  // click -> edit popover (edit mode only)
  if (!VIEW_MODE) {
    el.addEventListener("click", e => {
      e.stopPropagation();
      openChipEditPopover(el, team, role, idx);
    });
  }

  // In edit mode, wrap the chip in a small column with a quick color picker
  // (5 squares) underneath. View mode returns the bare chip — no editing UI.
  if (VIEW_MODE) return el;
  const wrap = document.createElement("div");
  wrap.className = "chip-wrap";
  wrap.appendChild(el);
  wrap.appendChild(buildChipColorPicker(team, role, chip));
  return wrap;
}

function buildChipColorPicker(team, role, chip) {
  const picker = document.createElement("div");
  picker.className = "chip-color-picker";
  picker.addEventListener("click", e => e.stopPropagation());

  const effective = effectiveChipColors(chip);
  const explicit = chipExplicitColors(chip);
  const colorLabels = state.chart?.colorMeanings || {};
  CHIP_COLORS.forEach(c => {
    const sq = document.createElement("button");
    sq.type = "button";
    sq.className = "chip-color-sq color-" + c;
    let tip = c + (colorLabels[c] ? ` — ${colorLabels[c]}` : "");
    if (effective.includes(c)) sq.classList.add("selected");
    // Magenta-specific auto-default styling: when Magenta is on display due
    // to auto and not explicitly picked, show it as "selected" but with a
    // visual hint that it's auto (dashed outline). Clicking dismisses.
    if (c === "Magenta" && effective.includes(c) && !explicit.includes(c)) {
      sq.classList.add("auto");
      tip += " — auto from usage tag (click to dismiss)";
    }
    sq.title = tip;
    sq.addEventListener("click", () => {
      const explicitNow = chipExplicitColors(chip);
      const isExplicit = explicitNow.includes(c);
      const isAutoMagenta = c === "Magenta" && !isExplicit && autoMagentaActive(chip);

      if (isExplicit) {
        // Remove from explicit colors.
        toggleChipColor(chip, c);
        // If the user is removing Magenta explicitly while usage tags exist,
        // also dismiss the auto so it doesn't immediately re-appear.
        if (c === "Magenta" && autoMagentaActive(chip)) chip.noMagenta = true;
      } else if (isAutoMagenta) {
        // Dismiss the auto-magenta — leaves explicit colors untouched.
        chip.noMagenta = true;
      } else {
        // Add to explicit colors. If the user is picking Magenta after
        // dismissing it, also clear the dismissal so auto can fire again
        // later if circumstances change.
        toggleChipColor(chip, c);
        if (c === "Magenta") delete chip.noMagenta;
      }
      rerenderRoleCell(team, role);
      markDirty();
    });
    picker.appendChild(sq);
  });
  return picker;
}

function rerenderRoleCell(team, role) {
  const tr = $$(`.team-row[data-team-id="${team.teamId ?? ""}"]`)
    .find(r => r.parentElement.id === (team.league === "AL" ? "alChart" : "nlChart"));
  if (!tr) return;
  const idx = state.chart.roleOrder.indexOf(role);
  // tr uses display:contents — children of tr are the grid cells in order:
  //   0(rating), 1(team), 2..6(roles), 7(notes)
  const roleCellOffset = 2;
  const cell = tr.children[roleCellOffset + idx];
  if (!cell) return;
  cell.innerHTML = "";
  cell.appendChild(buildChipList(team, role));
  cell.appendChild(buildChipAdd(team, role));
}

function buildChipAdd(team, role) {
  const wrap = document.createElement("div");
  wrap.className = "chip-add";
  const btn = document.createElement("button");
  btn.className = "chip-add-btn";
  btn.textContent = "+ add pitcher";
  btn.addEventListener("click", e => {
    e.stopPropagation();
    openAddSearch(btn, team, role);
  });
  wrap.appendChild(btn);
  return wrap;
}

// ===== popovers =====

let openPopover = null;
function closePopover() {
  if (openPopover) { openPopover.remove(); openPopover = null; }
}
document.addEventListener("click", closePopover);

function placeNear(el, anchor) {
  const r = anchor.getBoundingClientRect();
  el.style.left = `${window.scrollX + r.left}px`;
  el.style.top = `${window.scrollY + r.bottom + 4}px`;
  document.body.appendChild(el);
}

function openAddSearch(anchor, team, role) {
  closePopover();
  const popup = document.createElement("div");
  popup.className = "chip-add-search";
  popup.addEventListener("click", e => e.stopPropagation());

  // mode tabs
  const tabs = document.createElement("div");
  tabs.className = "chip-add-tabs";
  const modes = [
    { key: "roster", label: "40-Man" },
    { key: "org",    label: "Org (MILB)" },
  ];
  let mode = "roster";
  modes.forEach(m => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-add-tab" + (m.key === mode ? " active" : "");
    b.textContent = m.label;
    b.dataset.mode = m.key;
    b.addEventListener("click", () => {
      mode = m.key;
      Array.from(tabs.children).forEach(c =>
        c.classList.toggle("active", c.dataset.mode === mode));
      activeIdx = 0;
      render(input.value);
    });
    tabs.appendChild(b);
  });
  popup.appendChild(tabs);

  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "search pitchers...";
  popup.appendChild(input);

  const list = document.createElement("ul");
  popup.appendChild(list);

  const roster = team.teamId ? state.rosters[String(team.teamId)] : null;
  const rosterPitchers = roster ? roster.pitchers : [];

  let activeIdx = 0;
  let orgResults = [];
  let orgLoading = false;
  let orgQuery = null;        // last query we asked the server about
  let orgReqSeq = 0;          // race-guard counter

  async function fetchOrg(q) {
    if (!team.teamId) { orgResults = []; return; }
    const myReq = ++orgReqSeq;
    orgLoading = true;
    orgQuery = q;
    render(input.value);
    try {
      const url = `${API}/org-pitchers?teamId=${team.teamId}`
        + (q ? `&q=${encodeURIComponent(q)}` : "");
      const r = await fetch(url);
      const data = await r.json();
      if (myReq !== orgReqSeq) return;  // a newer request superseded this one
      orgResults = data.ok ? data.pitchers : [];
    } catch (e) {
      if (myReq !== orgReqSeq) return;
      orgResults = [];
      toast("Org search failed: " + e.message, "error");
    } finally {
      if (myReq === orgReqSeq) {
        orgLoading = false;
        render(input.value);
      }
    }
  }

  let orgDebounce = null;
  function maybeFetchOrg(q) {
    if (orgDebounce) clearTimeout(orgDebounce);
    // First open or query change -> debounce a fetch.
    orgDebounce = setTimeout(() => fetchOrg(q), q ? 220 : 0);
  }

  function makeRow(label, meta, onClick, extraClass) {
    const li = document.createElement("li");
    if (extraClass) li.classList.add(extraClass);
    const main = document.createElement("span");
    main.className = "pitcher-main";
    if (typeof label === "string") main.textContent = label;
    else main.appendChild(label);
    li.appendChild(main);
    if (meta) {
      const m = document.createElement("span");
      m.className = "pitcher-meta";
      m.textContent = meta;
      li.appendChild(m);
    }
    li.addEventListener("click", () => { onClick(); closePopover(); });
    return li;
  }

  function render(filterText) {
    list.innerHTML = "";
    const q = (filterText || "").trim();
    const qLower = q.toLowerCase();
    let rows = [];

    if (mode === "roster") {
      const matches = rosterPitchers
        .filter(p => !qLower || (p.name || "").toLowerCase().includes(qLower))
        .slice(0, 25);
      rows = matches.map(p => () => makeRow(
        p.name,
        [p.hand && `${p.hand}HP`, p.status].filter(Boolean).join(" · "),
        () => addChip(team, role, { name: p.name, id: p.id }),
      ));
    } else if (mode === "org") {
      if (orgLoading) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "searching org…";
        list.appendChild(li);
      } else {
        rows = orgResults.map(p => () => {
          const label = document.createElement("span");
          const lvl = document.createElement("span");
          lvl.className = "level-badge level-" + (p.level || "").replace("+", "p");
          lvl.textContent = p.level || "?";
          label.appendChild(lvl);
          label.appendChild(document.createTextNode(" " + p.name));
          const meta = [p.teamAbbr, p.hand && `${p.hand}HP`, p.status]
            .filter(Boolean).join(" · ");
          return makeRow(label, meta, () =>
            addChip(team, role, { name: p.name, id: p.id }));
        });
      }
    }

    rows.forEach((make, i) => {
      const li = make();
      if (i === activeIdx) li.classList.add("active");
      list.appendChild(li);
    });

    if (!rows.length && !orgLoading) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = q
        ? (mode === "org" ? "no org matches" : "no roster matches")
        : (mode === "org" ? "type to search org" : "type to filter");
      list.appendChild(li);
    }

    // Free-text footer: always show when there is typed text, regardless of mode.
    if (q) {
      const li = makeRow(
        `Add as free text: "${q}"`,
        "unresolved",
        () => addChip(team, role, { name: q, id: null }),
        "free-text",
      );
      // free-text is selectable as the last row
      if (activeIdx === rows.length) li.classList.add("active");
      list.appendChild(li);
    }
  }

  input.addEventListener("input", () => {
    activeIdx = 0;
    if (mode === "org") maybeFetchOrg(input.value.trim());
    render(input.value);
  });
  input.addEventListener("keydown", e => {
    const max = list.children.length - 1;
    if (e.key === "ArrowDown") {
      activeIdx = Math.min(activeIdx + 1, max);
      // mark active without rebuilding list
      Array.from(list.children).forEach((c, i) =>
        c.classList.toggle("active", i === activeIdx));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      activeIdx = Math.max(activeIdx - 1, 0);
      Array.from(list.children).forEach((c, i) =>
        c.classList.toggle("active", i === activeIdx));
      e.preventDefault();
    } else if (e.key === "Enter") {
      const li = list.children[activeIdx];
      if (li && !li.classList.contains("empty")) li.click();
      e.preventDefault();
    } else if (e.key === "Escape") {
      closePopover();
    }
  });

  // Re-route the tab click handler to also kick the initial org fetch.
  Array.from(tabs.children).forEach(b => {
    b.addEventListener("click", () => {
      if (mode === "org" && !orgResults.length && !orgLoading) {
        maybeFetchOrg(input.value.trim());
      }
    });
  });

  render("");
  placeNear(popup, anchor);
  openPopover = popup;
  setTimeout(() => input.focus(), 10);
}

function addChip(team, role, pitcher) {
  team.roles[role].push({
    name: pitcher.name,
    mlbamid: pitcher.id ?? null,
    statusTag: null,
    colors: [],
    other: null,
  });
  rerenderRoleCell(team, role);
  markDirty();
}

function openChipEditPopover(anchor, team, role, idx) {
  closePopover();
  const chip = team.roles[role][idx];
  const popup = document.createElement("div");
  popup.className = "chip-edit-popover";
  popup.addEventListener("click", e => e.stopPropagation());

  // Usage tag (read-only, derived from stats.json) — shown for context.
  const usageTags = chip.mlbamid
    ? (state.stats?.byPlayerId?.[String(chip.mlbamid)]?.usageTags || [])
    : [];
  const lblUsage = document.createElement("label");
  lblUsage.textContent = "Usage Tag (auto — Refresh Stats to update)";
  const usageVal = document.createElement("div");
  usageVal.className = "field-readonly";
  usageVal.textContent = usageTags.length ? usageTags.join(", ") : "—";
  lblUsage.appendChild(usageVal);
  popup.appendChild(lblUsage);

  // Status (IL/Paternity/Suspension/etc.)
  const lblStatus = document.createElement("label");
  lblStatus.textContent = "Injury / IL / Paternity / Suspension";
  const inpStatus = document.createElement("input");
  inpStatus.type = "text"; inpStatus.value = chip.statusTag || "";
  inpStatus.placeholder = "e.g. IL, paternity, suspended";
  lblStatus.appendChild(inpStatus);
  popup.appendChild(lblStatus);

  // Colors are now managed via the inline picker squares under each chip
  // (multi-select). The popover only handles Tag + Other now.

  // Other (free text — HLR / FROOP / etc.)
  const lblOther = document.createElement("label");
  lblOther.textContent = "Other (free text)";
  const inpOther = document.createElement("input");
  inpOther.type = "text"; inpOther.value = chip.other || "";
  inpOther.placeholder = "e.g. HLR, FROOP";
  lblOther.appendChild(inpOther);
  popup.appendChild(lblOther);

  const row = document.createElement("div");
  row.className = "row";
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closePopover);
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = "Save";
  save.addEventListener("click", () => {
    chip.statusTag = inpStatus.value.trim() || null;
    chip.other = inpOther.value.trim() || null;
    rerenderRoleCell(team, role);
    closePopover();
    markDirty();
  });
  row.appendChild(cancel); row.appendChild(save);
  popup.appendChild(row);

  placeNear(popup, anchor);
  openPopover = popup;
  setTimeout(() => inpStatus.focus(), 10);
}

// ===== stat tooltip =====

const tooltip = $("#statTooltip");

function showStatTooltip(e, chip) {
  if (!state.stats) return;
  const row = state.stats.byPlayerId[String(chip.mlbamid)];
  if (!row) {
    tooltip.innerHTML = `<div class="name">${escapeHtml(chip.name)}</div><div class="subtle">no stats yet</div>`;
  } else {
    const fmt = v => (v === null || v === undefined ? "—" : v);
    const usage = (row.usageTags || []).join(", ");
    const lg = row.lastGame;
    const lastGameLine = lg
      ? `<div class="subtle">last: ${lg.date} · ${fmt(lg.ip)} IP · ${fmt(lg.pitches)} pitches</div>`
      : "";
    const usageLine = usage
      ? `<div class="usage-line">usage: ${escapeHtml(usage)}</div>`
      : "";
    tooltip.innerHTML = `
      <div class="name">${escapeHtml(chip.name)} <span class="subtle">${row.teamAbbrev || ""}</span></div>
      ${usageLine}
      ${lastGameLine}
      <table>
        <tr><td class="label">G/GF</td><td>${fmt(row.gamesPitched)}/${fmt(row.gamesFinished)}</td>
            <td class="label">IP</td><td>${fmt(row.inningsPitched)}</td></tr>
        <tr><td class="label">SV/SVO/BS</td><td>${fmt(row.saves)}/${fmt(row.saveOpportunities)}/${fmt(row.blownSaves)}</td>
            <td class="label">HLD</td><td>${fmt(row.holds)}</td></tr>
        <tr><td class="label">ERA</td><td>${fmt(row.era)}</td>
            <td class="label">WHIP</td><td>${fmt(row.whip)}</td></tr>
        <tr><td class="label">K/9</td><td>${fmt(row.strikeoutsPer9)}</td>
            <td class="label">BB/9</td><td>${fmt(row.baseOnBallsPer9)}</td></tr>
        <tr><td class="label">K-BB%</td><td>${fmt(row.strikeoutsMinusWalksPercentage)}</td>
            <td class="label">SwStr%</td><td>${fmt(row.whiffPercentage)}</td></tr>
      </table>`;
  }
  tooltip.hidden = false;
  moveStatTooltip(e);
}
function moveStatTooltip(e) {
  if (tooltip.hidden) return;
  const x = e.clientX + window.scrollX + 12;
  const y = e.clientY + window.scrollY + 12;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}
function hideStatTooltip() { tooltip.hidden = true; }

// ===== quick hits =====

function renderQuickHits() {
  const list = $("#qhList");
  list.innerHTML = "";

  if (qhObserver) { qhObserver.disconnect(); qhObserver = null; }

  const leagueFilter = $("#qhLeagueFilter").value;
  const search = $("#qhSearch").value.toLowerCase().trim();

  const teamsByLeague = {
    AL: state.chart.teams.filter(t => t.league === "AL"),
    NL: state.chart.teams.filter(t => t.league === "NL"),
  };

  const filtered = state.quickhits.filter(q => {
    if (leagueFilter !== "ALL" && q.league !== leagueFilter) return false;
    if (search) {
      const blob = JSON.stringify(q.entries).toLowerCase();
      if (!blob.includes(search)) return false;
    }
    return true;
  });

  // Lazy-hydrate cards: render skeleton placeholders for every filtered day
  // so the scrollbar reflects total content, then swap each placeholder for
  // the full ~15-textarea card as it nears the viewport. Avoids building
  // ~14k textareas up front. Cards stay hydrated once built (data lives in
  // state.quickhits so re-render never loses edits).
  qhObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const placeholder = entry.target;
      qhObserver.unobserve(placeholder);
      const q = placeholder._qhRef;
      placeholder.replaceWith(buildQhDay(q, teamsByLeague[q.league] || []));
    }
  }, { rootMargin: "600px 0px" });

  filtered.forEach(q => {
    const placeholder = buildQhPlaceholder(q);
    placeholder._qhRef = q;
    list.appendChild(placeholder);
    qhObserver.observe(placeholder);
  });
}

function buildQhPlaceholder(q) {
  const card = document.createElement("div");
  card.className = "qh-day qh-day-placeholder";
  const head = document.createElement("div");
  head.className = "qh-day-head";
  const date = document.createElement("span");
  date.className = "qh-date";
  date.textContent = q.date;
  head.appendChild(date);
  const lg = document.createElement("span");
  lg.className = "qh-league";
  lg.textContent = q.league;
  head.appendChild(lg);
  card.appendChild(head);
  return card;
}

function buildQhDay(q, teams) {
  const card = document.createElement("div");
  card.className = "qh-day";

  const head = document.createElement("div");
  head.className = "qh-day-head";
  if (VIEW_MODE) {
    const dateEl = document.createElement("span");
    dateEl.className = "qh-date";
    dateEl.textContent = q.date;
    head.appendChild(dateEl);
  } else {
    const dateEl = document.createElement("input");
    dateEl.type = "date";
    dateEl.className = "qh-date";
    dateEl.value = q.date;
    dateEl.addEventListener("change", () => { q.date = dateEl.value; markDirty(); });
    head.appendChild(dateEl);
  }
  const lg = document.createElement("span");
  lg.className = "qh-league";
  lg.textContent = q.league;
  head.appendChild(lg);
  if (!VIEW_MODE) {
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Delete date";
    del.style.marginLeft = "auto";
    del.addEventListener("click", () => {
      if (!confirm(`Delete Quick Hits for ${q.date} (${q.league})?`)) return;
      const idx = state.quickhits.indexOf(q);
      if (idx >= 0) state.quickhits.splice(idx, 1);
      renderQuickHits();
      markDirty();
    });
    head.appendChild(del);
  }
  card.appendChild(head);

  // rollup
  const rollupText = q.entries["__rollup__"] || "";
  if (VIEW_MODE) {
    if (rollupText) {
      const rollup = document.createElement("div");
      rollup.className = "qh-rollup-readonly";
      rollup.textContent = rollupText;
      card.appendChild(rollup);
    }
  } else {
    const rollup = document.createElement("div");
    rollup.className = "qh-rollup";
    const rollupTa = document.createElement("textarea");
    rollupTa.placeholder = `Rollup "Quick Hits..." line for ${q.date}`;
    rollupTa.value = rollupText;
    rollupTa.addEventListener("input", () => {
      if (rollupTa.value.trim()) q.entries["__rollup__"] = rollupTa.value;
      else delete q.entries["__rollup__"];
      markDirty();
    });
    rollup.appendChild(rollupTa);
    card.appendChild(rollup);
  }

  // per-team grid
  const grid = document.createElement("div");
  grid.className = "qh-team-grid";
  teams.forEach(t => {
    const tid = String(t.teamId);
    // Read existing entry as either string (legacy) or string[] (new). The
    // canonical in-memory shape is always an array.
    const raw = q.entries[tid] !== undefined ? q.entries[tid] : q.entries[t.teamName];
    const entries = normalizeQhEntries(raw);

    // In view mode, skip teams with no non-empty entries to keep the grid tight.
    const visibleEntries = entries.filter(e => e && e.trim());
    if (VIEW_MODE && !visibleEntries.length) return;

    const cell = document.createElement("div");
    cell.className = "qh-team-cell";

    // Header row: team name + (edit mode) + button
    const head = document.createElement("div");
    head.className = "qh-team-head";
    const name = document.createElement("div");
    name.className = "qh-team-name";
    name.textContent = t.teamName;
    head.appendChild(name);
    if (!VIEW_MODE) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "qh-team-add";
      add.title = "Add another entry for this team";
      add.textContent = "+";
      add.addEventListener("click", () => {
        const list = ensureQhArray(q, tid, t.teamName);
        list.push("");
        renderQhTeamCell(cell, q, tid, t.teamName);
        // focus the new (last) textarea
        const tas = cell.querySelectorAll("textarea");
        tas[tas.length - 1]?.focus();
        markDirty();
      });
      head.appendChild(add);
    }
    cell.appendChild(head);

    // Body: render entries
    renderQhEntries(cell, q, tid, t.teamName, VIEW_MODE ? visibleEntries : entries);

    grid.appendChild(cell);
  });
  card.appendChild(grid);

  return card;
}

// Coerce a raw entry value (string | string[] | undefined) into an array of
// strings. Editing always operates on arrays; legacy quickhits.json with
// string values is handled transparently.
function normalizeQhEntries(raw) {
  if (Array.isArray(raw)) return raw.slice();
  if (typeof raw === "string") return raw ? [raw] : [""];
  return [""];
}

// Ensure the in-memory state for (qDay, teamId) is an array, mutating
// q.entries[tid] from string -> [string] on first edit. Returns the array.
function ensureQhArray(q, tid, teamName) {
  let cur = q.entries[tid] !== undefined ? q.entries[tid] : q.entries[teamName];
  if (!Array.isArray(cur)) cur = normalizeQhEntries(cur);
  q.entries[tid] = cur;
  // If the legacy key (team name) existed, clean it up so we don't write back two.
  if (q.entries[teamName] !== undefined && tid !== teamName) delete q.entries[teamName];
  return cur;
}

function renderQhTeamCell(cell, q, tid, teamName) {
  // Re-render just the entries portion (everything after .qh-team-head).
  const head = cell.querySelector(".qh-team-head");
  // Remove anything after head.
  while (cell.lastChild && cell.lastChild !== head) cell.removeChild(cell.lastChild);
  const arr = ensureQhArray(q, tid, teamName);
  renderQhEntries(cell, q, tid, teamName, arr);
}

function renderQhEntries(cell, q, tid, teamName, entries) {
  entries.forEach((value, idx) => {
    if (VIEW_MODE) {
      const body = document.createElement("div");
      body.className = "qh-team-readonly";
      body.textContent = value || "";
      cell.appendChild(body);
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "qh-entry";
    const ta = document.createElement("textarea");
    ta.value = value || "";
    ta.placeholder = "—";
    ta.addEventListener("input", () => {
      const list = ensureQhArray(q, tid, teamName);
      list[idx] = ta.value;
      // Auto-clean: if the user wiped the entry AND there's more than one,
      // leave the empty slot; if it's the only entry, fall back to deleting
      // the team key entirely so the cell shows as empty on next render.
      const allEmpty = list.every(e => !e || !e.trim());
      if (allEmpty) {
        delete q.entries[tid];
        delete q.entries[teamName];
      }
      markDirty();
    });
    wrap.appendChild(ta);

    // Remove button for non-first entries (or first entry if there's only one
    // empty? Keep it simple: any entry can be removed if there's >1 entry.)
    if (entries.length > 1) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "qh-entry-remove";
      rm.title = "Remove this entry";
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        const list = ensureQhArray(q, tid, teamName);
        list.splice(idx, 1);
        if (list.length === 0) {
          delete q.entries[tid];
          delete q.entries[teamName];
        }
        renderQhTeamCell(cell, q, tid, teamName);
        markDirty();
      });
      wrap.appendChild(rm);
    }

    cell.appendChild(wrap);
  });
}

// ===== save / refresh =====

function setSaveStatus(label, cls) {
  // Landing page topbar doesn't have a save-status element — guard so a
  // stale-cache pairing of new HTML + old JS can't crash the page.
  const el = $("#saveStatus");
  if (!el) return;
  el.textContent = label;
  el.className = "save-status " + (cls || "");
}

function markDirty() {
  if (VIEW_MODE) return;  // no-op in read-only mode
  state.dirty = true;
  setSaveStatus("Unsaved", "dirty");
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveAll, 1200);
}

async function backendPost(path, body = {}) {
  // Inject password in the body for remote backend. Local server.py ignores it.
  const payload = REMOTE_BACKEND
    ? { password: getPassword(), ...body }
    : body;
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.status === 401) {
    setPassword("");
    showSignIn("Wrong password. Try again.");
    throw new Error("unauthorized");
  }
  let data = null;
  try { data = await r.json(); } catch { /* may have empty body */ }
  if (!r.ok) throw new Error((data && (data.error || data.stderr)) || `HTTP ${r.status}`);
  return data || {};
}

// Concurrency guard: at most one /save round-trip in flight. If new edits
// happen while a save is running, we defer them — the post-save check fires
// one more save to flush. Prevents the editor from racing its own writes,
// which would surface as a 409 SHA conflict from GitHub.
let _saveInFlight = false;
let _savePending = false;

async function saveAll() {
  if (_saveInFlight) { _savePending = true; return; }
  _saveInFlight = true;
  setSaveStatus("Saving…", "saving");
  try {
    await backendPost("/save", { chart: state.chart, quickhits: state.quickhits });
    state.dirty = false;
    setSaveStatus("Saved " + new Date().toLocaleTimeString(), "saved");
  } catch (e) {
    if (e.message === "unauthorized") {
      setSaveStatus("Sign in to save", "error");
    } else {
      setSaveStatus("Save error", "error");
      toast("Save failed: " + e.message, "error");
    }
  } finally {
    _saveInFlight = false;
    if (_savePending) {
      _savePending = false;
      // Flush whatever changed during the previous save.
      setTimeout(saveAll, 50);
    }
  }
}

// ===== Workflow polling + progress modal =====
// After dispatching a refresh-* GitHub Action, watch its run via the
// public GitHub API and auto-reload the page once the commit lands.

const WORKFLOW_POLL_MS = 3000;
const WORKFLOW_TIMEOUT_MS = 4 * 60 * 1000;   // 4 minutes max
const PAGES_REBUILD_WAIT_MS = 12000;          // give Pages time to publish after commit
let _progressCancelled = false;

function showProgress(title, status) {
  _progressCancelled = false;
  const card = $("#progressBackdrop");
  if (!card) return;
  card.hidden = false;
  $("#progressTitle").textContent = title;
  $("#progressStatus").textContent = status || "";
  $("#progressDetail").textContent = "";
  $("#progressOpenAction").hidden = true;
  $("#progressSteps").hidden = true;
  $("#progressSteps").innerHTML = "";
  $(".progress-spinner").classList.remove("done", "error");
}

// Multi-step variant: title + N rows that update independently as each
// workflow finishes. Used by refreshAll().
function showProgressSteps(title, stepNames) {
  showProgress(title, "");
  const container = $("#progressSteps");
  container.innerHTML = "";
  stepNames.forEach((name, idx) => {
    const row = document.createElement("div");
    row.className = "progress-step";
    row.dataset.state = "pending";
    row.dataset.idx = String(idx);
    row.innerHTML = `
      <span class="step-icon">⏸</span>
      <span class="step-name"></span>
      <span class="step-detail"></span>
      <a class="step-link" target="_blank" rel="noopener" hidden>view →</a>
    `;
    row.querySelector(".step-name").textContent = name;
    container.appendChild(row);
  });
  container.hidden = false;
}

const STEP_ICONS = { pending: "⏸", running: "⏳", done: "✓", error: "✗" };

function updateStep(idx, state, detail, actionUrl) {
  if (_progressCancelled) return;
  const row = document.querySelector(
    `#progressSteps .progress-step[data-idx="${idx}"]`);
  if (!row) return;
  row.dataset.state = state;
  row.querySelector(".step-icon").textContent = STEP_ICONS[state] || "⏸";
  if (detail !== undefined) row.querySelector(".step-detail").textContent = detail;
  if (actionUrl !== undefined) {
    const link = row.querySelector(".step-link");
    if (actionUrl) { link.href = actionUrl; link.hidden = false; }
    else { link.hidden = true; }
  }
}
function updateProgress(status, detail, opts = {}) {
  if (_progressCancelled) return;
  if (status) $("#progressStatus").textContent = status;
  if (detail !== undefined) $("#progressDetail").textContent = detail;
  if (opts.actionUrl) {
    const a = $("#progressOpenAction");
    a.href = opts.actionUrl;
    a.hidden = false;
  }
  if (opts.state === "done") $(".progress-spinner").classList.add("done");
  if (opts.state === "error") $(".progress-spinner").classList.add("error");
}
function hideProgress() { $("#progressBackdrop").hidden = true; }

// One-shot poller. workflowFile is e.g. "refresh-stats.yml".
// triggeredAt is a JS timestamp (Date.now()) captured right before dispatch.
async function pollWorkflowAndReload(workflowFile, triggeredAt, friendlyTitle) {
  if (!window.CC_REPO) {
    // No repo configured — fall back to the old "queued" toast.
    toast(`${friendlyTitle} queued — reload manually after the workflow commits (~30–60s).`, "ok");
    return;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const start = Date.now();
  const runsUrl = `https://api.github.com/repos/${window.CC_REPO}/actions/workflows/${workflowFile}/runs?per_page=10`;

  let run = null;
  // Phase 1: find the run created by our dispatch. workflow_dispatch can take
  // a moment to materialize a run, so we patiently retry.
  while (Date.now() - start < WORKFLOW_TIMEOUT_MS && !_progressCancelled) {
    try {
      const r = await fetch(runsUrl, { cache: "no-store" });
      const data = await r.json();
      // Find the most recent workflow_dispatch run created at or after our trigger.
      const candidate = (data.workflow_runs || []).find(w =>
        w.event === "workflow_dispatch" &&
        new Date(w.created_at).getTime() >= triggeredAt - 5000);
      if (candidate) { run = candidate; break; }
      updateProgress("Waiting for run to spawn…",
        `${Math.round((Date.now() - start) / 1000)}s elapsed`);
    } catch (e) {
      updateProgress("Polling…", "Couldn't reach GitHub API: " + e.message);
    }
    await sleep(WORKFLOW_POLL_MS);
  }

  if (_progressCancelled) return;
  if (!run) {
    updateProgress("Timed out waiting for the run to start.", "", { state: "error" });
    return;
  }

  updateProgress("Running…", "", { actionUrl: run.html_url });

  // Phase 2: poll the run's status until completed.
  const runUrl = `https://api.github.com/repos/${window.CC_REPO}/actions/runs/${run.id}`;
  while (Date.now() - start < WORKFLOW_TIMEOUT_MS && !_progressCancelled) {
    await sleep(WORKFLOW_POLL_MS);
    let cur;
    try {
      cur = await fetch(runUrl, { cache: "no-store" }).then(r => r.json());
    } catch (e) {
      updateProgress("Running…", "Couldn't reach GitHub: " + e.message);
      continue;
    }
    const elapsed = Math.round((Date.now() - new Date(run.created_at).getTime()) / 1000);
    if (cur.status === "completed") {
      if (cur.conclusion === "success") {
        updateProgress(`Workflow succeeded in ${elapsed}s. Waiting for Pages to publish…`, "");
        await sleep(PAGES_REBUILD_WAIT_MS);
        if (_progressCancelled) return;
        updateProgress("Reloading…", "", { state: "done" });
        location.reload();
      } else {
        updateProgress(`Workflow ended: ${cur.conclusion}`,
          "Open the GitHub link above to inspect logs.",
          { state: "error" });
      }
      return;
    }
    updateProgress(`Status: ${cur.status} (${elapsed}s)`, "");
  }

  if (!_progressCancelled) {
    updateProgress("Timed out waiting for workflow to finish.",
      "It may still be running — check the GitHub link above.",
      { state: "error", actionUrl: run.html_url });
  }
}

// Single-step variant: polls one workflow's most recent dispatch run until
// it finishes. Reports state via updateStep(stepIdx, …) — does NOT reload
// the page. Returns {ok, elapsed, run} on success, {ok:false, error} on
// failure or timeout. Used by refreshAll().
async function pollWorkflowForStep(workflowFile, triggeredAt, stepIdx) {
  if (!window.CC_REPO) return { ok: false, error: "CC_REPO not set" };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const runsUrl = `https://api.github.com/repos/${window.CC_REPO}/actions/workflows/${workflowFile}/runs?per_page=10`;

  // Phase 1: find the run we just spawned.
  const findStart = Date.now();
  let run = null;
  while (Date.now() - findStart < WORKFLOW_TIMEOUT_MS && !_progressCancelled) {
    try {
      const r = await fetch(runsUrl, { cache: "no-store" });
      const data = await r.json();
      const candidate = (data.workflow_runs || []).find(w =>
        w.event === "workflow_dispatch" &&
        new Date(w.created_at).getTime() >= triggeredAt - 5000);
      if (candidate) { run = candidate; break; }
      updateStep(stepIdx, "running", "waiting for run…");
    } catch (e) {
      updateStep(stepIdx, "running", "polling…");
    }
    await sleep(WORKFLOW_POLL_MS);
  }
  if (_progressCancelled) return { ok: false, error: "cancelled" };
  if (!run) return { ok: false, error: "timed out waiting for run to start" };

  updateStep(stepIdx, "running", "queued", run.html_url);

  // Phase 2: poll the run until completed.
  const runStart = new Date(run.created_at).getTime();
  const runUrl = `https://api.github.com/repos/${window.CC_REPO}/actions/runs/${run.id}`;
  while (Date.now() - runStart < WORKFLOW_TIMEOUT_MS && !_progressCancelled) {
    await sleep(WORKFLOW_POLL_MS);
    let cur;
    try { cur = await fetch(runUrl, { cache: "no-store" }).then(r => r.json()); }
    catch { continue; }
    const elapsed = Math.round((Date.now() - runStart) / 1000);
    if (cur.status === "completed") {
      if (cur.conclusion === "success") {
        return { ok: true, elapsed, run };
      }
      return { ok: false, error: cur.conclusion || "failed", elapsed, run };
    }
    updateStep(stepIdx, "running", `${cur.status} (${elapsed}s)`, run.html_url);
  }
  return _progressCancelled
    ? { ok: false, error: "cancelled" }
    : { ok: false, error: "timed out" };
}

// "Refresh all" — fires the three workflows in sequence (NOT parallel, to
// avoid SHA conflicts since refresh-rosters also writes stats.json). The
// modal shows three rows that tick from pending → running → done as each
// workflow completes. After the last one, waits for Pages to publish and
// reloads.
async function refreshAll() {
  if (!REMOTE_BACKEND) {
    // Local server.py mode — just chain the three in sequence using the
    // synchronous local-mode paths inside each refresh fn.
    await refreshStats();
    await refreshRosters();
    await refreshDashboard();
    return;
  }

  const steps = [
    { name: "Stats",                    endpoint: "/refresh-stats",     file: "refresh-stats.yml",     body: {} },
    { name: "Rosters & pitcher index",  endpoint: "/refresh-rosters",   file: "refresh-rosters.yml",   body: {} },
    { name: "Dashboard",                endpoint: "/refresh-dashboard", file: "refresh-dashboard.yml", body: { days: 14 } },
  ];
  showProgressSteps("Refresh all", steps.map(s => s.name));

  for (let i = 0; i < steps.length; i++) {
    if (_progressCancelled) return;
    const s = steps[i];
    updateStep(i, "running", "triggering…");
    const triggeredAt = Date.now();
    try {
      await backendPost(s.endpoint, s.body);
    } catch (e) {
      if (e.message === "unauthorized") return;
      updateStep(i, "error", e.message);
      return;
    }
    const result = await pollWorkflowForStep(s.file, triggeredAt, i);
    if (!result.ok) {
      updateStep(i, "error", result.error,
        result.run ? result.run.html_url : undefined);
      return;
    }
    updateStep(i, "done", `${result.elapsed}s`,
      result.run ? result.run.html_url : undefined);
  }

  // All three done — wait for Pages to publish, then reload.
  $("#progressStatus").textContent = "All refreshes complete. Waiting for Pages to publish…";
  await new Promise(r => setTimeout(r, PAGES_REBUILD_WAIT_MS));
  if (_progressCancelled) return;
  $("#progressStatus").textContent = "Reloading…";
  $(".progress-spinner").classList.add("done");
  location.reload();
}

async function refreshStats() {
  if (!REMOTE_BACKEND) {
    // Local server.py mode — original behavior (synchronous fetch + render).
    toast("Refreshing stats…");
    try { await backendPost("/refresh-stats"); }
    catch (e) { toast("Refresh failed: " + e.message, "error"); return; }
    state.stats = await fetch("data/stats.json", { cache: "no-store" }).then(r => r.json());
    const lu = $("#lastUpdated");
    if (lu) lu.textContent = `last updated ${new Date(state.stats.fetchedAt).toLocaleString()}`;
    renderChart();
    toast("Stats refreshed (" + Object.keys(state.stats.byPlayerId).length + " pitchers)", "ok");
    return;
  }
  const triggeredAt = Date.now();
  showProgress("Refresh stats", "Triggering GitHub Action…");
  try {
    await backendPost("/refresh-stats");
  } catch (e) {
    if (e.message !== "unauthorized") updateProgress("Couldn't dispatch", e.message, { state: "error" });
    return;
  }
  await pollWorkflowAndReload("refresh-stats.yml", triggeredAt, "Refresh stats");
}

async function refreshDashboard() {
  if (!confirm("Refresh RP Dashboard? Fetches ~14 days of completed games (~30–60s).")) return;
  if (!REMOTE_BACKEND) {
    toast("Refreshing dashboard…");
    try { await backendPost("/refresh-dashboard", { days: 14 }); }
    catch (e) { toast("Dashboard refresh failed: " + e.message, "error"); return; }
    state.dashboard = await fetch("data/dashboard.json", { cache: "no-store" }).then(r => r.json());
    toast("Dashboard refreshed (" + state.dashboard.windowStart + " → " + state.dashboard.windowEnd + ")", "ok");
    if (!$("#dashboardModal").hidden) renderDashboardModal(currentDashboardTeam);
    return;
  }
  const triggeredAt = Date.now();
  showProgress("Refresh dashboard", "Triggering GitHub Action…");
  try {
    await backendPost("/refresh-dashboard", { days: 14 });
  } catch (e) {
    if (e.message !== "unauthorized") updateProgress("Couldn't dispatch", e.message, { state: "error" });
    return;
  }
  await pollWorkflowAndReload("refresh-dashboard.yml", triggeredAt, "Refresh dashboard");
}

async function refreshRosters() {
  if (!confirm("Refresh rosters? This re-pulls 40-man for all 30 teams (~30s).")) return;
  if (!REMOTE_BACKEND) {
    toast("Refreshing rosters…");
    try { await backendPost("/refresh-rosters"); }
    catch (e) { toast("Refresh failed: " + e.message, "error"); return; }
    state.rosters = await fetch("data/rosters.json", { cache: "no-store" }).then(r => r.json());
    renderChart();
    toast("Rosters refreshed", "ok");
    return;
  }
  const triggeredAt = Date.now();
  showProgress("Refresh rosters", "Triggering GitHub Action…");
  try {
    await backendPost("/refresh-rosters");
  } catch (e) {
    if (e.message !== "unauthorized") updateProgress("Couldn't dispatch", e.message, { state: "error" });
    return;
  }
  await pollWorkflowAndReload("refresh-rosters.yml", triggeredAt, "Refresh rosters");
}

// ===== RP Dashboard modal =====
// Click a team name in the chart -> opens a large overlay showing that team's
// reliever appearance grid for the last ~14 days. Data comes from
// data/dashboard.json (built by dashboard_data.py).

let currentDashboardTeam = null;

function teamAbbrFromTeam(team) {
  if (!team) return null;
  if (team.teamId) return state.rosters?.[String(team.teamId)]?.abbr || null;
  return null;
}

function fmtSituation(g) {
  if (!g || g.inning == null) return "—";
  const ord = n => ({1:"1st",2:"2nd",3:"3rd"}[n] || `${n}th`);
  return `${ord(g.inning)} (${g.teamScore}-${g.opponentScore})`;
}

function fmtResult(g) {
  if (!g) return "";
  let s = `${g.IP ?? "?"} (${g.BF ?? "?"}b ${g.PT ?? "?"}p)`;
  if (g.R) s += ` ${g.R}R`;
  if (g.W) s += " W";
  else if (g.L) s += " L";
  else if (g.SV) s += " SV";
  else if (g.HLD) s += " HLD";
  if (g.BS) s += " BS";
  return s;
}

function classForSituation(li) {
  if (li == null) return "";
  if (li > 2) return "li-high";
  if (li > 1) return "li-med";
  return "";
}

function fmtDateLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[m - 1]} ${d}`;
}

function openDashboardModal(team) {
  currentDashboardTeam = team;
  renderDashboardModal(team);
  const modal = $("#dashboardModal");
  modal.hidden = false;
  // Focus close button so ESC works immediately.
  setTimeout(() => $("#dashClose")?.focus(), 0);
}

function closeDashboardModal() {
  $("#dashboardModal").hidden = true;
  currentDashboardTeam = null;
}

function renderDashboardModal(team) {
  const abbr = teamAbbrFromTeam(team);
  $("#dashTeamName").textContent =
    `${abbr ? abbr + " · " : ""}${team.teamName}`;

  const body = $("#dashBody");
  body.innerHTML = "";

  if (!state.dashboard) {
    $("#dashWindow").textContent = "no dashboard data yet";
    const empty = document.createElement("div");
    empty.className = "dashboard-empty";
    empty.innerHTML = `
      <p>No dashboard data on disk.</p>
      <p class="subtle">Click <strong>Refresh dashboard</strong> in the topbar to fetch the last 14 days of completed games. This takes ~30–60 seconds.</p>`;
    body.appendChild(empty);
    return;
  }

  const d = state.dashboard;
  $("#dashWindow").textContent =
    `${d.windowStart} → ${d.windowEnd} · pulled ${new Date(d.fetchedAt).toLocaleString()}`;

  const relievers = (abbr && d.byTeam[abbr]) ? d.byTeam[abbr] : [];
  if (!relievers.length) {
    const empty = document.createElement("div");
    empty.className = "dashboard-empty";
    empty.textContent = abbr
      ? `No reliever appearances for ${abbr} in this window.`
      : "Team not bound to an MLB org — no dashboard data.";
    body.appendChild(empty);
    return;
  }

  body.appendChild(buildDashboardGrid(d.dates, relievers));
}

function buildDashboardGrid(dates, relievers) {
  const wrap = document.createElement("div");
  wrap.className = "dash-grid-wrap";

  const table = document.createElement("table");
  table.className = "dash-grid";

  // Header row
  const thead = document.createElement("thead");
  const headTr = document.createElement("tr");
  const blank = document.createElement("th");
  blank.colSpan = 2;
  blank.className = "dash-corner";
  headTr.appendChild(blank);
  dates.forEach(iso => {
    const th = document.createElement("th");
    th.textContent = fmtDateLabel(iso);
    th.title = iso;
    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
  table.appendChild(thead);

  // Body rows: each reliever gets a name+hand cell (rowspan=2) and two rows of
  // 14 date cells (situation on top, result on bottom).
  const tbody = document.createElement("tbody");
  relievers.forEach(r => {
    const sitTr = document.createElement("tr");
    sitTr.className = "row-situation";
    const nameTd = document.createElement("td");
    nameTd.rowSpan = 2;
    nameTd.className = "dash-name";
    nameTd.textContent = r.name;
    sitTr.appendChild(nameTd);
    const handTd = document.createElement("td");
    handTd.rowSpan = 2;
    handTd.className = "dash-hand";
    handTd.textContent = r.hand || "";
    sitTr.appendChild(handTd);

    const resTr = document.createElement("tr");
    resTr.className = "row-result";

    dates.forEach(iso => {
      const g = r.games[iso];
      const sit = document.createElement("td");
      sit.className = "dash-cell dash-cell-situation";
      const res = document.createElement("td");
      res.className = "dash-cell dash-cell-result";
      if (g) {
        sit.textContent = fmtSituation(g);
        sit.title = `LI: ${g.leverageIndex ?? "—"}`;
        const liCls = classForSituation(g.leverageIndex);
        if (liCls) sit.classList.add(liCls);
        res.textContent = fmtResult(g);
        res.classList.add(g.R ? "runs-bad" : "runs-clean");
      }
      sitTr.appendChild(sit);
      resTr.appendChild(res);
    });

    tbody.appendChild(sitTr);
    tbody.appendChild(resTr);
  });
  table.appendChild(tbody);

  wrap.appendChild(table);
  return wrap;
}

// ===== misc =====

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

let toastTimer = null;
function toast(msg, cls) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + (cls || "");
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

// ===== wiring =====

document.addEventListener("DOMContentLoaded", () => {
  if (VIEW_MODE) document.body.classList.add("view-mode");

  // Edit-mode-only button wiring. The view page omits these buttons entirely;
  // we still guard with `?.` so a stale DOM doesn't crash.
  if (!VIEW_MODE) {
    $("#btnRefreshAll")?.addEventListener("click", refreshAll);
    // Legacy individual-refresh buttons are no longer in the topbar but the
    // handlers stay defined for code reuse (refreshAll calls them in local
    // mode). If someone re-adds the buttons later, these wire-ups still work.
    $("#btnRefreshStats")?.addEventListener("click", refreshStats);
    $("#btnRefreshDashboard")?.addEventListener("click", refreshDashboard);
    $("#btnRefreshRosters")?.addEventListener("click", refreshRosters);
    $("#btnAddQhDate")?.addEventListener("click", () => {
      const today = new Date().toISOString().slice(0, 10);
      state.quickhits.unshift({ date: today, league: "AL", entries: {} });
      state.quickhits.unshift({ date: today, league: "NL", entries: {} });
      renderQuickHits();
      markDirty();
    });
  }

  // Dashboard modal close handlers — both modes (modal is read-only-friendly).
  $("#dashClose")?.addEventListener("click", closeDashboardModal);
  $("#dashboardModal")?.addEventListener("click", e => {
    if (e.target.id === "dashboardModal") closeDashboardModal();
  });

  // Progress modal: Hide button stops polling and dismisses the dialog. The
  // workflow keeps running in GitHub — user can use the "View on GitHub" link
  // to watch it there instead.
  $("#progressCancel")?.addEventListener("click", () => {
    _progressCancelled = true;
    hideProgress();
    toast("Hidden — workflow continues running on GitHub. Reload manually to pick up new data.", "ok");
  });

  $$(".tab").forEach(tab => tab.addEventListener("click", () => {
    $$(".tab").forEach(t => t.classList.toggle("active", t === tab));
    const view = tab.dataset.view;
    $$(".view").forEach(v => v.classList.remove("active"));
    $("#" + view + "View").classList.add("active");
  }));

  $("#qhLeagueFilter")?.addEventListener("change", renderQuickHits);
  $("#qhSearch")?.addEventListener("input", renderQuickHits);

  // Save on Cmd/Ctrl+S (edit only); ESC closes dashboard modal in any mode.
  window.addEventListener("keydown", e => {
    if (!VIEW_MODE && (e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault(); saveAll();
    }
    if (e.key === "Escape" && !$("#dashboardModal").hidden) closeDashboardModal();
    if (e.key === "Escape" && !$("#progressBackdrop").hidden) {
      _progressCancelled = true;
      hideProgress();
    }
  });
  // Warn on unload if dirty (edit only).
  window.addEventListener("beforeunload", e => {
    if (!VIEW_MODE && state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  // Re-measure --sticky-top whenever the viewport changes width (legend
  // wrapping changes the tabs height). Debounced via rAF so we don't thrash.
  let _stickyRAF = null;
  window.addEventListener("resize", () => {
    if (_stickyRAF) cancelAnimationFrame(_stickyRAF);
    _stickyRAF = requestAnimationFrame(recomputeStickyTop);
  });

  // Sign-in dialog (editor + remote backend). Wire it before loadAll so a
  // mis-typed password doesn't lose data — the editor doesn't render until
  // we have a password to send with /save.
  const signInBtn = $("#signInSubmit");
  const signInInput = $("#signInPassword");
  const signOutBtn = $("#btnSignOut");
  async function submitPassword() {
    const pw = signInInput.value.trim();
    if (!pw) return;
    // For remote backend, verify the password against the Worker before
    // letting the user in. The Worker's /verify endpoint requires the same
    // password gate as every other write endpoint, so a mismatch returns
    // 401 immediately. Local server.py mode skips this — it doesn't auth.
    if (REMOTE_BACKEND) {
      $("#signInError").textContent = "";
      signInBtn.disabled = true;
      signInBtn.textContent = "Verifying…";
      try {
        const r = await fetch(API + "/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pw }),
        });
        if (r.status === 401) {
          $("#signInError").textContent = "Wrong password.";
          return;
        }
        if (!r.ok) {
          $("#signInError").textContent = `Server error (${r.status}).`;
          return;
        }
      } catch (e) {
        $("#signInError").textContent = "Couldn't reach server: " + e.message;
        return;
      } finally {
        signInBtn.disabled = false;
        signInBtn.textContent = "Sign in";
      }
    }
    setPassword(pw);
    hideSignIn();
    // Show the sign-out button once auth is established.
    if (signOutBtn) signOutBtn.hidden = false;
  }
  signInBtn?.addEventListener("click", submitPassword);
  signInInput?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); submitPassword(); }
  });
  signOutBtn?.addEventListener("click", () => {
    setPassword("");
    showSignIn("Signed out.");
  });

  if (needsSignIn()) {
    showSignIn();
  } else if (REMOTE_BACKEND && signOutBtn) {
    signOutBtn.hidden = false;
  }

  loadAll().catch(e => {
    document.body.innerHTML = `<pre style="padding:24px;color:#ef6f6c">load failed: ${e.message}\n\nIf running locally, did you run python3 build_data.py first, then start server.py?</pre>`;
  });
});
