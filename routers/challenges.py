from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from models import Challenge, Trade, Payout
from schemas import (
    ChallengeCreate,
    ChallengeUpdate,
    ChallengeOut,
    ChallengeProgressOut,
    PayoutCreate,
    PayoutOut,
    PassChallengeIn,
    ChallengePassResult,
)

router = APIRouter(prefix="/api/challenges", tags=["challenges"])


def _next_challenge_id(challenge_id: int, db: Session) -> Optional[int]:
    nxt = db.query(Challenge).filter(Challenge.previous_challenge_id == challenge_id).first()
    return nxt.id if nxt else None


def _to_out(challenge: Challenge, db: Session) -> ChallengeOut:
    trade_count = db.query(func.count(Trade.id)).filter(Trade.challenge_id == challenge.id).scalar() or 0
    total_paid_out = db.query(func.coalesce(func.sum(Payout.amount), 0)).filter(
        Payout.challenge_id == challenge.id
    ).scalar() or 0

    # An account stops taking new trades the moment it's no longer "in
    # progress": it already passed/failed, OR (for a still-active Phase
    # account) it just hit its profit target and is waiting to be marked
    # passed, OR it breached its max drawdown or daily drawdown limit --
    # you shouldn't be able to keep adding trades to a blown account just
    # because nobody has manually marked it "failed" yet. This applies to
    # BOTH Phase and Master accounts (a Master account can breach its
    # drawdown limits too, and losing it doesn't get graduated anywhere --
    # it should just stop accepting trades the same as a failed Phase).
    locked_for_trading = False
    lock_reason = None
    if challenge.status != "active":
        locked_for_trading = True
    else:
        progress = _compute_progress(challenge, db)
        if progress.breached_drawdown:
            locked_for_trading = True
            lock_reason = "max drawdown breached"
        elif progress.breached_daily_drawdown:
            locked_for_trading = True
            lock_reason = "daily drawdown breached"
        elif challenge.account_type == "Phase" and progress.target_hit:
            locked_for_trading = True
            lock_reason = "target hit — mark passed"

    return ChallengeOut.model_validate(
        {
            "id": challenge.id,
            "name": challenge.name,
            "account_size": challenge.account_size,
            "account_type": challenge.account_type,
            "profit_target_pct": float(challenge.profit_target_pct),
            "max_drawdown_pct": float(challenge.max_drawdown_pct),
            "daily_drawdown_pct": float(challenge.daily_drawdown_pct) if challenge.daily_drawdown_pct is not None else None,
            "start_date": challenge.start_date,
            "days_allowed": challenge.days_allowed,
            "is_active": challenge.is_active,
            "notes": challenge.notes,
            "created_at": challenge.created_at,
            "trade_count": trade_count,
            "status": challenge.status,
            "phase_number": challenge.phase_number,
            "previous_challenge_id": challenge.previous_challenge_id,
            "next_challenge_id": _next_challenge_id(challenge.id, db),
            "total_paid_out": float(total_paid_out),
            "locked_for_trading": locked_for_trading,
            "lock_reason": lock_reason,
        }
    )


@router.get("", response_model=List[ChallengeOut])
def list_challenges(db: Session = Depends(get_db)):
    challenges = db.query(Challenge).order_by(Challenge.is_active.desc(), Challenge.start_date.desc()).all()
    return [_to_out(c, db) for c in challenges]


@router.get("/{challenge_id}", response_model=ChallengeOut)
def get_challenge(challenge_id: int, db: Session = Depends(get_db)):
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    return _to_out(challenge, db)


@router.post("", response_model=ChallengeOut, status_code=201)
def create_challenge(payload: ChallengeCreate, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Challenge name is required")

    challenge = Challenge(
        name=name,
        account_size=payload.account_size,
        account_type=payload.account_type,
        profit_target_pct=payload.profit_target_pct,
        max_drawdown_pct=payload.max_drawdown_pct,
        daily_drawdown_pct=payload.daily_drawdown_pct,
        start_date=payload.start_date,
        days_allowed=payload.days_allowed,
        is_active=payload.is_active,
        notes=payload.notes,
    )
    db.add(challenge)
    db.commit()
    db.refresh(challenge)
    return _to_out(challenge, db)


@router.patch("/{challenge_id}", response_model=ChallengeOut)
def update_challenge(challenge_id: int, payload: ChallengeUpdate, db: Session = Depends(get_db)):
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")

    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates:
        new_name = (updates["name"] or "").strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="Challenge name cannot be empty")
        updates["name"] = new_name

    for key, value in updates.items():
        setattr(challenge, key, value)

    db.commit()
    db.refresh(challenge)
    return _to_out(challenge, db)


@router.delete("/{challenge_id}", status_code=204)
def delete_challenge(challenge_id: int, db: Session = Depends(get_db)):
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")

    trade_count = db.query(func.count(Trade.id)).filter(Trade.challenge_id == challenge_id).scalar() or 0
    if trade_count:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Can't delete this challenge: {trade_count} trade(s) are still linked to it. "
                "Delete/unlink those trades first, then delete the challenge."
            ),
        )

    db.delete(challenge)
    db.commit()
    return None


# ---- Payouts (Master account profit withdrawals) ----

@router.get("/{challenge_id}/payouts", response_model=List[PayoutOut])
def list_payouts(challenge_id: int, db: Session = Depends(get_db)):
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    return (
        db.query(Payout)
        .filter(Payout.challenge_id == challenge_id)
        .order_by(Payout.payout_date.asc())
        .all()
    )


@router.post("/{challenge_id}/payouts", response_model=PayoutOut, status_code=201)
def create_payout(challenge_id: int, payload: PayoutCreate, db: Session = Depends(get_db)):
    """Record a profit withdrawal on a Master account. This closes out the
    current payout cycle -- the next cycle starts fresh (account back at its
    initial balance) from the day after payload.payout_date."""
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    if challenge.account_type != "Master":
        raise HTTPException(status_code=400, detail="Payouts can only be recorded on Master accounts")
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="Payout amount must be greater than 0")

    payout = Payout(
        challenge_id=challenge_id,
        payout_date=payload.payout_date,
        amount=payload.amount,
        notes=payload.notes,
    )
    db.add(payout)
    db.commit()
    db.refresh(payout)
    return payout


@router.delete("/{challenge_id}/payouts/{payout_id}", status_code=204)
def delete_payout(challenge_id: int, payout_id: int, db: Session = Depends(get_db)):
    payout = (
        db.query(Payout)
        .filter(Payout.id == payout_id, Payout.challenge_id == challenge_id)
        .first()
    )
    if not payout:
        raise HTTPException(status_code=404, detail="Payout not found")
    db.delete(payout)
    db.commit()
    return None


# ---- Phase pass/graduate ----

@router.post("/{challenge_id}/pass", response_model=ChallengePassResult)
def pass_challenge(challenge_id: int, payload: PassChallengeIn = PassChallengeIn(), db: Session = Depends(get_db)):
    """Mark a Phase account as passed once its profit target is hit, lock it
    (is_active=False so it drops out of the trade-linking dropdown, its
    history stays intact), and optionally spin up the Phase N+1 account it
    graduates into with the same (or overridden) rules."""
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    if challenge.account_type != "Phase":
        raise HTTPException(status_code=400, detail="Only Phase accounts can be marked as passed")
    if challenge.status == "passed":
        raise HTTPException(status_code=400, detail="This challenge is already marked as passed")

    progress = _compute_progress(challenge, db)
    if not progress.target_hit:
        raise HTTPException(status_code=400, detail="Profit target hasn't been reached yet")
    if progress.breached_drawdown or progress.breached_daily_drawdown:
        raise HTTPException(status_code=400, detail="A drawdown limit was breached -- this account failed, it can't be passed")

    challenge.status = "passed"
    challenge.is_active = False

    next_challenge = None
    if payload.create_next_phase:
        next_phase_number = (challenge.phase_number or 1) + 1
        next_name = payload.next_name or _default_next_name(challenge.name, next_phase_number, payload.next_account_type)
        if payload.next_account_type == "Master":
            # Graduating to a funded Master account: no profit target, and
            # days_allowed is reused as the payout-cycle length (default 14).
            next_days_allowed = payload.next_days_allowed if payload.next_days_allowed is not None else 14
        else:
            next_days_allowed = payload.next_days_allowed if payload.next_days_allowed is not None else challenge.days_allowed

        next_challenge = Challenge(
            name=next_name,
            account_size=challenge.account_size,
            account_type=payload.next_account_type,
            profit_target_pct=payload.next_profit_target_pct if payload.next_profit_target_pct is not None else float(challenge.profit_target_pct),
            max_drawdown_pct=payload.next_max_drawdown_pct if payload.next_max_drawdown_pct is not None else float(challenge.max_drawdown_pct),
            daily_drawdown_pct=payload.next_daily_drawdown_pct if payload.next_daily_drawdown_pct is not None else (
                float(challenge.daily_drawdown_pct) if challenge.daily_drawdown_pct is not None else None
            ),
            start_date=payload.next_start_date or date.today(),
            days_allowed=next_days_allowed,
            is_active=True,
            notes=f"Auto-created after passing '{challenge.name}'.",
            phase_number=next_phase_number,
            previous_challenge_id=challenge.id,
        )
        db.add(next_challenge)

    db.commit()
    db.refresh(challenge)
    if next_challenge:
        db.refresh(next_challenge)

    return ChallengePassResult(
        passed_challenge=_to_out(challenge, db),
        next_challenge=_to_out(next_challenge, db) if next_challenge else None,
    )


def _default_next_name(name: str, next_phase_number: int, next_account_type: str) -> str:
    import re

    if next_account_type == "Master":
        match = re.search(r"phase\s*\d+", name, flags=re.IGNORECASE)
        if match:
            return (name[: match.start()] + "Master" + name[match.end():]).strip(" -")
        return f"{name} - Master"

    match = re.search(r"phase\s*\d+", name, flags=re.IGNORECASE)
    if match:
        return name[: match.start()] + f"Phase {next_phase_number}" + name[match.end():]
    return f"{name} - Phase {next_phase_number}"


@router.get("/{challenge_id}/progress", response_model=ChallengeProgressOut)
def get_challenge_progress(challenge_id: int, db: Session = Depends(get_db)):
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=404, detail="Challenge not found")
    return _compute_progress(challenge, db)


def _compute_progress(challenge: Challenge, db: Session) -> ChallengeProgressOut:
    """The numbers that actually matter for a prop-firm challenge.

    Max drawdown is modeled the way FundingPips/most static-DD firms actually
    enforce it: the breach line is a FIXED dollar amount below the account's
    ORIGINAL balance (account_size - max_drawdown_amount) and never moves.
    It doesn't trail your equity peak. That means once you're in profit, the
    distance between your current equity and that fixed line is naturally
    bigger than the original max_drawdown_amount -- e.g. on a 10k account
    with an 8%/$800 max drawdown, if you're up $300, you can give back
    $1,100 (not just $800) before you'd hit the floor, because the floor
    itself never moved.

    Daily drawdown resets each day but is capped by whatever's left of the
    overall max-drawdown buffer (see the comment below), and is tracked as
    a running current-status number: a day's "used" amount is based on that
    day's NET result, so a loss that gets won back the same day goes right
    back to $0 used, same as the max-drawdown buffer above.
    """
    trades = (
        db.query(Trade)
        .filter(Trade.challenge_id == challenge.id)
        .order_by(Trade.trade_date.asc(), Trade.id.asc())
        .all()
    )

    account_size = float(challenge.account_size)
    profit_target_pct = float(challenge.profit_target_pct)
    max_drawdown_pct = float(challenge.max_drawdown_pct)
    daily_drawdown_pct = float(challenge.daily_drawdown_pct) if challenge.daily_drawdown_pct is not None else None

    profit_target_amount = round(account_size * profit_target_pct / 100, 2)
    max_drawdown_amount = round(account_size * max_drawdown_pct / 100, 2)
    daily_drawdown_amount = round(account_size * daily_drawdown_pct / 100, 2) if daily_drawdown_pct else None

    max_drawdown_floor = round(account_size - max_drawdown_amount, 2)

    today = date.today()
    trades_by_day: dict = {}
    for t in trades:
        trades_by_day.setdefault(t.trade_date, []).append(t)

    # Both drawdown buffers are running, CURRENT-STATUS numbers, not "worst
    # point ever reached" numbers -- exactly like a real prop-firm dashboard:
    # if you lose $1,000 then win it back, your remaining buffer goes right
    # back to where it was. It doesn't stay stuck at the worst dip. So a day
    # that nets -1000 then +1000 (net $0) shows $0 of today's daily-drawdown
    # used, not $1,000 -- and a day that nets -1000/-1000/+4300 (net +2300,
    # a winning day) shows $0 used too.
    #
    # The daily-drawdown ALLOWANCE itself is not just a flat % of the
    # original account size every single day -- it's capped by however much
    # of the overall max-drawdown buffer is actually left at the start of
    # that day. Concretely: a day's $ limit = min(the normal daily %
    # amount, remaining max-drawdown buffer at the start of that day). Once
    # the account has given back enough that the max-drawdown buffer is
    # thinner than a normal day's allowance, that thinner number becomes
    # the real limit for that day -- you can't lose more in one day than you
    # have left overall. Example: $5,000 account, daily base $250, max-
    # drawdown buffer $500. A day that nets +$100 leaves $600 of max-
    # drawdown buffer (buffer just tracks equity - the fixed floor), so the
    # *next* day's limit is still min(250, 600) = 250 as normal. But after
    # enough losing days shrink that buffer down to, say, $170, the next
    # day's limit becomes min(250, 170) = 170, not 250 -- the daily
    # allowance shrinks to match whatever's actually left, it doesn't reset
    # to the full base amount just because a new day started.
    equity = account_size
    peak_equity = account_size
    lowest_equity = account_size
    worst_daily_drawdown_amount = 0.0
    worst_daily_drawdown_ratio = 0.0
    any_daily_breach = False
    today_pnl = 0.0
    today_drawdown_amount = 0.0
    today_drawdown_limit_amount = daily_drawdown_amount

    for day in sorted(trades_by_day.keys()):
        day_start_equity = equity

        if daily_drawdown_amount is not None:
            remaining_md_at_day_start = day_start_equity - max_drawdown_floor
            day_drawdown_limit = max(0.0, min(daily_drawdown_amount, remaining_md_at_day_start))
        else:
            day_drawdown_limit = None

        # Net result for the day -- order doesn't matter for a sum, so
        # there's no ambiguity here even though trades only carry a date,
        # not a time of day.
        day_pnl = round(sum(float(t.pnl) for t in trades_by_day[day]), 2)
        day_equity = round(day_start_equity + day_pnl, 2)
        day_drawdown_used = round(max(0.0, -day_pnl), 2)

        peak_equity = max(peak_equity, day_equity)
        lowest_equity = min(lowest_equity, day_equity)
        worst_daily_drawdown_amount = max(worst_daily_drawdown_amount, day_drawdown_used)

        if day_drawdown_limit is not None:
            if day_drawdown_limit > 1e-9:
                day_ratio = day_drawdown_used / day_drawdown_limit
            else:
                # The max-drawdown buffer was already at/below zero at the
                # start of this day, so this day's real limit is $0 -- any
                # net loss at all breaches it.
                day_ratio = 1.0 if day_drawdown_used > 1e-9 else 0.0
            worst_daily_drawdown_ratio = max(worst_daily_drawdown_ratio, day_ratio)
            if day_drawdown_used > 1e-9 and day_drawdown_used >= day_drawdown_limit - 1e-9:
                any_daily_breach = True

        if day == today:
            today_pnl = day_pnl
            today_drawdown_amount = day_drawdown_used
            today_drawdown_limit_amount = (
                round(day_drawdown_limit, 2) if day_drawdown_limit is not None else None
            )
        equity = day_equity

    # No trade logged yet today -- today's limit still needs to reflect
    # wherever the max-drawdown buffer actually stands right now, not just
    # the flat base amount.
    if today not in trades_by_day and daily_drawdown_amount is not None:
        remaining_md_now = equity - max_drawdown_floor
        today_drawdown_limit_amount = round(max(0.0, min(daily_drawdown_amount, remaining_md_now)), 2)

    total_pnl = round(equity - account_size, 2)
    current_equity = round(equity, 2)

    max_drawdown_remaining_amount = round(current_equity - max_drawdown_floor, 2)
    max_drawdown_used_amount = round(max(0.0, max_drawdown_amount - max_drawdown_remaining_amount), 2)
    worst_drawdown_amount = round(max(0.0, account_size - lowest_equity), 2)
    drawdown_used_pct = (
        round((worst_drawdown_amount / max_drawdown_amount) * 100, 2) if max_drawdown_amount else 0.0
    )
    breached_drawdown = bool(max_drawdown_amount) and lowest_equity <= max_drawdown_floor + 1e-9

    profit_target_used_pct = (
        round((total_pnl / profit_target_amount) * 100, 2) if profit_target_amount else 0.0
    )

    worst_daily_drawdown_amount = round(worst_daily_drawdown_amount, 2)
    today_drawdown_used_pct = (
        round((today_drawdown_amount / today_drawdown_limit_amount) * 100, 2)
        if today_drawdown_limit_amount
        else (100.0 if daily_drawdown_amount is not None and today_drawdown_amount > 1e-9 else (0.0 if daily_drawdown_amount is not None else None))
    )
    worst_daily_drawdown_used_pct = (
        round(worst_daily_drawdown_ratio * 100, 2) if daily_drawdown_amount is not None else None
    )
    breached_daily_drawdown = any_daily_breach

    days_elapsed = (today - challenge.start_date).days
    days_remaining = None
    if challenge.days_allowed is not None and challenge.account_type != "Master":
        days_remaining = challenge.days_allowed - days_elapsed

    total_paid_out = 0.0
    cycle_start_date = None
    cycle_end_date = None
    cycle_length_days = None
    cycle_day_number = None
    cycle_days_remaining = None
    cycle_pnl = None
    cycle_equity = None
    ready_for_payout = None

    if challenge.account_type == "Master":
        payouts = (
            db.query(Payout)
            .filter(Payout.challenge_id == challenge.id)
            .order_by(Payout.payout_date.asc())
            .all()
        )
        total_paid_out = float(sum(float(p.amount) for p in payouts))
        last_payout_date = payouts[-1].payout_date if payouts else None

        cycle_trades = [t for t in trades if last_payout_date is None or t.trade_date > last_payout_date]
        cycle_pnl = round(sum(float(t.pnl) for t in cycle_trades), 2)
        cycle_equity = round(account_size + cycle_pnl, 2)

        cycle_length_days = challenge.days_allowed or 14
        if cycle_trades:
            cycle_start_date = min(t.trade_date for t in cycle_trades)
            cycle_end_date = cycle_start_date + timedelta(days=cycle_length_days - 1)
            cycle_day_number = (today - cycle_start_date).days + 1
            cycle_days_remaining = cycle_length_days - cycle_day_number
            ready_for_payout = cycle_day_number >= cycle_length_days
        else:
            ready_for_payout = False

    next_challenge = db.query(Challenge).filter(Challenge.previous_challenge_id == challenge.id).first()

    return ChallengeProgressOut(
        challenge_id=challenge.id,
        challenge_name=challenge.name,
        account_size=challenge.account_size,
        is_active=challenge.is_active,
        total_trades=len(trades),
        total_pnl=total_pnl,
        current_equity=current_equity,
        profit_target_pct=profit_target_pct,
        profit_target_amount=profit_target_amount,
        profit_target_used_pct=profit_target_used_pct,
        max_drawdown_pct=max_drawdown_pct,
        max_drawdown_amount=max_drawdown_amount,
        max_drawdown_floor=max_drawdown_floor,
        peak_equity=round(peak_equity, 2),
        max_drawdown_remaining_amount=max_drawdown_remaining_amount,
        max_drawdown_used_amount=max_drawdown_used_amount,
        current_drawdown_amount=max_drawdown_used_amount,
        worst_drawdown_amount=worst_drawdown_amount,
        drawdown_used_pct=drawdown_used_pct,
        daily_drawdown_pct=daily_drawdown_pct,
        daily_drawdown_amount=daily_drawdown_amount,
        today_pnl=today_pnl,
        today_drawdown_amount=today_drawdown_amount,
        today_drawdown_limit_amount=today_drawdown_limit_amount,
        today_drawdown_used_pct=today_drawdown_used_pct,
        worst_daily_drawdown_amount=worst_daily_drawdown_amount,
        worst_daily_drawdown_used_pct=worst_daily_drawdown_used_pct,
        breached_daily_drawdown=breached_daily_drawdown,
        start_date=challenge.start_date,
        days_allowed=challenge.days_allowed,
        days_elapsed=days_elapsed,
        days_remaining=days_remaining,
        target_hit=total_pnl >= profit_target_amount and profit_target_amount > 0 and challenge.account_type != "Master",
        breached_drawdown=breached_drawdown,
        status=challenge.status,
        phase_number=challenge.phase_number,
        previous_challenge_id=challenge.previous_challenge_id,
        next_challenge_id=next_challenge.id if next_challenge else None,
        total_paid_out=total_paid_out,
        cycle_start_date=cycle_start_date,
        cycle_end_date=cycle_end_date,
        cycle_length_days=cycle_length_days,
        cycle_day_number=cycle_day_number,
        cycle_days_remaining=cycle_days_remaining,
        cycle_pnl=cycle_pnl,
        cycle_equity=cycle_equity,
        ready_for_payout=ready_for_payout,
    )
