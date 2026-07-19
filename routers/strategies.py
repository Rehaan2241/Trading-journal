from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func, text

from database import get_db
from models import Strategy, StrategyConfluence, Trade, trade_confluences
from schemas import (
    StrategyCreate,
    StrategyUpdate,
    StrategyOut,
    StrategyPerformanceOut,
    StrategyPerformanceSummary,
    ConfluencePerformance,
)
from utils import apply_trade_filters, rr_ratio, win_rate

router = APIRouter(prefix="/api/strategies", tags=["strategies"])


def _to_out(strategy: Strategy, db: Session) -> StrategyOut:
    trade_count = db.query(func.count(Trade.id)).filter(Trade.setup_id == strategy.id).scalar() or 0
    return StrategyOut.model_validate(
        {
            "id": strategy.id,
            "name": strategy.name,
            "notes": strategy.notes,
            "created_at": strategy.created_at,
            "trade_count": trade_count,
            "confluences": strategy.confluences,
        }
    )


def _dedupe_confluence_items(incoming: List):
    """Collapse items that name the same confluence (case-insensitive,
    trimmed) into one, so 'Liquidity Sweep' and 'liquidity sweep ' typed
    twice on the same strategy don't become two separate tags. Keeps the
    first occurrence's id (if any) so existing trade tags/history stay
    attached to that row; later duplicates in the same submission are just
    dropped. This is what stops the "1. Liquidity Sweep" / "1. Liquidity
    Sweep" repeats from ever being created in the first place."""
    seen = {}
    result = []
    for item in incoming:
        name = item.name.strip()
        if not name:
            continue
        key = name.lower()
        if key in seen:
            # Prefer keeping an id that was already there over a blank one,
            # in case the duplicate happened to be the "real" existing row.
            if seen[key].id is None and item.id is not None:
                seen[key].id = item.id
            continue
        seen[key] = item
        result.append(item)
    return result


def _sync_confluences(strategy: Strategy, incoming: List, db: Session) -> None:
    """Replace strategy.confluences with `incoming` (list of ConfluenceIn),
    preserving the id (and therefore trade history) of any confluence that's
    kept, and assigning priority = position in the list (1-indexed).
    """
    incoming = _dedupe_confluence_items(incoming)
    existing_by_id = {c.id: c for c in strategy.confluences}
    keep_ids = {item.id for item in incoming if item.id is not None}

    # Remove confluences that were dropped from the list. This cascades to
    # trade_confluences, so any trade that had tagged a removed confluence
    # simply loses that tag -- same "keep the trade, drop the link" pattern
    # used elsewhere in this app.
    for cid, existing in list(existing_by_id.items()):
        if cid not in keep_ids:
            db.delete(existing)

    for i, item in enumerate(incoming):
        priority = i + 1
        name = item.name.strip()
        if not name:
            continue
        if item.id is not None and item.id in existing_by_id:
            row = existing_by_id[item.id]
            row.name = name
            row.priority = priority
        else:
            db.add(
                StrategyConfluence(strategy_id=strategy.id, name=name, priority=priority)
            )


@router.get("", response_model=List[StrategyOut])
def list_strategies(db: Session = Depends(get_db)):
    strategies = (
        db.query(Strategy).options(joinedload(Strategy.confluences)).order_by(Strategy.name).all()
    )
    return [_to_out(s, db) for s in strategies]


@router.get("/{strategy_id}", response_model=StrategyOut)
def get_strategy(strategy_id: int, db: Session = Depends(get_db)):
    strategy = (
        db.query(Strategy)
        .options(joinedload(Strategy.confluences))
        .filter(Strategy.id == strategy_id)
        .first()
    )
    if not strategy:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return _to_out(strategy, db)


@router.post("", response_model=StrategyOut, status_code=201)
def create_strategy(payload: StrategyCreate, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Strategy name is required")

    strategy = Strategy(name=name, notes=payload.notes)
    db.add(strategy)
    try:
        db.flush()  # assign strategy.id before creating confluence rows
        for i, item in enumerate(_dedupe_confluence_items(payload.confluences)):
            item_name = item.name.strip()
            if not item_name:
                continue
            db.add(StrategyConfluence(strategy_id=strategy.id, name=item_name, priority=i + 1))
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="A strategy with this name already exists")
    db.refresh(strategy)
    return _to_out(strategy, db)


@router.patch("/{strategy_id}", response_model=StrategyOut)
def update_strategy(strategy_id: int, payload: StrategyUpdate, db: Session = Depends(get_db)):
    strategy = (
        db.query(Strategy)
        .options(joinedload(Strategy.confluences))
        .filter(Strategy.id == strategy_id)
        .first()
    )
    if not strategy:
        raise HTTPException(status_code=404, detail="Strategy not found")

    if payload.name is not None:
        new_name = payload.name.strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="Strategy name cannot be empty")
        strategy.name = new_name

    if payload.notes is not None:
        strategy.notes = payload.notes

    if payload.confluences is not None:
        _sync_confluences(strategy, payload.confluences, db)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="A strategy with this name already exists")
    db.refresh(strategy)
    return _to_out(strategy, db)


@router.post("/{strategy_id}/dedupe-confluences", response_model=StrategyOut)
def dedupe_strategy_confluences(strategy_id: int, db: Session = Depends(get_db)):
    """One-time cleanup for confluences that already ended up duplicated
    under this strategy (same name, e.g. two 'Liquidity Sweep' rows) --
    this can happen from data created before duplicate names were blocked
    on save. For each duplicate name group, keeps the oldest row, re-points
    any trade tags sitting on the newer duplicate rows onto that kept row
    (so no trade silently loses its tag), removes the duplicates, then
    renumbers priority 1..N so the list stays gap-free."""
    strategy = (
        db.query(Strategy)
        .options(joinedload(Strategy.confluences))
        .filter(Strategy.id == strategy_id)
        .first()
    )
    if not strategy:
        raise HTTPException(status_code=404, detail="Strategy not found")

    # Stable order matching how the card displays them (priority, then id
    # as a tiebreaker), so "the oldest one" is well-defined per group.
    ordered = sorted(strategy.confluences, key=lambda c: (c.priority, c.id))

    groups = {}
    group_order = []
    for c in ordered:
        key = c.name.strip().lower()
        if key not in groups:
            groups[key] = []
            group_order.append(key)
        groups[key].append(c)

    merged_groups = 0
    removed = 0
    for key in group_order:
        members = groups[key]
        if len(members) < 2:
            continue
        merged_groups += 1
        canonical, duplicates = members[0], members[1:]
        duplicate_ids = [d.id for d in duplicates]

        # Re-point any trade tags on the duplicate rows onto the canonical
        # row instead of just deleting them out from under a trade.
        # ON CONFLICT DO NOTHING covers a trade that (oddly) already had
        # both the canonical and a duplicate tagged on it.
        db.execute(
            text(
                """
                INSERT INTO trade_confluences (trade_id, strategy_confluence_id)
                SELECT trade_id, :canonical_id FROM trade_confluences
                WHERE strategy_confluence_id = ANY(:dup_ids)
                ON CONFLICT DO NOTHING
                """
            ),
            {"canonical_id": canonical.id, "dup_ids": duplicate_ids},
        )

        for d in duplicates:
            db.delete(d)
            removed += 1

    db.flush()
    db.refresh(strategy)

    # Renumber priority 1..N in the same relative order, now gap-free.
    remaining = sorted(strategy.confluences, key=lambda c: (c.priority, c.id))
    for i, c in enumerate(remaining):
        c.priority = i + 1

    db.commit()
    db.refresh(strategy)
    return _to_out(strategy, db)


@router.delete("/{strategy_id}", status_code=204)
def delete_strategy(strategy_id: int, db: Session = Depends(get_db)):
    strategy = db.query(Strategy).filter(Strategy.id == strategy_id).first()
    if not strategy:
        raise HTTPException(status_code=404, detail="Strategy not found")

    trade_count = db.query(func.count(Trade.id)).filter(Trade.setup_id == strategy_id).scalar() or 0
    if trade_count:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Can't delete this strategy: {trade_count} trade(s) are still taken under it. "
                "Delete those trades first, then delete the strategy."
            ),
        )

    db.delete(strategy)
    db.commit()
    return None


@router.get("/{strategy_id}/performance", response_model=StrategyPerformanceOut)
def get_strategy_performance(
    strategy_id: int,
    account_type: Optional[str] = None,
    account_size: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    db: Session = Depends(get_db),
):
    """Performance stats for one strategy (e.g. "Type 1"), for the Strategy
    page's monitoring panel: overall win rate/PnL plus a win-rate breakdown
    per confluence defined on that strategy.
    """
    strategy = (
        db.query(Strategy)
        .options(joinedload(Strategy.confluences))
        .filter(Strategy.id == strategy_id)
        .first()
    )
    if not strategy:
        raise HTTPException(status_code=404, detail="Strategy not found")

    query = db.query(Trade).options(joinedload(Trade.confluences)).filter(Trade.setup_id == strategy_id)
    query = apply_trade_filters(
        query,
        account_type=account_type,
        account_size=account_size,
        date_from=date_from,
        date_to=date_to,
    )
    trades = query.all()

    wins = sum(1 for t in trades if t.result == "Win")
    losses = sum(1 for t in trades if t.result == "Loss")
    breakevens = sum(1 for t in trades if t.result == "Breakeven")
    total_pnl = round(sum(float(t.pnl) for t in trades), 2)
    rr_values = [v for v in (rr_ratio(t.pnl, t.risk_amount, t.result) for t in trades) if v is not None]
    avg_rr = round(sum(rr_values) / len(rr_values), 2) if rr_values else None

    summary = StrategyPerformanceSummary(
        total_trades=len(trades),
        wins=wins,
        losses=losses,
        breakevens=breakevens,
        win_rate=win_rate(wins, losses),
        total_pnl=total_pnl,
        avg_rr=avg_rr,
    )

    confluence_stats = []
    for c in strategy.confluences:
        matching = [t for t in trades if any(tc.id == c.id for tc in t.confluences)]
        m_wins = sum(1 for t in matching if t.result == "Win")
        m_losses = sum(1 for t in matching if t.result == "Loss")
        confluence_stats.append(
            ConfluencePerformance(
                id=c.id,
                name=c.name,
                priority=c.priority,
                count=len(matching),
                win_rate=win_rate(m_wins, m_losses),
                total_pnl=round(sum(float(t.pnl) for t in matching), 2),
            )
        )

    return StrategyPerformanceOut(
        strategy_id=strategy.id,
        strategy_name=strategy.name,
        summary=summary,
        confluence_stats=confluence_stats,
    )
