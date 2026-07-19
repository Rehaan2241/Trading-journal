// Reusable filters bar. Renders into a container and calls onChange(filters)
// only when the user explicitly clicks "Apply Filters" (or "Clear filters").
// Collapsed by default behind a "Filters" toggle button.
// NOTE: this is now only used on the Trades page.
async function renderFiltersBar(containerId, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let pairs = [];
  let strategies = [];
  let challenges = [];
  try {
    pairs = await Api.getPairs();
  } catch (e) {
    console.error("Could not load pairs for filter bar", e);
  }
  try {
    strategies = await Api.getStrategies();
  } catch (e) {
    console.error("Could not load setups for filter bar", e);
  }
  try {
    challenges = await Api.getChallenges();
  } catch (e) {
    console.error("Could not load challenges for filter bar", e);
  }

  container.innerHTML = `
    <div class="filters-toggle-row">
      <button type="button" class="btn filter-toggle-btn" id="f-toggle-btn">
        <span>⚙️ Filters</span>
        <span class="filter-badge" id="f-badge" style="display:none;">0</span>
      </button>
    </div>
    <div class="filters-panel" id="f-panel">
      <select id="f-pair">
        <option value="">All pairs</option>
        ${pairs.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("")}
      </select>
      <select id="f-position">
        <option value="">Long / Short</option>
        <option value="Long">Long</option>
        <option value="Short">Short</option>
      </select>
      <select id="f-account-type">
        <option value="">Master / Phase</option>
        <option value="Master">Master</option>
        <option value="Phase">Phase</option>
      </select>
      <select id="f-account-size">
        <option value="">Any Account Size</option>
        <option value="5000">$5,000</option>
        <option value="10000">$10,000</option>
        <option value="25000">$25,000</option>
        <option value="50000">$50,000</option>
        <option value="100000">$100,000</option>
      </select>
      <select id="f-result">
        <option value="">Any result</option>
        <option value="Win">Win</option>
        <option value="Loss">Loss</option>
        <option value="Breakeven">Breakeven</option>
      </select>
      <select id="f-entry-ltf">
        <option value="">Any Entry LTF</option>
        <option value="1m">1m</option>
        <option value="3m">3m</option>
        <option value="5m">5m</option>
      </select>
      <select id="f-candle-4h">
        <option value="">Any 4H Candle</option>
        <option value="3:30">3:30</option>
        <option value="7:30">7:30</option>
      </select>
      <select id="f-setup">
        <option value="">Setup: Any</option>
        ${strategies.map((s) => `<option value="${s.id}">Setup: ${escapeHtml(s.name)}</option>`).join("")}
      </select>
      <select id="f-challenge">
        <option value="">Challenge: Any</option>
        ${challenges.map((c) => `<option value="${c.id}">Challenge: ${escapeHtml(c.name)}</option>`).join("")}
      </select>
      <input type="date" id="f-date-from" title="From date" />
      <input type="date" id="f-date-to" title="To date" />
      <div class="filters-actions">
        <button type="button" class="btn btn-primary" id="f-apply">Apply Filters</button>
        <span class="clear-filters" id="f-clear">Clear filters</span>
      </div>
    </div>
  `;

  // No trade can be dated in the future, so a future date in a filter
  // would only ever return nothing -- cap both pickers at today.
  const todayIso = todayLocalIso();
  document.getElementById("f-date-from").max = todayIso;
  document.getElementById("f-date-to").max = todayIso;

  const fieldIds = [
    "f-pair",
    "f-position",
    "f-account-type",
    "f-account-size",
    "f-result",
    "f-entry-ltf",
    "f-candle-4h",
    "f-setup",
    "f-challenge",
    "f-date-from",
    "f-date-to",
  ];

  const toggleBtn = document.getElementById("f-toggle-btn");
  const panel = document.getElementById("f-panel");
  const badge = document.getElementById("f-badge");

  function collect() {
    return {
      pair: document.getElementById("f-pair").value,
      position: document.getElementById("f-position").value,
      account_type: document.getElementById("f-account-type").value,
      account_size: document.getElementById("f-account-size").value,
      result: document.getElementById("f-result").value,
      entry_ltf: document.getElementById("f-entry-ltf").value,
      candle_4h: document.getElementById("f-candle-4h").value,
      setup_id: document.getElementById("f-setup").value,
      challenge_id: document.getElementById("f-challenge").value,
      date_from: document.getElementById("f-date-from").value,
      date_to: document.getElementById("f-date-to").value,
    };
  }

  function updateBadge(filters) {
    const activeCount = Object.values(filters).filter((v) => v !== "" && v !== undefined && v !== null).length;
    if (activeCount > 0) {
      badge.style.display = "inline-block";
      badge.innerText = activeCount;
      toggleBtn.classList.add("has-active-filters");
    } else {
      badge.style.display = "none";
      toggleBtn.classList.remove("has-active-filters");
    }
  }

  toggleBtn.addEventListener("click", () => {
    panel.classList.toggle("open");
  });

  function apply() {
    const filters = collect();
    updateBadge(filters);
    onChange(filters);
  }

  // "Apply Filters" button still works (e.g. after typing a date range),
  // but selects now also apply themselves instantly on change so you don't
  // have to click it every time.
  document.getElementById("f-apply").addEventListener("click", () => {
    apply();
    panel.classList.remove("open");
  });

  document.getElementById("f-clear").addEventListener("click", () => {
    fieldIds.forEach((id) => (document.getElementById(id).value = ""));
    apply();
  });

  fieldIds.forEach((id) => {
    const el = document.getElementById(id);

    // Dropdowns (pair/position/account-type/result/entry-ltf/candle/setup)
    // apply the moment you pick an option — no need to click Apply.
    if (el.tagName === "SELECT") {
      el.addEventListener("change", apply);
    }

    // Date inputs apply as soon as a full date is chosen (native date
    // picker fires "change" only once a valid date is set, not per keystroke).
    if (el.tagName === "INPUT" && el.type === "date") {
      el.addEventListener("change", apply);
    }

    // Still allow pressing Enter inside any field to apply immediately.
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        apply();
      }
    });
  });

  // initial load with empty filters (panel stays collapsed)
  onChange(collect());
}
