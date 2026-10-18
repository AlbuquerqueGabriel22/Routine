from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, time, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import Cookie, Depends, FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("CLEANING_DB_PATH", BASE_DIR / "cleaning.db"))
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("CLEANING_DATABASE_URL")
UPLOAD_DIR = Path(os.environ.get("CLEANING_UPLOAD_DIR", BASE_DIR / "uploads"))
AUTH_SECRET_PATH = Path(os.environ.get("ROUTINER_AUTH_SECRET_FILE", BASE_DIR / ".auth_secret"))
STATIC_DIR = os.environ.get("ROUTINER_STATIC_DIR")
COOKIE_SECURE = os.environ.get("ROUTINER_COOKIE_SECURE", "").lower() == "true"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

FREQUENCIES = {"Diário", "Semanal", "Quinzenal", "Mensal"}
STATUSES = {"Limpo", "Não limpo"}
SCHEDULE_TIMEZONE = ZoneInfo(os.environ.get("ROUTINER_TIMEZONE", "America/Sao_Paulo"))
PASSWORD_ITERATIONS = 600_000
SESSION_COOKIE = "routiner_session"
SESSION_SECONDS = 60 * 60 * 12
PASSWORD_RESET_SECONDS = 30 * 60
HANDLE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")
USERNAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,29}$")


def load_auth_secret() -> bytes:
    configured = os.environ.get("ROUTINER_AUTH_SECRET")
    if configured:
        if len(configured) < 32:
            raise RuntimeError("ROUTINER_AUTH_SECRET deve ter pelo menos 32 caracteres.")
        return configured.encode("utf-8")
    AUTH_SECRET_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(AUTH_SECRET_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return AUTH_SECRET_PATH.read_bytes()
    secret = secrets.token_bytes(48)
    with os.fdopen(descriptor, "wb") as secret_file:
        secret_file.write(secret)
    return secret


AUTH_SECRET = load_auth_secret()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def app_lifespan(application: FastAPI):
    worker = asyncio.create_task(task_schedule_worker())
    application.state.task_schedule_worker = worker
    try:
        yield
    finally:
        worker.cancel()
        try:
            await worker
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="Routiner — Gestão de limpeza",
    version="2.0.0",
    lifespan=app_lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.environ.get(
            "ROUTINER_ALLOWED_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173",
        ).split(",")
        if origin.strip()
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def prevent_private_data_caching(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/api/", "/uploads/")):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response


class HybridRow(dict):
    def __init__(self, names, values):
        super().__init__(zip(names, values))
        self._values = values

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return super().__getitem__(key)


def postgres_row_factory(cursor):
    if cursor.description is None:
        return tuple
    names = [column.name for column in cursor.description]
    return lambda values: HybridRow(names, values)


class PostgresConnection:
    def __init__(self, raw_connection):
        self.raw_connection = raw_connection

    def execute(self, sql, parameters=None):
        statement = sql.replace(" COLLATE NOCASE", "").replace("?", "%s")
        statement = re.sub(r"\bLIKE\b", "ILIKE", statement, flags=re.IGNORECASE)
        try:
            if parameters is None:
                return self.raw_connection.execute(statement)
            return self.raw_connection.execute(statement, parameters)
        except Exception as error:
            import psycopg

            if isinstance(error, psycopg.IntegrityError):
                raise sqlite3.IntegrityError(str(error)) from error
            raise

    def executescript(self, sql):
        for statement in sql.replace(" COLLATE NOCASE", "").split(";"):
            if statement.strip():
                self.execute(statement)

    def commit(self):
        self.raw_connection.commit()

    def rollback(self):
        self.raw_connection.rollback()

    def close(self):
        self.raw_connection.close()


@contextmanager
def connection():
    if DATABASE_URL:
        import psycopg

        database_url = DATABASE_URL
        if database_url.startswith("postgres://"):
            database_url = database_url.replace("postgres://", "postgresql://", 1)
        raw_connection = psycopg.connect(database_url, row_factory=postgres_row_factory)
        conn = PostgresConnection(raw_connection)
    else:
        raw_connection = sqlite3.connect(DB_PATH)
        raw_connection.row_factory = sqlite3.Row
        conn = raw_connection
    if not DATABASE_URL:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def add_column_if_missing(conn: sqlite3.Connection, table: str, definition: str):
    column_name = definition.split()[0]
    if DATABASE_URL:
        existing = {
            row["column_name"]
            for row in conn.execute(
                """SELECT column_name FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = ?""",
                (table,),
            )
        }
    else:
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column_name not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {definition}")


def initialize_database():
    with connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS companies (
                id TEXT PRIMARY KEY,
                fantasy_name TEXT NOT NULL,
                company_handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                sector TEXT NOT NULL,
                username TEXT NOT NULL COLLATE NOCASE,
                email TEXT,
                password_hash TEXT NOT NULL,
                initial_password_pending INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                UNIQUE(company_id, username)
            );
            CREATE TABLE IF NOT EXISTS sectors (
                id TEXT PRIMARY KEY,
                company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                name TEXT NOT NULL COLLATE NOCASE,
                created_at TEXT NOT NULL,
                UNIQUE(company_id, name)
            );
            CREATE TABLE IF NOT EXISTS locations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                cleaning_type TEXT NOT NULL DEFAULT 'Estrutural',
                photo TEXT,
                responsible TEXT NOT NULL,
                responsible_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
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
            CREATE TABLE IF NOT EXISTS uploads (
                filename TEXT PRIMARY KEY,
                company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_schedules (
                id TEXT PRIMARY KEY,
                company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                location_id TEXT NOT NULL UNIQUE REFERENCES locations(id) ON DELETE CASCADE,
                assigned_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                weekdays TEXT NOT NULL,
                due_time TEXT NOT NULL,
                month_week TEXT NOT NULL DEFAULT '1',
                alternate_weeks INTEGER NOT NULL DEFAULT 0,
                anchor_date TEXT,
                last_generated_on TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                assigned_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                deadline TEXT NOT NULL,
                created_at TEXT NOT NULL,
                acknowledged_at TEXT,
                completed_at TEXT,
                completion_notes TEXT NOT NULL DEFAULT '',
                photo_before TEXT,
                photo_after TEXT,
                completed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                schedule_id TEXT REFERENCES task_schedules(id) ON DELETE SET NULL,
                scheduled_for TEXT,
                missed_at TEXT,
                missed_notes TEXT,
                missed_acknowledged_at TEXT,
                deleted_at TEXT,
                deletion_reason TEXT,
                deleted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS company_notifications (
                id TEXT PRIMARY KEY,
                company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                event_type TEXT NOT NULL CHECK (event_type IN ('acknowledged', 'completed')),
                created_at TEXT NOT NULL,
                read_at TEXT
            );
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id TEXT PRIMARY KEY,
                company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                used_at TEXT
            );
            """
        )
        add_column_if_missing(conn, "users", "email TEXT")
        add_column_if_missing(
            conn, "users", "initial_password_pending INTEGER NOT NULL DEFAULT 0"
        )
        # Existing prototype data stays unassigned and is never exposed to a new tenant.
        add_column_if_missing(
            conn, "locations", "company_id TEXT REFERENCES companies(id) ON DELETE CASCADE"
        )
        add_column_if_missing(
            conn, "locations", "responsible_user_id TEXT REFERENCES users(id) ON DELETE SET NULL"
        )
        add_column_if_missing(
            conn, "locations", "cleaning_type TEXT NOT NULL DEFAULT 'Estrutural'"
        )
        add_column_if_missing(conn, "task_schedules", "month_week TEXT NOT NULL DEFAULT '1'")
        add_column_if_missing(conn, "task_schedules", "alternate_weeks INTEGER NOT NULL DEFAULT 0")
        add_column_if_missing(conn, "task_schedules", "anchor_date TEXT")
        conn.execute(
            """UPDATE task_schedules SET anchor_date = last_generated_on
                WHERE anchor_date IS NULL"""
        )
        conn.execute(
            """UPDATE task_schedules SET alternate_weeks = 1
                WHERE location_id IN (
                    SELECT id FROM locations WHERE frequency = 'Quinzenal'
                )"""
        )
        conn.execute(
            """UPDATE locations
                SET responsible_user_id = (
                    SELECT MIN(u.id) FROM users u
                    WHERE u.company_id = locations.company_id
                        AND lower(trim(u.name)) = lower(trim(locations.responsible))
                    HAVING COUNT(*) = 1
                )
                WHERE responsible_user_id IS NULL"""
        )
        if DATABASE_URL:
            conn.execute(
                """INSERT INTO sectors (id, company_id, name, created_at)
                    SELECT md5(random()::text || clock_timestamp()::text),
                        company_id, trim(sector), ?
                    FROM users WHERE trim(sector) != ''
                    GROUP BY company_id, lower(trim(sector)), trim(sector)
                    ON CONFLICT DO NOTHING""",
                (datetime.now(timezone.utc).isoformat(timespec="seconds"),),
            )
        else:
            conn.execute(
                """INSERT OR IGNORE INTO sectors (id, company_id, name, created_at)
                    SELECT lower(hex(randomblob(16))), company_id, trim(sector), ?
                    FROM users WHERE trim(sector) != ''
                    GROUP BY company_id, lower(trim(sector))""",
                (datetime.now(timezone.utc).isoformat(timespec="seconds"),),
            )
        add_column_if_missing(
            conn, "cleanings", "created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL"
        )
        conn.execute(
            """UPDATE cleanings
                SET status = CASE
                    WHEN NULLIF(trim(photo_before), '') IS NOT NULL
                        AND NULLIF(trim(photo_after), '') IS NOT NULL THEN 'Limpo'
                    ELSE 'Não limpo'
                END
                WHERE status != CASE
                    WHEN NULLIF(trim(photo_before), '') IS NOT NULL
                        AND NULLIF(trim(photo_after), '') IS NOT NULL THEN 'Limpo'
                    ELSE 'Não limpo'
                END"""
        )
        add_column_if_missing(conn, "tasks", "completion_notes TEXT NOT NULL DEFAULT ''")
        add_column_if_missing(conn, "tasks", "photo_before TEXT")
        add_column_if_missing(conn, "tasks", "photo_after TEXT")
        add_column_if_missing(
            conn, "tasks", "completed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL"
        )
        add_column_if_missing(
            conn, "tasks", "schedule_id TEXT REFERENCES task_schedules(id) ON DELETE SET NULL"
        )
        add_column_if_missing(conn, "tasks", "scheduled_for TEXT")
        add_column_if_missing(conn, "tasks", "missed_at TEXT")
        add_column_if_missing(conn, "tasks", "missed_notes TEXT")
        add_column_if_missing(conn, "tasks", "missed_acknowledged_at TEXT")
        add_column_if_missing(conn, "tasks", "deleted_at TEXT")
        add_column_if_missing(conn, "tasks", "deletion_reason TEXT")
        add_column_if_missing(
            conn, "tasks", "deleted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_locations_company ON locations(company_id, name)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_cleanings_location_date ON cleanings(location_id, cleaning_date DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_cleanings_author_date ON cleanings(created_by_user_id, cleaning_date DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id, name)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tasks_assignee_deadline ON tasks(assigned_user_id, deadline)"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_schedule_occurrence ON tasks(schedule_id, scheduled_for)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tasks_history ON tasks(company_id, completed_at, missed_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tasks_deleted_company ON tasks(company_id, deleted_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_notifications_company_date ON company_notifications(company_id, created_at DESC)"
        )


initialize_database()


def schedule_occurs_on(
    occurrence_day: date,
    weekdays: set[int],
    frequency: str,
    month_week: str,
    alternate_weeks: bool,
    anchor_date: str | None,
) -> bool:
    if occurrence_day.weekday() not in weekdays:
        return False
    if frequency == "Mensal":
        if month_week == "last":
            return (occurrence_day + timedelta(days=7)).month != occurrence_day.month
        return (occurrence_day.day - 1) // 7 + 1 == int(month_week)
    if alternate_weeks:
        anchor = date.fromisoformat(anchor_date) if anchor_date else occurrence_day
        anchor_monday = anchor - timedelta(days=anchor.weekday())
        occurrence_monday = occurrence_day - timedelta(days=occurrence_day.weekday())
        return ((occurrence_monday - anchor_monday).days // 7) % 2 == 0
    return frequency in {"Diário", "Semanal", "Quinzenal"}


def process_due_tasks(now: datetime | None = None):
    current = now or datetime.now(timezone.utc)
    local_today = current.astimezone(SCHEDULE_TIMEZONE).date()
    generation_end = local_today + timedelta(days=6)
    with connection() as conn:
        schedules = conn.execute(
            """SELECT s.*, l.name AS location_name, l.frequency
                FROM task_schedules s
                JOIN locations l ON l.id = s.location_id"""
        ).fetchall()
        for schedule in schedules:
            weekdays = set(json.loads(schedule["weekdays"]))
            start = date.fromisoformat(schedule["last_generated_on"]) + timedelta(days=1)
            scheduled_time = time.fromisoformat(schedule["due_time"])
            occurrence_day = start
            while occurrence_day <= generation_end:
                if schedule_occurs_on(
                    occurrence_day,
                    weekdays,
                    schedule["frequency"],
                    schedule["month_week"],
                    bool(schedule["alternate_weeks"]) or schedule["frequency"] == "Quinzenal",
                    schedule["anchor_date"],
                ):
                    deadline_local = datetime.combine(
                        occurrence_day, scheduled_time, tzinfo=SCHEDULE_TIMEZONE
                    )
                    deadline = deadline_local.astimezone(timezone.utc).isoformat(timespec="seconds")
                    conn.execute(
                        """INSERT INTO tasks
                            (id, company_id, assigned_user_id, title, description, deadline,
                                created_at, schedule_id, scheduled_for, missed_at)
                            VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)
                            ON CONFLICT(schedule_id, scheduled_for) DO NOTHING""",
                        (
                            str(uuid.uuid4()),
                            schedule["company_id"],
                            schedule["assigned_user_id"],
                            schedule["location_name"],
                            deadline,
                            current.isoformat(timespec="seconds"),
                            schedule["id"],
                            occurrence_day.isoformat(),
                            deadline if deadline_local <= current else None,
                        ),
                    )
                occurrence_day += timedelta(days=1)
            if start <= generation_end:
                conn.execute(
                    "UPDATE task_schedules SET last_generated_on = ? WHERE id = ?",
                    (generation_end.isoformat(), schedule["id"]),
                )
        conn.execute(
            """UPDATE tasks SET missed_at = deadline
                WHERE completed_at IS NULL AND missed_at IS NULL
                    AND deleted_at IS NULL AND deadline <= ?""",
            (current.isoformat(timespec="seconds"),),
        )


async def task_schedule_worker():
    while True:
        try:
            process_due_tasks()
        except Exception:
            logger.exception("Falha ao gerar ocorrências ou registrar tarefas vencidas.")
        await asyncio.sleep(60)


class CompanyRegistration(BaseModel):
    fantasy_name: Annotated[str, Field(min_length=2, max_length=120)]
    company_handle: Annotated[str, Field(min_length=2, max_length=50)]
    email: Annotated[str, Field(min_length=5, max_length=254)]
    password: Annotated[str, Field(min_length=8, max_length=128)]

    @field_validator("fantasy_name")
    @classmethod
    def clean_fantasy_name(cls, value: str) -> str:
        return value.strip()

    @field_validator("company_handle")
    @classmethod
    def clean_company_handle(cls, value: str) -> str:
        handle = value.strip().lower()
        if handle.endswith(".routine"):
            handle = handle[:-8]
        if not HANDLE_PATTERN.fullmatch(handle):
            raise ValueError("Use de 2 a 40 letras minúsculas, números ou hífens no identificador.")
        return handle

    @field_validator("email")
    @classmethod
    def clean_email(cls, value: str) -> str:
        email = value.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ValueError("Informe um e-mail válido.")
        return email


class LoginInput(BaseModel):
    identifier: Annotated[str, Field(min_length=3, max_length=150)]
    password: Annotated[str, Field(min_length=1, max_length=128)]


class UserInput(BaseModel):
    name: Annotated[str, Field(min_length=2, max_length=120)]
    sector: Annotated[str, Field(min_length=2, max_length=80)]
    username: Annotated[str, Field(min_length=2, max_length=40)]
    email: Annotated[str, Field(min_length=5, max_length=254)]
    password: Annotated[str, Field(min_length=8, max_length=128)]

    @field_validator("name", "sector")
    @classmethod
    def clean_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("username")
    @classmethod
    def clean_username(cls, value: str) -> str:
        username = value.strip().lower()
        if not USERNAME_PATTERN.fullmatch(username):
            raise ValueError("Use de 2 a 30 letras minúsculas, números ou hífens.")
        return username

    @field_validator("email")
    @classmethod
    def clean_email(cls, value: str) -> str:
        email = value.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ValueError("Informe um e-mail válido.")
        return email


class UserUpdateInput(BaseModel):
    name: Annotated[str, Field(min_length=2, max_length=120)]
    sector: Annotated[str, Field(min_length=2, max_length=80)]
    email: Annotated[str, Field(min_length=5, max_length=254)]

    @field_validator("name", "sector")
    @classmethod
    def clean_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("email")
    @classmethod
    def clean_email(cls, value: str) -> str:
        email = value.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ValueError("Informe um e-mail válido.")
        return email


class PasswordResetRequest(BaseModel):
    role: Literal["company", "user"]
    identifier: Annotated[str, Field(min_length=3, max_length=150)]
    email: Annotated[str, Field(min_length=5, max_length=254)]

    @field_validator("identifier", "email")
    @classmethod
    def clean_value(cls, value: str) -> str:
        return value.strip().lower()

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
            raise ValueError("Informe um e-mail válido.")
        return value


class PasswordResetConfirm(BaseModel):
    token: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{43}$")]
    password: Annotated[str, Field(min_length=8, max_length=128)]


class InitialPasswordChange(BaseModel):
    current_password: Annotated[str, Field(min_length=1, max_length=128)]
    new_password: Annotated[str, Field(min_length=8, max_length=128)]


class SectorInput(BaseModel):
    name: Annotated[str, Field(min_length=2, max_length=80)]

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = value.strip()
        if len(cleaned) < 2:
            raise ValueError("Informe um nome de setor com pelo menos 2 caracteres.")
        return cleaned


class LocationInput(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=100)]
    cleaning_type: Annotated[str, Field(min_length=2, max_length=80)] = "Estrutural"
    photo: str | None = None
    sector: str = ""
    responsible: Annotated[str, Field(min_length=1, max_length=100)]
    responsible_user_id: str | None = None
    frequency: str
    schedule_days: Annotated[list[int], Field(min_length=1, max_length=7)] = Field(
        default_factory=lambda: list(range(6))
    )
    schedule_time: Annotated[str, Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")] = "23:59"
    month_week: str = "1"
    alternate_weeks: bool = False

    @field_validator("name", "cleaning_type", "sector", "responsible")
    @classmethod
    def clean_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("cleaning_type")
    @classmethod
    def validate_cleaning_type(cls, value: str) -> str:
        cleaned = value.strip()
        if len(cleaned) < 2:
            raise ValueError("Informe um tipo de limpeza com pelo menos 2 caracteres.")
        return cleaned

    @field_validator("schedule_days")
    @classmethod
    def validate_schedule_days(cls, value: list[int]) -> list[int]:
        if len(set(value)) != len(value) or any(day < 0 or day > 6 for day in value):
            raise ValueError("Selecione dias da semana válidos, sem repetições.")
        return sorted(value)

    @field_validator("schedule_time")
    @classmethod
    def validate_schedule_time(cls, value: str) -> str:
        try:
            time.fromisoformat(value)
        except ValueError as error:
            raise ValueError("Informe um horário válido no formato 24 horas.") from error
        return value

    @field_validator("month_week")
    @classmethod
    def validate_month_week(cls, value: str) -> str:
        if value not in {"1", "2", "3", "4", "last"}:
            raise ValueError("Selecione uma semana válida do mês.")
        return value


class CleaningInput(BaseModel):
    location_id: str
    cleaning_date: date
    photo_before: str | None = None
    photo_after: str | None = None
    notes: Annotated[str, Field(max_length=1000)] = ""

    @field_validator("notes")
    @classmethod
    def clean_notes(cls, value: str) -> str:
        return value.strip()


class TaskInput(BaseModel):
    assigned_user_id: str
    title: Annotated[str, Field(min_length=2, max_length=120)]
    description: Annotated[str, Field(max_length=1000)] = ""
    deadline: datetime

    @field_validator("title")
    @classmethod
    def clean_task_title(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("O título da tarefa não pode ficar vazio.")
        return cleaned

    @field_validator("description")
    @classmethod
    def clean_task_description(cls, value: str) -> str:
        return value.strip()

    @field_validator("deadline")
    @classmethod
    def validate_deadline(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("O prazo precisa incluir o fuso horário.")
        if value <= datetime.now(timezone.utc):
            raise ValueError("O prazo deve ser uma data e hora futuras.")
        return value.astimezone(timezone.utc)


class TaskUpdateInput(BaseModel):
    assigned_user_id: str
    deadline: datetime

    @field_validator("deadline")
    @classmethod
    def validate_deadline(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("O prazo precisa incluir o fuso horário.")
        deadline = value.astimezone(timezone.utc)
        if deadline <= datetime.now(timezone.utc):
            raise ValueError("O prazo deve ser uma data e hora futuras.")
        return deadline


class TaskDeletionInput(BaseModel):
    reason: Annotated[str, Field(min_length=3, max_length=500)]

    @field_validator("reason")
    @classmethod
    def clean_deletion_reason(cls, value: str) -> str:
        reason = value.strip()
        if len(reason) < 3:
            raise ValueError("Informe o motivo da exclusão.")
        return reason


class MissedTaskAcknowledgmentInput(BaseModel):
    notes: Annotated[str, Field(min_length=1, max_length=1000)]

    @field_validator("notes")
    @classmethod
    def clean_missed_notes(cls, value: str) -> str:
        notes = value.strip()
        if not notes:
            raise ValueError("A observação é obrigatória.")
        return notes


class TaskCompletionInput(BaseModel):
    photo_before: Annotated[str, Field(min_length=1, max_length=100)]
    photo_after: Annotated[str, Field(min_length=1, max_length=100)]
    notes: Annotated[str, Field(max_length=1000)] = ""

    @field_validator("notes")
    @classmethod
    def clean_completion_notes(cls, value: str) -> str:
        return value.strip()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return "$".join(
        (
            "pbkdf2_sha256",
            str(PASSWORD_ITERATIONS),
            base64.urlsafe_b64encode(salt).decode("ascii"),
            base64.urlsafe_b64encode(digest).decode("ascii"),
        )
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iteration_text, salt_text, digest_text = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(salt_text.encode("ascii"))
        expected = base64.urlsafe_b64decode(digest_text.encode("ascii"))
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, int(iteration_text)
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def password_reset_mail_settings() -> dict:
    host = os.environ.get("SMTP_HOST", "").strip()
    sender = os.environ.get("SMTP_FROM", "").strip()
    if not host or not sender:
        raise HTTPException(
            status_code=503,
            detail="A recuperação por e-mail ainda não está configurada no servidor.",
        )
    username = os.environ.get("SMTP_USERNAME", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "")
    if bool(username) != bool(password):
        raise HTTPException(
            status_code=503,
            detail="A configuração de e-mail do servidor está incompleta.",
        )
    try:
        default_port = "465" if os.environ.get("SMTP_USE_SSL", "").lower() == "true" else "587"
        port = int(os.environ.get("SMTP_PORT", default_port))
    except ValueError as error:
        raise HTTPException(
            status_code=503,
            detail="A configuração de e-mail do servidor está inválida.",
        ) from error
    if not 1 <= port <= 65535:
        raise HTTPException(
            status_code=503,
            detail="A porta SMTP precisa estar entre 1 e 65535.",
        )
    use_ssl = os.environ.get("SMTP_USE_SSL", "").lower() == "true"
    use_starttls = os.environ.get("SMTP_STARTTLS", str(not use_ssl)).lower() == "true"
    if use_ssl and use_starttls:
        raise HTTPException(
            status_code=503,
            detail="Escolha SSL ou STARTTLS na configuração de e-mail do servidor.",
        )
    return {
        "host": host,
        "port": port,
        "sender": sender,
        "sender_name": os.environ.get("SMTP_FROM_NAME", "Routiner").strip() or "Routiner",
        "username": username,
        "password": password,
        "use_ssl": use_ssl,
        "use_starttls": use_starttls,
    }


def send_password_reset_email(
    recipient: str,
    account_name: str,
    reset_url: str,
    settings: dict,
):
    message = EmailMessage()
    message["Subject"] = "Redefinição de senha do Routiner"
    message["From"] = formataddr((settings["sender_name"], settings["sender"]))
    message["To"] = recipient
    message.set_content(
        f"Olá, {account_name}.\n\n"
        "Recebemos uma solicitação para redefinir a senha da sua conta Routiner.\n"
        f"Acesse este link em até 30 minutos para escolher uma nova senha:\n{reset_url}\n\n"
        "Se você não solicitou esta alteração, ignore este e-mail. Sua senha atual continuará válida."
    )
    client_type = smtplib.SMTP_SSL if settings["use_ssl"] else smtplib.SMTP
    with client_type(settings["host"], settings["port"], timeout=10) as smtp:
        if settings["use_starttls"]:
            smtp.starttls(context=ssl.create_default_context())
        if settings["username"]:
            smtp.login(settings["username"], settings["password"])
        smtp.send_message(message)


def encode_session(payload: dict) -> str:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    body = base64.urlsafe_b64encode(raw).rstrip(b"=")
    signature = hmac.new(AUTH_SECRET, body, hashlib.sha256).digest()
    signed = body + b"." + base64.urlsafe_b64encode(signature).rstrip(b"=")
    return signed.decode("ascii")


def decode_session(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        body, signature_text = token.encode("ascii").split(b".", 1)
        signature = base64.urlsafe_b64decode(signature_text + b"=" * (-len(signature_text) % 4))
        expected = hmac.new(AUTH_SECRET, body, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            return None
        raw = base64.urlsafe_b64decode(body + b"=" * (-len(body) % 4))
        payload = json.loads(raw)
        if int(payload["exp"]) <= int(datetime.now(timezone.utc).timestamp()):
            return None
        if payload.get("role") not in {"company", "user"}:
            return None
        return payload
    except (ValueError, KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def set_session_cookie(response: Response, request: Request, account: dict):
    payload = {
        "company_id": account["company_id"],
        "account_id": account["account_id"],
        "role": account["role"],
        "exp": int(datetime.now(timezone.utc).timestamp()) + SESSION_SECONDS,
    }
    response.set_cookie(
        SESSION_COOKIE,
        encode_session(payload),
        max_age=SESSION_SECONDS,
        httponly=True,
        secure=(
            request.url.scheme == "https"
            or request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https"
            or COOKIE_SECURE
        ),
        samesite="lax",
        path="/",
    )


def current_session(
    routiner_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    session = decode_session(routiner_session)
    if not session:
        raise HTTPException(status_code=401, detail="Sua sessão expirou. Entre novamente.")
    return session


def company_only(session: dict = Depends(current_session)) -> dict:
    if session["role"] != "company":
        raise HTTPException(status_code=403, detail="Apenas o chefe da empresa pode acessar esta função.")
    return session


def validate_frequency(frequency: str):
    if frequency not in FREQUENCIES:
        raise HTTPException(status_code=422, detail="Frequência inválida.")


def company_row(conn: sqlite3.Connection, company_id: str):
    row = conn.execute(
        "SELECT id, fantasy_name, company_handle, email, created_at FROM companies WHERE id = ?",
        (company_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="A empresa desta sessão não existe mais.")
    return dict(row)


def fetch_location(conn: sqlite3.Connection, location_id: str, company_id: str):
    row = conn.execute(
        """SELECT l.*, u.sector AS responsible_sector,
                s.id AS schedule_id, s.weekdays AS schedule_days,
                s.due_time AS schedule_time, s.month_week,
                s.alternate_weeks, s.anchor_date
            FROM locations l
            LEFT JOIN users u ON u.id = l.responsible_user_id
            LEFT JOIN task_schedules s ON s.location_id = l.id
            WHERE l.id = ? AND l.company_id = ?""",
        (location_id, company_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Local não encontrado nesta empresa.")
    return dict(row)


def save_location_schedule(
    conn: sqlite3.Connection,
    location_id: str,
    company_id: str,
    responsible_user_id: str,
    location_name: str,
    weekdays: list[int],
    due_time: str,
    frequency: str,
    month_week: str,
    alternate_weeks: bool,
):
    today = datetime.now(SCHEDULE_TIMEZONE).date()
    existing = conn.execute(
        """SELECT id, alternate_weeks, anchor_date FROM task_schedules
            WHERE location_id = ? AND company_id = ?""",
        (location_id, company_id),
    ).fetchone()
    anchor_date = existing["anchor_date"] if existing is not None else None
    if alternate_weeks and (
        existing is None or not bool(existing["alternate_weeks"]) or not anchor_date
    ):
        anchor_date = (today - timedelta(days=today.weekday())).isoformat()
    elif not anchor_date:
        anchor_date = today.isoformat()
    if existing is not None:
        current_utc = datetime.now(timezone.utc).isoformat(timespec="seconds")
        for task in conn.execute(
            """SELECT id, scheduled_for, assigned_user_id
                FROM tasks WHERE schedule_id = ? AND completed_at IS NULL
                    AND missed_at IS NULL AND deleted_at IS NULL AND deadline > ?""",
            (existing["id"], current_utc),
        ).fetchall():
            occurrence_day = date.fromisoformat(task["scheduled_for"])
            if not schedule_occurs_on(
                occurrence_day,
                set(weekdays),
                frequency,
                month_week,
                alternate_weeks,
                anchor_date,
            ):
                conn.execute("DELETE FROM tasks WHERE id = ?", (task["id"],))
                continue
            deadline = datetime.combine(
                occurrence_day, time.fromisoformat(due_time), tzinfo=SCHEDULE_TIMEZONE
            ).astimezone(timezone.utc).isoformat(timespec="seconds")
            changed_assignee = task["assigned_user_id"] != responsible_user_id
            conn.execute(
                """UPDATE tasks SET title = ?, assigned_user_id = ?, deadline = ?,
                        acknowledged_at = CASE WHEN ? THEN NULL ELSE acknowledged_at END
                    WHERE id = ?""",
                (
                    location_name,
                    responsible_user_id,
                    deadline,
                    changed_assignee,
                    task["id"],
                ),
            )
    conn.execute(
        """INSERT INTO task_schedules
            (id, company_id, location_id, assigned_user_id, weekdays, due_time,
                month_week, alternate_weeks, anchor_date, last_generated_on, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(location_id) DO UPDATE SET
                company_id = excluded.company_id,
                assigned_user_id = excluded.assigned_user_id,
                weekdays = excluded.weekdays,
                due_time = excluded.due_time,
                month_week = excluded.month_week,
                alternate_weeks = excluded.alternate_weeks,
                anchor_date = excluded.anchor_date,
                last_generated_on = excluded.last_generated_on""",
        (
            str(uuid.uuid4()),
            company_id,
            location_id,
            responsible_user_id,
            json.dumps(weekdays),
            due_time,
            month_week,
            alternate_weeks,
            anchor_date,
            (today - timedelta(days=1)).isoformat(),
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
        ),
    )


def employee_location_filter(session: dict, alias: str = "l") -> tuple[str, list[str]]:
    return (
        f"""{alias}.responsible_user_id IN (
            SELECT sector_user.id FROM users sector_user
            WHERE sector_user.company_id = ?
                AND lower(trim(sector_user.sector)) = lower(trim((
                    SELECT own_user.sector FROM users own_user
                    WHERE own_user.id = ? AND own_user.company_id = ?
                )))
        )""",
        [session["company_id"], session["account_id"], session["company_id"]],
    )


def require_location_access(conn: sqlite3.Connection, location_id: str, session: dict):
    location = fetch_location(conn, location_id, session["company_id"])
    if session["role"] == "user" and (
        location["responsible_user_id"] is None
        or conn.execute(
            """SELECT 1 FROM users responsible
                JOIN users active_user
                    ON active_user.company_id = responsible.company_id
                    AND active_user.id = ?
                WHERE responsible.id = ? AND responsible.company_id = ?
                    AND lower(trim(responsible.sector)) = lower(trim(active_user.sector))""",
            (
                session["account_id"],
                location["responsible_user_id"],
                session["company_id"],
            ),
        ).fetchone()
        is None
    ):
        raise HTTPException(status_code=404, detail="Local não encontrado nesta conta.")
    return location


def responsible_user_for_location(
    conn: sqlite3.Connection,
    company_id: str,
    responsible: str,
    responsible_user_id: str | None = None,
    sector: str = "",
):
    if responsible_user_id:
        row = conn.execute(
            "SELECT id, name, sector FROM users WHERE id = ? AND company_id = ?",
            (responsible_user_id, company_id),
        ).fetchone()
        if row is None:
            raise HTTPException(
                status_code=422,
                detail="O responsável selecionado não pertence a esta empresa.",
            )
        if sector and row["sector"].strip().casefold() != sector.strip().casefold():
            raise HTTPException(
                status_code=422,
                detail="O funcionário responsável deve pertencer ao setor selecionado.",
            )
        return dict(row)
    rows = conn.execute(
        """SELECT id, name, sector FROM users
            WHERE company_id = ? AND lower(trim(name)) = lower(trim(?))""",
        (company_id, responsible),
    ).fetchall()
    if len(rows) != 1:
        raise HTTPException(
            status_code=422,
            detail="Selecione um funcionário cadastrado como responsável pelo local.",
        )
    if sector and rows[0]["sector"].strip().casefold() != sector.strip().casefold():
        raise HTTPException(
            status_code=422,
            detail="O funcionário responsável deve pertencer ao setor selecionado.",
        )
    return dict(rows[0])


def register_identifier(account: dict) -> dict:
    result = {"role": account["role"], "name": account["name"], "login": account["login"]}
    result["company"] = account["company"]
    if account["role"] == "user":
        result["account_id"] = account["account_id"]
        result["sector"] = account["sector"]
        result["initial_password_pending"] = account["initial_password_pending"]
    return result


@app.get("/api/health")
def health():
    with connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok"}


@app.post("/api/auth/register-company", status_code=201)
def register_company(payload: CompanyRegistration, request: Request, response: Response):
    company_id = str(uuid.uuid4())
    with connection() as conn:
        try:
            conn.execute(
                """INSERT INTO companies
                    (id, fantasy_name, company_handle, email, password_hash, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    company_id,
                    payload.fantasy_name,
                    payload.company_handle,
                    payload.email,
                    hash_password(payload.password),
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                ),
            )
        except sqlite3.IntegrityError as error:
            if "company_handle" in str(error).lower():
                raise HTTPException(status_code=409, detail="Este identificador de empresa já está em uso.") from error
            if "email" in str(error).lower():
                raise HTTPException(status_code=409, detail="Já existe uma empresa cadastrada com este e-mail.") from error
            raise
        company = company_row(conn, company_id)
    account = {
        "role": "company",
        "account_id": company_id,
        "company_id": company_id,
        "name": company["fantasy_name"],
        "login": f'{company["company_handle"]}.routine',
        "company": company,
    }
    set_session_cookie(response, request, account)
    return register_identifier(account)


@app.post("/api/auth/login-company")
def login_company(payload: LoginInput, request: Request, response: Response):
    identifier = payload.identifier.strip().lower()
    handle = identifier[:-8] if identifier.endswith(".routine") else identifier
    with connection() as conn:
        row = conn.execute("SELECT * FROM companies WHERE company_handle = ?", (handle,)).fetchone()
        if row is None or not verify_password(payload.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Identificador ou senha incorretos.")
        company = company_row(conn, row["id"])
    account = {
        "role": "company",
        "account_id": company["id"],
        "company_id": company["id"],
        "name": company["fantasy_name"],
        "login": f'{company["company_handle"]}.routine',
        "company": company,
    }
    set_session_cookie(response, request, account)
    return register_identifier(account)


@app.post("/api/auth/login-user")
def login_user(payload: LoginInput, request: Request, response: Response):
    identifier = payload.identifier.strip().lower()
    if not identifier.endswith(".routine"):
        raise HTTPException(status_code=401, detail="Identificador ou senha incorretos.")
    account_identifier = identifier[:-8]
    if "." not in account_identifier:
        raise HTTPException(status_code=401, detail="Identificador ou senha incorretos.")
    username, company_handle = account_identifier.rsplit(".", 1)
    if not USERNAME_PATTERN.fullmatch(username) or not HANDLE_PATTERN.fullmatch(company_handle):
        raise HTTPException(status_code=401, detail="Identificador ou senha incorretos.")
    with connection() as conn:
        row = conn.execute(
            """SELECT u.*, c.fantasy_name, c.company_handle, c.email
                FROM users u JOIN companies c ON c.id = u.company_id
                WHERE u.username = ? AND c.company_handle = ?""",
            (username, company_handle),
        ).fetchone()
        if row is None or not verify_password(payload.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Identificador ou senha incorretos.")
        company = {
            "id": row["company_id"],
            "fantasy_name": row["fantasy_name"],
            "company_handle": row["company_handle"],
            "email": row["email"],
        }
        account = {
            "role": "user",
            "account_id": row["id"],
            "company_id": row["company_id"],
            "name": row["name"],
            "sector": row["sector"],
            "login": f'{row["username"]}.{row["company_handle"]}.routine',
            "initial_password_pending": bool(row["initial_password_pending"]),
            "company": company,
        }
    set_session_cookie(response, request, account)
    return register_identifier(account)


@app.get("/api/auth/me")
def get_current_account(session: dict = Depends(current_session)):
    with connection() as conn:
        company = company_row(conn, session["company_id"])
        if session["role"] == "company":
            name = company["fantasy_name"]
            login = f'{company["company_handle"]}.routine'
            result = {
                "role": "company",
                "name": name,
                "login": login,
                "company": company,
            }
        else:
            user = conn.execute(
                """SELECT name, sector, username, initial_password_pending
                    FROM users WHERE id = ? AND company_id = ?""",
                (session["account_id"], session["company_id"]),
            ).fetchone()
            if user is None:
                raise HTTPException(status_code=401, detail="Esta conta de usuário não existe mais.")
            result = {
                "role": "user",
                "account_id": session["account_id"],
                "name": user["name"],
                "sector": user["sector"],
                "login": f'{user["username"]}.{company["company_handle"]}.routine',
                "initial_password_pending": bool(user["initial_password_pending"]),
                "company": company,
            }
    return result


@app.post("/api/auth/initial-password/keep")
def keep_initial_password(session: dict = Depends(current_session)):
    if session["role"] != "user":
        raise HTTPException(status_code=403, detail="Esta opção está disponível apenas para funcionários.")
    with connection() as conn:
        user = conn.execute(
            """SELECT initial_password_pending FROM users
                WHERE id = ? AND company_id = ?""",
            (session["account_id"], session["company_id"]),
        ).fetchone()
        if user is None:
            raise HTTPException(status_code=401, detail="Esta conta de funcionário não existe mais.")
        if user["initial_password_pending"]:
            conn.execute(
                """UPDATE users SET initial_password_pending = 0
                    WHERE id = ? AND company_id = ?""",
                (session["account_id"], session["company_id"]),
            )
    return {"message": "Senha inicial mantida."}


@app.post("/api/auth/initial-password/change")
def change_initial_password(
    payload: InitialPasswordChange,
    session: dict = Depends(current_session),
):
    if session["role"] != "user":
        raise HTTPException(status_code=403, detail="Esta opção está disponível apenas para funcionários.")
    with connection() as conn:
        user = conn.execute(
            """SELECT password_hash, initial_password_pending FROM users
                WHERE id = ? AND company_id = ?""",
            (session["account_id"], session["company_id"]),
        ).fetchone()
        if user is None:
            raise HTTPException(status_code=401, detail="Esta conta de funcionário não existe mais.")
        if not user["initial_password_pending"]:
            raise HTTPException(status_code=409, detail="A escolha da senha inicial já foi concluída.")
        if not verify_password(payload.current_password, user["password_hash"]):
            raise HTTPException(status_code=400, detail="A senha inicial informada está incorreta.")
        conn.execute(
            """UPDATE users SET password_hash = ?, initial_password_pending = 0
                WHERE id = ? AND company_id = ?""",
            (
                hash_password(payload.new_password),
                session["account_id"],
                session["company_id"],
            ),
        )
    return {"message": "Senha alterada com sucesso."}


@app.post("/api/auth/password-reset/request", status_code=202)
def request_password_reset(payload: PasswordResetRequest, request: Request):
    mail_settings = password_reset_mail_settings()
    account = None
    with connection() as conn:
        if payload.role == "company":
            company_handle = payload.identifier.removesuffix(".routine")
            if HANDLE_PATTERN.fullmatch(company_handle):
                row = conn.execute(
                    """SELECT id, fantasy_name AS name, email FROM companies
                        WHERE company_handle = ? AND lower(email) = ?""",
                    (company_handle, payload.email),
                ).fetchone()
                if row is not None:
                    account = {**dict(row), "company_id": row["id"], "user_id": None}
        elif payload.identifier.endswith(".routine"):
            account_identifier = payload.identifier[:-8]
            if "." in account_identifier:
                username, company_handle = account_identifier.rsplit(".", 1)
                if USERNAME_PATTERN.fullmatch(username) and HANDLE_PATTERN.fullmatch(company_handle):
                    row = conn.execute(
                        """SELECT u.id, u.company_id, u.name, u.email
                            FROM users u JOIN companies c ON c.id = u.company_id
                            WHERE u.username = ? AND c.company_handle = ?
                                AND lower(u.email) = ?""",
                        (username, company_handle, payload.email),
                    ).fetchone()
                    if row is not None:
                        account = {**dict(row), "user_id": row["id"]}

        if account is None:
            return {"message": "Se os dados corresponderem a uma conta, enviaremos um link para o e-mail cadastrado."}

        now = datetime.now(timezone.utc)
        now_text = now.isoformat(timespec="seconds")
        cooldown_text = (now - timedelta(seconds=60)).isoformat(timespec="seconds")
        if account["user_id"] is None:
            recent = conn.execute(
                """SELECT 1 FROM password_reset_tokens
                    WHERE company_id = ? AND user_id IS NULL AND created_at > ? LIMIT 1""",
                (account["company_id"], cooldown_text),
            ).fetchone()
        else:
            recent = conn.execute(
                """SELECT 1 FROM password_reset_tokens
                    WHERE user_id = ? AND created_at > ? LIMIT 1""",
                (account["user_id"], cooldown_text),
            ).fetchone()
        if recent is not None:
            return {"message": "Se os dados corresponderem a uma conta, enviaremos um link para o e-mail cadastrado."}

        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
        expires_at = (now + timedelta(seconds=PASSWORD_RESET_SECONDS)).isoformat(timespec="seconds")
        if account["user_id"] is None:
            conn.execute(
                "DELETE FROM password_reset_tokens WHERE company_id = ? AND user_id IS NULL",
                (account["company_id"],),
            )
        else:
            conn.execute(
                "DELETE FROM password_reset_tokens WHERE user_id = ?",
                (account["user_id"],),
            )
        conn.execute(
            """INSERT INTO password_reset_tokens
                (id, company_id, user_id, token_hash, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)""",
            (
                str(uuid.uuid4()),
                account["company_id"],
                account["user_id"],
                token_hash,
                now_text,
                expires_at,
            ),
        )

    public_url = os.environ.get("ROUTINER_PUBLIC_URL", "").strip().rstrip("/")
    if not public_url:
        public_url = str(request.base_url).rstrip("/")
    reset_url = f"{public_url}/?reset_token={quote(token)}"
    try:
        send_password_reset_email(account["email"], account["name"], reset_url, mail_settings)
    except (smtplib.SMTPException, OSError) as error:
        logger.exception("Falha ao enviar e-mail de redefinição de senha.")
        with connection() as conn:
            conn.execute(
                "DELETE FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL",
                (token_hash,),
            )
        raise HTTPException(
            status_code=502,
            detail="Não foi possível enviar o e-mail de recuperação. Tente novamente mais tarde.",
        ) from error
    return {"message": "Se os dados corresponderem a uma conta, enviaremos um link para o e-mail cadastrado."}


@app.post("/api/auth/password-reset/confirm")
def confirm_password_reset(payload: PasswordResetConfirm):
    token_hash = hashlib.sha256(payload.token.encode("ascii")).hexdigest()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with connection() as conn:
        token = conn.execute(
            """SELECT id, company_id, user_id FROM password_reset_tokens
                WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?""",
            (token_hash, now),
        ).fetchone()
        if token is None:
            raise HTTPException(status_code=400, detail="Este link expirou ou já foi utilizado. Solicite outro.")
        claimed = conn.execute(
            """UPDATE password_reset_tokens SET used_at = ?
                WHERE id = ? AND used_at IS NULL AND expires_at > ?""",
            (now, token["id"], now),
        )
        if claimed.rowcount != 1:
            raise HTTPException(status_code=400, detail="Este link expirou ou já foi utilizado. Solicite outro.")
        password_hash = hash_password(payload.password)
        if token["user_id"] is None:
            conn.execute(
                "UPDATE companies SET password_hash = ? WHERE id = ?",
                (password_hash, token["company_id"]),
            )
            conn.execute(
                """DELETE FROM password_reset_tokens
                    WHERE company_id = ? AND user_id IS NULL AND id != ?""",
                (token["company_id"], token["id"]),
            )
        else:
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ? AND company_id = ?",
                (password_hash, token["user_id"], token["company_id"]),
            )
            conn.execute(
                "DELETE FROM password_reset_tokens WHERE user_id = ? AND id != ?",
                (token["user_id"], token["id"]),
            )
    return {
        "message": "Senha redefinida. Entre com sua nova senha.",
        "role": "user" if token["user_id"] is not None else "company",
    }


@app.post("/api/auth/logout", status_code=204)
def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax")


@app.get("/api/users")
def list_users(session: dict = Depends(company_only)):
    with connection() as conn:
        company = company_row(conn, session["company_id"])
        rows = conn.execute(
            """SELECT id, name, sector, username, email, created_at
                FROM users WHERE company_id = ? ORDER BY name COLLATE NOCASE""",
            (session["company_id"],),
        ).fetchall()
    return [
        {
            **dict(row),
            "login": f'{row["username"]}.{company["company_handle"]}.routine',
        }
        for row in rows
    ]


@app.get("/api/sectors")
def list_sectors(session: dict = Depends(company_only)):
    with connection() as conn:
        rows = conn.execute(
            """SELECT s.id, s.name, COUNT(DISTINCT u.id) AS employee_count,
                    COUNT(DISTINCT l.id) AS location_count
                FROM sectors s
                LEFT JOIN users u ON u.company_id = s.company_id
                    AND lower(trim(u.sector)) = lower(trim(s.name))
                LEFT JOIN locations l ON l.company_id = s.company_id
                    AND l.responsible_user_id = u.id
                WHERE s.company_id = ?
                GROUP BY s.id
                ORDER BY s.name COLLATE NOCASE""",
            (session["company_id"],),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/sectors", status_code=201)
def create_sector(payload: SectorInput, session: dict = Depends(company_only)):
    sector_id = str(uuid.uuid4())
    try:
        with connection() as conn:
            conn.execute(
                "INSERT INTO sectors (id, company_id, name, created_at) VALUES (?, ?, ?, ?)",
                (
                    sector_id,
                    session["company_id"],
                    payload.name,
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                ),
            )
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="Este setor já existe nesta empresa.") from error
    return {"id": sector_id, "name": payload.name, "employee_count": 0, "location_count": 0}


@app.delete("/api/sectors/{sector_id}", status_code=204)
def delete_sector(sector_id: str, session: dict = Depends(company_only)):
    with connection() as conn:
        sector = conn.execute(
            "SELECT name FROM sectors WHERE id = ? AND company_id = ?",
            (sector_id, session["company_id"]),
        ).fetchone()
        if sector is None:
            raise HTTPException(status_code=404, detail="Setor não encontrado.")
        usage = conn.execute(
            """SELECT
                    EXISTS(SELECT 1 FROM users WHERE company_id = ?
                        AND lower(trim(sector)) = lower(trim(?))) AS has_users,
                    EXISTS(SELECT 1 FROM locations l JOIN users u ON u.id = l.responsible_user_id
                        WHERE l.company_id = ? AND lower(trim(u.sector)) = lower(trim(?))) AS has_locations""",
            (session["company_id"], sector["name"], session["company_id"], sector["name"]),
        ).fetchone()
        if usage["has_users"] or usage["has_locations"]:
            raise HTTPException(
                status_code=409,
                detail="Transfira ou remova os funcionários e locais deste setor antes de excluí-lo.",
            )
        conn.execute(
            "DELETE FROM sectors WHERE id = ? AND company_id = ?",
            (sector_id, session["company_id"]),
        )


def require_company_sector(conn: sqlite3.Connection, company_id: str, sector_name: str):
    sector = conn.execute(
        """SELECT name FROM sectors
            WHERE company_id = ? AND lower(trim(name)) = lower(trim(?))""",
        (company_id, sector_name),
    ).fetchone()
    if sector is None:
        raise HTTPException(status_code=422, detail="Selecione um setor cadastrado para esta empresa.")
    return sector["name"]


@app.post("/api/users", status_code=201)
def create_user(payload: UserInput, session: dict = Depends(company_only)):
    user_id = str(uuid.uuid4())
    with connection() as conn:
        company = company_row(conn, session["company_id"])
        sector_name = require_company_sector(conn, session["company_id"], payload.sector)
        try:
            conn.execute(
                """INSERT INTO users
                    (id, company_id, name, sector, username, email, password_hash,
                        initial_password_pending, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)""",
                (
                    user_id,
                    session["company_id"],
                    payload.name,
                    sector_name,
                    payload.username,
                    payload.email,
                    hash_password(payload.password),
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                ),
            )
        except sqlite3.IntegrityError as error:
            if "email" in str(error).lower():
                raise HTTPException(status_code=409, detail="Este e-mail já está cadastrado nesta empresa.") from error
            raise HTTPException(status_code=409, detail="Este identificador já está cadastrado nesta empresa.") from error
    return {
        "id": user_id,
        "name": payload.name,
        "sector": sector_name,
        "username": payload.username,
        "email": payload.email,
        "login": f'{payload.username}.{company["company_handle"]}.routine',
    }


@app.put("/api/users/{user_id}")
def update_user(user_id: str, payload: UserUpdateInput, session: dict = Depends(company_only)):
    with connection() as conn:
        sector_name = require_company_sector(conn, session["company_id"], payload.sector)
        cursor = conn.execute(
            """UPDATE users SET name = ?, sector = ?, email = ?
                WHERE id = ? AND company_id = ?""",
            (payload.name, sector_name, payload.email, user_id, session["company_id"]),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Funcionário não encontrado.")
        row = conn.execute(
            """SELECT u.id, u.name, u.sector, u.username, u.email,
                    c.company_handle
                FROM users u JOIN companies c ON c.id = u.company_id
                WHERE u.id = ? AND u.company_id = ?""",
            (user_id, session["company_id"]),
        ).fetchone()
    return {
        "id": row["id"],
        "name": row["name"],
        "sector": row["sector"],
        "username": row["username"],
        "email": row["email"],
        "login": f'{row["username"]}.{row["company_handle"]}.routine',
    }


@app.get("/api/tasks")
def list_tasks(session: dict = Depends(current_session)):
    process_due_tasks()
    clauses = ["t.company_id = ?"]
    params: list[str] = [session["company_id"]]
    if session["role"] == "user":
        clauses.append(
            """lower(trim(u.sector)) = lower(trim((
                SELECT active_user.sector FROM users active_user
                WHERE active_user.id = ? AND active_user.company_id = ?
            )))"""
        )
        params.extend([session["account_id"], session["company_id"]])
    with connection() as conn:
        rows = conn.execute(
            f"""SELECT t.*, u.name AS assignee_name, u.sector AS assignee_sector,
                    executor.name AS completed_by_name
                FROM tasks t
                JOIN users u ON u.id = t.assigned_user_id
                LEFT JOIN users executor ON executor.id = t.completed_by_user_id
                WHERE {' AND '.join(clauses)}
                    AND t.deleted_at IS NULL
                ORDER BY CASE WHEN t.completed_at IS NULL AND t.missed_at IS NULL THEN 0 ELSE 1 END,
                    t.deadline ASC""",
            params,
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/tasks/deleted")
def list_deleted_tasks(session: dict = Depends(company_only)):
    with connection() as conn:
        rows = conn.execute(
            """SELECT t.id, t.title, t.description, t.deadline, t.deleted_at,
                    t.deletion_reason, u.name AS assignee_name,
                    u.sector AS assignee_sector, deleter.name AS deleted_by_name
                FROM tasks t
                JOIN users u ON u.id = t.assigned_user_id
                LEFT JOIN users deleter ON deleter.id = t.deleted_by_user_id
                WHERE t.company_id = ? AND t.deleted_at IS NOT NULL
                ORDER BY t.deleted_at DESC""",
            (session["company_id"],),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/tasks", status_code=201)
def create_task(payload: TaskInput, session: dict = Depends(company_only)):
    task_id = str(uuid.uuid4())
    with connection() as conn:
        assignee = conn.execute(
            "SELECT id, name FROM users WHERE id = ? AND company_id = ?",
            (payload.assigned_user_id, session["company_id"]),
        ).fetchone()
        if assignee is None:
            raise HTTPException(status_code=404, detail="Funcionário não encontrado nesta empresa.")
        conn.execute(
            """INSERT INTO tasks
                (id, company_id, assigned_user_id, title, description, deadline, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                task_id,
                session["company_id"],
                payload.assigned_user_id,
                payload.title,
                payload.description,
                payload.deadline.isoformat(timespec="seconds"),
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
            ),
        )
        row = conn.execute(
            """SELECT t.*, u.name AS assignee_name, u.sector AS assignee_sector,
                    NULL AS completed_by_name
                FROM tasks t JOIN users u ON u.id = t.assigned_user_id
                WHERE t.id = ?""",
            (task_id,),
        ).fetchone()
    return dict(row)


@app.put("/api/tasks/{task_id}")
def update_task(
    task_id: str,
    payload: TaskUpdateInput,
    session: dict = Depends(company_only),
):
    process_due_tasks()
    with connection() as conn:
        assignee = conn.execute(
            "SELECT id FROM users WHERE id = ? AND company_id = ?",
            (payload.assigned_user_id, session["company_id"]),
        ).fetchone()
        if assignee is None:
            raise HTTPException(status_code=404, detail="Funcionário não encontrado nesta empresa.")
        existing = conn.execute(
            """SELECT assigned_user_id, deadline, completed_at, missed_at, deleted_at
                FROM tasks WHERE id = ? AND company_id = ?""",
            (task_id, session["company_id"]),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Demanda não encontrada.")
        if existing["completed_at"] is not None:
            raise HTTPException(status_code=409, detail="Demandas concluídas não podem ser editadas.")
        if existing["missed_at"] is not None:
            raise HTTPException(status_code=409, detail="Tarefas vencidas não podem ser editadas.")
        if existing["deleted_at"] is not None:
            raise HTTPException(status_code=409, detail="Tarefas excluídas não podem ser editadas.")
        deadline = payload.deadline.isoformat(timespec="seconds")
        changed = any(
            (
                existing["assigned_user_id"] != payload.assigned_user_id,
                existing["deadline"] != deadline,
            )
        )
        cursor = conn.execute(
            """UPDATE tasks SET assigned_user_id = ?,
                    deadline = ?, acknowledged_at = CASE WHEN ? THEN NULL ELSE acknowledged_at END
                WHERE id = ? AND company_id = ? AND deleted_at IS NULL
                    AND completed_at IS NULL AND missed_at IS NULL""",
            (
                payload.assigned_user_id,
                deadline,
                changed,
                task_id,
                session["company_id"],
            ),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=409, detail="Esta tarefa não pode mais ser editada.")
        row = conn.execute(
            """SELECT t.*, u.name AS assignee_name, u.sector AS assignee_sector,
                    executor.name AS completed_by_name
                FROM tasks t JOIN users u ON u.id = t.assigned_user_id
                LEFT JOIN users executor ON executor.id = t.completed_by_user_id
                WHERE t.id = ? AND t.company_id = ?""",
            (task_id, session["company_id"]),
        ).fetchone()
    return dict(row)


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(
    task_id: str,
    payload: TaskDeletionInput,
    session: dict = Depends(company_only),
):
    process_due_tasks()
    deleted_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with connection() as conn:
        task = conn.execute(
            """SELECT completed_at, missed_at, deleted_at FROM tasks
                WHERE id = ? AND company_id = ?""",
            (task_id, session["company_id"]),
        ).fetchone()
        if task is None:
            raise HTTPException(status_code=404, detail="Tarefa não encontrada.")
        if task["deleted_at"] is not None:
            raise HTTPException(status_code=409, detail="Esta tarefa já foi excluída.")
        if task["completed_at"] is not None:
            raise HTTPException(status_code=409, detail="Tarefas concluídas não podem ser excluídas.")
        if task["missed_at"] is not None:
            raise HTTPException(status_code=409, detail="Tarefas vencidas no histórico não podem ser excluídas.")
        cursor = conn.execute(
            """UPDATE tasks SET deleted_at = ?, deletion_reason = ?, deleted_by_user_id = ?
                WHERE id = ? AND company_id = ? AND deleted_at IS NULL
                    AND completed_at IS NULL AND missed_at IS NULL""",
            (deleted_at, payload.reason, session["account_id"], task_id, session["company_id"]),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=409, detail="Esta tarefa não pode mais ser excluída.")


@app.post("/api/tasks/{task_id}/acknowledge")
def acknowledge_task(task_id: str, session: dict = Depends(current_session)):
    if session["role"] != "user":
        raise HTTPException(status_code=403, detail="Somente funcionários podem dar ciência.")
    process_due_tasks()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with connection() as conn:
        task = conn.execute(
            """SELECT t.acknowledged_at, t.completed_at, t.missed_at, assigned.sector AS assignee_sector,
                    active_user.sector AS current_sector
                FROM tasks t
                JOIN users assigned ON assigned.id = t.assigned_user_id
                JOIN users active_user ON active_user.id = ?
                WHERE t.id = ? AND t.company_id = ? AND t.deleted_at IS NULL
                    AND assigned.company_id = ? AND active_user.company_id = ?""",
            (
                session["account_id"],
                task_id,
                session["company_id"],
                session["company_id"],
                session["company_id"],
            ),
        ).fetchone()
        if task is None or task["assignee_sector"].strip().casefold() != task["current_sector"].strip().casefold():
            raise HTTPException(status_code=404, detail="Tarefa não encontrada nesta conta.")
        if task["completed_at"] is not None:
            raise HTTPException(status_code=409, detail="Esta tarefa já foi concluída.")
        if task["missed_at"] is not None:
            raise HTTPException(status_code=409, detail="O prazo desta tarefa venceu; ela está no histórico.")
        if task["acknowledged_at"] is not None:
            return {"id": task_id, "acknowledged_at": task["acknowledged_at"]}
        cursor = conn.execute(
            """UPDATE tasks SET acknowledged_at = ?
                WHERE id = ? AND company_id = ?
                    AND acknowledged_at IS NULL AND completed_at IS NULL
                    AND missed_at IS NULL AND deleted_at IS NULL AND deadline > ?""",
            (now, task_id, session["company_id"], now),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=409, detail="Esta tarefa foi atualizada por outra pessoa.")
        conn.execute(
            """INSERT INTO company_notifications
                (id, company_id, task_id, actor_user_id, event_type, created_at)
                VALUES (?, ?, ?, ?, 'acknowledged', ?)""",
            (str(uuid.uuid4()), session["company_id"], task_id, session["account_id"], now),
        )
    return {"id": task_id, "acknowledged_at": now}


@app.post("/api/tasks/{task_id}/missed-acknowledge")
def acknowledge_missed_task(
    task_id: str,
    payload: MissedTaskAcknowledgmentInput,
    session: dict = Depends(current_session),
):
    if session["role"] != "user":
        raise HTTPException(status_code=403, detail="Somente o funcionário responsável pode confirmar uma tarefa vencida.")
    process_due_tasks()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with connection() as conn:
        task = conn.execute(
            """SELECT missed_at, completed_at, missed_notes, missed_acknowledged_at
                FROM tasks
                WHERE id = ? AND company_id = ? AND assigned_user_id = ?
                    AND deleted_at IS NULL""",
            (task_id, session["company_id"], session["account_id"]),
        ).fetchone()
        if task is None:
            raise HTTPException(status_code=404, detail="Tarefa vencida não encontrada nesta conta.")
        if task["missed_at"] is None or task["completed_at"] is not None:
            raise HTTPException(status_code=409, detail="Esta tarefa ainda não venceu.")
        if task["missed_acknowledged_at"] is not None:
            return {
                "id": task_id,
                "missed_acknowledged_at": task["missed_acknowledged_at"],
                "missed_notes": task["missed_notes"],
            }
        cursor = conn.execute(
            """UPDATE tasks SET missed_notes = ?, missed_acknowledged_at = ?
                WHERE id = ? AND company_id = ? AND assigned_user_id = ?
                    AND missed_at IS NOT NULL AND completed_at IS NULL
                    AND deleted_at IS NULL AND missed_acknowledged_at IS NULL""",
            (
                payload.notes,
                now,
                task_id,
                session["company_id"],
                session["account_id"],
            ),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=409, detail="A confirmação desta tarefa foi atualizada em outro dispositivo.")
    return {"id": task_id, "missed_acknowledged_at": now, "missed_notes": payload.notes}


@app.post("/api/tasks/{task_id}/complete")
def complete_task(
    task_id: str,
    payload: TaskCompletionInput,
    session: dict = Depends(current_session),
):
    if session["role"] != "user":
        raise HTTPException(status_code=403, detail="Somente um funcionário do setor responsável pode concluir a tarefa.")
    process_due_tasks()
    photo_filenames = []
    for photo in (payload.photo_before, payload.photo_after):
        match = re.fullmatch(r"/uploads/([a-f0-9]{32}\.(?:jpg|png|webp))", photo)
        if match is None:
            raise HTTPException(status_code=422, detail="As duas fotos devem ser capturadas e enviadas pelo aplicativo.")
        photo_filenames.append(match.group(1))
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with connection() as conn:
        task = conn.execute(
            """SELECT t.assigned_user_id, t.acknowledged_at, t.completed_at, t.missed_at, t.deadline,
                    assigned.sector AS assignee_sector,
                    active_user.sector AS current_sector
                FROM tasks t
                JOIN users assigned ON assigned.id = t.assigned_user_id
                JOIN users active_user ON active_user.id = ?
                WHERE t.id = ? AND t.company_id = ? AND t.deleted_at IS NULL
                    AND assigned.company_id = ? AND active_user.company_id = ?""",
            (
                session["account_id"],
                task_id,
                session["company_id"],
                session["company_id"],
                session["company_id"],
            ),
        ).fetchone()
        if task is None or task["assignee_sector"].strip().casefold() != task["current_sector"].strip().casefold():
            raise HTTPException(status_code=404, detail="Tarefa não encontrada nesta conta.")
        if task["completed_at"] is not None:
            raise HTTPException(status_code=409, detail="Esta tarefa já foi concluída.")
        if task["missed_at"] is not None or task["deadline"] <= now:
            raise HTTPException(status_code=409, detail="O prazo desta tarefa venceu; ela está no histórico.")
        if task["acknowledged_at"] is None:
            raise HTTPException(status_code=409, detail="Dê ciência da tarefa antes de concluí-la.")
        if task["assigned_user_id"] != session["account_id"] and not payload.notes:
            raise HTTPException(
                status_code=422,
                detail="Informe o motivo de outro funcionário executar esta tarefa.",
            )
        for filename in photo_filenames:
            upload = conn.execute(
                """SELECT 1 FROM uploads
                    WHERE filename = ? AND company_id = ? AND owner_user_id = ?""",
                (filename, session["company_id"], session["account_id"]),
            ).fetchone()
            if upload is None:
                raise HTTPException(status_code=403, detail="Uma das fotos não pertence a esta conta.")
        cursor = conn.execute(
            """UPDATE tasks SET completed_at = ?, completion_notes = ?,
                    photo_before = ?, photo_after = ?, completed_by_user_id = ?
                WHERE id = ? AND company_id = ?
                    AND acknowledged_at IS NOT NULL AND completed_at IS NULL
                    AND missed_at IS NULL AND deleted_at IS NULL AND deadline > ?""",
            (
                now,
                payload.notes,
                payload.photo_before,
                payload.photo_after,
                session["account_id"],
                task_id,
                session["company_id"],
                now,
            ),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=409, detail="Esta tarefa foi concluída por outra pessoa.")
        conn.execute(
            """INSERT INTO company_notifications
                (id, company_id, task_id, actor_user_id, event_type, created_at)
                VALUES (?, ?, ?, ?, 'completed', ?)""",
            (str(uuid.uuid4()), session["company_id"], task_id, session["account_id"], now),
        )
    return {"id": task_id, "completed_at": now}


@app.get("/api/notifications")
def list_company_notifications(session: dict = Depends(company_only)):
    with connection() as conn:
        rows = conn.execute(
            """SELECT n.id, n.task_id, n.event_type, n.created_at, n.read_at,
                    t.title AS task_title, t.deadline,
                    assigned.name AS assignee_name,
                    u.name AS actor_name, u.sector AS actor_sector
                FROM company_notifications n
                JOIN tasks t ON t.id = n.task_id
                JOIN users assigned ON assigned.id = t.assigned_user_id
                LEFT JOIN users u ON u.id = n.actor_user_id
                WHERE n.company_id = ?
                ORDER BY n.created_at DESC, n.id DESC LIMIT 100""",
            (session["company_id"],),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/notifications/{notification_id}/read")
def mark_notification_read(notification_id: str, session: dict = Depends(company_only)):
    with connection() as conn:
        cursor = conn.execute(
            """UPDATE company_notifications SET read_at = ?
                WHERE id = ? AND company_id = ? AND read_at IS NULL""",
            (datetime.now(timezone.utc).isoformat(timespec="seconds"), notification_id, session["company_id"]),
        )
        if cursor.rowcount == 0:
            exists = conn.execute(
                "SELECT 1 FROM company_notifications WHERE id = ? AND company_id = ?",
                (notification_id, session["company_id"]),
            ).fetchone()
            if exists is None:
                raise HTTPException(status_code=404, detail="Notificação não encontrada.")
    return {"id": notification_id, "read": True}


@app.post("/api/upload")
async def upload_image(
    file: UploadFile = File(...),
    session: dict = Depends(current_session),
):
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
    with connection() as conn:
        conn.execute(
            "INSERT INTO uploads (filename, company_id, owner_user_id, created_at) VALUES (?, ?, ?, ?)",
            (
                filename,
                session["company_id"],
                session["account_id"] if session["role"] == "user" else None,
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
            ),
        )
    return {"url": f"/uploads/{filename}"}


@app.get("/uploads/{filename}")
def get_upload(filename: str, session: dict = Depends(current_session)):
    if not re.fullmatch(r"[a-f0-9]{32}\.(?:jpg|png|webp)", filename):
        raise HTTPException(status_code=404, detail="Imagem não encontrada.")
    with connection() as conn:
        upload = conn.execute(
            "SELECT company_id, owner_user_id FROM uploads WHERE filename = ?", (filename,)
        ).fetchone()
        if upload is None or upload["company_id"] != session["company_id"]:
            raise HTTPException(status_code=404, detail="Imagem não encontrada.")
        if session["role"] == "user":
            shared_location_photo = conn.execute(
                """SELECT 1 FROM locations l
                    WHERE l.company_id = ? AND l.photo = ?
                        AND l.responsible_user_id IN (
                            SELECT sector_user.id FROM users sector_user
                            WHERE sector_user.company_id = ?
                                AND lower(trim(sector_user.sector)) = lower(trim((
                                    SELECT own_user.sector FROM users own_user
                                    WHERE own_user.id = ? AND own_user.company_id = ?
                                )))
                        )
                    UNION ALL
                    SELECT 1 FROM cleanings c
                    JOIN locations l ON l.id = c.location_id
                    WHERE l.company_id = ?
                        AND (c.photo_before = ? OR c.photo_after = ?)
                        AND l.responsible_user_id IN (
                            SELECT sector_user.id FROM users sector_user
                            WHERE sector_user.company_id = ?
                                AND lower(trim(sector_user.sector)) = lower(trim((
                                    SELECT own_user.sector FROM users own_user
                                    WHERE own_user.id = ? AND own_user.company_id = ?
                                )))
                        )
                    UNION ALL
                    SELECT 1 FROM tasks t
                    JOIN users assigned ON assigned.id = t.assigned_user_id
                    WHERE t.company_id = ? AND (t.photo_before = ? OR t.photo_after = ?)
                        AND lower(trim(assigned.sector)) = lower(trim((
                            SELECT own_user.sector FROM users own_user
                            WHERE own_user.id = ? AND own_user.company_id = ?
                        )))
                    UNION ALL
                    SELECT 1 FROM uploads uploaded
                    WHERE uploaded.filename = ? AND uploaded.owner_user_id = ?
                        AND NOT EXISTS (
                            SELECT 1 FROM locations WHERE photo = ?
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM cleanings
                            WHERE photo_before = ? OR photo_after = ?
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM tasks
                            WHERE photo_before = ? OR photo_after = ?
                        )
                    LIMIT 1""",
                (
                    session["company_id"],
                    f"/uploads/{filename}",
                    session["company_id"],
                    session["account_id"],
                    session["company_id"],
                    session["company_id"],
                    f"/uploads/{filename}",
                    f"/uploads/{filename}",
                    session["company_id"],
                    session["account_id"],
                    session["company_id"],
                    session["company_id"],
                    f"/uploads/{filename}",
                    f"/uploads/{filename}",
                    session["account_id"],
                    session["company_id"],
                    filename,
                    session["account_id"],
                    f"/uploads/{filename}",
                    f"/uploads/{filename}",
                    f"/uploads/{filename}",
                    f"/uploads/{filename}",
                    f"/uploads/{filename}",
                ),
            ).fetchone()
            if shared_location_photo is None:
                raise HTTPException(status_code=404, detail="Imagem não encontrada.")
        path = UPLOAD_DIR / filename
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Imagem não encontrada.")
    return FileResponse(path)


@app.get("/api/locations")
def list_locations(
    search: str = "",
    frequency: str = "",
    responsible: str = "",
    photo: str = "",
    session: dict = Depends(current_session),
):
    clauses = ["l.company_id = ?"]
    params: list[str] = [session["company_id"]]
    if session["role"] == "user":
        sector_filter, sector_params = employee_location_filter(session)
        clauses.append(sector_filter)
        params.extend(sector_params)
    if search.strip():
        clauses.append("(l.name LIKE ? OR l.responsible LIKE ?)")
        params.extend([f"%{search.strip()}%", f"%{search.strip()}%"])
    if frequency:
        clauses.append("l.frequency = ?")
        params.append(frequency)
    if responsible:
        clauses.append("l.responsible = ?")
        params.append(responsible)
    if photo == "with":
        clauses.append("l.photo IS NOT NULL AND l.photo != ''")
    elif photo == "without":
        clauses.append("(l.photo IS NULL OR l.photo = '')")
    elif photo:
        raise HTTPException(status_code=422, detail="Filtro de foto inválido.")
    with connection() as conn:
        rows = conn.execute(
            f"""
            SELECT l.*, owner.sector AS responsible_sector,
                schedule.id AS schedule_id, schedule.weekdays AS schedule_days,
                schedule.due_time AS schedule_time, schedule.month_week,
                schedule.alternate_weeks, schedule.anchor_date,
                (SELECT COUNT(*) FROM cleanings c WHERE c.location_id = l.id) AS cleaning_count,
                (SELECT c.cleaning_date FROM cleanings c WHERE c.location_id = l.id
                    ORDER BY c.cleaning_date DESC, c.created_at DESC LIMIT 1) AS last_cleaned,
                (SELECT c.status FROM cleanings c WHERE c.location_id = l.id
                    ORDER BY c.cleaning_date DESC, c.created_at DESC LIMIT 1) AS last_status
            FROM locations l
            LEFT JOIN users owner ON owner.id = l.responsible_user_id
            LEFT JOIN task_schedules schedule ON schedule.location_id = l.id
            WHERE {' AND '.join(clauses)}
            ORDER BY l.name COLLATE NOCASE
            """,
            params,
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/locations", status_code=201)
def create_location(payload: LocationInput, session: dict = Depends(company_only)):
    validate_frequency(payload.frequency)
    location_id = str(uuid.uuid4())
    with connection() as conn:
        responsible = responsible_user_for_location(
            conn,
            session["company_id"],
            payload.responsible,
            payload.responsible_user_id,
            payload.sector,
        )
        conn.execute(
            """INSERT INTO locations
                (id, company_id, name, cleaning_type, photo, responsible,
                    responsible_user_id, frequency, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                location_id,
                session["company_id"],
                payload.name,
                payload.cleaning_type,
                payload.photo,
                responsible["name"],
                responsible["id"],
                payload.frequency,
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
            ),
        )
        save_location_schedule(
            conn,
            location_id,
            session["company_id"],
            responsible["id"],
            payload.name,
            payload.schedule_days,
            payload.schedule_time,
            payload.frequency,
            payload.month_week,
            payload.alternate_weeks,
        )
        return fetch_location(conn, location_id, session["company_id"])


@app.get("/api/locations/{location_id}")
def get_location(location_id: str, session: dict = Depends(current_session)):
    with connection() as conn:
        return require_location_access(conn, location_id, session)


@app.put("/api/locations/{location_id}")
def update_location(
    location_id: str,
    payload: LocationInput,
    session: dict = Depends(company_only),
):
    validate_frequency(payload.frequency)
    with connection() as conn:
        fetch_location(conn, location_id, session["company_id"])
        responsible = responsible_user_for_location(
            conn,
            session["company_id"],
            payload.responsible,
            payload.responsible_user_id,
            payload.sector,
        )
        conn.execute(
            """UPDATE locations SET name = ?, cleaning_type = ?, photo = ?, responsible = ?,
                    responsible_user_id = ?, frequency = ?
                WHERE id = ? AND company_id = ?""",
            (
                payload.name,
                payload.cleaning_type,
                payload.photo,
                responsible["name"],
                responsible["id"],
                payload.frequency,
                location_id,
                session["company_id"],
            ),
        )
        save_location_schedule(
            conn,
            location_id,
            session["company_id"],
            responsible["id"],
            payload.name,
            payload.schedule_days,
            payload.schedule_time,
            payload.frequency,
            payload.month_week,
            payload.alternate_weeks,
        )
        return fetch_location(conn, location_id, session["company_id"])


@app.delete("/api/locations/{location_id}", status_code=204)
def delete_location(location_id: str, session: dict = Depends(company_only)):
    with connection() as conn:
        fetch_location(conn, location_id, session["company_id"])
        conn.execute(
            "DELETE FROM locations WHERE id = ? AND company_id = ?",
            (location_id, session["company_id"]),
        )


@app.get("/api/history")
def list_history(
    location_id: str = "",
    status: str = "",
    search: str = "",
    date_from: str = Query(default="", alias="from"),
    date_to: str = Query(default="", alias="to"),
    session: dict = Depends(current_session),
):
    process_due_tasks()
    clauses = ["l.company_id = ?"]
    params: list[str] = [session["company_id"]]
    if session["role"] == "user":
        sector_filter, sector_params = employee_location_filter(session)
        clauses.append(sector_filter)
        params.extend(sector_params)
    if location_id:
        clauses.append("c.location_id = ?")
        params.append(location_id)
    if status:
        if status not in STATUSES | {"Concluída", "Não feito"}:
            raise HTTPException(status_code=422, detail="Filtro de status inválido.")
        if status in STATUSES:
            clauses.append("c.status = ?")
            params.append(status)
        elif status == "Concluída":
            clauses.append("c.status = 'Limpo'")
        else:
            clauses.append("0 = 1")
    if search.strip():
        clauses.append("(l.name LIKE ? OR l.responsible LIKE ? OR c.notes LIKE ? OR u.name LIKE ?)")
        params.extend([f"%{search.strip()}%"] * 4)
    if date_from:
        clauses.append("c.cleaning_date >= ?")
        params.append(date_from)
    if date_to:
        clauses.append("c.cleaning_date <= ?")
        params.append(date_to)
    with connection() as conn:
        rows = conn.execute(
            f"""
            SELECT c.*, l.name AS location_name, l.responsible,
                l.cleaning_type AS cleaning_type,
                owner.sector AS responsible_sector,
                COALESCE(u.name, co.fantasy_name) AS created_by_name,
                u.name AS executor_name,
                c.created_at AS event_at,
                'cleaning' AS record_type
            FROM cleanings c
            JOIN locations l ON l.id = c.location_id
            JOIN companies co ON co.id = l.company_id
            LEFT JOIN users owner ON owner.id = l.responsible_user_id
            LEFT JOIN users u ON u.id = c.created_by_user_id
            WHERE {' AND '.join(clauses)}
            ORDER BY c.cleaning_date DESC, c.created_at DESC
            """,
            params,
        ).fetchall()
        task_clauses = [
            "t.company_id = ?",
            "(t.completed_at IS NOT NULL OR t.missed_at IS NOT NULL)",
            "t.deleted_at IS NULL",
        ]
        task_params: list[str] = [session["company_id"]]
        if session["role"] == "user":
            task_clauses.append(
                """lower(trim(assigned.sector)) = lower(trim((
                    SELECT active_user.sector FROM users active_user
                    WHERE active_user.id = ? AND active_user.company_id = ?
                )))"""
            )
            task_params.extend([session["account_id"], session["company_id"]])
        if status == "Concluída":
            task_clauses.append("t.completed_at IS NOT NULL")
        elif status == "Não feito":
            task_clauses.append("t.missed_at IS NOT NULL")
        elif status in STATUSES:
            task_clauses.append("0 = 1")
        if search.strip():
            task_clauses.append(
                """(t.title LIKE ? OR t.description LIKE ? OR assigned.name LIKE ?
                    OR executor.name LIKE ? OR assigned.sector LIKE ?)"""
            )
            task_params.extend([f"%{search.strip()}%"] * 5)
        if date_from:
            task_clauses.append("substr(COALESCE(t.completed_at, t.missed_at), 1, 10) >= ?")
            task_params.append(date_from)
        if date_to:
            task_clauses.append("substr(COALESCE(t.completed_at, t.missed_at), 1, 10) <= ?")
            task_params.append(date_to)
        task_rows = conn.execute(
            f"""SELECT 'task-' || t.id AS id, t.id AS task_id,
                    COALESCE(schedule.location_id, '') AS location_id, 'task' AS record_type,
                    substr(COALESCE(t.completed_at, t.missed_at), 1, 10) AS cleaning_date,
                    t.completed_at AS completed_at,
                    t.missed_at AS missed_at,
                    CASE WHEN t.missed_at IS NOT NULL THEN 'Não feito' ELSE 'Concluída' END AS status,
                    t.photo_before, t.photo_after,
                    CASE WHEN t.missed_at IS NOT NULL THEN t.missed_notes
                        ELSE t.completion_notes END AS notes,
                    t.missed_acknowledged_at AS missed_acknowledged_at,
                    COALESCE(t.completed_at, t.missed_at) AS created_at,
                    COALESCE(t.completed_at, t.missed_at) AS event_at,
                    t.title AS location_name, t.deadline AS deadline,
                    COALESCE(cleaning_location.cleaning_type, '') AS cleaning_type,
                    assigned.name AS responsible, assigned.sector AS assignee_sector,
                    assigned.sector AS responsible_sector,
                    executor.name AS executor_name,
                    executor.name AS created_by_name
                FROM tasks t
                JOIN users assigned ON assigned.id = t.assigned_user_id
                LEFT JOIN task_schedules schedule ON schedule.id = t.schedule_id
                LEFT JOIN locations cleaning_location ON cleaning_location.id = schedule.location_id
                LEFT JOIN users executor ON executor.id = t.completed_by_user_id
                WHERE {' AND '.join(task_clauses)}
                ORDER BY COALESCE(t.completed_at, t.missed_at) DESC""",
            task_params,
        ).fetchall()
    return sorted(
        [dict(row) for row in (*rows, *task_rows)],
        key=lambda row: (row["event_at"] or "", row["created_at"] or ""),
        reverse=True,
    )


@app.delete("/api/tasks/{task_id}/missed", status_code=204)
def delete_missed_task(
    task_id: str,
    session: dict = Depends(company_only),
):
    with connection() as conn:
        task = conn.execute(
            "SELECT missed_at, completed_at FROM tasks WHERE id = ? AND company_id = ?",
            (task_id, session["company_id"]),
        ).fetchone()
        if task is None:
            raise HTTPException(status_code=404, detail="Tarefa vencida não encontrada.")
        if task["missed_at"] is None or task["completed_at"] is not None:
            raise HTTPException(status_code=409, detail="Esta tarefa não é um registro vencido.")
    raise HTTPException(
        status_code=409,
        detail="Tarefas vencidas no histórico não podem ser excluídas.",
    )


@app.post("/api/history", status_code=201)
def create_cleaning(payload: CleaningInput, session: dict = Depends(current_session)):
    status = "Limpo" if payload.photo_before and payload.photo_after else "Não limpo"
    cleaning_id = str(uuid.uuid4())
    with connection() as conn:
        require_location_access(conn, payload.location_id, session)
        conn.execute(
            """INSERT INTO cleanings
                (id, location_id, cleaning_date, status, photo_before, photo_after, notes,
                    created_by_user_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                cleaning_id,
                payload.location_id,
                payload.cleaning_date.isoformat(),
                status,
                payload.photo_before,
                payload.photo_after,
                payload.notes,
                session["account_id"] if session["role"] == "user" else None,
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
            ),
        )
        row = conn.execute(
            """SELECT c.*, l.name AS location_name, l.responsible,
                    COALESCE(u.name, co.fantasy_name) AS created_by_name,
                    u.name AS executor_name
                FROM cleanings c
                JOIN locations l ON l.id = c.location_id
                JOIN companies co ON co.id = l.company_id
                LEFT JOIN users u ON u.id = c.created_by_user_id
                WHERE c.id = ? AND l.company_id = ?""",
            (cleaning_id, session["company_id"]),
        ).fetchone()
        return dict(row)


@app.delete("/api/history/{cleaning_id}", status_code=204)
def delete_cleaning(cleaning_id: str, session: dict = Depends(current_session)):
    with connection() as conn:
        clauses = ["location_id IN (SELECT id FROM locations WHERE company_id = ?)"]
        params: list[str] = [session["company_id"]]
        if session["role"] == "user":
            sector_filter, sector_params = employee_location_filter(session, "scoped_location")
            clauses.append(
                """location_id IN (
                    SELECT scoped_location.id FROM locations scoped_location
                    WHERE """
                + sector_filter
                + ")"
            )
            params.extend(sector_params)
            clauses.append("created_by_user_id = ?")
            params.append(session["account_id"])
        cursor = conn.execute(
            f"DELETE FROM cleanings WHERE id = ? AND {' AND '.join(clauses)}",
            [cleaning_id, *params],
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Registro não encontrado ou sem permissão.")


@app.get("/api/dashboard")
def dashboard(session: dict = Depends(current_session)):
    today = date.today().isoformat()
    location_scope = ""
    location_scope_params: list[str] = []
    if session["role"] == "user":
        sector_filter, location_scope_params = employee_location_filter(session)
        location_scope = f" AND {sector_filter}"
    with connection() as conn:
        location_count = conn.execute(
            f"""SELECT COUNT(*) FROM locations l
                WHERE l.company_id = ?{location_scope}""",
            [session["company_id"], *location_scope_params],
        ).fetchone()[0]
        totals = conn.execute(
            f"""SELECT
                COUNT(*) AS total_cleanings,
                COALESCE(SUM(CASE WHEN c.cleaning_date = ? AND c.status = 'Limpo' THEN 1 ELSE 0 END), 0) AS completed_today,
                COALESCE(SUM(CASE WHEN c.cleaning_date = ? AND c.status = 'Não limpo' THEN 1 ELSE 0 END), 0) AS attention_today
                FROM cleanings c JOIN locations l ON l.id = c.location_id
                WHERE l.company_id = ?{location_scope}""",
            [today, today, session["company_id"], *location_scope_params],
        ).fetchone()
        latest = conn.execute(
            f"""SELECT c.id, c.cleaning_date, c.status, c.notes,
                    l.name AS location_name, l.responsible,
                    COALESCE(u.name, co.fantasy_name) AS created_by_name
                FROM cleanings c
                JOIN locations l ON l.id = c.location_id
                JOIN companies co ON co.id = l.company_id
                LEFT JOIN users u ON u.id = c.created_by_user_id
                WHERE l.company_id = ?{location_scope}
                ORDER BY c.cleaning_date DESC, c.created_at DESC LIMIT 6""",
            [session["company_id"], *location_scope_params],
        ).fetchall()
    return {
        "locations": location_count,
        **dict(totals),
        "recent": [dict(row) for row in latest],
    }


if STATIC_DIR:
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="frontend")
