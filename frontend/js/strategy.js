// Confluences are built dynamically now: no fixed checkbox list. Each row in
// this array is { id, name } -- `id` is set when the row came from an
// existing saved confluence, null for a brand-new one you just added.
// Priority is implicit: it's just the row's position in the array
// (index 0 = priority 1, the highest).
let confluenceRows = [];
let performanceStrategy = null;

async function initStrategyPage() {
  const todayIso = todayLocalIso();
  document.getElementById("perf-date-from").max = todayIso;
  document.getElementById("perf-date-to").max = todayIso;

  document.getElementById("btn-new-strategy").addEventListener("click", () => openStrategyModal());
  document.getElementById("btn-strategy-cancel").addEventListener("click", closeStrategyModal);
  document.getElementById("strategy-form").addEventListener("submit", handleStrategySubmit);
  document.getElementById("btn-add-confluence").addEventListener("click", () => {
    confluenceRows.push({ id: null, name: "" });
    renderConfluenceBuilder();
  });

  document.getElementById("btn-performance-close").addEventListener("click", closePerformanceModal);
  document.getElementById("perf-account-type").addEventListener("change", refreshPerformance);
  document.getElementById("perf-date-from").addEventListener("change", refreshPerformance);
  document.getElementById("perf-date-to").addEventListener("change", refreshPerformance);

  document.getElementById("strategy-btn-add-mistake-tag").addEventListener("click", handleStrategyAddMistakeTag);
  document.getElementById("strategy-new-mistake-tag").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleStrategyAddMistakeTag();
    }
  });
  await loadStrategyMistakeTags();

  document.getElementById("strategy-btn-add-pair").addEventListener("click", handleStrategyAddPair);
  document.getElementById("strategy-new-pair").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleStrategyAddPair();
    }
  });
  await loadStrategyPairs();

  await loadStrategies();
}

async function loadStrategyPairs() {
  const list = document.getElementById("strategy-pair-list");
  try {
    const pairs = await Api.getPairs();
    if (!pairs.length) {
      list.innerHTML = `<div class="computed-hint" style="margin:0;">No pairs yet — add your first one below.</div>`;
      return;
    }
    list.innerHTML = pairs
      .map(
        (p) => `
        <span class="chip" style="display:inline-flex; align-items:center; gap:6px;">
          ${escapeHtml(p.name)}
          <button type="button" class="mistake-tag-delete" data-id="${p.id}" title="Delete this pair">✕</button>
        </span>
      `
      )
      .join("");
    list.querySelectorAll(".mistake-tag-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this pair?")) return;
        try {
          await Api.deletePair(btn.dataset.id);
          await loadStrategyPairs();
        } catch (err) {
          alert(`Could not delete pair: ${err.message}`);
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="empty-state">Couldn't load pairs: ${escapeHtml(e.message)}</div>`;
  }
}

async function handleStrategyAddPair() {
  const input = document.getElementById("strategy-new-pair");
  const name = input.value.trim();
  if (!name) return;
  try {
    await Api.createPair(name);
    input.value = "";
    await loadStrategyPairs();
  } catch (err) {
    alert(`Could not add pair: ${err.message}`);
  }
}

async function loadStrategyMistakeTags() {
  const list = document.getElementById("strategy-mistake-tag-list");
  try {
    const tags = await Api.getMistakeTags();
    if (!tags.length) {
      list.innerHTML = `<div class="computed-hint" style="margin:0;">No mistake/emotion tags yet — add your first one below.</div>`;
      return;
    }
    list.innerHTML = tags
      .map(
        (t) => `
        <span class="chip chip-mistake" style="display:inline-flex; align-items:center; gap:6px;">
          ${escapeHtml(t.name)}
          <button type="button" class="mistake-tag-delete" data-id="${t.id}" title="Delete this tag">✕</button>
        </span>
      `
      )
      .join("");
    list.querySelectorAll(".mistake-tag-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this mistake tag? It will be removed from any trades that have it tagged.")) return;
        try {
          await Api.deleteMistakeTag(btn.dataset.id);
          await loadStrategyMistakeTags();
        } catch (err) {
          alert(`Could not delete tag: ${err.message}`);
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="empty-state">Couldn't load mistake tags: ${escapeHtml(e.message)}</div>`;
  }
}

async function handleStrategyAddMistakeTag() {
  const input = document.getElementById("strategy-new-mistake-tag");
  const name = input.value.trim();
  if (!name) return;
  try {
    await Api.createMistakeTag(name);
    input.value = "";
    await loadStrategyMistakeTags();
  } catch (err) {
    alert(`Could not add mistake tag: ${err.message}`);
  }
}

async function loadStrategies() {
  const grid = document.getElementById("strategy-grid");
  try {
    const strategies = await Api.getStrategies();
    renderStrategyGrid(strategies);
  } catch (e) {
    grid.innerHTML = `<div class="empty-state">Couldn't load strategies: ${escapeHtml(e.message)}</div>`;
  }
}

function renderStrategyGrid(strategies) {
  const grid = document.getElementById("strategy-grid");
  if (!strategies.length) {
    grid.innerHTML = `<div class="empty-state">No strategies yet. Click "+ New Strategy" to save your first setup (e.g. "Type 1").</div>`;
    return;
  }

  grid.innerHTML = strategies.map((s) => strategyCard(s)).join("");

  strategies.forEach((s) => {
    document.getElementById(`strategy-perf-${s.id}`)?.addEventListener("click", () => openPerformanceModal(s));
    document.getElementById(`strategy-edit-${s.id}`)?.addEventListener("click", () => openStrategyModal(s));
    document.getElementById(`strategy-del-${s.id}`)?.addEventListener("click", () => handleStrategyDelete(s));
    document.getElementById(`strategy-dedupe-${s.id}`)?.addEventListener("click", () => handleDedupeConfluences(s));

    // Quick-glance win rate / PnL right on the card, loaded in the
    // background so the grid itself renders instantly. Skipped for
    // strategies with no trades yet (nothing to show).
    if (s.trade_count) loadQuickStats(s.id);
  });
}

// Merges any duplicate-named confluences on this strategy (see the
// backend docstring on POST /api/strategies/{id}/dedupe-confluences) --
// re-points any trade tags on the removed duplicates onto the kept row
// first, so no trade silently loses its confluence tag.
async function handleDedupeConfluences(strategy) {
  if (
    !confirm(
      `Merge duplicate confluences on "${strategy.name}"? Any trade tagged with a duplicate will keep its tag, just pointed at the merged row instead.`
    )
  )
    return;
  try {
    await Api.dedupeStrategyConfluences(strategy.id);
    await loadStrategies();
  } catch (err) {
    alert(`Could not merge duplicates: ${err.message}`);
  }
}

async function loadQuickStats(strategyId) {
  const el = document.getElementById(`strategy-quickstats-${strategyId}`);
  if (!el) return;
  try {
    const perf = await Api.getStrategyPerformance(strategyId, {});
    const s = perf.summary;
    el.innerHTML = `
      <span>${fmtPct(s.win_rate)} win rate</span>
      <span class="${pnlClass(s.total_pnl)}">${fmtMoney(s.total_pnl)}</span>
    `;
  } catch (e) {
    el.innerHTML = "";
  }
}

function hasDuplicateConfluences(s) {
  const seen = new Set();
  for (const c of s.confluences || []) {
    const key = c.name.trim().toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function strategyCard(s) {
  const deleteBtn = s.trade_count
    ? `<button class="btn btn-sm" disabled title="Delete the ${s.trade_count} trade(s) taken under this strategy first, then you can delete it.">Delete</button>`
    : `<button class="btn btn-sm btn-danger" id="strategy-del-${s.id}">Delete</button>`;

  const dedupeBtn = hasDuplicateConfluences(s)
    ? `<button class="btn btn-sm" id="strategy-dedupe-${s.id}" title="This setup has the same confluence listed more than once -- merge the duplicates without losing any trade tags">🧹 Fix Duplicates</button>`
    : "";

  return `
    <div class="strategy-card">
      <h3>${escapeHtml(s.name)}</h3>
      <div>${confluenceChipsHtml(s)}</div>
      ${s.notes ? `<div class="strategy-notes">${escapeHtml(s.notes)}</div>` : ""}
      <div class="strategy-meta">${s.trade_count} trade${s.trade_count === 1 ? "" : "s"} using this setup</div>
      <div class="strategy-quickstats" id="strategy-quickstats-${s.id}"></div>
      <div class="strategy-actions">
        <button class="btn btn-sm" id="strategy-perf-${s.id}">📊 Performance</button>
        <button class="btn btn-sm" id="strategy-edit-${s.id}">Edit</button>
        ${deleteBtn}
        ${dedupeBtn}
      </div>
    </div>
  `;
}

// ---------- Confluence builder (add / reorder / remove) ----------

function renderConfluenceBuilder() {
  const wrap = document.getElementById("confluence-builder");
  if (!confluenceRows.length) {
    wrap.innerHTML = `<div class="computed-hint" style="margin:0;">No confluences yet — click "+ Add confluence" below.</div>`;
    return;
  }

  wrap.innerHTML = confluenceRows
    .map(
      (row, i) => `
      <div class="confluence-row ${confluenceLevelClass(i + 1)}" data-idx="${i}">
        <span class="priority-num">${i + 1}</span>
        <input type="text" class="confluence-row-name" data-idx="${i}" placeholder="e.g. Liquidity Sweep" value="${escapeHtml(row.name)}" />
        <button type="button" class="btn btn-sm" data-action="up" data-idx="${i}" ${i === 0 ? "disabled" : ""} title="Raise priority">↑</button>
        <button type="button" class="btn btn-sm" data-action="down" data-idx="${i}" ${i === confluenceRows.length - 1 ? "disabled" : ""} title="Lower priority">↓</button>
        <button type="button" class="btn btn-sm btn-danger" data-action="remove" data-idx="${i}" title="Remove">✕</button>
      </div>
    `
    )
    .join("");

  wrap.querySelectorAll(".confluence-row-name").forEach((input) => {
    input.addEventListener("input", (e) => {
      confluenceRows[Number(e.target.dataset.idx)].name = e.target.value;
    });
  });

  wrap.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      const action = btn.dataset.action;
      if (action === "remove") {
        confluenceRows.splice(idx, 1);
      } else if (action === "up" && idx > 0) {
        [confluenceRows[idx - 1], confluenceRows[idx]] = [confluenceRows[idx], confluenceRows[idx - 1]];
      } else if (action === "down" && idx < confluenceRows.length - 1) {
        [confluenceRows[idx + 1], confluenceRows[idx]] = [confluenceRows[idx], confluenceRows[idx + 1]];
      }
      renderConfluenceBuilder();
    });
  });
}

// ---------- Add / Edit modal ----------

function openStrategyModal(strategy = null) {
  document.getElementById("strategy-form").reset();
  document.getElementById("strategy-modal-title").innerText = strategy ? "Edit Strategy" : "New Strategy";
  document.getElementById("strategy-id").value = strategy?.id || "";
  document.getElementById("f-strategy-name").value = strategy?.name || "";
  document.getElementById("f-strategy-notes").value = strategy?.notes || "";

  confluenceRows = strategy?.confluences?.length
    ? strategy.confluences
        .slice()
        .sort((a, b) => a.priority - b.priority)
        .map((c) => ({ id: c.id, name: c.name }))
    : [];
  renderConfluenceBuilder();

  document.getElementById("strategy-modal").style.display = "flex";
}

function closeStrategyModal() {
  document.getElementById("strategy-modal").style.display = "none";
}

async function handleStrategySubmit(e) {
  e.preventDefault();

  const confluences = confluenceRows
    .map((r) => ({ id: r.id, name: r.name.trim() }))
    .filter((r) => r.name);

  const payload = {
    name: document.getElementById("f-strategy-name").value.trim(),
    notes: document.getElementById("f-strategy-notes").value || null,
    confluences,
  };

  const strategyId = document.getElementById("strategy-id").value;

  try {
    if (strategyId) {
      await Api.updateStrategy(strategyId, payload);
    } else {
      await Api.createStrategy(payload);
    }
    closeStrategyModal();
    loadStrategies();
  } catch (err) {
    alert(`Could not save strategy: ${err.message}`);
  }
}

async function handleStrategyDelete(strategy) {
  if (!confirm(`Delete "${strategy.name}"? This cannot be undone.`)) return;
  try {
    await Api.deleteStrategy(strategy.id);
    loadStrategies();
  } catch (err) {
    alert(`Could not delete strategy: ${err.message}`);
  }
}

// ---------- Performance modal (monitor win rate etc. per strategy) ----------

function openPerformanceModal(strategy) {
  performanceStrategy = strategy;
  document.getElementById("performance-modal-title").innerText = `${strategy.name} — Performance`;
  document.getElementById("perf-account-type").value = "";
  document.getElementById("perf-date-from").value = "";
  document.getElementById("perf-date-to").value = "";
  document.getElementById("performance-modal").style.display = "flex";
  refreshPerformance();
}

function closePerformanceModal() {
  document.getElementById("performance-modal").style.display = "none";
  performanceStrategy = null;
}

async function refreshPerformance() {
  if (!performanceStrategy) return;
  const body = document.getElementById("performance-body");
  body.innerHTML = `<div class="empty-state">Loading…</div>`;

  const filters = {
    account_type: document.getElementById("perf-account-type").value,
    date_from: document.getElementById("perf-date-from").value,
    date_to: document.getElementById("perf-date-to").value,
  };

  try {
    const data = await Api.getStrategyPerformance(performanceStrategy.id, filters);
    renderPerformance(data);
  } catch (err) {
    body.innerHTML = `<div class="empty-state">Couldn't load performance: ${escapeHtml(err.message)}</div>`;
  }
}

function renderPerformance(data) {
  const body = document.getElementById("performance-body");
  const s = data.summary;

  if (!s.total_trades) {
    body.innerHTML = `<div class="empty-state">No trades logged under this strategy for the selected filters.</div>`;
    return;
  }

  const confluenceRowsHtml = data.confluence_stats.length
    ? data.confluence_stats
        .map(
          (c) => `
        <div class="perf-conf-row">
          <div class="perf-conf-label">
            <span class="priority-num">${c.priority}</span> ${escapeHtml(c.name)}
            <span class="computed-hint" style="margin:0;">(${c.count} trade${c.count === 1 ? "" : "s"})</span>
          </div>
          <div class="perf-bar-track">
            <div class="perf-bar-fill ${confluenceLevelClass(c.priority)}" style="width:${c.win_rate}%;"></div>
          </div>
          <div class="perf-conf-value">${fmtPct(c.win_rate)}</div>
        </div>
      `
        )
        .join("")
    : `<div class="computed-hint">No confluences defined on this strategy yet.</div>`;

  body.innerHTML = `
    <div class="stat-grid" style="margin-bottom:18px;">
      <div class="stat-card">
        <div class="label">Total PnL</div>
        <div class="value ${s.total_pnl >= 0 ? "positive" : "negative"}">${fmtMoney(s.total_pnl)}</div>
      </div>
      <div class="stat-card">
        <div class="label">Win Rate</div>
        <div class="value">${fmtPct(s.win_rate)}</div>
      </div>
      <div class="stat-card">
        <div class="label">Total Trades</div>
        <div class="value">${s.total_trades}</div>
      </div>
      <div class="stat-card">
        <div class="label">Avg R:R</div>
        <div class="value">${s.avg_rr !== null ? s.avg_rr.toFixed(2) + "R" : "—"}</div>
      </div>
    </div>
    <h3 style="margin:0 0 10px; font-size:14px;">Win Rate by Confluence</h3>
    <div class="perf-conf-list">${confluenceRowsHtml}</div>
  `;
}
