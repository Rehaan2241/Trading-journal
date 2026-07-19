import os
from datetime import date
from typing import Optional

from sqlalchemy.orm import Query

from config import UPLOAD_DIR
from models import Trade
from schemas import TradeOut


def delete_screenshot_files(urls) -> None:
    """Best-effort delete of screenshot files from disk given their
    `/uploads/<filename>` URLs (as stored on Trade.screenshot_urls).

    This is cleanup, not a hard requirement -- a missing file, a bad path,
    or a permissions error here should never block a trade delete/update,
    so every failure is swallowed silently rather than raised.
    """
    if not urls:
        return
    for url in urls:
        if not url or not isinstance(url, str):
            continue
        # Screenshots may be stored either as a plain "/uploads/xxx.png"
        # path (legacy) or timeframe-tagged as "1m|/uploads/xxx.png" -- in
        # either case, the actual path is everything after the last "|".
        path = url.rsplit("|", 1)[-1]
        if not path.startswith("/uploads/"):
            continue
        filename = os.path.basename(path)
        if not filename:
            continue
        filepath = os.path.join(UPLOAD_DIR, filename)
        try:
            if os.path.isfile(filepath):
                os.remove(filepath)
        except OSError:
            pass


def loss_percentage(pnl: float, account_size: int) -> float:
    if not account_size:
        return 0.0
    return round((float(pnl) / float(account_size)) * 100, 2)


def rr_ratio(pnl: float, risk_amount: Optional[float], result: Optional[str] = None) -> Optional[float]:
    # Loss trades never show an R:R value (shown as "-" in the UI).
    if result == "Loss":
        return None
    if not risk_amount or float(risk_amount) == 0:
        return None
    return round(abs(float(pnl)) / abs(float(risk_amount)), 2)


def win_rate(wins: int, losses: int) -> float:
    decided = wins + losses
    if decided == 0:
        return 0.0
    return round((wins / decided) * 100, 2)


def risk_percentage(risk_amount: Optional[float], account_size: int) -> Optional[float]:
    """risk_amount as a % of account_size -- the position-sizing discipline
    number. Shown for ALL results (Win/Loss/Breakeven), unlike rr_ratio."""
    if not risk_amount or not account_size:
        return None
    return round((float(risk_amount) / float(account_size)) * 100, 2)


def trade_to_out(trade: Trade) -> TradeOut:
    return TradeOut.model_validate(
        {
            "id": trade.id,
            "created_at": trade.created_at,
            "trade_date": trade.trade_date,
            "account_size": trade.account_size,
            "account_type": trade.account_type,
            "position": trade.position,
            "pair": trade.pair,
            "entry_ltf": trade.entry_ltf,
            "candle_4h": trade.candle_4h,
            "setup_id": trade.setup_id,
            "challenge_id": trade.challenge_id,
            "result": trade.result,
            "pnl": trade.pnl,
            "risk_amount": trade.risk_amount,
            "screenshot_urls": trade.screenshot_urls or [],
            "notes": trade.notes,
            "setup_name": trade.setup.name if trade.setup else None,
            "challenge_name": trade.challenge.name if trade.challenge else None,
            "confluences": sorted(trade.confluences, key=lambda c: c.priority),
            "mistake_tags": sorted(trade.mistake_tags, key=lambda m: m.name),
            "loss_percentage": loss_percentage(trade.pnl, trade.account_size),
            "rr_ratio": rr_ratio(trade.pnl, trade.risk_amount, trade.result),
            "risk_percentage": risk_percentage(trade.risk_amount, trade.account_size),
        }
    )


def apply_trade_filters(
    query: Query,
    pair: Optional[str] = None,
    result: Optional[str] = None,
    entry_ltf: Optional[str] = None,
    candle_4h: Optional[str] = None,
    position: Optional[str] = None,
    account_type: Optional[str] = None,
    account_size: Optional[int] = None,
    setup_id: Optional[int] = None,
    challenge_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
) -> Query:
    """Apply the same optional filter set used by /trades, /dashboard, and
    the per-strategy /performance endpoint."""
    if pair:
        query = query.filter(Trade.pair == pair)
    if result:
        query = query.filter(Trade.result == result)
    if entry_ltf:
        query = query.filter(Trade.entry_ltf == entry_ltf)
    if candle_4h:
        query = query.filter(Trade.candle_4h == candle_4h)
    if position:
        query = query.filter(Trade.position == position)
    if account_type:
        query = query.filter(Trade.account_type == account_type)
    if account_size:
        query = query.filter(Trade.account_size == account_size)
    if setup_id is not None:
        query = query.filter(Trade.setup_id == setup_id)
    if challenge_id is not None:
        query = query.filter(Trade.challenge_id == challenge_id)
    if date_from:
        query = query.filter(Trade.trade_date >= date_from)
    if date_to:
        query = query.filter(Trade.trade_date <= date_to)
    return query


# Columns the Trades page is allowed to sort by (whitelist to avoid passing
# arbitrary attribute names into getattr on a SQLAlchemy model).
SORTABLE_TRADE_FIELDS = {
    "trade_date": Trade.trade_date,
    "pnl": Trade.pnl,
    "pair": Trade.pair,
    "result": Trade.result,
    "account_size": Trade.account_size,
    "created_at": Trade.created_at,
}


def apply_trade_sort(query: Query, sort_by: Optional[str], sort_dir: Optional[str]) -> Query:
    """Click-to-sort support for the Trades table. Falls back to the
    original newest-first ordering when sort_by isn't a recognized column."""
    column = SORTABLE_TRADE_FIELDS.get(sort_by)
    if column is None:
        return query.order_by(Trade.trade_date.desc(), Trade.id.desc())
    if (sort_dir or "desc").lower() == "asc":
        return query.order_by(column.asc(), Trade.id.asc())
    return query.order_by(column.desc(), Trade.id.desc())


def mistake_breakdown(trades) -> list:
    """Aggregate mistake tags across a list of Trade rows: for each tag that
    shows up at least once, how many trades used it, its win rate, and --
    the headline insight -- what % of ALL LOSSES in this trade set involved
    that mistake (e.g. "60% of my losses involve moving my stop loss")."""
    total_losses = sum(1 for t in trades if t.result == "Loss")

    stats = {}
    for t in trades:
        for tag in t.mistake_tags:
            entry = stats.setdefault(
                tag.id, {"id": tag.id, "name": tag.name, "count": 0, "wins": 0, "losses": 0, "total_pnl": 0.0}
            )
            entry["count"] += 1
            entry["total_pnl"] += float(t.pnl)
            if t.result == "Win":
                entry["wins"] += 1
            elif t.result == "Loss":
                entry["losses"] += 1

    out = []
    for entry in stats.values():
        out.append(
            {
                "id": entry["id"],
                "name": entry["name"],
                "count": entry["count"],
                "win_rate": win_rate(entry["wins"], entry["losses"]),
                "total_pnl": round(entry["total_pnl"], 2),
                "loss_count": entry["losses"],
                "pct_of_losses": round((entry["losses"] / total_losses) * 100, 2) if total_losses else 0.0,
            }
        )
    out.sort(key=lambda x: x["pct_of_losses"], reverse=True)
    return out
