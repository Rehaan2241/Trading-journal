from datetime import date, datetime
from typing import Optional, Literal, List
from pydantic import BaseModel, Field, ConfigDict

Position = Literal["Long", "Short"]
EntryLTF = Literal["1m", "3m", "5m"]
Candle4H = Literal["3:30", "7:30"]
Result = Literal["Win", "Loss", "Breakeven"]
AccountSize = Literal[5000, 10000, 25000, 50000, 100000]
AccountType = Literal["Master", "Phase"]


# ---- Confluences (custom, per-strategy, user-prioritized) ----

class ConfluenceIn(BaseModel):
    """One confluence row coming from the Strategy form. `id` is set when
    editing an existing confluence (so it keeps its identity / history on
    trades that already tagged it) and left out/None for a brand new one.
    Priority is NOT sent by the client -- it's derived from the row's
    position in the list (index + 1), which is how the UI lets you
    prioritize them.
    """

    id: Optional[int] = None
    name: str


class ConfluenceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    priority: int


class MistakeTagOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str


class MistakeTagCreate(BaseModel):
    name: str


class TradeBase(BaseModel):
    trade_date: date
    # The trading account this trade was taken on. Every trade must be
    # linked to one of your active Challenge accounts (e.g. "FTMO 50k
    # Phase 1" or "FundingPips 10k Master") -- account_size and
    # account_type are no longer typed in by hand, they're copied down
    # from the chosen challenge automatically.
    challenge_id: int
    position: Position
    pair: str
    entry_ltf: EntryLTF
    candle_4h: Candle4H
    setup_id: Optional[int] = None
    result: Result
    pnl: float
    risk_amount: Optional[float] = None
    confluence_ids: List[int] = Field(default_factory=list)
    mistake_tag_ids: List[int] = Field(default_factory=list)
    screenshot_urls: List[str] = Field(default_factory=list)
    notes: Optional[str] = None


class TradeCreate(TradeBase):
    pass


class TradeUpdate(BaseModel):
    """All fields optional so PATCH can send a partial payload."""

    trade_date: Optional[date] = None
    # If provided, re-points the trade at a different (active) challenge
    # account, and account_size/account_type are re-derived from it.
    challenge_id: Optional[int] = None
    position: Optional[Position] = None
    pair: Optional[str] = None
    entry_ltf: Optional[EntryLTF] = None
    candle_4h: Optional[Candle4H] = None
    setup_id: Optional[int] = None
    result: Optional[Result] = None
    pnl: Optional[float] = None
    risk_amount: Optional[float] = None
    confluence_ids: Optional[List[int]] = None
    mistake_tag_ids: Optional[List[int]] = None
    screenshot_urls: Optional[List[str]] = None
    notes: Optional[str] = None


class TradeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    trade_date: date
    account_size: int
    account_type: AccountType
    position: Position
    pair: str
    entry_ltf: EntryLTF
    candle_4h: Candle4H
    setup_id: Optional[int] = None
    challenge_id: Optional[int] = None
    result: Result
    pnl: float
    risk_amount: Optional[float] = None
    screenshot_urls: List[str] = Field(default_factory=list)
    notes: Optional[str] = None

    setup_name: Optional[str] = Field(default=None)
    challenge_name: Optional[str] = Field(default=None)
    confluences: List[ConfluenceOut] = Field(default_factory=list)
    mistake_tags: List[MistakeTagOut] = Field(default_factory=list)
    loss_percentage: float
    rr_ratio: Optional[float] = Field(default=None)
    risk_percentage: Optional[float] = Field(default=None)


class TradesPage(BaseModel):
    """Paginated trades list response for GET /api/trades."""

    total: int
    items: List[TradeOut]


class PairCreate(BaseModel):
    name: str


class PairOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str


# ---- Strategies ("Setups") ----

class StrategyBase(BaseModel):
    name: str
    notes: Optional[str] = None


class StrategyCreate(StrategyBase):
    # Confluences you define yourself, in the order you want them
    # prioritized (first item = priority 1).
    confluences: List[ConfluenceIn] = Field(default_factory=list)


class StrategyUpdate(BaseModel):
    name: Optional[str] = None
    notes: Optional[str] = None
    # If provided, replaces the strategy's confluence set: existing rows
    # (matched by id) are renamed/reordered in place, ones left out are
    # removed, and ones without an id are created new.
    confluences: Optional[List[ConfluenceIn]] = None


class StrategyOut(StrategyBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    trade_count: int = Field(default=0, description="How many trades currently use this setup")
    confluences: List[ConfluenceOut] = Field(default_factory=list)


# ---- Strategy performance (for the Strategy page's performance filter) ----

class ConfluencePerformance(ConfluenceOut):
    count: int
    win_rate: float
    total_pnl: float


class StrategyPerformanceSummary(BaseModel):
    total_trades: int
    wins: int
    losses: int
    breakevens: int
    win_rate: float
    total_pnl: float
    avg_rr: Optional[float] = None


class StrategyPerformanceOut(BaseModel):
    strategy_id: int
    strategy_name: str
    summary: StrategyPerformanceSummary
    confluence_stats: List[ConfluencePerformance]


# ---- Challenges (prop-firm / funded phase tracking) ----

class ChallengeBase(BaseModel):
    name: str
    account_size: AccountSize
    account_type: AccountType = "Master"
    profit_target_pct: float = 8
    max_drawdown_pct: float = 10
    daily_drawdown_pct: Optional[float] = 5
    start_date: date
    days_allowed: Optional[int] = None
    is_active: bool = True
    notes: Optional[str] = None


class ChallengeCreate(ChallengeBase):
    pass


class ChallengeUpdate(BaseModel):
    name: Optional[str] = None
    account_size: Optional[AccountSize] = None
    account_type: Optional[AccountType] = None
    profit_target_pct: Optional[float] = None
    max_drawdown_pct: Optional[float] = None
    daily_drawdown_pct: Optional[float] = None
    start_date: Optional[date] = None
    days_allowed: Optional[int] = None
    is_active: Optional[bool] = None
    notes: Optional[str] = None
    status: Optional[Literal["active", "passed", "failed"]] = None


class ChallengeOut(ChallengeBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    trade_count: int = Field(default=0, description="How many trades are logged against this challenge")
    status: Literal["active", "passed", "failed"] = "active"
    phase_number: int = 1
    previous_challenge_id: Optional[int] = None
    next_challenge_id: Optional[int] = Field(
        default=None, description="The Phase N+1 challenge created after this one passed, if any"
    )
    total_paid_out: float = Field(default=0, description="Sum of all payouts recorded against this account (Master only)")
    locked_for_trading: bool = Field(
        default=False,
        description="True once this account can no longer accept new trades -- either it already passed/failed, it breached its max or daily drawdown, or (for an active Phase account) it just hit its profit target and is waiting to be marked passed.",
    )
    lock_reason: Optional[str] = Field(
        default=None,
        description="Human-readable reason locked_for_trading is true, e.g. 'max drawdown breached'. None while the account is still open for trading.",
    )


# ---- Payouts (Master account profit withdrawals) ----

class PayoutCreate(BaseModel):
    payout_date: date
    amount: float
    notes: Optional[str] = None


class PayoutOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    challenge_id: int
    payout_date: date
    amount: float
    notes: Optional[str] = None
    created_at: datetime


class ChallengePassResult(BaseModel):
    """Returned when a Phase account is marked as passed. `next_challenge`
    is the freshly-created Phase N+1 account it graduates into (None if the
    caller asked to just mark it passed without starting the next phase)."""

    passed_challenge: ChallengeOut
    next_challenge: Optional[ChallengeOut] = None


class PassChallengeIn(BaseModel):
    """Optional overrides for the Phase N+1 account created when a Phase
    account is marked as passed. Anything left out falls back to a sensible
    default (usually the same rules as the phase that just passed)."""

    create_next_phase: bool = True
    next_account_type: Literal["Phase", "Master"] = "Phase"
    next_name: Optional[str] = None
    next_profit_target_pct: Optional[float] = None
    next_max_drawdown_pct: Optional[float] = None
    next_daily_drawdown_pct: Optional[float] = None
    next_days_allowed: Optional[int] = None
    next_start_date: Optional[date] = None


class ChallengeProgressOut(BaseModel):
    challenge_id: int
    challenge_name: str
    account_size: int
    is_active: bool

    total_trades: int
    total_pnl: float
    current_equity: float

    profit_target_pct: float
    profit_target_amount: float
    profit_target_used_pct: float = Field(description="% of the profit target reached so far (can exceed 100)")

    max_drawdown_pct: float
    max_drawdown_amount: float = Field(description="Static $ buffer allowed below the ORIGINAL account size (account_size * max_drawdown_pct)")
    max_drawdown_floor: float = Field(description="The fixed equity line that ends the account if crossed (account_size - max_drawdown_amount). This line never moves, win or lose.")
    peak_equity: float = Field(description="Highest equity ever reached (informational only, no longer used to compute the drawdown line)")
    max_drawdown_remaining_amount: float = Field(
        description="How much further you could lose right now before hitting the floor (current_equity - max_drawdown_floor). Grows above max_drawdown_amount once you're in profit, since the floor is static."
    )
    max_drawdown_used_amount: float = Field(description="How much of the static max-drawdown buffer has actually been eaten into (0 while at/above the original account size)")
    current_drawdown_amount: float = Field(description="Alias of max_drawdown_used_amount, kept for backwards compatibility")
    worst_drawdown_amount: float = Field(description="The worst the account has ever dipped below its original account size, in $")
    drawdown_used_pct: float = Field(description="% of the max allowed drawdown used, based on the worst dip below the original account size")

    # Daily drawdown -- measured against the equity at the start of each
    # calendar day, not the overall peak. None if the challenge has no daily
    # limit configured.
    daily_drawdown_pct: Optional[float] = None
    daily_drawdown_amount: Optional[float] = Field(default=None, description="Base daily loss limit in $ (account_size * daily_drawdown_pct). This is the MOST a day's allowance can be -- see today_drawdown_limit_amount for the actual (possibly smaller) limit in force today.")
    today_pnl: float = Field(description="Realized PnL so far today")
    today_drawdown_amount: float = Field(description="Worst dip below today's start-of-day equity, so far today")
    today_drawdown_limit_amount: Optional[float] = Field(
        default=None,
        description=(
            "The actual $ daily-loss limit in force today: min(daily_drawdown_amount, "
            "remaining max-drawdown buffer at the start of today). Shrinks once the "
            "overall max-drawdown buffer runs lower than the normal daily allowance, "
            "since you can't lose more in a day than you have left overall."
        ),
    )
    today_drawdown_used_pct: Optional[float] = Field(default=None, description="% of today's actual daily limit (today_drawdown_limit_amount) used today")
    worst_daily_drawdown_amount: float = Field(description="Worst single-day drawdown seen on any day of this challenge, in $")
    worst_daily_drawdown_used_pct: Optional[float] = None
    breached_daily_drawdown: bool = Field(description="Whether any single day ever breached that day's own daily drawdown limit")

    start_date: date
    days_allowed: Optional[int] = None
    days_elapsed: int
    days_remaining: Optional[int] = None

    target_hit: bool
    breached_drawdown: bool

    # ---- Phase lifecycle ----
    status: Literal["active", "passed", "failed"] = "active"
    phase_number: int = 1
    previous_challenge_id: Optional[int] = None
    next_challenge_id: Optional[int] = None

    # ---- Master account payout cycle (None for Phase accounts) ----
    total_paid_out: float = 0
    cycle_start_date: Optional[date] = Field(default=None, description="Day the current (post-payout) trading cycle started")
    cycle_end_date: Optional[date] = Field(default=None, description="cycle_start_date + payout cycle length - 1")
    cycle_length_days: Optional[int] = Field(default=None, description="Length of one payout cycle in days, e.g. 14")
    cycle_day_number: Optional[int] = Field(default=None, description="Which day of the current cycle today is (1-indexed)")
    cycle_days_remaining: Optional[int] = None
    cycle_pnl: Optional[float] = Field(default=None, description="Realized PnL since the last payout (or since the first trade, if none yet)")
    cycle_equity: Optional[float] = Field(default=None, description="account_size + cycle_pnl -- the actual balance right now")
    ready_for_payout: Optional[bool] = Field(default=None, description="True once the current cycle has run its full length")
