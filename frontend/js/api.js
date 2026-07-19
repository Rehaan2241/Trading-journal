// Base URL of the FastAPI backend. Change this if you deploy the backend
// somewhere other than localhost:8001.
const API_BASE = window.API_BASE || "http://localhost:8001";

// Today's date as YYYY-MM-DD in the BROWSER'S LOCAL timezone.
//
// Do NOT use `new Date().toISOString().slice(0, 10)` for this -- toISOString()
// always converts to UTC first. For timezones ahead of UTC (e.g. IST,
// UTC+5:30), that makes it return YESTERDAY's date for the first few hours
// after local midnight (local 00:30 IST = 19:00 UTC the day before), which
// wrongly blocks/defaults today's trade date until ~5:30 AM local time.
// This builds the string from local getters instead, so it always matches
// the calendar date the user actually sees on their device.
function todayLocalIso() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function apiRequest(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    cache: "no-store", // never let the browser reuse a stale cached response
    headers: options.body instanceof FormData
      ? undefined
      : { "Content-Type": "application/json" },
    ...options,
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const errJson = await res.json();
      detail = errJson.detail || JSON.stringify(errJson);
    } catch (_) {}
    throw new Error(detail || `Request failed (${res.status})`);
  }

  if (res.status === 204) return null;
  return res.json();
}

function buildQuery(params = {}) {
  const usable = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ""
  );
  if (usable.length === 0) return "";
  const qs = new URLSearchParams(usable);
  return `?${qs.toString()}`;
}

const Api = {
  // ---- Trades ----
  getTrades: (filters = {}) => apiRequest(`/api/trades${buildQuery(filters)}`),
  getTrade: (id) => apiRequest(`/api/trades/${id}`),
  createTrade: (data) =>
    apiRequest("/api/trades", { method: "POST", body: JSON.stringify(data) }),
  updateTrade: (id, data) =>
    apiRequest(`/api/trades/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTrade: (id) => apiRequest(`/api/trades/${id}`, { method: "DELETE" }),
  exportTradesCsvUrl: (filters = {}) => `${API_BASE}/api/trades/export${buildQuery(filters)}`,
  // Import expects EXACTLY the file Export CSV produces -- see the backend
  // docstring on /api/trades/import for what it auto-creates by name.
  importTradesCsv: (file) => {
    const form = new FormData();
    form.append("file", file);
    return apiRequest("/api/trades/import", { method: "POST", body: form });
  },
  // Full backup: trades + chart screenshots bundled into one .zip, so
  // moving to a new device doesn't leave images behind.
  exportTradesFullUrl: (filters = {}) => `${API_BASE}/api/trades/export-full${buildQuery(filters)}`,
  importTradesFull: (file) => {
    const form = new FormData();
    form.append("file", file);
    return apiRequest("/api/trades/import-full", { method: "POST", body: form });
  },

  // ---- Pairs ----
  getPairs: () => apiRequest("/api/pairs"),
  createPair: (name) =>
    apiRequest("/api/pairs", { method: "POST", body: JSON.stringify({ name }) }),
  deletePair: (id) => apiRequest(`/api/pairs/${id}`, { method: "DELETE" }),

  // ---- Mistake / emotion tags ----
  getMistakeTags: () => apiRequest("/api/mistake-tags"),
  createMistakeTag: (name) =>
    apiRequest("/api/mistake-tags", { method: "POST", body: JSON.stringify({ name }) }),
  deleteMistakeTag: (id) => apiRequest(`/api/mistake-tags/${id}`, { method: "DELETE" }),

  // ---- Challenges (prop-firm / phase tracking) ----
  getChallenges: () => apiRequest("/api/challenges"),
  getChallenge: (id) => apiRequest(`/api/challenges/${id}`),
  createChallenge: (data) =>
    apiRequest("/api/challenges", { method: "POST", body: JSON.stringify(data) }),
  updateChallenge: (id, data) =>
    apiRequest(`/api/challenges/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteChallenge: (id) => apiRequest(`/api/challenges/${id}`, { method: "DELETE" }),
  getChallengeProgress: (id) => apiRequest(`/api/challenges/${id}/progress`),
  passChallenge: (id, data = {}) =>
    apiRequest(`/api/challenges/${id}/pass`, { method: "POST", body: JSON.stringify(data) }),
  getPayouts: (id) => apiRequest(`/api/challenges/${id}/payouts`),
  createPayout: (id, data) =>
    apiRequest(`/api/challenges/${id}/payouts`, { method: "POST", body: JSON.stringify(data) }),
  deletePayout: (id, payoutId) =>
    apiRequest(`/api/challenges/${id}/payouts/${payoutId}`, { method: "DELETE" }),

  // ---- Strategies ("Setups") ----
  getStrategies: () => apiRequest("/api/strategies"),
  getStrategy: (id) => apiRequest(`/api/strategies/${id}`),
  createStrategy: (data) =>
    apiRequest("/api/strategies", { method: "POST", body: JSON.stringify(data) }),
  updateStrategy: (id, data) =>
    apiRequest(`/api/strategies/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteStrategy: (id) => apiRequest(`/api/strategies/${id}`, { method: "DELETE" }),
  dedupeStrategyConfluences: (id) =>
    apiRequest(`/api/strategies/${id}/dedupe-confluences`, { method: "POST" }),
  getStrategyPerformance: (id, filters = {}) =>
    apiRequest(`/api/strategies/${id}/performance${buildQuery(filters)}`),

  // ---- Dashboard ----
  getDashboard: (filters = {}) => apiRequest(`/api/dashboard${buildQuery(filters)}`),

  // ---- Calendar ----
  getCalendar: (year, month, setupId, accountType) =>
    apiRequest(
      `/api/calendar?year=${year}&month=${month}${setupId ? `&setup_id=${setupId}` : ""}${
        accountType ? `&account_type=${accountType}` : ""
      }`
    ),

  // ---- Upload ----
  uploadScreenshot: async (file) => {
    const form = new FormData();
    form.append("file", file);
    return apiRequest("/api/upload", { method: "POST", body: form });
  },

  fileUrl: (path) => (path && path.startsWith("/") ? `${API_BASE}${path}` : path),
};
