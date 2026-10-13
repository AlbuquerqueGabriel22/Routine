from __future__ import annotations

import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("CLEANING_DB_PATH", BASE_DIR / "cleaning.db"))
UPLOAD_DIR = Path(os.environ.get("CLEANING_UPLOAD_DIR", BASE_DIR / "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

FREQUENCIES = {"Diário", "Semanal", "Quinzenal", "Mensal"}
STATUSES = {"Limpo", "Não limpo"}

app = FastAPI(title="Rotina — API de controle de limpeza", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


@contextmanager
def connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def initialize_database():
    with connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS locations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                photo TEXT,
                responsible TEXT NOT NULL,
                frequency TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cleanings (
                id TEXT PRIMARY KEY,
                location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
                cleaning_date TEXT NOT NULL,
                status TEXT NOT NULL,
                photo_before TEXT,
                photo_after TEXT,
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cleanings_location_date
                ON cleanings(location_id, cleaning_date DESC);
            """
        )


initialize_database()


class LocationInput(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=100)]
    photo: str | None = None
    responsible: Annotated[str, Field(min_length=1, max_length=100)]
    frequency: str


class CleaningInput(BaseModel):
    location_id: str
    cleaning_date: date
    status: str
    photo_before: str | None = None
    photo_after: str | None = None
    notes: Annotated[str, Field(max_length=1000)] = ""


def validate_frequency(frequency: str):
    if frequency not in FREQUENCIES:
        raise HTTPException(status_code=422, detail="Frequência inválida.")


def validate_status(status: str):
    if status not in STATUSES:
        raise HTTPException(status_code=422, detail="Status inválido.")


def fetch_location(conn: sqlite3.Connection, location_id: str):
    row = conn.execute("SELECT * FROM locations WHERE id = ?", (location_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Local não encontrado.")
    return dict(row)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_image(file: UploadFile = File(...)):
    allowed_types = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
    suffix = allowed_types.get(file.content_type or "")
    if suffix is None:
        raise HTTPException(status_code=415, detail="Envie uma imagem JPG, PNG ou WEBP.")

    contents = await file.read(5 * 1024 * 1024 + 1)
    if not contents:
        raise HTTPException(status_code=400, detail="O arquivo está vazio.")
    if len(contents) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="A imagem deve ter até 5 MB.")

    filename = f"{uuid.uuid4().hex}{suffix}"
    (UPLOAD_DIR / filename).write_bytes(contents)
    return {"url": f"/uploads/{filename}"}


@app.get("/api/locations")
def list_locations(
    search: str = "",
    frequency: str = "",
    responsible: str = "",
):
    clauses: list[str] = []
    params: list[str] = []
    if search.strip():
        clauses.append("(l.name LIKE ? OR l.responsible LIKE ?)")
        params.extend([f"%{search.strip()}%", f"%{search.strip()}%"])
    if frequency:
        clauses.append("l.frequency = ?")
        params.append(frequency)
    if responsible:
        clauses.append("l.responsible = ?")
        params.append(responsible)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with connection() as conn:
        rows = conn.execute(
            f"""
            SELECT l.*,
                (SELECT COUNT(*) FROM cleanings c WHERE c.location_id = l.id) AS cleaning_count,
                (SELECT c.cleaning_date FROM cleanings c WHERE c.location_id = l.id
                    ORDER BY c.cleaning_date DESC, c.created_at DESC LIMIT 1) AS last_cleaned,
                (SELECT c.status FROM cleanings c WHERE c.location_id = l.id
                    ORDER BY c.cleaning_date DESC, c.created_at DESC LIMIT 1) AS last_status
            FROM locations l {where}
            ORDER BY l.name COLLATE NOCASE
            """,
            params,
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/locations", status_code=201)
def create_location(payload: LocationInput):
    validate_frequency(payload.frequency)
    location_id = str(uuid.uuid4())
    with connection() as conn:
        conn.execute(
            "INSERT INTO locations (id, name, photo, responsible, frequency, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                location_id,
                payload.name.strip(),
                payload.photo,
                payload.responsible.strip(),
                payload.frequency,
                datetime.now().isoformat(timespec="seconds"),
            ),
        )
        return fetch_location(conn, location_id)


@app.get("/api/locations/{location_id}")
def get_location(location_id: str):
    with connection() as conn:
        return fetch_location(conn, location_id)


@app.put("/api/locations/{location_id}")
def update_location(location_id: str, payload: LocationInput):
    validate_frequency(payload.frequency)
    with connection() as conn:
        fetch_location(conn, location_id)
        conn.execute(
            "UPDATE locations SET name = ?, photo = ?, responsible = ?, frequency = ? WHERE id = ?",
            (payload.name.strip(), payload.photo, payload.responsible.strip(), payload.frequency, location_id),
        )
        return fetch_location(conn, location_id)


@app.delete("/api/locations/{location_id}", status_code=204)
def delete_location(location_id: str):
    with connection() as conn:
        fetch_location(conn, location_id)
        conn.execute("DELETE FROM locations WHERE id = ?", (location_id,))


@app.get("/api/history")
def list_history(
    location_id: str = "",
    status: str = "",
    search: str = "",
    date_from: str = Query(default="", alias="from"),
    date_to: str = Query(default="", alias="to"),
):
    clauses: list[str] = []
    params: list[str] = []
    if location_id:
        clauses.append("c.location_id = ?")
        params.append(location_id)
    if status:
        clauses.append("c.status = ?")
        params.append(status)
    if search.strip():
        clauses.append("(l.name LIKE ? OR l.responsible LIKE ? OR c.notes LIKE ?)")
        params.extend([f"%{search.strip()}%"] * 3)
    if date_from:
        clauses.append("c.cleaning_date >= ?")
        params.append(date_from)
    if date_to:
        clauses.append("c.cleaning_date <= ?")
        params.append(date_to)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with connection() as conn:
        rows = conn.execute(
            f"""
            SELECT c.*, l.name AS location_name, l.responsible
            FROM cleanings c JOIN locations l ON l.id = c.location_id
            {where}
            ORDER BY c.cleaning_date DESC, c.created_at DESC
            """,
            params,
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/history", status_code=201)
def create_cleaning(payload: CleaningInput):
    validate_status(payload.status)
    cleaning_id = str(uuid.uuid4())
    with connection() as conn:
        fetch_location(conn, payload.location_id)
        conn.execute(
            """INSERT INTO cleanings
                (id, location_id, cleaning_date, status, photo_before, photo_after, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                cleaning_id,
                payload.location_id,
                payload.cleaning_date.isoformat(),
                payload.status,
                payload.photo_before,
                payload.photo_after,
                payload.notes.strip(),
                datetime.now().isoformat(timespec="seconds"),
            ),
        )
        row = conn.execute(
            """SELECT c.*, l.name AS location_name, l.responsible
                FROM cleanings c JOIN locations l ON l.id = c.location_id WHERE c.id = ?""",
            (cleaning_id,),
        ).fetchone()
        return dict(row)


@app.put("/api/history/{cleaning_id}")
def update_cleaning(cleaning_id: str, payload: CleaningInput):
    validate_status(payload.status)
    with connection() as conn:
        row = conn.execute("SELECT id FROM cleanings WHERE id = ?", (cleaning_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Registro não encontrado.")
        fetch_location(conn, payload.location_id)
        conn.execute(
            """UPDATE cleanings SET location_id = ?, cleaning_date = ?, status = ?,
                photo_before = ?, photo_after = ?, notes = ? WHERE id = ?""",
            (
                payload.location_id,
                payload.cleaning_date.isoformat(),
                payload.status,
                payload.photo_before,
                payload.photo_after,
                payload.notes.strip(),
                cleaning_id,
            ),
        )
        updated = conn.execute(
            """SELECT c.*, l.name AS location_name, l.responsible
                FROM cleanings c JOIN locations l ON l.id = c.location_id WHERE c.id = ?""",
            (cleaning_id,),
        ).fetchone()
        return dict(updated)


@app.delete("/api/history/{cleaning_id}", status_code=204)
def delete_cleaning(cleaning_id: str):
    with connection() as conn:
        cursor = conn.execute("DELETE FROM cleanings WHERE id = ?", (cleaning_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Registro não encontrado.")


@app.get("/api/dashboard")
def dashboard():
    today = date.today().isoformat()
    with connection() as conn:
        totals = conn.execute(
            """SELECT
                (SELECT COUNT(*) FROM locations) AS locations,
                (SELECT COUNT(*) FROM cleanings) AS total_cleanings,
                (SELECT COUNT(*) FROM cleanings WHERE cleaning_date = ? AND status = 'Limpo') AS completed_today,
                (SELECT COUNT(*) FROM cleanings WHERE cleaning_date = ? AND status = 'Não limpo') AS attention_today
            """,
            (today, today),
        ).fetchone()
        latest = conn.execute(
            """SELECT c.id, c.cleaning_date, c.status, c.notes, l.name AS location_name, l.responsible
                FROM cleanings c JOIN locations l ON l.id = c.location_id
                ORDER BY c.cleaning_date DESC, c.created_at DESC LIMIT 6"""
        ).fetchall()
    return {**dict(totals), "recent": [dict(row) for row in latest]}
