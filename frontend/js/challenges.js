let challengesCache = [];
let selectedChallengeActive = "true";
let selectedChallengeAccountType = "Master";

async function initChallengesPage() {
  document.getElementById("btn-new-challenge").addEventListener("click", () => openChallengeModal());
  document.getElementById("btn-challenge-cancel").addEventListener("click", closeChallengeModal);
  document.getElementById("challenge-form").addEventListener("submit", handleChallengeSubmit);

  document.getElementById("challenge-trades-close").addEventListener("click", closeChallengeTradesModal);
  document.getElementById("challenge-trades-modal").addEventListener("click", (e) => {
    if (e.target.id === "challenge-trades-modal") closeChallengeTradesModal(); // backdrop click
  });

  document.getElementById("f-challenge-active-toggle").querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .getElementById("f-challenge-active-toggle")
        .querySelectorAll("button")
        .forEach((b) => b.classList.remove("active-yes", "active-no"));
      btn.classList.add(btn.dataset.value === "true" ? "active-yes" : "active-no");
      selectedChallengeActive = btn.dataset.value;
    });
  });

  document.getElementById("f-challenge-account-type-toggle").querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .getElementById("f-challenge-account-type-toggle")
        .querySelectorAll("button")
        .forEach((b) => b.classList.remove("active-yes", "active-no"));
      btn.classList.add(btn.dataset.value === "Master" ? "active-yes" : "active-no");
      selectedChallengeAccountType = btn.dataset.value;
    });
  });

  await loadChallenges();
}

async function loadChallenges() {
  const grid = document.getElementById("challenge-grid");
  try {
    challengesCache = await Api.getChallenges();
    if (!challengesCache.length) {
      grid.innerHTML = `<div class="empty-state">No challenges yet. Click "+ New Challenge" to set one up, then link your Phase trades to it.</div>`;
      return;
    }
    grid.innerHTML = `<div class="empty-state" id="challenge-loading">Loading progress…</div>`;

    const withProgress = await Promise.all(
      challengesCache.map(async (c) => {
        try {
          const progress = await Api.getChallengeProgress(c.id);
          return { challenge: c, progress };
        } catch (e) {
          console.error(`Couldn't load progress for challenge ${c.id}`, e);
          return { challenge: c, progress: null };
        }
      })
    );

    // Breached accounts (max or daily drawdown) sink to the bottom of the
    // grid -- they're done, there's nothing actionable left to do with
    // them, so they shouldn't compete for attention with accounts you're
    // still actively trading. Everything else keeps the order the API gave
    // (is_active desc, start_date desc).
    const isBreached = (p) => !!(p && (p.breached_drawdown || p.breached_daily_drawdown));
    withProgress.sort((a, b) => Number(isBreached(a.progress)) - Number(isBreached(b.progress)));

    const cards = withProgress.map(({ challenge: c, progress }) => challengeCardHtml(c, progress));
    grid.innerHTML = cards.join("");

    challengesCache.forEach((c) => {
      document.getElementById(`edit-challenge-${c.id}`)?.addEventListener("click", (e) => {
        e.stopPropagation();
        openChallengeModal(c);
      });
      document.getElementById(`del-challenge-${c.id}`)?.addEventListener("click", (e) => {
        e.stopPropagation();
        handleDeleteChallenge(c.id);
      });
      document.getElementById(`pass-challenge-${c.id}`)?.addEventListener("click", (e) => {
        e.stopPropagation();
        handlePassChallenge(c);
      });
      document.getElementById(`payout-challenge-${c.id}`)?.addEventListener("click", (e) => {
        e.stopPropagation();
        handleRecordPayout(c);
      });
    });

    // Clicking anywhere else on the card (not one of the action buttons
    // above) opens the "trades on this account" list.
    grid.querySelectorAll(".challenge-card").forEach((cardEl) => {
      cardEl.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        const id = Number(cardEl.dataset.challengeId);
        const challenge = challengesCache.find((x) => x.id === id);
        if (challenge) openChallengeTradesModal(challenge);
      });
    });
  } catch (e) {
    grid.innerHTML = `<div class="empty-state">Couldn't load challenges: ${escapeHtml(e.message)}</div>`;
  }
}

function progressBarHtml(label, usedPct, amount, targetAmount, fillClass, warnAtPct) {
  const clamped = Math.max(0, Math.min(100, usedPct));
  const warn = warnAtPct !== undefined && usedPct >= warnAtPct;
  return `
    <div class="progress-row">
      <div class="progress-row-label">
        <span>${label}</span>
        <span>${fmtMoney(amount)} / ${fmtMoney(targetAmount)} (${usedPct.toFixed(1)}%)</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill ${fillClass}${warn ? " warn" : ""}" style="width:${clamped}%;"></div>
      </div>
    </div>
  `;
}

function challengeCardHtml(challenge, progress) {
  let statusBadge = `<span class="challenge-status-badge status-active">Active</span>`;
  let bars = `<div class="empty-state" style="padding:8px 0;">No progress data</div>`;
  const accountTypeBadge = `<span class="badge ${accountTypeBadgeClass(challenge.account_type)}">${challenge.account_type}</span>`;
  let metaLine = `${fmtMoney(challenge.account_size)} account`;
  let actionButtons = "";
  let cycleBanner = "";

  // A breached account (max or daily drawdown) is done -- there's nothing
  // left to edit toward and nothing to delete until its trades are
  // unlinked, so Edit/Delete are disabled rather than just quietly failing
  // when clicked, and the whole card is dimmed to visually de-emphasize it
  // next to accounts still open for trading.
  const breached = !!(progress && (progress.breached_drawdown || progress.breached_daily_drawdown));

  if (progress) {
    if (challenge.status === "passed") {
      const nextName = challengesCache.find((x) => x.id === progress.next_challenge_id)?.name;
      statusBadge = `<span class="challenge-status-badge status-passed">✅ Passed${nextName ? ` → ${escapeHtml(nextName)}` : ""}</span>`;
    } else if (progress.breached_drawdown || progress.breached_daily_drawdown) {
      statusBadge = `<span class="challenge-status-badge status-failed">${progress.breached_daily_drawdown && !progress.breached_drawdown ? "Daily Drawdown Breached" : "Max Drawdown Breached"}</span>`;
    } else if (progress.target_hit) {
      statusBadge = `<span class="challenge-status-badge status-passed">Target Hit</span>`;
    } else if (!challenge.is_active) {
      statusBadge = `<span class="challenge-status-badge" style="background:var(--bg-hover); color:var(--text-muted);">Inactive</span>`;
    }

    const daysLine =
      challenge.account_type !== "Master" && progress.days_remaining !== null && progress.days_remaining !== undefined
        ? `${progress.days_remaining >= 0 ? progress.days_remaining : 0} day${progress.days_remaining === 1 ? "" : "s"} remaining`
        : "No time limit";

    metaLine = `${progress.total_trades} trade${progress.total_trades === 1 ? "" : "s"} · ${daysLine} · Equity: ${fmtMoney(progress.current_equity)}`;

    if (challenge.account_type === "Master") {
      // Master accounts: no profit target bar -- show the payout cycle instead.
      const cyclePct = progress.cycle_length_days
        ? Math.max(0, Math.min(100, ((progress.cycle_day_number || 0) / progress.cycle_length_days) * 100))
        : 0;
      bars = `
        <div class="progress-row">
          <div class="progress-row-label">
            <span>Payout Cycle</span>
            <span>${progress.cycle_start_date ? `Day ${Math.max(progress.cycle_day_number, 0)} / ${progress.cycle_length_days}` : "Not started"}</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill fill-target${progress.ready_for_payout ? " warn" : ""}" style="width:${cyclePct}%;"></div>
          </div>
        </div>
        ${progressBarHtml("Max Drawdown Buffer", progress.drawdown_used_pct, progress.max_drawdown_used_amount, progress.max_drawdown_amount, "fill-drawdown", 70)}
        ${
          progress.daily_drawdown_amount
            ? progressBarHtml("Today's Drawdown", progress.today_drawdown_used_pct || 0, progress.today_drawdown_amount, progress.today_drawdown_limit_amount ?? progress.daily_drawdown_amount, "fill-drawdown", 70)
            : ""
        }
        ${
          progress.daily_drawdown_amount && progress.today_drawdown_limit_amount != null && progress.today_drawdown_limit_amount < progress.daily_drawdown_amount - 0.01
            ? `<div class="computed-hint" style="margin:0 0 8px;">Today's limit is capped to ${fmtMoney(progress.today_drawdown_limit_amount)} (normally ${fmtMoney(progress.daily_drawdown_amount)}) because the overall max-drawdown buffer is running low.</div>`
            : ""
        }
      `;
      const cyclePnlLine = progress.cycle_start_date
        ? `Cycle P&L: ${fmtMoney(progress.cycle_pnl)} · Cycle balance: ${fmtMoney(progress.cycle_equity)} · Cycle ends ${progress.cycle_end_date}`
        : "Cycle starts on your first trade after the last payout.";
      cycleBanner = `<div class="computed-hint" style="margin:0;">${cyclePnlLine}${progress.total_paid_out ? ` · Total paid out so far: ${fmtMoney(progress.total_paid_out)}` : ""}</div>`;
      if (progress.ready_for_payout) {
        actionButtons += `<button class="btn btn-sm btn-primary" id="payout-challenge-${challenge.id}"${breached ? ` disabled title="This account is breached -- no payout to record on a blown account"` : ""}>💰 Record Payout</button>`;
      } else {
        actionButtons += `<button class="btn btn-sm" id="payout-challenge-${challenge.id}"${breached ? ` disabled title="This account is breached -- no payout to record on a blown account"` : ""}>Record Payout Early</button>`;
      }
    } else {
      bars = `
        ${progressBarHtml("Profit Target", progress.profit_target_used_pct, progress.total_pnl, progress.profit_target_amount, "fill-target")}
        ${progressBarHtml("Max Drawdown Buffer Used", progress.drawdown_used_pct, progress.max_drawdown_used_amount, progress.max_drawdown_amount, "fill-drawdown", 70)}
        ${
          progress.daily_drawdown_amount
            ? progressBarHtml("Today's Drawdown", progress.today_drawdown_used_pct || 0, progress.today_drawdown_amount, progress.today_drawdown_limit_amount ?? progress.daily_drawdown_amount, "fill-drawdown", 70)
            : ""
        }
        ${
          progress.daily_drawdown_amount && progress.today_drawdown_limit_amount != null && progress.today_drawdown_limit_amount < progress.daily_drawdown_amount - 0.01
            ? `<div class="computed-hint" style="margin:0 0 8px;">Today's limit is capped to ${fmtMoney(progress.today_drawdown_limit_amount)} (normally ${fmtMoney(progress.daily_drawdown_amount)}) because the overall max-drawdown buffer is running low.</div>`
            : ""
        }
      `;
      cycleBanner = `<div class="computed-hint" style="margin:0;">Drawdown floor: ${fmtMoney(progress.max_drawdown_floor)} (fixed) · Remaining buffer right now: ${fmtMoney(progress.max_drawdown_remaining_amount)}</div>`;

      if (
        challenge.status === "active" &&
        progress.target_hit &&
        !progress.breached_drawdown &&
        !progress.breached_daily_drawdown
      ) {
        actionButtons += `<button class="btn btn-sm btn-primary" id="pass-challenge-${challenge.id}">🎓 Mark Passed → Next Phase</button>`;
      }
    }
  } else if (!challenge.is_active) {
    statusBadge = `<span class="challenge-status-badge" style="background:var(--bg-hover); color:var(--text-muted);">Inactive</span>`;
  }

  return `
    <div class="challenge-card${challenge.is_active ? "" : " inactive"}${breached ? " breached" : ""}" data-challenge-id="${challenge.id}">
      <div class="challenge-card-header">
        <div>
          <div class="challenge-card-title">${escapeHtml(challenge.name)} ${accountTypeBadge}${challenge.account_type === "Phase" && challenge.phase_number > 1 ? ` <span class="badge">Phase ${challenge.phase_number}</span>` : ""}</div>
          <div class="challenge-card-meta">${metaLine}</div>
        </div>
        ${statusBadge}
      </div>

      ${bars}
      ${cycleBanner}

      <div class="challenge-card-meta">
        ${challenge.account_type === "Master" ? "" : `Target ${challenge.profit_target_pct}% · `}Max DD ${challenge.max_drawdown_pct}%${challenge.daily_drawdown_pct ? ` · Daily DD ${challenge.daily_drawdown_pct}%` : ""} · Started ${challenge.start_date}
        ${challenge.account_type !== "Master" && challenge.days_allowed ? ` · ${challenge.days_allowed} days allowed` : ""}
        ${challenge.account_type === "Master" && challenge.days_allowed ? ` · ${challenge.days_allowed}-day payout cycle` : ""}
      </div>
      ${challenge.notes ? `<div class="computed-hint" style="margin:0;">${escapeHtml(challenge.notes)}</div>` : ""}

      <div class="challenge-card-actions">
        ${actionButtons}
        <button class="btn btn-sm" id="edit-challenge-${challenge.id}"${breached ? ` disabled title="This account is breached -- nothing left to edit toward"` : ""}>Edit</button>
        <button class="btn btn-sm btn-danger" id="del-challenge-${challenge.id}"${breached ? ` disabled title="This account is breached -- unlink its trades if you really want to delete it"` : ""}>Delete</button>
      </div>
    </div>
  `;
}

// ==========================================================================
// Challenge Trades modal -- click a challenge/account card to see every
// trade logged against it; click a trade in that list to pop open the same
// shared Trade Detail view used on the Outcome page (nav.js).
// ==========================================================================

let currentChallengeTradesId = null;

async function openChallengeTradesModal(challenge) {
  currentChallengeTradesId = challenge.id;
  document.getElementById("challenge-trades-modal").style.display = "flex";
  document.getElementById("challenge-trades-title").innerHTML = `
    ${escapeHtml(challenge.name)}
    <span class="badge ${accountTypeBadgeClass(challenge.account_type)}">${challenge.account_type}</span>
  `;

  const body = document.getElementById("challenge-trades-body");
  body.innerHTML = `<div class="empty-state">Loading trades…</div>`;

  try {
    const page = await Api.getTrades({ challenge_id: challenge.id, sort_by: "trade_date", sort_dir: "desc" });
    renderChallengeTradesList(page.items);
  } catch (e) {
    body.innerHTML = `<div class="empty-state">Couldn't load trades: ${escapeHtml(e.message)}</div>`;
  }
}

function renderChallengeTradesList(trades) {
  const body = document.getElementById("challenge-trades-body");

  if (!trades.length) {
    body.innerHTML = `<div class="empty-state">No trades logged on this account yet.</div>`;
    return;
  }

  const totalPnl = trades.reduce((sum, t) => sum + Number(t.pnl), 0);

  body.innerHTML = `
    <div class="computed-hint" style="margin:0 0 12px;">
      ${trades.length} trade${trades.length === 1 ? "" : "s"} · Total P&L:
      <span class="${pnlClass(totalPnl)}">${fmtMoney(totalPnl)}</span>
    </div>
    <div class="kanban-cards">
      ${trades.map((t) => challengeTradeCardHtml(t)).join("")}
    </div>
  `;

  body.querySelectorAll(".kanban-card").forEach((card) => {
    card.addEventListener("click", () => {
      openTradeDetailModal(Number(card.dataset.id), handleChallengeTradeDeleted);
    });
  });
}

function challengeTradeCardHtml(t) {
  return `
    <div class="kanban-card" data-id="${t.id}">
      <div class="row1">
        <span>${escapeHtml(t.pair)} <span class="badge ${positionBadgeClass(t.position)}">${t.position}</span></span>
        <span class="${pnlClass(t.pnl)}">${fmtMoney(t.pnl)}</span>
      </div>
      <div class="date">
        ${t.trade_date}
        <span class="badge ${resultBadgeClass(t.result)}">${t.result}</span>
        ${t.setup_name ? ` · <span class="badge badge-setup">${escapeHtml(t.setup_name)}</span>` : ""}
      </div>
      <div class="computed-hint" style="margin:6px 0 0;">Click for full details →</div>
    </div>
  `;
}

// After a trade is deleted from inside the Trade Detail modal, refresh both
// this trades list and the challenge cards behind it (progress bars change).
async function handleChallengeTradeDeleted() {
  if (currentChallengeTradesId != null) {
    const page = await Api.getTrades({ challenge_id: currentChallengeTradesId }).catch(() => ({ items: [] }));
    renderChallengeTradesList(page.items);
  }
  await loadChallenges();
}

function closeChallengeTradesModal() {
  document.getElementById("challenge-trades-modal").style.display = "none";
  currentChallengeTradesId = null;
}

async function handlePassChallenge(challenge) {
  const typeInput = (
    prompt(
      `"${challenge.name}" hit its profit target 🎉 (it's now locked -- no more trades can be added to it).\n\n` +
        `What's next?\nType "phase" to start Phase ${challenge.phase_number + 1}, or "master" to graduate to a funded Master account:`,
      "phase"
    ) || ""
  )
    .trim()
    .toLowerCase();
  if (!typeInput) return; // cancelled
  if (typeInput !== "phase" && typeInput !== "master") {
    alert('Please type "phase" or "master".');
    return;
  }
  const nextAccountType = typeInput === "master" ? "Master" : "Phase";

  let payload = { create_next_phase: true, next_account_type: nextAccountType };

  if (nextAccountType === "Phase") {
    const targetInput = prompt(
      `Profit target % for Phase ${challenge.phase_number + 1} (leave blank to reuse ${challenge.profit_target_pct}%):`,
      5
    );
    if (targetInput === null) return;
    const ddInput = prompt(
      `Max drawdown % for Phase ${challenge.phase_number + 1} (leave blank to reuse ${challenge.max_drawdown_pct}%):`,
      challenge.max_drawdown_pct
    );
    if (ddInput === null) return;
    payload.next_profit_target_pct = targetInput.trim() ? parseFloat(targetInput) : undefined;
    payload.next_max_drawdown_pct = ddInput.trim() ? parseFloat(ddInput) : undefined;
  } else {
    const ddInput = prompt(
      `Max drawdown % for the Master account (leave blank to reuse ${challenge.max_drawdown_pct}%):`,
      challenge.max_drawdown_pct
    );
    if (ddInput === null) return;
    const dailyInput = prompt(
      `Daily drawdown % for the Master account (leave blank to reuse ${challenge.daily_drawdown_pct ?? 5}%):`,
      challenge.daily_drawdown_pct ?? 5
    );
    if (dailyInput === null) return;
    const cycleInput = prompt("Payout cycle length in days:", 14);
    if (cycleInput === null) return;
    payload.next_max_drawdown_pct = ddInput.trim() ? parseFloat(ddInput) : undefined;
    payload.next_daily_drawdown_pct = dailyInput.trim() ? parseFloat(dailyInput) : undefined;
    payload.next_days_allowed = cycleInput.trim() ? parseInt(cycleInput, 10) : 14;
  }

  try {
    const result = await Api.passChallenge(challenge.id, payload);
    alert(
      result.next_challenge
        ? `Passed! "${result.next_challenge.name}" was created and is ready to trade.`
        : `Marked as passed.`
    );
    await loadChallenges();
  } catch (err) {
    alert(`Could not mark as passed: ${err.message}`);
  }
}

async function handleRecordPayout(challenge) {
  const progress = await Api.getChallengeProgress(challenge.id).catch(() => null);
  const suggested = progress?.cycle_pnl ?? 0;
  const amountInput = prompt(
    `Record a payout for "${challenge.name}".\n\nHow much profit are you withdrawing? (Cycle P&L so far: ${fmtMoney(suggested)})`,
    suggested > 0 ? suggested : ""
  );
  if (amountInput === null || !amountInput.trim()) return;
  const amount = parseFloat(amountInput);
  if (!amount || amount <= 0) {
    alert("Enter a positive payout amount.");
    return;
  }
  const dateInput = prompt("Payout date (YYYY-MM-DD):", todayLocalIso());
  if (dateInput === null) return;

  try {
    await Api.createPayout(challenge.id, { payout_date: dateInput, amount });
    alert(`Payout of ${fmtMoney(amount)} recorded. The next 14-day cycle starts on your next trade.`);
    await loadChallenges();
  } catch (err) {
    alert(`Could not record payout: ${err.message}`);
  }
}

function openChallengeModal(challenge = null) {
  document.getElementById("challenge-form").reset();
  document.getElementById("challenge-modal-title").innerText = challenge ? "Edit Challenge" : "New Challenge";
  document.getElementById("challenge-id").value = challenge?.id || "";
  document.getElementById("f-challenge-name").value = challenge?.name || "";
  document.getElementById("f-challenge-account-size").value = challenge?.account_size || 10000;
  const todayIso = todayLocalIso();
  document.getElementById("f-challenge-start-date").max = todayIso;
  document.getElementById("f-challenge-start-date").value = challenge?.start_date || todayIso;
  document.getElementById("f-challenge-profit-target").value = challenge?.profit_target_pct ?? 8;
  document.getElementById("f-challenge-max-drawdown").value = challenge?.max_drawdown_pct ?? 10;
  document.getElementById("f-challenge-daily-drawdown").value = challenge?.daily_drawdown_pct ?? 5;
  document.getElementById("f-challenge-days-allowed").value = challenge?.days_allowed ?? "";
  document.getElementById("f-challenge-notes").value = challenge?.notes || "";

  selectedChallengeActive = challenge ? String(challenge.is_active) : "true";
  document
    .getElementById("f-challenge-active-toggle")
    .querySelectorAll("button")
    .forEach((btn) => {
      btn.classList.remove("active-yes", "active-no");
      if (btn.dataset.value === selectedChallengeActive) {
        btn.classList.add(selectedChallengeActive === "true" ? "active-yes" : "active-no");
      }
    });

  selectedChallengeAccountType = challenge?.account_type === "Phase" ? "Phase" : "Master";
  document
    .getElementById("f-challenge-account-type-toggle")
    .querySelectorAll("button")
    .forEach((btn) => {
      btn.classList.remove("active-yes", "active-no");
      if (btn.dataset.value === selectedChallengeAccountType) {
        btn.classList.add(selectedChallengeAccountType === "Master" ? "active-yes" : "active-no");
      }
    });

  const daysLabel = document.querySelector('label[for="f-challenge-days-allowed"]');
  const daysField = document.getElementById("f-challenge-days-allowed");
  if (daysField) {
    daysField.placeholder = selectedChallengeAccountType === "Master" ? "e.g. 14 (payout cycle length)" : "e.g. 30";
  }

  document.getElementById("challenge-modal").style.display = "flex";
}

function closeChallengeModal() {
  document.getElementById("challenge-modal").style.display = "none";
}

async function handleChallengeSubmit(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById("f-challenge-name").value.trim(),
    account_size: parseInt(document.getElementById("f-challenge-account-size").value, 10),
    account_type: selectedChallengeAccountType,
    start_date: document.getElementById("f-challenge-start-date").value,
    profit_target_pct: parseFloat(document.getElementById("f-challenge-profit-target").value),
    max_drawdown_pct: parseFloat(document.getElementById("f-challenge-max-drawdown").value),
    daily_drawdown_pct: document.getElementById("f-challenge-daily-drawdown").value
      ? parseFloat(document.getElementById("f-challenge-daily-drawdown").value)
      : null,
    days_allowed: document.getElementById("f-challenge-days-allowed").value
      ? parseInt(document.getElementById("f-challenge-days-allowed").value, 10)
      : null,
    is_active: selectedChallengeActive === "true",
    notes: document.getElementById("f-challenge-notes").value || null,
  };

  const challengeId = document.getElementById("challenge-id").value;
  try {
    if (challengeId) {
      await Api.updateChallenge(challengeId, payload);
    } else {
      await Api.createChallenge(payload);
    }
    closeChallengeModal();
    await loadChallenges();
  } catch (err) {
    alert(`Could not save challenge: ${err.message}`);
  }
}

async function handleDeleteChallenge(id) {
  if (!confirm("Delete this challenge? This only works if no trades are linked to it yet.")) return;
  try {
    await Api.deleteChallenge(id);
    await loadChallenges();
  } catch (err) {
    alert(`Could not delete challenge: ${err.message}`);
  }
}
