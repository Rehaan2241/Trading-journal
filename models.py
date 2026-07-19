from sqlalchemy import (
    Column,
    Integer,
    String,
    Numeric,
    Boolean,
    Date,
    DateTime,
    Text,
    ForeignKey,
    CheckConstraint,
    Table,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import relationship

from database import Base


class Pair(Base):
    __tablename__ = "pairs"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Strategy(Base):
    """A saved "Setup" / playbook, e.g. 'Type 1', 'Type 2'.

    Confluences are no longer a fixed set of booleans -- each strategy
    defines its own list of custom-named confluences (StrategyConfluence),
    which you order by priority yourself when creating/editing the
    strategy. Selected on a trade via Trade.setup_id.
    """

    __tablename__ = "strategies"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, nullable=False, index=True)

    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    trades = relationship("Trade", back_populates="setup")
    confluences = relationship(
        "StrategyConfluence",
        back_populates="strategy",
        order_by="StrategyConfluence.priority",
        cascade="all, delete-orphan",
    )


class StrategyConfluence(Base):
    """A single custom confluence belonging to one strategy, e.g. 'Liquidity
    Sweep' under 'Type 1'. `priority` is user-defined (1 = highest) and is
    set by the order the confluences are arranged in on the Strategy page.
    """

    __tablename__ = "strategy_confluences"

    id = Column(Integer, primary_key=True, index=True)
    strategy_id = Column(
        Integer, ForeignKey("strategies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name = Column(String, nullable=False)
    priority = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    strategy = relationship("Strategy", back_populates="confluences")

    __table_args__ = (
        CheckConstraint("priority >= 1", name="ck_strategy_confluences_priority"),
    )


# Many-to-many: a trade can be tagged with any number of confluences that
# belong to the setup it was taken under.
trade_confluences = Table(
    "trade_confluences",
    Base.metadata,
    Column("trade_id", Integer, ForeignKey("trades.id", ondelete="CASCADE"), primary_key=True),
    Column(
        "strategy_confluence_id",
        Integer,
        ForeignKey("strategy_confluences.id", ondelete="CASCADE"),
        primary_key=True,
    ),
)


class MistakeTag(Base):
    """A reusable, global "what went wrong / emotional state" tag, e.g.
    'Moved Stop Loss', 'Revenge Trade', 'FOMO Entry'. Unlike confluences,
    these are NOT scoped to a strategy -- a mistake like "oversized position"
    can happen under any setup, so there's one shared list tagged onto
    trades directly. This is what lets the Dashboard answer "60% of my
    losses involve moving my stop loss" instead of that insight being
    buried in free-text notes.
    """

    __tablename__ = "mistake_tags"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# Many-to-many: a trade can be tagged with any number of global mistake tags.
trade_mistakes = Table(
    "trade_mistakes",
    Base.metadata,
    Column("trade_id", Integer, ForeignKey("trades.id", ondelete="CASCADE"), primary_key=True),
    Column(
        "mistake_tag_id", Integer, ForeignKey("mistake_tags.id", ondelete="CASCADE"), primary_key=True
    ),
)


class Challenge(Base):
    """A prop-firm/funded challenge or phase account instance, e.g. "FTMO
    Phase 1 - July". `account_type` on a Trade stays a simple Master/Phase
    label for quick filtering, but when a trade belongs to one of these it's
    also linked via Trade.challenge_id so progress toward the target/
    drawdown limits can be tracked properly instead of Phase just being an
    unstructured filter value.
    """

    __tablename__ = "challenges"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)
    account_size = Column(Integer, nullable=False)
    # Master account vs. a funded/evaluation Phase account. This is now the
    # single source of truth for a trade's account_type/account_size -- when
    # a trade picks this challenge as its trading account, both values are
    # copied down onto the trade automatically instead of being typed in by
    # hand every time.
    account_type = Column(String, nullable=False, default="Master")
    profit_target_pct = Column(Numeric, nullable=False, default=8)
    max_drawdown_pct = Column(Numeric, nullable=False, default=10)
    # Daily loss limit, e.g. FTMO's 5% max daily drawdown. Optional since not
    # every firm enforces one. Measured against the equity at the start of
    # each calendar day (see the /progress endpoint).
    daily_drawdown_pct = Column(Numeric, nullable=True, default=5)
    start_date = Column(Date, nullable=False)
    # For a Phase account: the total evaluation window in days (null = no
    # time limit). For a Master account: the length of one payout cycle in
    # days (e.g. 14) -- reused for this purpose instead of adding a second
    # column, since a Master account never has a hard "deadline", only a
    # repeating payout window measured the same way.
    days_allowed = Column(Integer, nullable=True)  # null = no time limit
    is_active = Column(Boolean, nullable=False, default=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Lifecycle status of a Phase account: 'active' while trading it,
    # 'passed' once the profit target was hit and it was locked/graduated to
    # the next phase, 'failed' if a drawdown limit was breached. Master
    # accounts just stay 'active' indefinitely (they cycle via payouts
    # instead of pass/fail).
    status = Column(String, nullable=False, default="active", server_default="active")
    # 1 for a Phase 1 account, 2 for the Phase 2 account created after
    # passing Phase 1, etc. Not meaningful for Master accounts.
    phase_number = Column(Integer, nullable=False, default=1, server_default="1")
    # Links a Phase N+1 account back to the Phase N account it was created
    # from when that one passed, so the UI can show/link the chain.
    previous_challenge_id = Column(
        Integer, ForeignKey("challenges.id", ondelete="SET NULL"), nullable=True
    )

    trades = relationship("Trade", back_populates="challenge")
    payouts = relationship(
        "Payout", back_populates="challenge", cascade="all, delete-orphan", order_by="Payout.payout_date"
    )

    __table_args__ = (
        CheckConstraint(
            "account_size in (5000, 10000, 25000, 50000, 100000)",
            name="ck_challenges_account_size",
        ),
        CheckConstraint(
            "account_type in ('Master', 'Phase')", name="ck_challenges_account_type"
        ),
        CheckConstraint(
            "status in ('active', 'passed', 'failed')", name="ck_challenges_status"
        ),
    )


class Payout(Base):
    """A profit withdrawal recorded against a Master account. Each payout
    marks the end of one payout cycle (e.g. the 14-day window a
    FundingPips-style Master account trades through before taking profit) --
    the amount is the profit taken out, and the next cycle starts fresh from
    the account's initial balance the day after.
    """

    __tablename__ = "payouts"

    id = Column(Integer, primary_key=True, index=True)
    challenge_id = Column(
        Integer, ForeignKey("challenges.id", ondelete="CASCADE"), nullable=False, index=True
    )
    payout_date = Column(Date, nullable=False)
    amount = Column(Numeric, nullable=False)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    challenge = relationship("Challenge", back_populates="payouts")



class Trade(Base):
    __tablename__ = "trades"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    trade_date = Column(Date, nullable=False, index=True)
    account_size = Column(Integer, nullable=False)
    account_type = Column(String, nullable=False, default="Master", index=True)
    position = Column(String, nullable=False)
    pair = Column(String, nullable=False, index=True)

    entry_ltf = Column(String, nullable=False)
    candle_4h = Column(String, nullable=False)

    # Setup ("Strategy") this trade was taken under. Optional -- a trade can
    # be logged without picking a saved setup.
    setup_id = Column(
        Integer, ForeignKey("strategies.id", ondelete="SET NULL"), nullable=True, index=True
    )
    setup = relationship("Strategy", back_populates="trades")

    # Which Challenge (prop-firm phase/instance) this trade counts against,
    # if any. Independent of account_type -- account_type is still the quick
    # Master/Phase filter label, this is the structured link used for
    # target/drawdown/days-remaining tracking.
    challenge_id = Column(
        Integer, ForeignKey("challenges.id", ondelete="SET NULL"), nullable=True, index=True
    )
    challenge = relationship("Challenge", back_populates="trades")

    result = Column(String, nullable=False, index=True)
    pnl = Column(Numeric, nullable=False, default=0)
    risk_amount = Column(Numeric, nullable=True)

    # Confluences tagged on this trade. Each one is a StrategyConfluence row
    # (custom-named, user-prioritized) belonging to the trade's own setup --
    # there is no fixed/global confluence list anymore.
    confluences = relationship(
        "StrategyConfluence", secondary=trade_confluences, order_by="StrategyConfluence.priority"
    )

    # Mistake/emotion tags tagged on this trade (global list, e.g. "Moved
    # Stop Loss", "Revenge Trade") -- structured alternative/complement to
    # the free-text notes field so these can be aggregated over time.
    mistake_tags = relationship("MistakeTag", secondary=trade_mistakes)

    # Chart screenshots for this trade. A list so you can attach 2-3 images
    # (e.g. HTF context + LTF entry + outcome) instead of just one.
    screenshot_urls = Column(ARRAY(String), nullable=True, default=list)
    notes = Column(Text, nullable=True)

    __table_args__ = (
        CheckConstraint(
            "account_size in (5000, 10000, 25000, 50000, 100000)",
            name="ck_trades_account_size",
        ),
        CheckConstraint(
            "account_type in ('Master', 'Phase')", name="ck_trades_account_type"
        ),
        CheckConstraint("position in ('Long', 'Short')", name="ck_trades_position"),
        CheckConstraint(
            "entry_ltf in ('1m', '3m', '5m')", name="ck_trades_entry_ltf"
        ),
        CheckConstraint(
            "candle_4h in ('3:30', '7:30')", name="ck_trades_candle_4h"
        ),
        CheckConstraint(
            "result in ('Win', 'Loss', 'Breakeven')", name="ck_trades_result"
        ),
    )
