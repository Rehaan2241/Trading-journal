# Trading Journal

A private, no-login trading journal: log trades, track strategy performance,
review outcomes, and see everything on a calendar. Built with **FastAPI +
PostgreSQL** on the backend and plain **HTML/CSS/JS** on the frontend, dark
mode throughout.

## Structure

```
trading-journal/
├── backend/
│   ├── main.py            # FastAPI app entrypoint
│   ├── database.py        # SQLAlchemy engine/session
│   ├── models.py          # Trade, Pair, Strategy ORM models
│   ├── schemas.py         # Pydantic request/response models
│   ├── utils.py           # loss %, R:R calculation, shared filters
│   ├── config.py          # env var loading
│   ├── schema.sql         # raw SQL schema (manual/reference)
│   ├── seed.sql           # optional sample data
│   ├── requirements.txt
│   ├── .env.example
│   └── routers/
│       ├── trades.py      # CRUD /api/trades (+ sort/pagination + CSV export)
│       ├── pairs.py       # /api/pairs
│       ├── strategies.py  # CRUD /api/strategies ("Setups")
│       ├── mistake_tags.py# CRUD /api/mistake-tags (global mistake/emotion tags)
│       ├── challenges.py  # CRUD /api/challenges + /progress (prop-firm tracking)
│       ├── dashboard.py   # /api/dashboard (aggregated stats)
│       ├── calendar.py    # /api/calendar (per-day summaries)
│       └── upload.py      # /api/upload (chart screenshots)
└── frontend/
    ├── index.html          # redirects to dashboard.html
    ├── dashboard.html/js   # win rate, long/short, equity curve, confluence + setup + mistake stats
    ├── trades.html/js      # add/edit/delete trades, sort/paginate, filters, CSV export
    ├── strategy.html/js    # add/edit/delete Setups (e.g. "Type 1") with confluences + notes + mistake tag list
    ├── challenges.html/js  # prop-firm/phase challenge tracking (target %, drawdown %, days remaining)
    ├── outcome.html/js     # kanban board grouped by Win/Loss/Breakeven
    ├── calendar.html/js    # month calendar with daily PnL
    ├── css/style.css
    └── js/api.js, nav.js, filters.js
```

### Confluences & Setups

Confluences are tagged in priority order (1 = highest), and each priority
level gets its own color throughout the UI:

1. **Liquidity Sweep** and **HTF-PDA** — tied for top priority, same color
2. **Displacement**
3. **SMT**
4. **IFVG**

HTF-PDA used to be its own standalone field/column; it's now folded into the
confluences group (`conf_htf_pda`) alongside the others.

**Setups** (`strategies` table) are named playbooks — e.g. "Type 1" — each
with its own confluence flags and a free-form notes field for reminders on
how to trade it. On the Trades page, pick a Setup *before* the confluence
checkboxes appear; picking a saved Setup pre-fills its confluences (still
editable per-trade). Trades track which Setup they used (`setup_id`), so you
can filter the Trades table and see win-rate breakdowns by Setup on the
Dashboard. Deleting a Setup keeps trade history intact — it just clears the
Setup link on those trades.



Create a database:

```bash
createdb trading_journal
```

You don't need to run `schema.sql` manually — the FastAPI app creates the
tables automatically on startup. But `schema.sql` / `seed.sql` are there if
you prefer to set it up by hand or want sample data:

```bash
psql -U postgres -d trading_journal -f backend/schema.sql
psql -U postgres -d trading_journal -f backend/seed.sql   # optional sample trades
```

## 2. Backend setup

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# edit .env: set DATABASE_URL to match your PostgreSQL user/password,
# and add whatever address you'll open the frontend from to CORS_ORIGINS

uvicorn main:app --reload --port 8000
```

The API is now at `http://localhost:8000`. Visit `http://localhost:8000/`
for a health check, or `http://localhost:8000/docs` for interactive API docs.

## 3. Frontend setup

The frontend is static HTML/JS — no build step. Two easy ways to run it:

**Option A — VS Code Live Server extension**: right-click `frontend/index.html` → "Open with Live Server".

**Option B — Python's built-in server**:
```bash
cd frontend
python -m http.server 5500
```
Then open `http://localhost:5500`.

Whichever port you use, make sure it's listed in `CORS_ORIGINS` in your
backend `.env` file, or API requests will be blocked by the browser.

If you deploy the backend somewhere other than `localhost:8000`, set
`window.API_BASE` before `api.js` loads (e.g. add a line in each HTML file's
`<head>`: `<script>window.API_BASE = "https://your-api.com";</script>`).

## Features

- **Dashboard** — total PnL, win rate, avg R:R, win/loss/breakeven donut,
  Long vs Short bar chart, cumulative equity curve, confluence win-rate
  breakdown, and a best/worst pair table. Filterable by pair, position,
  result, entry LTF, 4H candle, and date range.
- **Trades** — add/edit/delete trades with all required fields (date,
  account size, position, pair, entry LTF, 4H candle, HTF PDA, result, PnL),
  auto-calculated loss % and R:R ratio, 4 confluence checkboxes, notes /
  lesson learned, and chart screenshot upload. Same filters as Dashboard.
- **Outcome** — kanban board grouping all trades into Win / Loss / Breakeven
  columns with per-column trade count and total PnL.
- **Calendar** — month view showing each day's total PnL and win rate,
  color-coded green/red/yellow; click a day to see the individual trades.

## What's new in this update

1. **Mistake / Emotion tags** — a structured multi-select (global list, e.g.
   "Moved Stop Loss", "Revenge Trade", "FOMO Entry"), tagged on any trade
   independent of its Setup. Manage the list from the Trades modal or the
   Strategy page; the Dashboard's new "Mistake / Emotion Breakdown" panel
   shows what % of all your losses involved each tag.
2. **Risk % of account** — every trade with a `risk_amount` now also shows
   `risk_percentage` (risk_amount / account_size), on the Trades table, the
   trade detail modal, and as an "Avg Risk % of Account" stat on the
   Dashboard. `risk_amount` is now captured for every result (not just
   non-Loss trades), since position-sizing discipline matters regardless of
   outcome.
3. **CSV export** — a "⬇ Export CSV" button on the Trades page
   (`GET /api/trades/export`), respecting whatever filters are currently
   applied.
4. **Challenges (prop-firm / phase tracking)** — a new `challenges` table
   and **Challenges** page. Create a challenge (account size, profit
   target %, max drawdown %, start date, days allowed), link "Phase" trades
   to it, and see live progress bars for profit target used, max drawdown
   used (based on the worst peak-to-trough drawdown, not just current vs.
   start), and days remaining.
5. **Sorting + pagination on Trades** — click any sortable column header
   (Date, Pair, Account Size, Result, PnL) to sort; 50 trades per page with
   Prev/Next controls. `GET /api/trades` now returns `{ total, items }`
   instead of a bare array.
6. **No-setup discipline nudge** — a banner on the Trades and Dashboard
   pages surfaces "X% of trades have no strategy tagged" (those trades are
   invisible to confluence win-rate / strategy trend / setup performance
   stats).

### New/changed backend endpoints

- `GET /api/trades` — now paginated: `?sort_by=&sort_dir=&limit=&offset=`,
  returns `{ total, items }`.
- `GET /api/trades/export` — CSV download, same filters as `/api/trades`.
- `GET/POST/DELETE /api/mistake-tags` — manage the global mistake/emotion
  tag list.
- `GET/POST/PATCH/DELETE /api/challenges` and
  `GET /api/challenges/{id}/progress` — challenge CRUD + progress numbers.
- `GET /api/dashboard` — response now also includes `summary.avg_risk_pct`,
  `summary.no_setup_count`/`no_setup_pct`, and a top-level `mistake_stats`
  array.

## Notes

- No authentication — this is meant to be used via a private link/local
  network only, as requested. Don't expose the backend publicly without
  adding auth.
- Screenshots are stored on disk in `backend/uploads/` and served at
  `/uploads/<filename>`. Back that folder up along with your database.
- This project only has demo/seed data (`seed.sql`) — the schema changes in
  this update (new `mistake_tags`, `challenges`, `trade_mistakes` tables,
  and a new `challenge_id` column on `trades`) are picked up automatically
  by `create_all()` on startup. If you'd previously created the database by
  hand from `schema.sql`, note that file is empty/unused in this project —
  table creation has always happened via SQLAlchemy at app startup.
