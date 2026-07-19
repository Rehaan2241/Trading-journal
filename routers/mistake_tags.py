from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import get_db
from models import MistakeTag, Trade, trade_mistakes
from schemas import MistakeTagCreate, MistakeTagOut

router = APIRouter(prefix="/api/mistake-tags", tags=["mistake-tags"])


@router.get("", response_model=List[MistakeTagOut])
def list_mistake_tags(db: Session = Depends(get_db)):
    return db.query(MistakeTag).order_by(MistakeTag.name).all()


@router.post("", response_model=MistakeTagOut, status_code=201)
def create_mistake_tag(payload: MistakeTagCreate, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Mistake tag name is required")

    existing = db.query(MistakeTag).filter(func.lower(MistakeTag.name) == name.lower()).first()
    if existing:
        return existing

    tag = MistakeTag(name=name)
    db.add(tag)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Mistake tag already exists")
    db.refresh(tag)
    return tag


@router.delete("/{tag_id}", status_code=204)
def delete_mistake_tag(tag_id: int, db: Session = Depends(get_db)):
    """Deleting a tag just removes it (and its trade_mistakes links, via
    cascade) -- same 'keep the trade, drop the tag' pattern used for
    confluences and setups. No trades are ever deleted because a tag was
    removed."""
    tag = db.query(MistakeTag).filter(MistakeTag.id == tag_id).first()
    if not tag:
        raise HTTPException(status_code=404, detail="Mistake tag not found")
    db.delete(tag)
    db.commit()
    return None


@router.get("/{tag_id}/usage-count")
def mistake_tag_usage(tag_id: int, db: Session = Depends(get_db)):
    count = (
        db.query(func.count(trade_mistakes.c.trade_id))
        .filter(trade_mistakes.c.mistake_tag_id == tag_id)
        .scalar()
        or 0
    )
    return {"tag_id": tag_id, "trade_count": count}
