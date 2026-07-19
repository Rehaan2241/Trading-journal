import calendar as cal
from datetime import date
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session, joinedload

from database import get_db
from models import Trade

router = APIRouter(prefix="/api/calendar", tags=["calendar"])


@router.get("")
def get_calendar(
    year: int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
    setup_id: Optional[int] = None,
    # "Master", "Phase", or omitted/blank = all accounts. This now drives
    # BOTH the day cells AND the weekly/monthly summary below, so the two
    # never disagree with each other (previously the day cells always mixed
    # Master + Phase trades together while the summary was silently
    # Master-only, which made the numbers look inconsistent/confusing).
    account_type: Optional[str] = None,
    db: Session = Depends(get_db),
):
    start = date(year, month, 1)
    last_day = cal.monthrange(year, month)[1]
    end = date(year, month, last_day)

    query = (
        db.query(Trade)
        .options(joinedload(Trade.setup))
        .filter(Trade.trade_date >= start, Trade.trade_date <= end)
    )
    if setup_id is not None:
        query = query.filter(Trade.setup_id == setup_id)
    if account_type:
        query = query.filter(Trade.account_type == account_type)
    trades = query.order_by(Trade.trade_date.asc()).all()

    by_day = defaultdict(list)
    for t in trades:
        by_day[t.trade_date.isoformat()].append(t)

    days = {}
    for day_str, day_trades in by_day.items():
        wins = sum(1 for t in day_trades if t.result == "Win")
        losses = sum(1 for t in day_trades if t.result == "Loss")
        decided = wins + losses
        total_pnl = round(sum(float(t.pnl) for t in day_trades), 2)

        days[day_str] = {
            "total_pnl": total_pnl,
            "trade_count": len(day_trades),
            "win_rate": round((wins / decided) * 100, 2) if decided else 0.0,
            "overall": "Win" if total_pnl > 0 else ("Loss" if total_pnl < 0 else "Breakeven"),
            "trades": [
                {
                    "id": t.id,
                    "pair": t.pair,
                    "position": t.position,
                    "result": t.result,
                    "pnl": float(t.pnl),
                    "setup_name": t.setup.name if t.setup else None,
                }
                for t in day_trades
            ],
        }

    # --- Weekly/monthly summary, scoped by the SAME account_type filter as
    # the day cells above (still independent of the setup_id/strategy
    # filter, since "what did this account make me" shouldn't reset just
    # because you're drilling into one setup). Using the same `trades` list
    # the day cells were built from keeps the two numbers always in sync. ---
    summary_daily_pnl = defaultdict(float)
    for t in trades:
        summary_daily_pnl[t.trade_date.isoformat()] += float(t.pnl)
    summary_month_pnl = round(sum(summary_daily_pnl.values()), 2)

    # Weekly breakdown that lines up with the calendar grid the frontend
    # renders: weeks start on Sunday, and "Week 1" is whichever row day 1
    # falls into (so a month that starts on a Friday still has its first
    # row -- mostly blank -- counted as Week 1, matching what's on screen).
    start_dow = (start.weekday() + 1) % 7  # Python Monday=0 -> Sunday=0
    summary_weekly_pnl = []
    week_total = 0.0
    week_number = 1
    for day in range(1, last_day + 1):
        day_str = date(year, month, day).isoformat()
        week_total += summary_daily_pnl.get(day_str, 0.0)
        position_in_week = (start_dow + day - 1) % 7
        is_last_day_of_month = day == last_day
        if position_in_week == 6 or is_last_day_of_month:
            summary_weekly_pnl.append({"week_number": week_number, "pnl": round(week_total, 2)})
            week_total = 0.0
            week_number += 1

    return {
        "year": year,
        "month": month,
        "days": days,
        # Label reflecting which accounts the summary below covers, so the
        # frontend can show e.g. "Master Accounts this month" vs "All
        # Accounts this month" instead of it always silently meaning Master.
        "account_type_filter": account_type or "All",
        "summary_month_pnl": summary_month_pnl,
        "summary_weekly_pnl": summary_weekly_pnl,
    }
