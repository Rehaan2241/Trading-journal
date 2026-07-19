-- Optional sample data, matching the trades shown in the reference screenshots.
-- Run after schema.sql if you want some data to look at right away:
--   psql -U postgres -d trading_journal -f seed.sql

insert into pairs (name) values ('EUR/USD'), ('BTC'), ('AAPL'), ('TSLA')
  on conflict (name) do nothing;

-- Sample setups/strategies. Add your own real playbooks (and your own
-- confluences, in whatever order you prioritize them) from the Strategy page.
insert into strategies (name, notes) values
  ('Type 1', 'Sweep the HTF-PDA level first, wait for displacement through it, then enter on the retest.'),
  ('Type 2', 'Liquidity sweep + SMT divergence confirmation, entry on the IFVG fill. Skip if there is no clean sweep.')
on conflict (name) do nothing;

insert into strategy_confluences (strategy_id, name, priority)
select id, c.name, c.priority
from strategies, (values ('Liquidity Sweep', 1), ('HTF-PDA', 1), ('Displacement', 2)) as c(name, priority)
where strategies.name = 'Type 1'
on conflict do nothing;

insert into strategy_confluences (strategy_id, name, priority)
select id, c.name, c.priority
from strategies, (values ('Liquidity Sweep', 1), ('SMT', 2), ('IFVG', 3)) as c(name, priority)
where strategies.name = 'Type 2'
on conflict do nothing;

-- Sample mistake/emotion tags -- the global list used across every trade
-- regardless of setup.
insert into mistake_tags (name) values
  ('Moved Stop Loss'), ('Entered Early'), ('Revenge Trade'), ('FOMO Entry'), ('Oversized Position')
on conflict (name) do nothing;

-- Sample prop-firm/phase challenges -- these are the only two "accounts"
-- trades can be logged against until you add your own on the Challenges page.
insert into challenges (name, account_size, account_type, profit_target_pct, max_drawdown_pct, daily_drawdown_pct, start_date, days_allowed, is_active, notes, status, phase_number)
values
  ('FTMO 50k - Phase 1', 50000, 'Phase', 8, 10, 5, '2026-07-01', 30, true, 'Demo challenge, replace with your real one.', 'active', 1),
  ('FundingPips 10k - Master', 10000, 'Master', 8, 10, 5, '2026-06-01', null, true, 'Demo master account, replace with your real one.', 'active', 1)
on conflict do nothing;

insert into trades
  (trade_date, account_size, account_type, position, pair, entry_ltf, candle_4h, setup_id, challenge_id, result, pnl, risk_amount, notes)
values
  ('2026-06-02', 10000, 'Master', 'Long', 'AAPL', '3m', '7:30', (select id from strategies where name = 'Type 1'),
   (select id from challenges where name = 'FundingPips 10k - Master'),
   'Win', 730.00, 250.00, 'Clean breakout after sweep, followed plan.'),
  ('2026-06-03', 10000, 'Master', 'Short', 'AAPL', '1m', '3:30', null,
   (select id from challenges where name = 'FundingPips 10k - Master'),
   'Loss', -300.00, 300.00, 'Entered too early, no confirmation.'),
  ('2026-07-01', 50000, 'Phase', 'Long', 'EUR/USD', '5m', '7:30', (select id from strategies where name = 'Type 2'),
   (select id from challenges where name = 'FTMO 50k - Phase 1'),
   'Win', 1200.00, 500.00, 'Trend follow, textbook setup.'),
  ('2026-07-04', 50000, 'Phase', 'Long', 'TSLA', '3m', '3:30', null,
   (select id from challenges where name = 'FTMO 50k - Phase 1'),
   'Breakeven', 30.00, 400.00, 'Scalp, closed early on hesitation.'),
  ('2026-07-05', 50000, 'Phase', 'Short', 'EUR/USD', '1m', '3:30',
   (select id from strategies where name = 'Type 1'),
   (select id from challenges where name = 'FTMO 50k - Phase 1'),
   'Loss', -500.00, 500.00, 'Moved stop loss out of fear, should have let it hit.')
on conflict do nothing;

-- Tag the "entered too early" loss and the "moved stop" Phase loss with
-- their matching mistake tags.
insert into trade_mistakes (trade_id, mistake_tag_id)
select t.id, m.id from trades t, mistake_tags m
where t.pair = 'BTC' and t.result = 'Loss' and m.name = 'Entered Early'
on conflict do nothing;

insert into trade_mistakes (trade_id, mistake_tag_id)
select t.id, m.id from trades t, mistake_tags m
where t.account_type = 'Phase' and t.pair = 'EUR/USD' and t.result = 'Loss' and m.name = 'Moved Stop Loss'
on conflict do nothing;

-- Tag the sample trades with confluences from their setup.
insert into trade_confluences (trade_id, strategy_confluence_id)
select t.id, sc.id
from trades t
join strategies s on s.id = t.setup_id
join strategy_confluences sc on sc.strategy_id = s.id
where s.name = 'Type 1' and t.pair = 'AAPL' and sc.name in ('Liquidity Sweep', 'HTF-PDA', 'Displacement')
on conflict do nothing;

insert into trade_confluences (trade_id, strategy_confluence_id)
select t.id, sc.id
from trades t
join strategies s on s.id = t.setup_id
join strategy_confluences sc on sc.strategy_id = s.id
where s.name = 'Type 2' and t.pair = 'EUR/USD' and sc.name in ('Liquidity Sweep', 'SMT', 'IFVG')
on conflict do nothing;
