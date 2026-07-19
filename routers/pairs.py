from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import get_db
from models import Pair, Trade
from schemas import PairCreate, PairOut

router = APIRouter(prefix="/api/pairs", tags=["pairs"])


@router.get("", response_model=List[PairOut])
def list_pairs(db: Session = Depends(get_db)):
    return db.query(Pair).order_by(Pair.name).all()


@router.post("", response_model=PairOut, status_code=201)
def create_pair(payload: PairCreate, db: Session = Depends(get_db)):
    name = payload.name.strip().upper()
    if not name:
        raise HTTPException(status_code=400, detail="Pair name is required")

    existing = db.query(Pair).filter(Pair.name == name).first()
    if existing:
        return existing

    pair = Pair(name=name)
    db.add(pair)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Pair already exists")
    db.refresh(pair)
    return pair


@router.delete("/{pair_id}", status_code=204)
def delete_pair(pair_id: int, db: Session = Depends(get_db)):
    """Delete an unused pair. Blocked (like Strategy/Challenge deletes)
    if any trade still references it by name, so you can't silently lose
    which pair a trade was tagged under."""
    pair = db.query(Pair).filter(Pair.id == pair_id).first()
    if not pair:
        raise HTTPException(status_code=404, detail="Pair not found")

    trade_count = db.query(Trade).filter(Trade.pair == pair.name).count()
    if trade_count:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Can't delete this pair: {trade_count} trade(s) still use it. "
                "Delete/reassign those trades first, then delete the pair."
            ),
        )

    db.delete(pair)
    db.commit()
    return None
