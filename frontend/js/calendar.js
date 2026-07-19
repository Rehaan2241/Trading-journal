const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let currentYear;
let currentMonth; // 1-12
let currentSetupId = "";
let currentAccountType = ""; // "" = All, "Master", "Phase"

function initCalendarPage() {
  const today = new Date();
  currentYear = today.getFullYear();
  currentMonth = today.getMonth() + 1;

  document.getElementById("btn-prev-month").addEventListener("click", () => shiftMonth(-1));
  document.getElementById("btn-next-month").addEventListener("click", () => shiftMonth(1));
  document.getElementById("btn-today").addEventListener("click", () => {
    const t = new Date();
    currentYear = t.getFullYear();
    currentMonth = t.getMonth() + 1;
    loadCalendar();
  });

  const strategySelect = document.getElementById("calendar-strategy");
  Api.getStrategies()
    .then((strategies) => {
      strategySelect.innerHTML =
        `<option value="">All Strategies</option>` +
        strategies.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
    })
    .catch((e) => console.error("Failed to load strategies for calendar filter", e));
  strategySelect.addEventListener("change", () => {
    currentSetupId = strategySelect.value;
    loadCalendar();
  });

  // All / Master / Phase account filter -- drives BOTH the day cells and
  // the weekly/monthly summary column, so there's one clear, consistent
  // scope instead of the day cells mixing Master+Phase while the summary
  // silently meant Master only.
  const accountTypeSelect = document.getElementById("calendar-account-type");
  accountTypeSelect.addEventListener("change", () => {
    currentAccountType = accountTypeSelect.value;
    loadCalendar();
  });

  // Popup modal close handlers
  document.getElementById("day-detail-close").addEventListener("click", closeDayDetail);
  document.getElementById("day-detail-modal").addEventListener("click", (e) => {
    if (e.target.id === "day-detail-modal") closeDayDetail(); // click on backdrop
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDayDetail();
  });

  loadCalendar();
}

function shiftMonth(delta) {
  currentMonth += delta;
  if (currentMonth < 1) { currentMonth = 12; currentYear -= 1; }
  if (currentMonth > 12) { currentMonth = 1; currentYear += 1; }
  loadCalendar();
}

async function loadCalendar() {
  document.getElementById("calendar-month-label").innerText =
    `${MONTH_NAMES[currentMonth - 1]} ${currentYear}`;
  closeDayDetail();

  const grid = document.getElementById("calendar-grid");
  const monthlyPnlNote = document.getElementById("calendar-master-month-pnl");
  try {
    const data = await Api.getCalendar(currentYear, currentMonth, currentSetupId || undefined, currentAccountType || undefined);
    if (monthlyPnlNote) {
      const scopeLabel =
        data.account_type_filter === "Master"
          ? "Master Accounts"
          : data.account_type_filter === "Phase"
          ? "Phase Accounts"
          : "All Accounts";
      monthlyPnlNote.innerHTML = `${scopeLabel} this month: <span class="${pnlClass(data.summary_month_pnl)}">${fmtMoney(data.summary_month_pnl)}</span>`;
    }
    renderCalendarGrid(data.days, data.summary_weekly_pnl);
  } catch (e) {
    grid.innerHTML = `<div class="empty-state">Couldn't load calendar: ${escapeHtml(e.message)}</div>`;
    if (monthlyPnlNote) monthlyPnlNote.innerHTML = "";
  }
}

// Renders the day grid AND, to the right of every horizontal week row, a
// summary cell with that week's P&L for the currently selected account-type
// scope (Week 1, Week 2, ...). Row/week numbering matches exactly how the
// backend groups summary_weekly_pnl (Sunday-start weeks, "Week 1" =
// whichever row day 1 falls into), so the totals shown always line up with
// the days above them.
function renderCalendarGrid(daysData, weeklyPnl) {
  const grid = document.getElementById("calendar-grid");
  const firstOfMonth = new Date(currentYear, currentMonth - 1, 1);
  const startDow = firstOfMonth.getDay(); // 0 = Sunday
  const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
  const weeklyPnlByWeek = new Map((weeklyPnl || []).map((w) => [w.week_number, w.pnl]));

  let html = DOW_NAMES.map((d) => `<div class="calendar-dow">${d}</div>`).join("");
  html += `<div class="calendar-dow calendar-week-dow">Weekly P/L</div>`;

  let cellsInRow = 0;
  let weekNumber = 1;

  const appendWeekSummaryCell = () => {
    const pnl = weeklyPnlByWeek.get(weekNumber);
    html += `
      <div class="calendar-week-summary">
        <span class="week-label">Week ${weekNumber}</span>
        <span class="${pnl !== undefined ? pnlClass(pnl) : ""}">${pnl !== undefined ? fmtMoney(pnl) : "—"}</span>
      </div>
    `;
    weekNumber++;
    cellsInRow = 0;
  };

  for (let i = 0; i < startDow; i++) {
    html += `<div class="calendar-cell empty"></div>`;
    cellsInRow++;
    if (cellsInRow === 7) appendWeekSummaryCell();
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const info = daysData[dateStr];

    if (!info) {
      html += `<div class="calendar-cell"><div class="day-num">${day}</div></div>`;
    } else {
      const overallClass =
        info.overall === "Win" ? "day-win" : info.overall === "Loss" ? "day-loss" : "day-breakeven";

      html += `
        <div class="calendar-cell has-trades ${overallClass}" data-date="${dateStr}">
          <div class="day-num">${day}</div>
          <div class="day-pnl ${pnlClass(info.total_pnl)}">${fmtMoney(info.total_pnl)}</div>
          <div class="day-meta">${info.trade_count} trade${info.trade_count === 1 ? "" : "s"} · ${fmtPct(info.win_rate)}</div>
        </div>
      `;
    }
    cellsInRow++;
    if (cellsInRow === 7) appendWeekSummaryCell();
  }

  // Pad the final, possibly-incomplete week out to 7 day-cells so its
  // summary cell still lines up on the right, then close it out.
  if (cellsInRow > 0) {
    while (cellsInRow < 7) {
      html += `<div class="calendar-cell empty"></div>`;
      cellsInRow++;
    }
    appendWeekSummaryCell();
  }

  grid.innerHTML = html;

  grid.querySelectorAll(".calendar-cell.has-trades").forEach((cell) => {
    cell.addEventListener("click", () => showDayDetail(cell.dataset.date, daysData[cell.dataset.date]));
  });
}

function showDayDetail(dateStr, info) {
  const title = document.getElementById("day-detail-title");
  const body = document.getElementById("day-detail-body");

  title.innerText = `${dateStr} — ${info.trade_count} trade${info.trade_count === 1 ? "" : "s"} · ${fmtMoney(info.total_pnl)} · ${fmtPct(info.win_rate)} win rate`;

  body.innerHTML = `
    <div class="day-detail-list">
      ${info.trades
        .map(
          (t) => `
        <div class="kanban-card" style="margin-bottom:0;" data-id="${t.id}">
          <div class="row1">
            <span>${escapeHtml(t.pair)} <span class="badge ${positionBadgeClass(t.position)}">${t.position}</span></span>
            <span class="${pnlClass(t.pnl)}">${fmtMoney(t.pnl)}</span>
          </div>
          <span class="badge ${resultBadgeClass(t.result)}">${t.result}</span>
          ${t.setup_name ? `<span class="badge badge-setup" style="margin-left:6px;">${escapeHtml(t.setup_name)}</span>` : ""}
        </div>`
        )
        .join("")}
    </div>
  `;

  // Opens as a center popup; clicking a different day just re-renders
  // this same modal's content instead of stacking another one.
  document.getElementById("day-detail-modal").style.display = "flex";

  // Click any trade card to pop the full shared Trade Detail modal on top
  // (screenshots, notes, confluences applied/skipped, etc.) -- same one
  // used on the Outcome board, so there's only one place that builds this
  // view instead of two.
  document.querySelectorAll("#day-detail-body .kanban-card").forEach((card) => {
    card.addEventListener("click", () => {
      openTradeDetailModal(Number(card.dataset.id), () => loadCalendar());
    });
  });
}

function closeDayDetail() {
  const modal = document.getElementById("day-detail-modal");
  if (modal) modal.style.display = "none";
}
