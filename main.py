import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import CORS_ORIGINS, UPLOAD_DIR
from database import Base, engine
from models import (  # noqa: F401  (needed for create_all to see the tables)
    Trade,
    Pair,
    Strategy,
    StrategyConfluence,
    MistakeTag,
    Challenge,
    Payout,
)

from routers import trades, pairs, dashboard, calendar, upload, strategies, mistake_tags, challenges

# Create tables if they don't exist yet (schema.sql is the source of truth for
# production; this is a convenience for local dev so `uvicorn main:app` just works).
Base.metadata.create_all(bind=engine)

# create_all only creates tables that don't exist yet -- it won't add new
# columns to a "challenges" table that already existed before this update
# (status / phase_number / previous_challenge_id). This adds them in place if
# missing, so existing databases don't need to be dropped and recreated.
try:
    from sqlalchemy import inspect, text

    inspector = inspect(engine)
    if "challenges" in inspector.get_table_names():
        existing_cols = {c["name"] for c in inspector.get_columns("challenges")}
        with engine.begin() as conn:
            if "status" not in existing_cols:
                conn.execute(text("ALTER TABLE challenges ADD COLUMN status VARCHAR NOT NULL DEFAULT 'active'"))
            if "phase_number" not in existing_cols:
                conn.execute(text("ALTER TABLE challenges ADD COLUMN phase_number INTEGER NOT NULL DEFAULT 1"))
            if "previous_challenge_id" not in existing_cols:
                conn.execute(text("ALTER TABLE challenges ADD COLUMN previous_challenge_id INTEGER REFERENCES challenges(id) ON DELETE SET NULL"))
except Exception as _migration_err:  # pragma: no cover - best-effort convenience only
    print(f"Note: skipped auto-migration check ({_migration_err})")

os.makedirs(UPLOAD_DIR, exist_ok=True)

app = FastAPI(title="Trading Journal API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

app.include_router(trades.router)
app.include_router(pairs.router)
app.include_router(strategies.router)
app.include_router(dashboard.router)
app.include_router(calendar.router)
app.include_router(upload.router)
app.include_router(mistake_tags.router)
app.include_router(challenges.router)


@app.get("/")
def health_check():
    return {"status": "ok", "service": "trading-journal-api"}
