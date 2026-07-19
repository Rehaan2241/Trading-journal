// Confluences are custom and per-strategy now (no fixed/global list). Every
// object that carries confluences (a trade, or a strategy) exposes a
// `confluences` array of { id, name, priority }. There are only 4 color
// "levels" in the stylesheet (conf-lvl-1..4), so priorities beyond 4 cycle
// back through them rather than needing new colors defined.
function confluenceLevelClass(priority) {
  const level = ((Number(priority) - 1) % 4 + 4) % 4 + 1;
  return `conf-lvl-${level}`;
}

// Renders the confluence chips for a trade-like object (or a strategy), in
// priority order, colored by priority level (cycling every 4).
function confluenceChipsHtml(obj) {
  const list = (obj.confluences || []).slice().sort((a, b) => a.priority - b.priority);
  if (!list.length) return `<span class="chip">—</span>`;
  return list
    .map(
      (c) =>
        `<span class="chip on ${confluenceLevelClass(c.priority)}" title="Priority ${c.priority}">${c.priority}. ${escapeHtml(c.name)}</span>`
    )
    .join("");
}

// Renders mistake/emotion tag chips for a trade, in a consistent "warning"
// style (distinct from confluence chips, since these flag what went WRONG
// rather than what confluence was applied).
function mistakeChipsHtml(trade) {
  const list = trade.mistake_tags || [];
  if (!list.length) return `<span class="chip">—</span>`;
  return list.map((m) => `<span class="chip chip-mistake">${escapeHtml(m.name)}</span>`).join("");
}

// ==========================================================================
// Per-timeframe chart screenshots. A trade's `screenshot_urls` is still
// just List[str] on the backend, but each entry is now optionally tagged
// with which timeframe it's a screenshot of, encoded as "1m|/uploads/xxx.png".
// Screenshots saved before this existed are plain "/uploads/xxx.png" with no
// tag -- everything here treats those as untagged rather than breaking.
// ==========================================================================
const SCREENSHOT_TIMEFRAMES = ["1m", "3m", "5m", "15m", "1h", "4h"];

function parseScreenshotEntry(raw) {
  if (!raw || typeof raw !== "string") return { tf: null, url: raw };
  const sep = raw.indexOf("|");
  if (sep > 0) {
    const tf = raw.slice(0, sep);
    if (SCREENSHOT_TIMEFRAMES.includes(tf)) return { tf, url: raw.slice(sep + 1) };
  }
  return { tf: null, url: raw };
}

function makeScreenshotEntry(tf, url) {
  return `${tf}|${url}`;
}

// Returns every screenshot on a trade as { tf, url }, tagged ones first in
// fixed 1m -> 4h order, followed by any untagged/legacy screenshots (tf:
// null) at the end. Untagged screenshots are NEVER guessed into a
// timeframe slot -- there's no reliable way to know which chart an old,
// untagged screenshot actually is, so guessing just mislabels it. Use
// assignScreenshotTimeframe() (Trades page, Edit Trade) to label them for
// real instead.
function tradeScreenshotsOrdered(trade) {
  const raw = trade?.screenshot_urls || [];
  const byTf = {};
  const untagged = [];
  raw.forEach((entry) => {
    const { tf, url } = parseScreenshotEntry(entry);
    if (tf && !byTf[tf]) byTf[tf] = url;
    else untagged.push(url);
  });
  const ordered = SCREENSHOT_TIMEFRAMES.filter((tf) => byTf[tf]).map((tf) => ({ tf, url: byTf[tf] }));
  untagged.forEach((url) => ordered.push({ tf: null, url }));
  return ordered;
}

function renderNav(activePage) {
  const items = [
    { id: "dashboard", href: "dashboard.html", icon: "📊", label: "Dashboard" },
    { id: "trades", href: "trades.html", icon: "📋", label: "Trades" },
    { id: "pictures", href: "pictures.html", icon: "🖼️", label: "Pictures" },
    { id: "strategy", href: "strategy.html", icon: "🧩", label: "Strategy" },
    { id: "challenges", href: "challenges.html", icon: "🎯", label: "Challenges" },
    { id: "calendar", href: "calendar.html", icon: "📅", label: "Calendar" },
  ];

  const nav = document.getElementById("app-nav");
  if (!nav) return;

  nav.innerHTML = items
    .map(
      (item) => `
      <a href="${item.href}" class="${item.id === activePage ? "active" : ""}">
        <span>${item.icon}</span><span>${item.label}</span>
      </a>`
    )
    .join("");
}

function fmtMoney(value) {
  const num = Number(value) || 0;
  const sign = num < 0 ? "-" : "";
  return `${sign}$${Math.abs(num).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtPct(value) {
  if (value === null || value === undefined) return "—";
  return `${Number(value).toFixed(2)}%`;
}

function pnlClass(value) {
  return Number(value) >= 0 ? "pnl-positive" : "pnl-negative";
}

function resultBadgeClass(result) {
  if (result === "Win") return "badge-win";
  if (result === "Loss") return "badge-loss";
  return "badge-breakeven";
}

function positionBadgeClass(position) {
  return position === "Long" ? "badge-long" : "badge-short";
}

function accountTypeBadgeClass(accountType) {
  return accountType === "Phase" ? "badge-phase" : "badge-master";
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ==========================================================================
// Shared "Trade Detail" modal — a single, reusable read-only popup for
// "show me everything about this trade" (screenshots, mistakes/notes,
// account + strategy info, and which confluences were/weren't applied).
// Any page that loads nav.js + api.js can call openTradeDetailModal(id):
// used by the Outcome board's cards, and by Calendar's day-detail trades.
// This is the one place that builds this view, instead of every page
// re-implementing its own version of "show full trade info".
// ==========================================================================

function ensureTradeDetailModal() {
  if (document.getElementById("trade-detail-modal")) return;

  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="modal-overlay" id="trade-detail-modal" style="display:none;">
      <div class="modal trade-detail-modal">
        <div class="modal-header-row">
          <h2 id="trade-detail-title">Trade Details</h2>
          <button type="button" class="btn btn-sm" id="trade-detail-close">✕ Close</button>
        </div>
        <div id="trade-detail-body"><div class="empty-state">Loading…</div></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-danger" id="trade-detail-delete">Delete Trade</button>
          <button type="button" class="btn btn-primary" id="trade-detail-edit">Edit Trade</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap.firstElementChild);

  document.getElementById("trade-detail-close").addEventListener("click", closeTradeDetailModal);
  document.getElementById("trade-detail-modal").addEventListener("click", (e) => {
    if (e.target.id === "trade-detail-modal") closeTradeDetailModal(); // backdrop click
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTradeDetailModal();
  });
}

function closeTradeDetailModal() {
  const modal = document.getElementById("trade-detail-modal");
  if (modal) modal.style.display = "none";
}

// onDeleted(tradeId) is called after a successful delete from inside the
// modal, so the page that opened it can refresh its own list/board.
async function openTradeDetailModal(tradeId, onDeleted) {
  ensureTradeDetailModal();
  document.getElementById("trade-detail-modal").style.display = "flex";
  const body = document.getElementById("trade-detail-body");
  body.innerHTML = `<div class="empty-state">Loading…</div>`;

  try {
    const trade = await Api.getTrade(tradeId);
    let strategy = null;
    if (trade.setup_id) {
      try {
        strategy = await Api.getStrategy(trade.setup_id);
      } catch (e) {
        console.error("Couldn't load strategy for trade detail", e);
      }
    }
    renderTradeDetailBody(trade, strategy);

    document.getElementById("trade-detail-edit").onclick = () => {
      window.location.href = `trades.html?edit=${trade.id}`;
    };
    document.getElementById("trade-detail-delete").onclick = async () => {
      if (!confirm("Delete this trade? This cannot be undone.")) return;
      try {
        await Api.deleteTrade(trade.id);
        closeTradeDetailModal();
        if (typeof onDeleted === "function") onDeleted(trade.id);
      } catch (err) {
        alert(`Could not delete trade: ${err.message}`);
      }
    };
  } catch (e) {
    body.innerHTML = `<div class="empty-state">Couldn't load trade: ${escapeHtml(e.message)}</div>`;
  }
}

function renderTradeDetailBody(trade, strategy) {
  const title = document.getElementById("trade-detail-title");
  title.innerHTML = `
    ${escapeHtml(trade.pair)}
    <span class="badge ${positionBadgeClass(trade.position)}">${trade.position}</span>
    <span class="badge ${resultBadgeClass(trade.result)}">${trade.result}</span>
  `;

  const rrDisplay =
    trade.result !== "Loss" && trade.rr_ratio !== null && trade.rr_ratio !== undefined
      ? trade.rr_ratio.toFixed(2) + "R"
      : "—";

  // Confluences actually tagged on the trade vs. the rest of that strategy's
  // list that were NOT applied -- the "what did I skip" view the person
  // specifically asked for.
  const appliedIds = new Set((trade.confluences || []).map((c) => c.id));
  const allConfluences = (strategy?.confluences || []).slice().sort((a, b) => a.priority - b.priority);
  const skippedConfluences = allConfluences.filter((c) => !appliedIds.has(c.id));

  const orderedShots = tradeScreenshotsOrdered(trade);
  const screenshotsHtml = orderedShots.length
    ? `<div class="screenshot-preview-list">
        ${orderedShots
          .map(
            (s, i) => `
          <a href="pictures.html?trade=${trade.id}&tf=${encodeURIComponent(s.tf || "")}" class="screenshot-thumb" title="View ${s.tf || "unlabeled"} in Pictures">
            <img src="${Api.fileUrl(s.url)}" alt="${s.tf || `Screenshot ${i + 1}`}" />
            <span class="screenshot-tf-tag">${s.tf || "unlabeled"}</span>
          </a>
        `
          )
          .join("")}
      </div>`
    : `<div class="computed-hint" style="margin:0;">No screenshots attached.</div>`;

  const confluenceSection = strategy
    ? `
      <div class="trade-detail-section">
        <h4>Confluences Applied</h4>
        <div>${trade.confluences.length ? confluenceChipsHtml(trade) : `<span class="chip">None</span>`}</div>
      </div>
      <div class="trade-detail-section">
        <h4>Confluences Not Applied</h4>
        <div>
          ${
            skippedConfluences.length
              ? skippedConfluences
                  .map((c) => `<span class="chip chip-skipped">${c.priority}. ${escapeHtml(c.name)}</span>`)
                  .join("")
              : `<span class="chip">None — everything on this setup was applied 🎯</span>`
          }
        </div>
      </div>
    `
    : `
      <div class="trade-detail-section">
        <h4>Confluences</h4>
        <div class="computed-hint" style="margin:0;">This trade has no setup, so there's no confluence list.</div>
      </div>
    `;

  const body = document.getElementById("trade-detail-body");
  body.innerHTML = `
    <div class="trade-detail-stats">
      <div><span class="label">Date</span><span>${trade.trade_date}</span></div>
      <div><span class="label">Account</span><span><span class="badge ${accountTypeBadgeClass(trade.account_type)}">${trade.account_type}</span> · $${Number(trade.account_size).toLocaleString()}</span></div>
      <div><span class="label">Strategy</span><span>${trade.setup_name ? `<span class="badge badge-setup">${escapeHtml(trade.setup_name)}</span>` : "— (no setup)"}</span></div>
      <div><span class="label">Challenge</span><span>${trade.challenge_name ? escapeHtml(trade.challenge_name) : "—"}</span></div>
      <div><span class="label">Entry LTF / 4H</span><span>${trade.entry_ltf} / ${trade.candle_4h}</span></div>
      <div><span class="label">PnL</span><span class="${pnlClass(trade.pnl)}">${fmtMoney(trade.pnl)}</span></div>
      <div><span class="label">Per (%)</span><span class="${pnlClass(trade.loss_percentage)}">${fmtPct(trade.loss_percentage)}</span></div>
      <div><span class="label">R:R</span><span>${rrDisplay}</span></div>
      <div><span class="label">Risk Amount</span><span>${trade.risk_amount ? fmtMoney(trade.risk_amount) : "—"}</span></div>
      <div><span class="label">Risk % of Account</span><span>${fmtPct(trade.risk_percentage)}</span></div>
    </div>

    ${confluenceSection}

    <div class="trade-detail-section">
      <h4>Mistakes / Emotions Tagged</h4>
      <div>${mistakeChipsHtml(trade)}</div>
    </div>

    <div class="trade-detail-section">
      <h4>Chart Screenshots</h4>
      ${screenshotsHtml}
    </div>

    <div class="trade-detail-section">
      <h4>Notes / Mistake</h4>
      <div class="computed-hint" style="margin:0; white-space:pre-wrap;">${trade.notes ? escapeHtml(trade.notes) : "No notes recorded for this trade."}</div>
    </div>
  `;
}
