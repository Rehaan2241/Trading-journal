import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/trading_journal"
)

UPLOAD_DIR = os.getenv("UPLOAD_DIR", "uploads")

CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:5500").split(",")
    if origin.strip()
]
