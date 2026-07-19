import csv
import io
import os
import zipfile
from datetime import date
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload

from config import UPLOAD_DIR
from database import get_db
from models import Trade, StrategyConfluence, MistakeTag, Challenge, Pair, Strategy
from schemas import TradeCreate, TradeUpdate, TradeOut, TradesPage
from utils import trade_to_out, apply_trade_filters, apply_trade_sort, delete_screenshot_files

router = APIRouter(prefix="/api/trades", tags=["trades"])

# Eager-load everything trade_to_out() touches, on every route that returns
# one or more trades, so there's no N+1 lazy-load per trade.
TRADE_LOAD_OPTIONS = (
    joinedload(Trade.setup),
    joinedload(Trade.challenge),
    joinedload(Trade.confluences),
    joinedload(Trade.mistake_tags),
)


def _resolve_confluences(confluence_ids: List[int], setup_id: Optional[int], db: Session):
    """Look up the StrategyConfluence rows for the given ids, making sure
    each one actually belongs to the trade's chosen setup (confluences are
    always scoped to their strategy -- there's no free/global list)."""
    if not confluence_ids:
        return []
    rows = db.query(StrategyConfluence).filter(StrategyConfluence.id.in_(confluence_ids)).all()
    if len(rows) != len(set(confluence_ids)):
        raise HTTPException(status_code=400, detail="One or more confluences were not found")
    if setup_id is not None:
        mismatched = [r for r in rows if r.strategy_id != setup_id]
        if mismatched:
            raise HTTPException(
                status_code=400,
                detail="Confluences must belong to the trade's selected setup",
            )
    elif rows:
        raise HTTPException(
            status_code=400,
            detail="Select a setup before tagging confluences (there's no free-standing confluence list)",
        )
    return rows


def _resolve_mistake_tags(mistake_tag_ids: List[int], db: Session):
    """Look up MistakeTag rows for the given ids. Unlike confluences, these
    are a global list -- not scoped to a setup -- so no ownership check."""
    if not mistake_tag_ids:
        return []
    rows = db.query(MistakeTag).filter(MistakeTag.id.in_(mistake_tag_ids)).all()
    if len(rows) != len(set(mistake_tag_ids)):
        raise HTTPException(status_code=400, detail="One or more mistake tags were not found")
    return rows


def _resolve_account(challenge_id: int, db: Session) -> Challenge:
    """A trade's "account" is really just the Challenge it's placed
    against -- account_size/account_type are derived from it rather than
    typed in by hand, and only active challenges can receive new trades
    (matching how prop-firm accounts actually work: you can't log a trade
    against a challenge you haven't set up, or one that's already closed
    out)."""
    challenge = db.query(Challenge).filter(Challenge.id == challenge_id).first()
    if not challenge:
        raise HTTPException(status_code=400, detail="Trading account (challenge) not found")
    if not challenge.is_active:
        raise HTTPException(
            status_code=400,
            detail=(
                f"'{challenge.name}' is not an active account -- trades can only be logged "
                "against active challenge accounts. Reactivate it on the Challenges page first."
            ),
        )
    return challenge


def _filtered_trades_query(
    db: Session,
    pair, result, entry_ltf, candle_4h, position, account_type, account_size,
    setup_id, challenge_id, date_from, date_to,
):
    query = db.query(Trade).options(*TRADE_LOAD_OPTIONS)
    return apply_trade_filters(
        query, pair, result, entry_ltf, candle_4h, position, account_type,
        account_size, setup_id, challenge_id, date_from, date_to,
    )


@router.get("", response_model=TradesPage)
def list_trades(
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
    sort_by: Optional[str] = None,
    sort_dir: Optional[str] = "desc",
    limit: Optional[int] = None,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """Returns {total, items}. `total` reflects all trades matching the
    filters (ignoring limit/offset) so the frontend can render pagination
    controls; `items` is just the current page."""
    query = _filtered_trades_query(
        db, pair, result, entry_ltf, candle_4h, position, account_type,
        account_size, setup_id, challenge_id, date_from, date_to,
    )
    total = query.order_by(None).count()

    query = apply_trade_sort(query, sort_by, sort_dir)
    if limit is not None:
        query = query.limit(limit).offset(offset)

    trades = query.all()
    return TradesPage(total=total, items=[trade_to_out(t) for t in trades])


def _trades_to_csv_string(trades) -> str:
    """Shared by both /export (plain CSV) and /export-full (zip backup) so
    the two never drift out of sync. Includes a 'screenshots' column
    (semicolon-joined /uploads/... urls) so the file linkage survives a
    round trip -- plain CSV import still won't have the actual image bytes,
    but /export-full + /import-full bundles those too (see below)."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([
        "id", "trade_date", "account_type", "account_size", "challenge",
        "position", "pair", "entry_ltf", "candle_4h", "setup", "result",
        "pnl", "loss_percentage", "risk_amount", "risk_percentage", "rr_ratio",
        "confluences", "mistake_tags", "screenshots", "notes",
    ])
    for t in trades:
        out = trade_to_out(t)
        writer.writerow([
            out.id, out.trade_date, out.account_type, out.account_size,
            out.challenge_name or "", out.position, out.pair, out.entry_ltf,
            out.candle_4h, out.setup_name or "", out.result, out.pnl,
            out.loss_percentage, out.risk_amount or "", out.risk_percentage or "",
            out.rr_ratio or "",
            "; ".join(c.name for c in out.confluences),
            "; ".join(m.name for m in out.mistake_tags),
            "; ".join(out.screenshot_urls or []),
            (out.notes or "").replace("\n", " ").replace("\r", " "),
        ])
    buffer.seek(0)
    return buffer.getvalue()


@router.get("/export")
def export_trades_csv(
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
    """Exports every trade matching the current filters to CSV. Cheap
    insurance for a single-database, no-backup, no-login personal tool --
    also handy for tax season or moving data elsewhere.

    Note: this plain CSV records screenshot *paths* only, not the actual
    image files -- use /export-full if you want screenshots to come along
    too when moving to a new device."""
    query = _filtered_trades_query(
        db, pair, result, entry_ltf, candle_4h, position, account_type,
        account_size, setup_id, challenge_id, date_from, date_to,
    )
    query = query.order_by(Trade.trade_date.asc(), Trade.id.asc())
    trades = query.all()

    csv_text = _trades_to_csv_string(trades)
    filename = f"trades-export-{date.today().isoformat()}.csv"
    return StreamingResponse(
        iter([csv_text]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export-full")
def export_trades_full(
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
    """Same trades as /export, but bundled into a .zip together with every
    chart screenshot file those trades actually reference (read straight
    out of UPLOAD_DIR). This is the one file you need to move a journal --
    trades + screenshots -- to a brand new device: download it here, then
    upload it to /import-full there."""
    query = _filtered_trades_query(
        db, pair, result, entry_ltf, candle_4h, position, account_type,
        account_size, setup_id, challenge_id, date_from, date_to,
    )
    query = query.order_by(Trade.trade_date.asc(), Trade.id.asc())
    trades = query.all()

    csv_text = _trades_to_csv_string(trades)

    # Collect every screenshot filename these trades reference, deduped, so
    # a screenshot shared/re-used isn't written into the zip twice.
    filenames = set()
    for t in trades:
        for url in (t.screenshot_urls or []):
            filenames.add(os.path.basename(url))

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("trades.csv", csv_text)
        missing = []
        for name in sorted(filenames):
            filepath = os.path.join(UPLOAD_DIR, name)
            if os.path.isfile(filepath):
                zf.write(filepath, arcname=f"images/{name}")
            else:
                missing.append(name)
        if missing:
            # Still record which ones weren't found on disk, rather than
            # silently producing a backup that looks complete but isn't.
            zf.writestr(
                "MISSING_IMAGES.txt",
                "These screenshots were referenced by a trade but not found "
                "in the uploads folder, so they couldn't be included:\n"
                + "\n".join(missing),
            )

    zip_buffer.seek(0)
    filename = f"trading-journal-backup-{date.today().isoformat()}.zip"
    return StreamingResponse(
        iter([zip_buffer.getvalue()]),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# Columns Export CSV always writes, in this order. Import only strictly
# needs the ones actually used to reconstruct a Trade row (see
# REQUIRED_IMPORT_COLUMNS below) -- loss_percentage/risk_percentage/rr_ratio
# are present in the export for reference but are always recomputed, never
# read back in.
REQUIRED_IMPORT_COLUMNS = {
    "trade_date", "account_type", "account_size", "position", "pair",
    "entry_ltf", "candle_4h", "result", "pnl",
}


def _import_trades_from_csv_text(text: str, db: Session, image_filenames: Optional[set] = None):
    """Shared row-import logic used by both /import (plain CSV) and
    /import-full (zip backup). `image_filenames`, when provided (i.e. we're
    importing a zip that actually contained image files), restricts which
    'screenshots' column urls get kept on the trade -- any screenshot the
    CSV mentions that didn't actually come with a matching file is dropped
    rather than saved as a broken link. When None (plain CSV import), any
    screenshot urls in the file are kept as-is, on the assumption the
    uploads folder was copied over by hand."""
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="This CSV appears to be empty.")

    headers = {h.strip() for h in reader.fieldnames}
    missing = REQUIRED_IMPORT_COLUMNS - headers
    if missing:
        raise HTTPException(
            status_code=400,
            detail=(
                f"This CSV is missing required column(s): {', '.join(sorted(missing))}. "
                "Import expects the exact format produced by this app's own 'Export CSV' button."
            ),
        )

    # Look up everything that already exists once, up front, then keep the
    # caches updated as new rows create new pairs/challenges/setups/tags --
    # avoids a repeat query per row and keeps rows that reference the same
    # new name (e.g. the same new setup across many trades) from creating
    # duplicates of it.
    pair_cache = {p.name: p for p in db.query(Pair).all()}
    challenge_cache = {c.name: c for c in db.query(Challenge).all()}
    strategy_cache = {s.name: s for s in db.query(Strategy).all()}
    mistake_cache = {m.name: m for m in db.query(MistakeTag).all()}

    created = 0
    errors: List[str] = []
    skipped_images: List[str] = []

    for i, row in enumerate(reader, start=2):  # row 1 is the header
        try:
            trade_date_str = (row.get("trade_date") or "").strip()
            if not trade_date_str:
                raise ValueError("trade_date is required")
            trade_date_val = date.fromisoformat(trade_date_str)

            account_type = (row.get("account_type") or "").strip()
            if account_type not in ("Master", "Phase"):
                raise ValueError(f"account_type must be 'Master' or 'Phase', got '{account_type}'")

            account_size_str = (row.get("account_size") or "").strip()
            try:
                account_size = int(float(account_size_str))
            except ValueError:
                raise ValueError(f"account_size must be a number, got '{account_size_str}'")
            if account_size not in (5000, 10000, 25000, 50000, 100000):
                raise ValueError(
                    f"account_size must be one of 5000/10000/25000/50000/100000, got {account_size}"
                )

            position = (row.get("position") or "").strip()
            if position not in ("Long", "Short"):
                raise ValueError(f"position must be 'Long' or 'Short', got '{position}'")

            pair_name = (row.get("pair") or "").strip()
            if not pair_name:
                raise ValueError("pair is required")

            entry_ltf = (row.get("entry_ltf") or "").strip()
            if entry_ltf not in ("1m", "3m", "5m"):
                raise ValueError(f"entry_ltf must be 1m/3m/5m, got '{entry_ltf}'")

            candle_4h = (row.get("candle_4h") or "").strip()
            if candle_4h not in ("3:30", "7:30"):
                raise ValueError(f"candle_4h must be 3:30/7:30, got '{candle_4h}'")

            result = (row.get("result") or "").strip()
            if result not in ("Win", "Loss", "Breakeven"):
                raise ValueError(f"result must be Win/Loss/Breakeven, got '{result}'")

            pnl_str = (row.get("pnl") or "").strip()
            try:
                pnl = float(pnl_str) if pnl_str else 0.0
            except ValueError:
                raise ValueError(f"pnl must be a number, got '{pnl_str}'")

            risk_amount_str = (row.get("risk_amount") or "").strip()
            try:
                risk_amount = float(risk_amount_str) if risk_amount_str else None
            except ValueError:
                raise ValueError(f"risk_amount must be a number, got '{risk_amount_str}'")

            notes = (row.get("notes") or "").strip() or None

            # Screenshot urls, if the CSV has that column (older exports
            # won't). Keep only ones whose file we actually have on hand
            # when importing a zip backup; keep as-is for a plain CSV
            # import (uploads/ was presumably copied over separately).
            screenshots_str = (row.get("screenshots") or "").strip()
            screenshot_urls: List[str] = []
            if screenshots_str and screenshots_str != "—":
                for url in (u.strip() for u in screenshots_str.split(";")):
                    if not url:
                        continue
                    if image_filenames is not None and os.path.basename(url) not in image_filenames:
                        skipped_images.append(url)
                        continue
                    screenshot_urls.append(url)

            # All scalar fields validated above -- only now start creating
            # any new related rows, so a bad row never leaves behind a
            # half-created pair/challenge/setup with no trade attached to it.

            if pair_name not in pair_cache:
                new_pair = Pair(name=pair_name)
                db.add(new_pair)
                db.flush()
                pair_cache[pair_name] = new_pair

            challenge_name = (row.get("challenge") or "").strip()
            if not challenge_name:
                # No account name in the file -- group these under one
                # shared placeholder account per type/size instead of
                # leaving them unattached.
                challenge_name = f"Imported {account_type} ${account_size:,}"
            challenge = challenge_cache.get(challenge_name)
            if not challenge:
                challenge = Challenge(
                    name=challenge_name,
                    account_size=account_size,
                    account_type=account_type,
                    start_date=trade_date_val,
                    notes="Auto-created by CSV import.",
                )
                db.add(challenge)
                db.flush()
                challenge_cache[challenge_name] = challenge

            setup_name = (row.get("setup") or "").strip()
            setup = None
            if setup_name:
                setup = strategy_cache.get(setup_name)
                if not setup:
                    setup = Strategy(name=setup_name)
                    db.add(setup)
                    db.flush()
                    strategy_cache[setup_name] = setup

            confluences = []
            confluences_str = (row.get("confluences") or "").strip()
            if confluences_str and confluences_str != "—" and setup:
                names = [n.strip() for n in confluences_str.split(";") if n.strip()]
                existing_by_name = {c.name: c for c in setup.confluences}
                next_priority = max([c.priority for c in setup.confluences], default=0) + 1
                for name in names:
                    conf = existing_by_name.get(name)
                    if not conf:
                        conf = StrategyConfluence(strategy_id=setup.id, name=name, priority=next_priority)
                        db.add(conf)
                        db.flush()
                        existing_by_name[name] = conf
                        next_priority += 1
                    confluences.append(conf)

            mistakes = []
            mistakes_str = (row.get("mistake_tags") or "").strip()
            if mistakes_str and mistakes_str != "—":
                names = [n.strip() for n in mistakes_str.split(";") if n.strip()]
                for name in names:
                    tag = mistake_cache.get(name)
                    if not tag:
                        tag = MistakeTag(name=name)
                        db.add(tag)
                        db.flush()
                        mistake_cache[name] = tag
                    mistakes.append(tag)

            trade = Trade(
                trade_date=trade_date_val,
                account_size=account_size,
                account_type=account_type,
                position=position,
                pair=pair_name,
                entry_ltf=entry_ltf,
                candle_4h=candle_4h,
                setup_id=setup.id if setup else None,
                challenge_id=challenge.id,
                result=result,
                pnl=pnl,
                risk_amount=risk_amount,
                notes=notes,
                screenshot_urls=screenshot_urls,
            )
            trade.confluences = confluences
            trade.mistake_tags = mistakes
            db.add(trade)
            created += 1
        except Exception as row_err:
            errors.append(f"Row {i}: {row_err}")

    db.commit()
    return {
        "created": created,
        "error_count": len(errors),
        # Capped so one giant malformed file doesn't blow up the response.
        "errors": errors[:50],
        "skipped_images": skipped_images[:50],
    }


@router.post("/import")
async def import_trades_csv(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Imports trades from a CSV in EXACTLY the format Export CSV produces --
    the intended workflow is: export from your old device/database, then
    import that same file here on the new one. Any pair, trading account
    (challenge), setup, confluence, or mistake tag referenced by name that
    doesn't already exist gets auto-created so the trades have somewhere to
    attach; this is additive only (nothing existing is modified or
    replaced), so importing the same file twice will duplicate trades.

    Screenshot *paths* travel with a plain CSV, but the actual image files
    don't -- if you haven't manually copied backend/uploads/ over to this
    device too, those links will be broken. Use /import-full instead if you
    want screenshots handled automatically.
    """
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")  # -sig strips Excel's BOM if present
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Couldn't read this file as text -- please upload a CSV.")

    return _import_trades_from_csv_text(text, db, image_filenames=None)


@router.post("/import-full")
async def import_trades_full(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Imports a .zip produced by /export-full: trades.csv plus an images/
    folder of chart screenshots. Restores the image files into UPLOAD_DIR
    first, then imports the trades so their screenshot_urls point at files
    that now actually exist on this device -- the whole point being that
    moving to a new device is just 'download the zip, upload it here'."""
    raw = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Couldn't read this file as a zip -- please upload the .zip from 'Export Full Backup'.")

    names = zf.namelist()
    if "trades.csv" not in names:
        raise HTTPException(status_code=400, detail="This zip doesn't contain a trades.csv -- please upload the .zip produced by 'Export Full Backup'.")

    csv_bytes = zf.read("trades.csv")
    try:
        text = csv_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="trades.csv inside the zip isn't readable as text.")

    # Restore images first, so the import step below can check which
    # screenshot filenames actually exist on disk.
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    restored_filenames = set()
    for entry in names:
        if not entry.startswith("images/") or entry.endswith("/"):
            continue
        # os.path.basename strips any directory component -- guards against
        # a maliciously-crafted zip entry trying to write outside UPLOAD_DIR.
        filename = os.path.basename(entry)
        if not filename:
            continue
        with open(os.path.join(UPLOAD_DIR, filename), "wb") as f:
            f.write(zf.read(entry))
        restored_filenames.add(filename)

    result = _import_trades_from_csv_text(text, db, image_filenames=restored_filenames)
    result["images_restored"] = len(restored_filenames)
    return result


@router.get("/{trade_id}", response_model=TradeOut)
def get_trade(trade_id: int, db: Session = Depends(get_db)):
    trade = (
        db.query(Trade)
        .options(*TRADE_LOAD_OPTIONS)
        .filter(Trade.id == trade_id)
        .first()
    )
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")
    return trade_to_out(trade)


@router.post("", response_model=TradeOut, status_code=201)
def create_trade(payload: TradeCreate, db: Session = Depends(get_db)):
    if payload.trade_date > date.today():
        raise HTTPException(status_code=400, detail="Trade date can't be in the future")
    data = payload.model_dump()
    confluence_ids = data.pop("confluence_ids", [])
    mistake_tag_ids = data.pop("mistake_tag_ids", [])
    confluences = _resolve_confluences(confluence_ids, data.get("setup_id"), db)
    mistake_tags = _resolve_mistake_tags(mistake_tag_ids, db)

    account = _resolve_account(data["challenge_id"], db)
    data["account_size"] = account.account_size
    data["account_type"] = account.account_type

    trade = Trade(**data)
    trade.confluences = confluences
    trade.mistake_tags = mistake_tags
    db.add(trade)
    db.commit()
    db.refresh(trade)
    return trade_to_out(trade)


@router.patch("/{trade_id}", response_model=TradeOut)
def update_trade(trade_id: int, payload: TradeUpdate, db: Session = Depends(get_db)):
    trade = (
        db.query(Trade)
        .options(*TRADE_LOAD_OPTIONS)
        .filter(Trade.id == trade_id)
        .first()
    )
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")

    updates = payload.model_dump(exclude_unset=True)
    if "trade_date" in updates and updates["trade_date"] > date.today():
        raise HTTPException(status_code=400, detail="Trade date can't be in the future")
    confluence_ids = updates.pop("confluence_ids", None)
    mistake_tag_ids = updates.pop("mistake_tag_ids", None)

    # Snapshot the screenshot urls this trade had BEFORE applying updates,
    # so that any that got removed/replaced (edit modal swapped one out,
    # etc.) can have their actual files deleted from disk below instead of
    # being orphaned in backend/uploads/ forever.
    old_screenshot_urls = (
        list(trade.screenshot_urls or []) if "screenshot_urls" in updates else None
    )

    if "challenge_id" in updates:
        if updates["challenge_id"] is None:
            raise HTTPException(
                status_code=400,
                detail="A trade must stay linked to a trading account -- pick a challenge instead of clearing it.",
            )
        account = _resolve_account(updates["challenge_id"], db)
        updates["account_size"] = account.account_size
        updates["account_type"] = account.account_type

    for key, value in updates.items():
        setattr(trade, key, value)

    if confluence_ids is not None:
        effective_setup_id = updates.get("setup_id", trade.setup_id)
        trade.confluences = _resolve_confluences(confluence_ids, effective_setup_id, db)

    if mistake_tag_ids is not None:
        trade.mistake_tags = _resolve_mistake_tags(mistake_tag_ids, db)

    db.commit()
    db.refresh(trade)

    # Now that the update is committed, delete any screenshot files that
    # were removed/replaced (present in the old list, gone from the new
    # one) so they don't sit orphaned on disk forever (see #1).
    if old_screenshot_urls is not None:
        new_urls = set(trade.screenshot_urls or [])
        removed_urls = [u for u in old_screenshot_urls if u not in new_urls]
        delete_screenshot_files(removed_urls)

    return trade_to_out(trade)


@router.delete("/{trade_id}", status_code=204)
def delete_trade(trade_id: int, db: Session = Depends(get_db)):
    trade = db.query(Trade).filter(Trade.id == trade_id).first()
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")

    # Grab the screenshot urls before the row is gone, then delete the
    # actual files from disk after the DB delete is committed -- otherwise
    # a deleted trade's screenshots stay in backend/uploads/ forever (#1).
    screenshot_urls = list(trade.screenshot_urls or [])
    db.delete(trade)
    db.commit()
    delete_screenshot_files(screenshot_urls)
    return None
