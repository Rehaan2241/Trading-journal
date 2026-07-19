import os
import re
import time
import uuid

from fastapi import APIRouter, UploadFile, File, HTTPException

from config import UPLOAD_DIR

router = APIRouter(prefix="/api/upload", tags=["upload"])

ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
MAX_FILE_SIZE = 8 * 1024 * 1024  # 8 MB


def _safe_filename(original: str) -> str:
    name, ext = os.path.splitext(original)
    ext = ext.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported image type")
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "-", name)[:40]
    return f"{int(time.time())}-{uuid.uuid4().hex[:8]}-{safe_name}{ext}"


@router.post("")
async def upload_screenshot(file: UploadFile = File(...)):
    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File too large (max 8MB)")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    filename = _safe_filename(file.filename or "screenshot.png")
    filepath = os.path.join(UPLOAD_DIR, filename)

    with open(filepath, "wb") as f:
        f.write(contents)

    # Served statically by main.py under /uploads
    return {"url": f"/uploads/{filename}"}
