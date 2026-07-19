from collections import defaultdict
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session, joinedload

from database import get_db
from models import Trade, Challenge, Payout
from utils import apply_trade_filters, rr_ratio, win_rate as _win_rate, risk_percentage, mistake_breakdown

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def _active_account_equity_curves(db: Session) -> list:
    """Running equity-over-time for every currently active challenge
    account (starting balance, then cumulative after each trade taken on
    it) -- the single most useful chart a trading journal is missing (#11).

    For Master accounts this also folds in the payout cycle: every recorded
    Payout is plotted as its own point that drops the running equity back
    down by the payout amount (e.g. 5000 -> +50 -> 5050 -> +45 -> 5095 ->
    payout of 95 -> 5000), matching the same payout-cycle math used on the
    Challenges page (the cycle resets to account_size the moment a payout
    is recorded, then the next cycle's trades build back up from there).
    A payout dated on/before a trade's date is applied before that trade
    (the trade belongs to the next, fresh cycle); any trailing payout after
    the last trade is appended at the end.
    """
    challenges = db.query(Challenge).filter(Challenge.is_active.is_(True)).all()

    curves = []
    for c in challenges:
        trades = (
            db.query(Trade)
            .filter(Trade.challenge_id == c.id)
            .order_by(Trade.trade_date.asc(), Trade.id.asc())
            .all()
        )
        equity = float(c.account_size)
        points = [
            {"trade_no": 0, "date": c.start_date.isoformat(), "equity": round(equity, 2), "type": "start"}
        ]

        if c.account_type == "Master":
            payouts = (
                db.query(Payout)
                .filter(Payout.challenge_id == c.id)
                .order_by(Payout.payout_date.asc())
                .all()
            )
            payout_idx = 0
            event_no = 0

            def _apply_payout(p):
                nonlocal equity, event_no
                equity -= float(p.amount)
                event_no += 1
                points.append(
                    {
                        "trade_no": event_no,
                        "date": p.payout_date.isoformat(),
                        "equity": round(equity, 2),
                        "type": "payout",
                        "payout_amount": round(float(p.amount), 2),
                    }
                )

            for t in trades:
                while payout_idx < len(payouts) and payouts[payout_idx].payout_date <= t.trade_date:
                    _apply_payout(payouts[payout_idx])
                    payout_idx += 1
                equity += float(t.pnl)
                event_no += 1
                points.append(
                    {"trade_no": event_no, "date": t.trade_date.isoformat(), "equity": round(equity, 2), "type": "trade"}
                )
            while payout_idx < len(payouts):
                _apply_payout(payouts[payout_idx])
                payout_idx += 1
        else:
            for i, t in enumerate(trades, start=1):
                equity += float(t.pnl)
                points.append(
                    {"trade_no": i, "date": t.trade_date.isoformat(), "equity": round(equity, 2), "type": "trade"}
                )

        curves.append(
            {
                "challenge_id": c.id,
                "name": c.name,
                "account_type": c.account_type,
                "account_size": c.account_size,
                "points": points,
            }
        )
    return curves

# NOTE: confluence win-rate stats used to live here, but confluences are no
# longer a fixed global set -- they're custom per-strategy now, so that
# breakdown moved to GET /api/strategies/{id}/performance (see the Strategy
# page's performance panel, and the dashboard's "Confluence Win Rate" panel
# which only appears once you pick a single strategy up top).


@router.get("")
def get_dashboard(
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
    db: Session = Depends(get_db),
):
    query = (
        db.query(Trade)
        .options(joinedload(Trade.mistake_tags), joinedload(Trade.setup))
        .order_by(Trade.trade_date.asc(), Trade.id.asc())
    )
    query = apply_trade_filters(
        query,
        pair,
        result,
        entry_ltf,
        candle_4h,
        position,
        account_type,
        account_size,
        setup_id,
        challenge_id,
        date_from,
        date_to,
    )
    trades = query.all()

    total_trades = len(trades)
    wins = sum(1 for t in trades if t.result == "Win")
    losses = sum(1 for t in trades if t.result == "Loss")
    breakevens = sum(1 for t in trades if t.result == "Breakeven")
    total_pnl = round(sum(float(t.pnl) for t in trades), 2)

    rr_values = [rr_ratio(t.pnl, t.risk_amount, t.result) for t in trades]
    rr_values = [v for v in rr_values if v is not None]
    avg_rr = round(sum(rr_values) / len(rr_values), 2) if rr_values else None

    risk_pct_values = [v for v in (risk_percentage(t.risk_amount, t.account_size) for t in trades) if v is not None]
    avg_risk_pct = round(sum(risk_pct_values) / len(risk_pct_values), 2) if risk_pct_values else None

    # "No setup" blind spot: a trade logged without a Setup can't show up in
    # confluence win-rate, strategy trend, or setup performance stats.
    # Surfaced as a soft discipline nudge, not a hard requirement.
    no_setup_count = sum(1 for t in trades if t.setup_id is None)
    no_setup_pct = round((no_setup_count / total_trades) * 100, 2) if total_trades else 0.0

    # --- Buy (Long) vs Sell (Short) breakdown ---
    position_stats = {}
    for pos in ("Long", "Short"):
        pos_trades = [t for t in trades if t.position == pos]
        pos_wins = sum(1 for t in pos_trades if t.result == "Win")
        pos_losses = sum(1 for t in pos_trades if t.result == "Loss")
        position_stats[pos] = {
            "count": len(pos_trades),
            "win_rate": _win_rate(pos_wins, pos_losses),
            "total_pnl": round(sum(float(t.pnl) for t in pos_trades), 2),
        }

    # --- Current streak: consecutive most-recent trades with the same
    # result (Win/Loss/Breakeven), within whatever filters are active. Handy
    # for noticing "I'm on a 3-loss streak, maybe stop for today" type
    # patterns while a strategy is being tracked. ---
    current_streak = {"result": None, "count": 0}
    for t in reversed(trades):  # trades is ascending by date, so walk backwards
        if current_streak["result"] is None:
            current_streak = {"result": t.result, "count": 1}
        elif t.result == current_streak["result"]:
            current_streak["count"] += 1
        else:
            break

    # --- Win-rate trend per strategy: cumulative win rate after each trade,
    # in the order trades were taken under that strategy. This ignores the
    # setup_id filter on purpose (it needs multiple strategies to compare as
    # separate lines) but still respects everything else filtered above. ---
    trend_query = (
        db.query(Trade)
        .options(joinedload(Trade.setup))
        .filter(Trade.setup_id.isnot(None))
    )
    trend_query = apply_trade_filters(
        trend_query,
        pair,
        result,
        entry_ltf,
        candle_4h,
        position,
        account_type,
        account_size,
        None,  # setup_id intentionally not applied here
        challenge_id,
        date_from,
        date_to,
    )
    trend_trades = trend_query.order_by(Trade.trade_date.asc(), Trade.id.asc()).all()

    trend_by_setup = defaultdict(list)
    for t in trend_trades:
        trend_by_setup[t.setup_id].append(t)

    strategy_trends = []
    for sid, s_trades in trend_by_setup.items():
        s_wins = 0
        s_losses = 0
        # Start every line at (0, 0%) -- before any trade has been taken
        # under this strategy, its cumulative win rate hasn't been earned
        # yet, so the chart shouldn't jump straight to 100% just because
        # the first trade happened to be a win.
        points = [{"trade_no": 0, "win_rate": 0}]
        for i, t in enumerate(s_trades, start=1):
            if t.result == "Win":
                s_wins += 1
            elif t.result == "Loss":
                s_losses += 1
            points.append({"trade_no": i, "win_rate": _win_rate(s_wins, s_losses)})
        strategy_trends.append(
            {"setup_id": sid, "setup_name": s_trades[0].setup.name, "points": points}
        )
    strategy_trends.sort(key=lambda x: x["setup_name"])

    # --- Performance by pair ---
    by_pair = defaultdict(list)
    for t in trades:
        by_pair[t.pair].append(t)

    pair_stats = []
    for pair_name, pair_trades in by_pair.items():
        p_wins = sum(1 for t in pair_trades if t.result == "Win")
        p_losses = sum(1 for t in pair_trades if t.result == "Loss")
        pair_stats.append(
            {
                "pair": pair_name,
                "count": len(pair_trades),
                "win_rate": _win_rate(p_wins, p_losses),
                "total_pnl": round(sum(float(t.pnl) for t in pair_trades), 2),
            }
        )
    pair_stats.sort(key=lambda x: x["total_pnl"], reverse=True)

    # --- Performance by setup/strategy ---
    by_setup = defaultdict(list)
    for t in trades:
        key = t.setup.name if t.setup else "No Setup"
        by_setup[key].append(t)

    setup_stats = []
    for setup_name, setup_trades in by_setup.items():
        s_wins = sum(1 for t in setup_trades if t.result == "Win")
        s_losses = sum(1 for t in setup_trades if t.result == "Loss")
        setup_stats.append(
            {
                "setup": setup_name,
                "count": len(setup_trades),
                "win_rate": _win_rate(s_wins, s_losses),
                "total_pnl": round(sum(float(t.pnl) for t in setup_trades), 2),
            }
        )
    setup_stats.sort(key=lambda x: x["total_pnl"], reverse=True)

    return {
        "account_type": account_type or "All",
        "summary": {
            "total_trades": total_trades,
            "wins": wins,
            "losses": losses,
            "breakevens": breakevens,
            "win_rate": _win_rate(wins, losses),
            "total_pnl": total_pnl,
            "avg_rr": avg_rr,
            "avg_risk_pct": avg_risk_pct,
            "current_streak": current_streak,
            "no_setup_count": no_setup_count,
            "no_setup_pct": no_setup_pct,
        },
        "position_stats": position_stats,
        "strategy_trends": strategy_trends,
        "pair_stats": pair_stats,
        "setup_stats": setup_stats,
        "mistake_stats": mistake_breakdown(trades),
        "active_account_equity_curves": _active_account_equity_curves(db),
    }
