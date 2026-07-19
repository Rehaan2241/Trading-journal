let currentFilters = {};
// Chart screenshots keyed by timeframe, e.g. { "1m": "/uploads/xxx.png" }.
// Only timeframes that actually have an image attached get a key.
let tfScreenshots = {};
// Screenshots on the trade being edited that aren't tagged to a timeframe
// yet (older trades, saved before this feature existed) -- shown as their
// own "assign a timeframe" list rather than guessed into a slot.
let untaggedScreenshots = [];
let selectedPosition = null;
let strategiesCache = [];
let mistakeTagsCache = [];
let challengesCache = [];
let checkedMistakeTagIds = [];
let currentSort = { by: "trade_date", dir: "desc" };
let currentPage = 0;
const PAGE_SIZE = 50;

// #7: tracks whether the New/Edit Trade form has unsaved changes, so we can
// warn before it's lost to a refresh/back/close instead of silently
// discarding it (including already-uploaded screenshots).
let formDirty = false;
// #8: guards the Save button against double-submits (slow network + an
// impatient double-click could otherwise POST the same trade twice).
let isSaving = false;

async function initTradesPage() {
  await populatePairSelect();
  await populateSetupSelect();
  await populateAccountSelect();
  await populateMistakeTagsCache();
  renderFiltersBar("filters-bar", (filters) => {
    currentFilters = filters;
    currentPage = 0;
    loadTrades();
  });

  document.getElementById("btn-new-trade").addEventListener("click", () => openModal());
  document.getElementById("btn-cancel").addEventListener("click", handleCancelClick);
  document.getElementById("trade-form").addEventListener("submit", handleSubmit);

  // #7: any change inside the trade form marks it dirty. Attached once
  // here (not per-openModal) so it doesn't get double-bound; openModal()
  // resets formDirty back to false itself after populating fields.
  document.getElementById("trade-form").addEventListener("input", () => (formDirty = true));
  document.getElementById("trade-form").addEventListener("change", () => (formDirty = true));

  // #7: warn before an accidental refresh/close/back tab loses an in-
  // progress trade (including already-uploaded screenshots, which would
  // otherwise become orphaned files per #1).
  window.addEventListener("beforeunload", (e) => {
    const modalOpen = document.getElementById("trade-modal").style.display === "flex";
    if (modalOpen && formDirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  document.getElementById("f-pnl").addEventListener("input", updateComputedHint);
  document.getElementById("f-risk-amount").addEventListener("input", updateComputedHint);
  document.getElementById("modal-account").addEventListener("change", () => {
    updateAccountSelectHint();
    updateComputedHint();
  });
  document.getElementById("modal-result").addEventListener("change", () => {
    updatePnlLabel();
    updateComputedHint();
  });

  document.getElementById("tf-screenshot-grid").addEventListener("change", handleTfFileInputChange);
  document.getElementById("tf-screenshot-grid").addEventListener("click", handleTfGridRemoveClick);
  document.getElementById("unassigned-screenshot-list").addEventListener("change", handleAssignScreenshotTf);
  document.getElementById("unassigned-screenshot-list").addEventListener("click", handleUnassignedRemoveClick);
  document.getElementById("modal-setup").addEventListener("change", () => handleSetupChange());
  document.getElementById("btn-add-mistake-tag").addEventListener("click", handleAddMistakeTag);
  document.getElementById("f-new-mistake-tag").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddMistakeTag();
    }
  });

  document.getElementById("btn-export-csv").addEventListener("click", (e) => {
    e.preventDefault();
    window.open(Api.exportTradesCsvUrl(currentFilters), "_blank");
  });

  // Import expects exactly the file Export CSV produces (see the backend
  // docstring on /api/trades/import) -- the intended flow is: export from
  // your old device, then import that same file here on a fresh database.
  document.getElementById("btn-import-csv").addEventListener("click", () => {
    document.getElementById("f-import-csv").click();
  });
  document.getElementById("f-import-csv").addEventListener("change", handleImportCsv);

  // Full backup: one .zip with trades.csv + every referenced screenshot,
  // so screenshots actually survive a move to a new device.
  document.getElementById("btn-export-full").addEventListener("click", (e) => {
    e.preventDefault();
    window.open(Api.exportTradesFullUrl(currentFilters), "_blank");
  });
  document.getElementById("btn-import-full").addEventListener("click", () => {
    document.getElementById("f-import-full").click();
  });
  document.getElementById("f-import-full").addEventListener("change", handleImportFull);

  setupToggle(
    "f-position-toggle",
    (val) => (selectedPosition = val),
    "position"
  );

  // Deep link support: links like trades.html?edit=42 (used by the shared
  // Trade Detail modal's "Edit Trade" button on the Outcome/Calendar pages)
  // jump straight into editing that trade instead of just landing on the list.
  const editId = new URLSearchParams(window.location.search).get("edit");
  if (editId) {
    try {
      const trade = await Api.getTrade(editId);
      openModal(trade);
    } catch (e) {
      console.error(`Couldn't open trade #${editId} for editing`, e);
    }
    // Clean the URL so refreshing/closing doesn't reopen the same modal.
    window.history.replaceState({}, "", "trades.html");
  }

  loadNoSetupBanner();
  renderNoAccountBanner();
}

function renderNoAccountBanner() {
  const banner = document.getElementById("no-account-banner");
  const activeCount = challengesCache.filter((c) => c.is_active).length;
  const newTradeBtn = document.getElementById("btn-new-trade");
  if (activeCount === 0) {
    banner.style.display = "block";
    banner.innerHTML = `⚠ You don't have any active challenge accounts yet. Add one on the <a href="challenges.html">Challenges page</a> before logging a trade — every trade has to be linked to an active account.`;
    newTradeBtn.disabled = true;
    newTradeBtn.title = "Add an active challenge account first";
  } else {
    banner.style.display = "none";
    newTradeBtn.disabled = false;
    newTradeBtn.title = "";
  }
}

// Uploads a CSV in exactly the format Export CSV produces. Any pair,
// account, setup, confluence, or mistake tag it references by name that
// doesn't already exist gets auto-created (see the backend docstring on
// POST /api/trades/import) -- this is how a journal moves from one
// device/database to another: Export CSV there, Import CSV here.
async function handleImportCsv(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = ""; // allow re-selecting the same file again later
  if (!file) return;

  const banner = document.getElementById("import-result-banner");
  const importBtn = document.getElementById("btn-import-csv");
  banner.style.display = "block";
  banner.innerHTML = `Importing "${escapeHtml(file.name)}"…`;
  importBtn.disabled = true;

  try {
    const res = await Api.importTradesCsv(file);
    if (res.error_count > 0) {
      banner.innerHTML = `✅ Imported ${res.created} trade(s). ⚠ ${res.error_count} row(s) had errors and were skipped:<br>${res.errors
        .map((err) => escapeHtml(err))
        .join("<br>")}`;
    } else {
      banner.innerHTML = `✅ Imported ${res.created} trade(s) from "${escapeHtml(file.name)}".`;
    }

    // The import may have created new pairs/setups/challenges/mistake tags
    // by name -- refresh every cache that feeds a dropdown on this page
    // (New Trade modal + the filter bar) so they show up immediately
    // instead of only appearing after a manual refresh.
    await Promise.all([populatePairSelect(), populateSetupSelect(), populateAccountSelect(), populateMistakeTagsCache()]);
    renderFiltersBar("filters-bar", (filters) => {
      currentFilters = filters;
      currentPage = 0;
      loadTrades();
    });
    currentPage = 0;
    loadTrades();
    loadNoSetupBanner();
  } catch (err) {
    banner.innerHTML = `❌ Import failed: ${escapeHtml(err.message)}`;
  } finally {
    importBtn.disabled = false;
  }
}

// Uploads a .zip produced by "Export Full Backup" -- trades.csv plus every
// referenced chart screenshot. The backend restores the image files into
// its uploads/ folder and then imports the trades, so screenshots come
// along automatically instead of needing the folder copied over by hand.
async function handleImportFull(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = ""; // allow re-selecting the same file again later
  if (!file) return;

  const banner = document.getElementById("import-result-banner");
  const importBtn = document.getElementById("btn-import-full");
  banner.style.display = "block";
  banner.innerHTML = `Importing "${escapeHtml(file.name)}"…`;
  importBtn.disabled = true;

  try {
    const res = await Api.importTradesFull(file);
    let msg = `✅ Imported ${res.created} trade(s) and restored ${res.images_restored} screenshot(s) from "${escapeHtml(file.name)}".`;
    if (res.error_count > 0) {
      msg += `<br>⚠ ${res.error_count} row(s) had errors and were skipped:<br>${res.errors
        .map((err) => escapeHtml(err))
        .join("<br>")}`;
    }
    if (res.skipped_images && res.skipped_images.length > 0) {
      msg += `<br>⚠ ${res.skipped_images.length} screenshot reference(s) had no matching file in the zip and were skipped.`;
    }
    banner.innerHTML = msg;

    await Promise.all([populatePairSelect(), populateSetupSelect(), populateAccountSelect(), populateMistakeTagsCache()]);
    renderFiltersBar("filters-bar", (filters) => {
      currentFilters = filters;
      currentPage = 0;
      loadTrades();
    });
    currentPage = 0;
    loadTrades();
    loadNoSetupBanner();
  } catch (err) {
    banner.innerHTML = `❌ Import failed: ${escapeHtml(err.message)}`;
  } finally {
    importBtn.disabled = false;
  }
}

async function loadNoSetupBanner() {
  const banner = document.getElementById("no-setup-banner");
  try {
    const { summary } = await Api.getDashboard();
    if (summary.no_setup_count > 0) {
      banner.style.display = "block";
      banner.innerHTML = `⚠ ${summary.no_setup_count} of ${summary.total_trades} trades (${summary.no_setup_pct}%) have no strategy tagged — they won't show up in confluence win-rate or strategy performance stats.`;
    } else {
      banner.style.display = "none";
    }
  } catch (e) {
    console.error("Couldn't load no-setup stat", e);
  }
}

async function populateAccountSelect(currentTrade = null) {
  const select = document.getElementById("modal-account");
  try {
    challengesCache = await Api.getChallenges();
  } catch (e) {
    console.error("Failed to load challenges", e);
    challengesCache = [];
  }

  const active = challengesCache.filter((c) => c.is_active && !c.locked_for_trading);

  // If we're editing a trade whose account is no longer active, still show
  // it (marked inactive) so the existing trade renders correctly and can be
  // saved without being forced to switch accounts -- but it won't be
  // offered for brand new trades.
  let options = active;
  if (currentTrade?.challenge_id && !active.some((c) => c.id === currentTrade.challenge_id)) {
    const linked = challengesCache.find((c) => c.id === currentTrade.challenge_id);
    if (linked) options = [...active, linked];
  }

  select.innerHTML =
    `<option value="">— Select an active account —</option>` +
    options
      .map(
        (c) =>
          `<option value="${c.id}">${escapeHtml(c.name)} — $${Number(c.account_size).toLocaleString()} · ${c.account_type}${!c.is_active ? " (inactive)" : c.locked_for_trading ? ` (${escapeHtml(c.lock_reason || "locked")})` : ""}</option>`
      )
      .join("");

  renderNoAccountBanner();
}

function updateAccountSelectHint() {
  const hint = document.getElementById("account-select-hint");
  const select = document.getElementById("modal-account");
  const challenge = challengesCache.find((c) => String(c.id) === select.value);
  if (!challenge) {
    hint.innerText = "";
    return;
  }
  hint.innerText = `Account size: $${Number(challenge.account_size).toLocaleString()} · ${challenge.account_type}${challenge.daily_drawdown_pct ? ` · Daily DD limit ${challenge.daily_drawdown_pct}%` : ""}`;
}

function selectedAccount() {
  const select = document.getElementById("modal-account");
  return challengesCache.find((c) => String(c.id) === select.value) || null;
}

function setupToggle(containerId, onSelect, kind) {
  const container = document.getElementById(containerId);
  container.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll("button").forEach((b) => b.classList.remove("active-yes", "active-no"));
      const isYesLike = btn.dataset.value === "Long" || btn.dataset.value === "true" || btn.dataset.value === "Master";
      btn.classList.add(isYesLike ? "active-yes" : "active-no");
      onSelect(btn.dataset.value);
    });
  });
}

async function populatePairSelect() {
  // NOTE: this targets the pair select INSIDE the new/edit trade modal
  // (id="modal-pair"). It used to share id="f-pair" with the filter bar's
  // pair dropdown, which caused the wrong value to be read on save.
  const select = document.getElementById("modal-pair");
  try {
    const pairs = await Api.getPairs();
    select.innerHTML = pairs
      .map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`)
      .join("");
  } catch (e) {
    console.error("Failed to load pairs", e);
  }
}

async function populateSetupSelect() {
  const select = document.getElementById("modal-setup");
  try {
    strategiesCache = await Api.getStrategies();
    select.innerHTML = `
      <option value="">— Select a setup first —</option>
      <option value="none">No setup (this trade doesn't have a confluence list)</option>
      ${strategiesCache
        .map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
        .join("")}
    `;
  } catch (e) {
    console.error("Failed to load strategies/setups", e);
  }
}

async function populateMistakeTagsCache() {
  try {
    mistakeTagsCache = await Api.getMistakeTags();
  } catch (e) {
    console.error("Failed to load mistake tags", e);
  }
  renderMistakeTagCheckboxes();
}

function renderMistakeTagCheckboxes() {
  const list = document.getElementById("mistake-tag-list");
  const checkedSet = new Set(checkedMistakeTagIds.map(String));
  if (!mistakeTagsCache.length) {
    list.innerHTML = `<div class="computed-hint" style="margin:0;">No mistake tags yet — add your first one below.</div>`;
    return;
  }
  list.innerHTML = mistakeTagsCache
    .map(
      (m) => `
      <label class="mistake-tag-item">
        <input type="checkbox" class="trade-mistake-checkbox" data-id="${m.id}" ${checkedSet.has(String(m.id)) ? "checked" : ""} />
        ${escapeHtml(m.name)}
        <button type="button" class="mistake-tag-delete" data-id="${m.id}" title="Delete this tag">✕</button>
      </label>
    `
    )
    .join("");

  list.querySelectorAll(".mistake-tag-delete").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      if (!confirm("Delete this mistake tag? It will be removed from any trades that have it tagged.")) return;
      try {
        await Api.deleteMistakeTag(id);
        checkedMistakeTagIds = checkedMistakeTagIds.filter((cid) => String(cid) !== String(id));
        await populateMistakeTagsCache();
      } catch (err) {
        alert(`Could not delete tag: ${err.message}`);
      }
    });
  });
}

async function handleAddMistakeTag() {
  const input = document.getElementById("f-new-mistake-tag");
  const name = input.value.trim();
  if (!name) return;
  checkedMistakeTagIds = getCheckedMistakeTagIds();
  try {
    const tag = await Api.createMistakeTag(name);
    input.value = "";
    checkedMistakeTagIds.push(tag.id);
    await populateMistakeTagsCache();
  } catch (err) {
    alert(`Could not add mistake tag: ${err.message}`);
  }
}

function getCheckedMistakeTagIds() {
  return Array.from(document.querySelectorAll(".trade-mistake-checkbox:checked")).map((el) =>
    parseInt(el.dataset.id, 10)
  );
}

async function loadTrades() {
  const wrap = document.getElementById("trades-table-wrap");
  try {
    const page = await Api.getTrades({
      ...currentFilters,
      sort_by: currentSort.by,
      sort_dir: currentSort.dir,
      limit: PAGE_SIZE,
      offset: currentPage * PAGE_SIZE,
    });
    renderTradesTable(page.items);
    renderPaginationBar(page.total);
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state">Couldn't load trades: ${escapeHtml(e.message)}</div>`;
  }
}

const SORTABLE_COLUMNS = [
  { key: "trade_date", label: "Date" },
  { key: null, label: "Account Type" },
  { key: "pair", label: "Pair" },
  { key: null, label: "Position" },
  { key: "account_size", label: "Account Size" },
  { key: null, label: "Entry LTF" },
  { key: null, label: "4H" },
  { key: null, label: "Setup" },
  { key: "result", label: "Result" },
  { key: "pnl", label: "PnL" },
  { key: null, label: "Per (%)" },
  { key: null, label: "Risk %" },
  { key: null, label: "R:R" },
  { key: null, label: "Confluences" },
  { key: null, label: "Mistakes" },
  { key: null, label: "Chart" },
  { key: null, label: "" },
];

function sortArrow(key) {
  if (currentSort.by !== key) return "";
  return currentSort.dir === "asc" ? " ▲" : " ▼";
}

function renderTradesTable(trades) {
  const wrap = document.getElementById("trades-table-wrap");
  if (!trades.length) {
    wrap.innerHTML = `<div class="empty-state">No trades yet. Click "+ New Trade" to add your first one.</div>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          ${SORTABLE_COLUMNS.map(
            (col) =>
              `<th${col.key ? ` class="sortable-th" data-sort="${col.key}"` : ""}>${col.label}${col.key ? sortArrow(col.key) : ""}</th>`
          ).join("")}
        </tr>
      </thead>
      <tbody>
        ${trades.map((t) => tradeRow(t)).join("")}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll(".sortable-th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (currentSort.by === key) {
        currentSort.dir = currentSort.dir === "asc" ? "desc" : "asc";
      } else {
        currentSort = { by: key, dir: "desc" };
      }
      currentPage = 0;
      loadTrades();
    });
  });

  trades.forEach((t) => {
    document.getElementById(`edit-${t.id}`)?.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also trigger the row's own click-to-detail
      openModal(t);
    });
    document.getElementById(`del-${t.id}`)?.addEventListener("click", (e) => {
      e.stopPropagation();
      handleDelete(t.id);
    });
  });

  // Click anywhere else on a trade's row to open the same shared Trade
  // Detail modal used on the Calendar and Challenges pages (screenshots,
  // confluences applied/skipped, mistakes, notes, etc.) instead of only
  // being able to Edit or Delete from this table.
  wrap.querySelectorAll("tr.trade-row-clickable").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("a")) return; // let screenshot links open normally
      openTradeDetailModal(Number(row.dataset.id), () => loadTrades());
    });
  });
}

function renderPaginationBar(total) {
  const bar = document.getElementById("pagination-bar");
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total <= PAGE_SIZE) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  bar.innerHTML = `
    <button type="button" class="btn btn-sm" id="pg-prev" ${currentPage === 0 ? "disabled" : ""}>← Prev</button>
    <span class="computed-hint" style="margin:0;">Page ${currentPage + 1} of ${totalPages} (${total} trades)</span>
    <button type="button" class="btn btn-sm" id="pg-next" ${currentPage + 1 >= totalPages ? "disabled" : ""}>Next →</button>
  `;
  document.getElementById("pg-prev")?.addEventListener("click", () => {
    if (currentPage > 0) {
      currentPage--;
      loadTrades();
    }
  });
  document.getElementById("pg-next")?.addEventListener("click", () => {
    if (currentPage + 1 < totalPages) {
      currentPage++;
      loadTrades();
    }
  });
}

function screenshotLinksHtml(trade) {
  const shots = tradeScreenshotsOrdered(trade);
  if (!shots.length) return "—";
  return shots
    .map(
      (s) =>
        `<a href="pictures.html?trade=${trade.id}&tf=${encodeURIComponent(s.tf || "")}" title="View ${s.tf || "unlabeled"} in Pictures">📷${s.tf ? " " + s.tf : ""}</a>`
    )
    .join(" ");
}

function tradeRow(t) {
  // R:R is intentionally never shown for Loss trades (backend always
  // returns rr_ratio = null for a Loss, so this just renders the dash).
  const rrDisplay =
    t.result !== "Loss" && t.rr_ratio !== null && t.rr_ratio !== undefined
      ? t.rr_ratio.toFixed(2) + "R"
      : "—";

  return `
    <tr class="trade-row-clickable" data-id="${t.id}">
      <td>${t.trade_date}</td>
      <td><span class="badge ${accountTypeBadgeClass(t.account_type)}">${t.account_type}</span></td>
      <td>${escapeHtml(t.pair)}</td>
      <td><span class="badge ${positionBadgeClass(t.position)}">${t.position}</span></td>
      <td>$${Number(t.account_size).toLocaleString()}</td>
      <td>${t.entry_ltf}</td>
      <td>${t.candle_4h}</td>
      <td>${t.setup_name ? `<span class="badge badge-setup">${escapeHtml(t.setup_name)}</span>` : "—"}</td>
      <td><span class="badge ${resultBadgeClass(t.result)}">${t.result}</span></td>
      <td class="${pnlClass(t.pnl)}">${fmtMoney(t.pnl)}</td>
      <td class="${pnlClass(t.loss_percentage)}">${fmtPct(t.loss_percentage)}</td>
      <td>${fmtPct(t.risk_percentage)}</td>
      <td>${rrDisplay}</td>
      <td>${confluenceChipsHtml(t)}</td>
      <td>${mistakeChipsHtml(t)}</td>
      <td>${screenshotLinksHtml(t)}</td>
      <td>
        <button class="btn btn-sm" id="edit-${t.id}">Edit</button>
        <button class="btn btn-sm btn-danger" id="del-${t.id}">Delete</button>
      </td>
    </tr>
  `;
}

function updatePnlLabel() {
  const result = document.getElementById("modal-result").value;
  const label = document.getElementById("f-pnl-label");
  const pnlInput = document.getElementById("f-pnl");
  if (result === "Loss") {
    label.innerText = "PnL ($) — amount lost (saved as negative automatically)";
    pnlInput.min = "0";
  } else {
    label.innerText = "PnL ($)";
    pnlInput.removeAttribute("min");
  }
}

function signedPnl() {
  const result = document.getElementById("modal-result").value;
  let pnl = parseFloat(document.getElementById("f-pnl").value);
  if (isNaN(pnl)) pnl = 0;
  if (result === "Loss") pnl = -Math.abs(pnl);
  return pnl;
}

function updateComputedHint() {
  const result = document.getElementById("modal-result").value;
  const pnl = signedPnl();
  const accountSize = selectedAccount()?.account_size || 0;
  const riskAmount = parseFloat(document.getElementById("f-risk-amount").value) || 0;

  const pct = accountSize ? ((pnl / accountSize) * 100).toFixed(2) : "0.00";

  // R:R is never computed/shown for Loss trades.
  let rrText = "—";
  if (result !== "Loss" && riskAmount) {
    rrText = (Math.abs(pnl) / Math.abs(riskAmount)).toFixed(2) + "R";
  }

  const riskPct = accountSize && riskAmount ? ((riskAmount / accountSize) * 100).toFixed(2) : null;

  document.getElementById("computed-hint").innerText =
    `PnL: ${fmtMoney(pnl)}  ·  Per (%): ${pct}%  ·  Risk %: ${riskPct !== null ? riskPct + "%" : "—"}  ·  R:R: ${rrText}`;
}

// One slot per timeframe (1m/3m/5m/15m/1h/4h) instead of a single free-for-all
// upload list -- each slot holds at most one image, so it's never ambiguous
// which screenshot is "the 1m one" later on the Pictures page.
function screenshotHintText() {
  const count = Object.keys(tfScreenshots).length;
  return count ? `${count}/${SCREENSHOT_TIMEFRAMES.length} timeframe(s) attached` : "";
}

function renderTfScreenshotGrid() {
  const grid = document.getElementById("tf-screenshot-grid");
  grid.innerHTML = SCREENSHOT_TIMEFRAMES.map((tf) => {
    const url = tfScreenshots[tf];
    return `
      <div class="tf-slot">
        <div class="tf-slot-label">${tf}</div>
        ${
          url
            ? `<div class="tf-slot-preview">
                <img src="${Api.fileUrl(url)}" alt="${tf} screenshot" />
                <button type="button" class="screenshot-remove tf-remove-btn" data-tf="${tf}" title="Remove">✕</button>
              </div>`
            : `<label class="tf-slot-empty" data-tf="${tf}">
                + Add
                <input type="file" accept="image/*" class="tf-file-input" data-tf="${tf}" style="display:none;" />
              </label>`
        }
      </div>
    `;
  }).join("");
}

async function handleTfFileInputChange(e) {
  const input = e.target.closest(".tf-file-input");
  if (!input || !input.files || !input.files[0]) return;
  const tf = input.dataset.tf;
  const file = input.files[0];
  const hint = document.getElementById("screenshot-hint");
  hint.innerText = `Uploading ${tf} screenshot…`;
  try {
    const { url } = await Api.uploadScreenshot(file);
    tfScreenshots[tf] = url;
    renderTfScreenshotGrid();
    hint.innerText = screenshotHintText();
  } catch (err) {
    hint.innerText = `Upload failed for "${file.name}": ${err.message}`;
  }
}

function handleTfGridRemoveClick(e) {
  const btn = e.target.closest(".tf-remove-btn");
  if (!btn) return;
  delete tfScreenshots[btn.dataset.tf];
  renderTfScreenshotGrid();
  document.getElementById("screenshot-hint").innerText = screenshotHintText();
}

// Screenshots saved before per-timeframe tagging existed show up here,
// separate from the 6 slots above, so they can be assigned for real
// instead of guessed. Picking a timeframe moves the image into that slot;
// slots that are already filled aren't offered, so assigning never
// silently overwrites an existing tagged screenshot.
function renderUnassignedScreenshots() {
  const wrap = document.getElementById("unassigned-screenshot-wrap");
  const list = document.getElementById("unassigned-screenshot-list");
  if (!untaggedScreenshots.length) {
    wrap.style.display = "none";
    list.innerHTML = "";
    return;
  }
  wrap.style.display = "block";
  list.innerHTML = untaggedScreenshots
    .map((url, i) => {
      const availableTfs = SCREENSHOT_TIMEFRAMES.filter((tf) => !tfScreenshots[tf]);
      return `
        <div class="unassigned-shot" data-idx="${i}">
          <img src="${Api.fileUrl(url)}" alt="Unlabeled screenshot ${i + 1}" />
          <select class="unassigned-tf-select" data-idx="${i}">
            <option value="">Assign timeframe…</option>
            ${availableTfs.map((tf) => `<option value="${tf}">${tf}</option>`).join("")}
          </select>
          <button type="button" class="btn btn-sm btn-danger unassigned-remove-btn" data-idx="${i}" title="Delete this screenshot">✕</button>
        </div>
      `;
    })
    .join("");
}

function handleAssignScreenshotTf(e) {
  const select = e.target.closest(".unassigned-tf-select");
  if (!select || !select.value) return;
  const idx = Number(select.dataset.idx);
  const tf = select.value;
  const url = untaggedScreenshots[idx];
  if (!url || tfScreenshots[tf]) return; // slot filled elsewhere between renders -- ignore
  tfScreenshots[tf] = url;
  untaggedScreenshots.splice(idx, 1);
  renderTfScreenshotGrid();
  renderUnassignedScreenshots();
  document.getElementById("screenshot-hint").innerText = screenshotHintText();
}

function handleUnassignedRemoveClick(e) {
  const btn = e.target.closest(".unassigned-remove-btn");
  if (!btn) return;
  if (!confirm("Remove this screenshot from the trade?")) return;
  untaggedScreenshots.splice(Number(btn.dataset.idx), 1);
  renderUnassignedScreenshots();
}

// Setup gates the confluence section: pick a setup ("Type 1", etc.) before
// the confluence checkboxes appear. Those checkboxes come from that
// strategy's own custom confluence list and are ALWAYS unchecked by
// default -- there's no fixed/predefined confluence set to auto-check
// anymore, so you always choose which ones actually applied to this trade.
function handleSetupChange(checkedIds = []) {
  const value = document.getElementById("modal-setup").value;
  const list = document.getElementById("confluence-list");
  const gateHint = document.getElementById("confluence-gate-hint");
  const notesHint = document.getElementById("setup-notes-hint");

  if (!value) {
    list.style.display = "none";
    list.innerHTML = "";
    gateHint.style.display = "block";
    gateHint.innerText = "Select a setup above to tag confluences.";
    notesHint.innerText = "";
    return;
  }

  if (value === "none") {
    list.style.display = "none";
    list.innerHTML = "";
    gateHint.style.display = "block";
    gateHint.innerText = "This trade has no setup, so there's no confluence list to tag.";
    notesHint.innerText = "";
    return;
  }

  const strategy = strategiesCache.find((s) => String(s.id) === String(value));
  notesHint.innerText = strategy?.notes ? `Setup notes: ${strategy.notes}` : "";

  const confluences = (strategy?.confluences || []).slice().sort((a, b) => a.priority - b.priority);

  if (!confluences.length) {
    list.style.display = "none";
    list.innerHTML = "";
    gateHint.style.display = "block";
    gateHint.innerText = `"${strategy?.name || "This setup"}" doesn't have any confluences defined yet — add some from the Strategy page.`;
    return;
  }

  gateHint.style.display = "none";
  list.style.display = "flex";
  const checkedSet = new Set(checkedIds.map(String));
  list.innerHTML = confluences
    .map(
      (c) => `
      <label class="confluence-item ${confluenceLevelClass(c.priority)}">
        <span class="priority-num">${c.priority}</span>
        <input type="checkbox" class="trade-confluence-checkbox" data-id="${c.id}" ${checkedSet.has(String(c.id)) ? "checked" : ""} />
        ${escapeHtml(c.name)}
      </label>
    `
    )
    .join("");
}

function getCheckedConfluenceIds() {
  return Array.from(document.querySelectorAll(".trade-confluence-checkbox:checked")).map((el) =>
    parseInt(el.dataset.id, 10)
  );
}

async function openModal(trade = null) {
  document.getElementById("trade-form").reset();
  // Reset AFTER .reset() and BEFORE the fields below get populated, since
  // programmatically setting .value also fires "input"/"change" — this
  // stops the initial population itself from being mistaken for a real
  // unsaved edit.
  formDirty = false;
  tfScreenshots = {};
  untaggedScreenshots = [];
  if (trade?.screenshot_urls?.length) {
    tradeScreenshotsOrdered(trade).forEach(({ tf, url }) => {
      if (tf) tfScreenshots[tf] = url;
      else untaggedScreenshots.push(url);
    });
  }
  renderTfScreenshotGrid();
  renderUnassignedScreenshots();
  document.getElementById("screenshot-hint").innerText = screenshotHintText();

  document.getElementById("modal-title").innerText = trade ? "Edit Trade" : "New Trade";
  document.getElementById("trade-id").value = trade?.id || "";

  const todayIso = todayLocalIso();
  document.getElementById("f-trade-date").max = todayIso; // no logging trades for a day that hasn't happened yet
  document.getElementById("f-trade-date").value = trade?.trade_date || todayIso;
  document.getElementById("modal-pair").value = trade?.pair || "";
  document.getElementById("f-new-pair").value = "";
  document.getElementById("modal-entry-ltf").value = trade?.entry_ltf || "1m";
  document.getElementById("modal-candle-4h").value = trade?.candle_4h || "3:30";
  document.getElementById("modal-result").value = trade?.result || "Win";
  // Show the loss amount as a positive number in the field; it's converted
  // back to negative automatically on save (see signedPnl()).
  document.getElementById("f-pnl").value =
    trade?.pnl !== undefined && trade?.pnl !== null ? Math.abs(trade.pnl) : "";
  document.getElementById("f-risk-amount").value = trade?.risk_amount ?? "";
  document.getElementById("f-notes").value = trade?.notes || "";

  checkedMistakeTagIds = (trade?.mistake_tags || []).map((m) => m.id);
  renderMistakeTagCheckboxes();

  // Trading account (challenge) select -- re-populated per open so a trade
  // whose account has since gone inactive still shows up (tagged
  // "(inactive)") for editing purposes, while new trades only ever see
  // active accounts.
  await populateAccountSelect(trade);
  document.getElementById("modal-account").value = trade?.challenge_id ? String(trade.challenge_id) : "";
  updateAccountSelectHint();

  // Setup select + confluence gate. When editing a trade, its already-saved
  // confluence ids are passed through so those checkboxes come back checked
  // -- everything else in the setup's list starts unchecked, never
  // auto-filled from the strategy's definition.
  const setupSelect = document.getElementById("modal-setup");
  const savedConfluenceIds = (trade?.confluences || []).map((c) => c.id);
  if (trade?.setup_id) {
    setupSelect.value = String(trade.setup_id);
  } else if (trade) {
    setupSelect.value = "none";
  } else {
    setupSelect.value = "";
  }
  handleSetupChange(savedConfluenceIds);

  selectedPosition = trade?.position || "Long";
  syncToggleUI("f-position-toggle", trade?.position === "Short" ? "Short" : "Long");

  updatePnlLabel();
  updateComputedHint();
  // Populating the fields above fires input/change events that would have
  // flipped formDirty back to true — clear it once more now that the form
  // reflects the (possibly existing) trade, right before showing it.
  formDirty = false;
  document.getElementById("trade-modal").style.display = "flex";
}

function syncToggleUI(containerId, value) {
  const container = document.getElementById(containerId);
  container.querySelectorAll("button").forEach((btn) => {
    btn.classList.remove("active-yes", "active-no");
    if (btn.dataset.value === value) {
      const isYesLike = value === "Long" || value === "true" || value === "Master";
      btn.classList.add(isYesLike ? "active-yes" : "active-no");
    }
  });
}

function closeModal() {
  document.getElementById("trade-modal").style.display = "none";
  formDirty = false;
}

// #7: Cancel button confirms first if the form has unsaved changes,
// instead of silently discarding them (and any already-uploaded
// screenshots) the moment it's clicked.
function handleCancelClick() {
  if (formDirty && !confirm("Discard unsaved changes to this trade?")) return;
  closeModal();
}

async function handleSubmit(e) {
  e.preventDefault();

  // #8: ignore a second submit (double-click, or slow network + impatient
  // re-click) while the first one is still in flight.
  if (isSaving) return;
  const saveBtn = document.getElementById("btn-save");
  const originalBtnText = saveBtn.textContent;
  isSaving = true;
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  try {
    // Reads from #modal-pair (the trade form's own pair select), NOT the
    // filter bar's pair dropdown.
    let pair = document.getElementById("modal-pair").value;
    const newPair = document.getElementById("f-new-pair").value.trim();
    if (newPair) {
      try {
        const created = await Api.createPair(newPair);
        pair = created.name;
        await populatePairSelect();
      } catch (err) {
        alert(`Could not add pair: ${err.message}`);
        return;
      }
    }

    const result = document.getElementById("modal-result").value;

    const setupValue = document.getElementById("modal-setup").value;
    const setupId = setupValue && setupValue !== "none" ? parseInt(setupValue, 10) : null;

    const accountValue = document.getElementById("modal-account").value;
    if (!accountValue) {
      alert("Select the trading account (challenge) this trade was taken on.");
      return;
    }
    const challengeId = parseInt(accountValue, 10);

    const payload = {
      trade_date: document.getElementById("f-trade-date").value,
      challenge_id: challengeId,
      position: selectedPosition || "Long",
      pair,
      entry_ltf: document.getElementById("modal-entry-ltf").value,
      candle_4h: document.getElementById("modal-candle-4h").value,
      setup_id: setupId,
      result,
      // Loss trades are always stored as a negative number, computed
      // automatically from whatever positive amount was typed in.
      pnl: signedPnl(),
      // Risk amount is captured for every result (not just wins) -- it's
      // needed for the Risk % of Account discipline metric regardless of
      // outcome. R:R itself still only ever shows for non-Loss trades
      // (the backend always returns rr_ratio = null for a Loss).
      risk_amount: document.getElementById("f-risk-amount").value
        ? parseFloat(document.getElementById("f-risk-amount").value)
        : null,
      confluence_ids: setupId ? getCheckedConfluenceIds() : [],
      mistake_tag_ids: getCheckedMistakeTagIds(),
      screenshot_urls: [
        ...SCREENSHOT_TIMEFRAMES.filter((tf) => tfScreenshots[tf]).map((tf) => makeScreenshotEntry(tf, tfScreenshots[tf])),
        ...untaggedScreenshots,
      ],
      notes: document.getElementById("f-notes").value || null,
    };

    const tradeId = document.getElementById("trade-id").value;

    try {
      if (tradeId) {
        await Api.updateTrade(tradeId, payload);
      } else {
        await Api.createTrade(payload);
      }
      closeModal();
      loadTrades();
    } catch (err) {
      alert(`Could not save trade: ${err.message}`);
    }
  } finally {
    isSaving = false;
    saveBtn.disabled = false;
    saveBtn.textContent = originalBtnText;
  }
}

async function handleDelete(id) {
  if (!confirm("Delete this trade? This cannot be undone.")) return;
  try {
    await Api.deleteTrade(id);
    loadTrades();
  } catch (err) {
    alert(`Could not delete trade: ${err.message}`);
  }
}
