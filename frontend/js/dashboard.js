let charts = {};

function destroyCharts() {
  Object.values(charts).forEach((c) => {
    if (Array.isArray(c)) c.forEach((sub) => sub && sub.destroy());
    else if (c) c.destroy();
  });
  charts = {};
}

const CHART_COLORS = {
  green: "#4caf78",
  red: "#e0605a",
  yellow: "#d3a13a",
  blue: "#3b82f6",
  grid: "#373737",
  text: "#9b9b9b",
};

// Guard against Chart.js failing to load from the CDN (offline / blocked
// network). Without this, the very first line below would throw a
// ReferenceError and, further down, every chart render would silently fail.
const CHARTS_AVAILABLE = typeof Chart !== "undefined";

if (CHARTS_AVAILABLE) {
  Chart.defaults.color = CHART_COLORS.text;
  Chart.defaults.borderColor = CHART_COLORS.grid;
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif";
} else {
  console.error("Chart.js did not load (check your network/CDN access to cdnjs.cloudflare.com). Charts will be skipped, but stats and the pair table will still render.");
}

async function loadDashboard(filters) {
  const grid = document.getElementById("stat-grid");
  try {
    const data = await Api.getDashboard(filters);

    // Each render below is isolated: if one chart fails (bad data shape,
    // missing canvas, Chart.js not loaded, etc.) it no longer wipes out
    // everything else on the page — it just logs the error and leaves
    // that one panel showing a small message.
    safeRender(() => renderStatCards(data.summary), "stat-grid");
    safeRender(() => renderNoSetupBanner(data.summary), "no-setup-banner");
    safeRender(() => renderEquityCurveChart(data.active_account_equity_curves), "equity-curves-grid");
    safeRender(() => renderWinRateChart(data.summary), "chart-winrate");
    safeRender(() => renderPositionChart(data.position_stats), "chart-position");
    safeRender(() => renderStrategyTrendChart(data.strategy_trends), "chart-strategy-trend");
    safeRender(() => renderPairTable(data.pair_stats), "pair-table-wrap");
    safeRender(() => renderSetupTable(data.setup_stats), "setup-table-wrap");
    safeRender(() => renderMistakeBreakdown(data.mistake_stats), "mistake-breakdown-wrap");

    // Confluence win rate only makes sense for ONE strategy at a time (each
    // strategy has its own custom confluences, so mixing them together
    // under "All Trades" would just be a confusing pile of unrelated tags).
    // So this panel only shows up once you've picked a specific strategy
    // from the dropdown up top.
    await safeRenderAsync(() => renderConfluenceWinRatePanel(filters.setup_id), "confluence-winrate-body");
  } catch (e) {
    console.error("Dashboard load failed", e);
    grid.innerHTML = `<div class="empty-state">Couldn't load dashboard: ${escapeHtml(e.message)}</div>`;
  }
}

// Runs fn(); if it throws, logs the real error to the console and shows a
// short inline message in the given element instead of nuking the whole
// dashboard.
function safeRender(fn, fallbackElementId) {
  try {
    fn();
  } catch (e) {
    console.error(`Dashboard panel "${fallbackElementId}" failed to render:`, e);
    const el = document.getElementById(fallbackElementId);
    if (el && !el.dataset.rendered) {
      el.innerHTML = `<div class="empty-state">Couldn't render this panel (${escapeHtml(e.message)})</div>`;
    }
  }
}

// Same as safeRender, but for an async render function.
async function safeRenderAsync(fn, fallbackElementId) {
  try {
    await fn();
  } catch (e) {
    console.error(`Dashboard panel "${fallbackElementId}" failed to render:`, e);
    const el = document.getElementById(fallbackElementId);
    if (el) {
      el.innerHTML = `<div class="empty-state">Couldn't render this panel (${escapeHtml(e.message)})</div>`;
    }
  }
}

function renderStatCards(summary) {
  const grid = document.getElementById("stat-grid");
  const streak = summary.current_streak || { result: null, count: 0 };
  const streakColor =
    streak.result === "Win" ? CHART_COLORS.green : streak.result === "Loss" ? CHART_COLORS.red : CHART_COLORS.yellow;
  const streakText = streak.result
    ? `${streak.count} ${streak.count > 1 ? (streak.result === "Loss" ? "Losses" : streak.result + "s") : streak.result}`
    : "—";

  grid.innerHTML = `
    <div class="stat-card">
      <div class="label">Win Rate</div>
      <div class="value">${fmtPct(summary.win_rate)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Total Trades</div>
      <div class="value">${summary.total_trades}</div>
    </div>
    <div class="stat-card">
      <div class="label">Avg R:R</div>
      <div class="value">${summary.avg_rr !== null ? summary.avg_rr.toFixed(2) + "R" : "—"}</div>
    </div>
    <div class="stat-card">
      <div class="label">Avg Risk % of Account</div>
      <div class="value">${summary.avg_risk_pct !== null && summary.avg_risk_pct !== undefined ? fmtPct(summary.avg_risk_pct) : "—"}</div>
    </div>
    <div class="stat-card">
      <div class="label">Win / Loss / BE</div>
      <div class="value" style="font-size:18px;">
        <span style="color:${CHART_COLORS.green}">${summary.wins}</span> /
        <span style="color:${CHART_COLORS.red}">${summary.losses}</span> /
        <span style="color:${CHART_COLORS.yellow}">${summary.breakevens}</span>
      </div>
    </div>
    <div class="stat-card">
      <div class="label">Current Streak</div>
      <div class="value" style="color:${streakColor};">${streakText}</div>
    </div>
  `;
  grid.dataset.rendered = "1";
}

// Master Account weekly/monthly PnL now lives on the Calendar page (top-left
// monthly note + per-week totals alongside each calendar row), so it always
// sits next to the actual days it came from instead of a separate card here.

// Distinct line colors per active account, cycling if there are more
// accounts than colors defined here.
const EQUITY_CURVE_COLORS = ["#3b82f6", "#4caf78", "#c084fc", "#fbbf24", "#e0605a", "#60a5fa"];

// Renders ONE separate chart per currently active account (rather than a
// single chart with a line per account), each panel clearly labeled with
// the account's own name so it's obvious which account you're looking at.
// This whole section is fed by /api/dashboard's active_account_equity_curves,
// which is always computed across ALL trades on that account regardless of
// the strategy filter below it -- it intentionally never resets/changes
// when that filter is touched.
//
// With several active accounts this can get crowded, so a small checkbox
// filter (persisted in `selectedEquityAccountIds`) lets you pick which
// account(s) actually get charted, independent of the dashboard's own
// strategy filter above.
let allEquityCurves = [];
let selectedEquityAccountIds = null; // null/unset = "show all"

function renderEquityCurveChart(curves) {
  allEquityCurves = curves || [];
  renderEquityAccountFilter(allEquityCurves);
  renderEquityCurveCharts(visibleEquityCurves());
}

function visibleEquityCurves() {
  if (!selectedEquityAccountIds || !selectedEquityAccountIds.size) return allEquityCurves;
  return allEquityCurves.filter((c) => selectedEquityAccountIds.has(c.challenge_id));
}

// A single dropdown, styled and behaving exactly like the "All Trades"
// strategy filter elsewhere on the dashboard: "All Accounts" plus one
// option per currently active account. Picking one narrows the single
// equity chart down to just that account's line; "All Accounts" shows
// every active account's line together.
function renderEquityAccountFilter(curves) {
  const wrap = document.getElementById("equity-account-filter");
  if (!wrap) return;

  // Not worth showing a filter for 0 or 1 account.
  if (curves.length <= 1) {
    wrap.innerHTML = "";
    selectedEquityAccountIds = null;
    return;
  }

  const currentIds = new Set(curves.map((c) => c.challenge_id));
  const stillValid =
    selectedEquityAccountIds &&
    selectedEquityAccountIds.size === 1 &&
    [...selectedEquityAccountIds].every((id) => currentIds.has(id));
  const selectedValue = stillValid ? [...selectedEquityAccountIds][0] : "";

  wrap.innerHTML = `
    <select id="equity-account-select">
      <option value="">All Accounts</option>
      ${curves
        .map(
          (c) =>
            `<option value="${c.challenge_id}" ${c.challenge_id === selectedValue ? "selected" : ""}>${escapeHtml(
              c.name
            )}</option>`
        )
        .join("")}
    </select>
  `;

  document.getElementById("equity-account-select").addEventListener("change", (e) => {
    const val = e.target.value;
    selectedEquityAccountIds = val ? new Set([parseInt(val, 10)]) : null;
    renderEquityCurveCharts(visibleEquityCurves());
  });
}

// ONE chart, one line per selected account (instead of a separate canvas per
// account) -- pick which account(s) show up using the checkbox filter above,
// same way the strategy dropdowns elsewhere let you narrow down a view.
function renderEquityCurveCharts(curves) {
  const body = document.getElementById("equity-curves-body");
  if (!body) return;

  charts.equityCurve && charts.equityCurve.destroy();
  charts.equityCurve = null;

  if (!curves || !curves.length) {
    body.innerHTML = `<div class="empty-state">${
      allEquityCurves.length
        ? "No accounts selected — check one above to see its chart."
        : "No active accounts yet — add one on the Challenges page."
    }</div>`;
    body.dataset.rendered = "1";
    return;
  }

  body.innerHTML = `<canvas id="chart-equity"></canvas>`;
  body.dataset.rendered = "1";

  if (!CHARTS_AVAILABLE) return;

  const ctx = document.getElementById("chart-equity");
  if (!ctx) return;

  // Each account's own trade sequence can be a different length, so the
  // shared x-axis just runs 0 (starting balance) .. the longest sequence,
  // and shorter accounts' lines simply stop (spanGaps) at their last trade.
  const maxLen = Math.max(...curves.map((c) => c.points.length));
  const labels = Array.from({ length: maxLen }, (_, i) => i); // 0 (start), 1, 2, ...

  // Master accounts fold their payout cycle into this same points array (see
  // active_account_equity_curves on the backend): a "payout" point is where
  // the balance drops back down after the profit is withdrawn (e.g. 5000 ->
  // 5050 -> 5095 -> payout -> 5000, cycle repeats). Those points get a
  // distinct color/size and their own tooltip line so the reset is obvious
  // instead of just looking like a loss.
  charts.equityCurve = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: curves.map((c, i) => {
        const lineColor = EQUITY_CURVE_COLORS[i % EQUITY_CURVE_COLORS.length];
        return {
          label: `${c.name} (${c.account_type})`,
          data: c.points.map((p) => p.equity),
          borderColor: lineColor,
          backgroundColor: "transparent",
          tension: 0.2,
          pointRadius: c.points.map((p) => (p.type === "payout" ? 6 : 2)),
          pointStyle: c.points.map((p) => (p.type === "payout" ? "rectRot" : "circle")),
          pointBackgroundColor: c.points.map((p) => (p.type === "payout" ? "#e0605a" : lineColor)),
          pointBorderColor: c.points.map((p) => (p.type === "payout" ? "#e0605a" : lineColor)),
          spanGaps: true,
          _points: c.points, // stashed for tooltip lookup below
        };
      }),
    },
    options: {
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            title: (items) => {
              const ds = items[0].dataset;
              const p = ds._points && ds._points[items[0].dataIndex];
              if (!p || p.type === "start") return "Starting balance";
              if (p.type === "payout") return `Payout on ${p.date}`;
              return `Trade #${items[0].dataIndex} (${p.date})`;
            },
            label: (item) => {
              const ds = item.dataset;
              const p = ds._points && ds._points[item.dataIndex];
              const base = `${item.dataset.label}: ${fmtMoney(item.parsed.y)}`;
              if (p && p.type === "payout") {
                return [base, `Withdrawn: ${fmtMoney(p.payout_amount)} · cycle reset`];
              }
              return base;
            },
          },
        },
      },
      scales: {
        x: { title: { display: true, text: "Trade # on that account (♦ = payout / cycle reset)" } },
        y: { ticks: { callback: (v) => fmtMoney(v) } },
      },
    },
  });
}

function renderWinRateChart(summary) {
  if (!CHARTS_AVAILABLE) return;
  const ctx = document.getElementById("chart-winrate");
  charts.winrate && charts.winrate.destroy();
  charts.winrate = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Win", "Loss", "Breakeven"],
      datasets: [
        {
          data: [summary.wins, summary.losses, summary.breakevens],
          backgroundColor: [CHART_COLORS.green, CHART_COLORS.red, CHART_COLORS.yellow],
          borderWidth: 0,
        },
      ],
    },
    options: {
      plugins: { legend: { position: "bottom" } },
      cutout: "65%",
    },
  });
}

function renderPositionChart(positionStats) {
  if (!CHARTS_AVAILABLE) return;
  const ctx = document.getElementById("chart-position");
  charts.position && charts.position.destroy();
  const longs = positionStats.Long || { count: 0, win_rate: 0, total_pnl: 0 };
  const shorts = positionStats.Short || { count: 0, win_rate: 0, total_pnl: 0 };

  charts.position = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Long", "Short"],
      datasets: [
        {
          label: "Trade Count",
          data: [longs.count, shorts.count],
          backgroundColor: [CHART_COLORS.green, CHART_COLORS.red],
          borderRadius: 4,
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: (item) => {
              const s = item.dataIndex === 0 ? longs : shorts;
              return [`Win rate: ${s.win_rate}%`, `Total PnL: ${fmtMoney(s.total_pnl)}`];
            },
          },
        },
      },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}

// Distinct line colors per strategy, cycling if there are more strategies
// than colors defined here.
const STRATEGY_TREND_COLORS = ["#3b82f6", "#c084fc", "#4caf78", "#fbbf24", "#e0605a", "#60a5fa"];

function renderStrategyTrendChart(strategyTrends) {
  if (!CHARTS_AVAILABLE) return;
  const ctx = document.getElementById("chart-strategy-trend");
  charts.strategyTrend && charts.strategyTrend.destroy();

  if (!strategyTrends || !strategyTrends.length) {
    return; // safeRender leaves the panel's existing "no data" message alone
  }

  const maxLen = Math.max(...strategyTrends.map((s) => s.points.length));
  const labels = Array.from({ length: maxLen }, (_, i) => i); // trade #0, #1, ...

  charts.strategyTrend = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: strategyTrends.map((s, i) => ({
        label: s.setup_name,
        data: s.points.map((p) => p.win_rate),
        borderColor: STRATEGY_TREND_COLORS[i % STRATEGY_TREND_COLORS.length],
        backgroundColor: "transparent",
        tension: 0.25,
        pointRadius: 2,
        spanGaps: true,
      })),
    },
    options: {
      plugins: { legend: { position: "bottom" } },
      scales: {
        x: { title: { display: true, text: "Trade # under that strategy" } },
        y: { min: 0, max: 100, ticks: { callback: (v) => v + "%" } },
      },
    },
  });
}

// Fetches and renders the win-rate-by-confluence panel for ONE strategy.
// Hidden entirely when no single strategy is selected (setupId falsy).
async function renderConfluenceWinRatePanel(setupId) {
  const panel = document.getElementById("panel-confluence-winrate");
  const body = document.getElementById("confluence-winrate-body");
  const title = document.getElementById("confluence-winrate-title");

  if (!setupId) {
    panel.style.display = "none";
    return;
  }

  panel.style.display = "block";
  body.innerHTML = `<div class="empty-state">Loading…</div>`;

  const data = await Api.getStrategyPerformance(setupId, {});
  title.innerText = `Confluence Win Rate — ${data.strategy_name}`;

  if (!data.confluence_stats.length) {
    body.innerHTML = `<div class="computed-hint">No confluences defined on this strategy yet — add some from the Strategy page.</div>`;
    return;
  }

  body.innerHTML = `
    <div class="perf-conf-list">
      ${data.confluence_stats
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
        .join("")}
    </div>
  `;
}

function renderSetupTable(setupStats) {
  const wrap = document.getElementById("setup-table-wrap");
  if (!wrap) return;
  if (!setupStats.length) {
    wrap.innerHTML = `<div class="empty-state">No trades yet.</div>`;
    wrap.dataset.rendered = "1";
    return;
  }

  // Mark the best-performing strategy by win rate (needs at least 3 trades
  // to mean anything) with a trophy, as a quick "what's working" signal.
  const eligible = setupStats.filter((s) => s.count >= 3);
  const best = eligible.length ? eligible.reduce((a, b) => (b.win_rate > a.win_rate ? b : a)) : null;

  wrap.innerHTML = `
    <table>
      <thead>
        <tr><th>Setup</th><th>Trades</th><th>Win Rate</th><th>Total PnL</th></tr>
      </thead>
      <tbody>
        ${setupStats
          .map(
            (s) => `
          <tr>
            <td>${best && s.setup === best.setup ? "🏆 " : ""}${escapeHtml(s.setup)}</td>
            <td>${s.count}</td>
            <td>${fmtPct(s.win_rate)}</td>
            <td class="${pnlClass(s.total_pnl)}">${fmtMoney(s.total_pnl)}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
  wrap.dataset.rendered = "1";
}

function renderPairTable(pairStats) {
  const wrap = document.getElementById("pair-table-wrap");
  if (!pairStats.length) {
    wrap.innerHTML = `<div class="empty-state">No trades yet.</div>`;
    wrap.dataset.rendered = "1";
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead>
        <tr><th>Pair</th><th>Trades</th><th>Win Rate</th><th>Total PnL</th></tr>
      </thead>
      <tbody>
        ${pairStats
          .map(
            (p) => `
          <tr>
            <td>${escapeHtml(p.pair)}</td>
            <td>${p.count}</td>
            <td>${fmtPct(p.win_rate)}</td>
            <td class="${pnlClass(p.total_pnl)}">${fmtMoney(p.total_pnl)}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
  wrap.dataset.rendered = "1";
}

function renderNoSetupBanner(summary) {
  const banner = document.getElementById("no-setup-banner");
  if (!banner) return;
  if (summary.no_setup_count > 0) {
    banner.style.display = "block";
    banner.innerHTML = `⚠ ${summary.no_setup_count} of ${summary.total_trades} trades (${summary.no_setup_pct}%) have no strategy tagged — they're invisible to confluence win-rate, strategy trend, and setup performance stats.`;
  } else {
    banner.style.display = "none";
  }
}

// "60% of my losses involve moving my stop loss" -- the headline metric is
// pct_of_losses, so that's what drives the bar width; count/win-rate/pnl
// are shown as supporting context per tag.
function renderMistakeBreakdown(mistakeStats) {
  const wrap = document.getElementById("mistake-breakdown-wrap");
  if (!wrap) return;
  if (!mistakeStats || !mistakeStats.length) {
    wrap.innerHTML = `<div class="empty-state">No mistake/emotion tags logged on any trades in this filter yet.</div>`;
    wrap.dataset.rendered = "1";
    return;
  }

  wrap.innerHTML = `
    <div class="perf-conf-list">
      ${mistakeStats
        .map(
          (m) => `
        <div class="perf-conf-row">
          <div class="perf-conf-label">
            ${escapeHtml(m.name)}
            <span class="computed-hint" style="margin:0;">(${m.count} trade${m.count === 1 ? "" : "s"}, ${m.loss_count} loss${m.loss_count === 1 ? "" : "es"}, win rate ${fmtPct(m.win_rate)}, ${fmtMoney(m.total_pnl)})</span>
          </div>
          <div class="perf-bar-track">
            <div class="perf-bar-fill" style="width:${m.pct_of_losses}%; background: var(--red);"></div>
          </div>
          <div class="perf-conf-value">${fmtPct(m.pct_of_losses)} of losses</div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
  wrap.dataset.rendered = "1";
}
