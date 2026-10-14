from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import Cookie, Depends, FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("CLEANING_DB_PATH", BASE_DIR / "cleaning.db"))
UPLOAD_DIR = Path(os.environ.get("CLEANING_UPLOAD_DIR", BASE_DIR / "uploads"))
AUTH_SECRET_PATH = Path(os.environ.get("ROUTINER_AUTH_SECRET_FILE", BASE_DIR / ".auth_secret"))
STATIC_DIR = os.environ.get("ROUTINER_STATIC_DIR")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

FREQUENCIES = {"Diário", "Semanal", "Quinzenal", "Mensal"}
STATUSES = {"Limpo", "Não limpo"}
PASSWORD_ITERATIONS = 600_000
SESSION_COOKIE = "routiner_session"
SESSION_SECONDS = 60 * 60 * 12
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
app = FastAPI(title="Routiner — Gestão de limpeza", version="2.0.0")
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
@contextmanager
def connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
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
                password_hash TEXT NOT NULL,
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
                completed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
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
            """
        )
        # Existing prototype data stays unassigned and is never exposed to a new tenant.
        add_column_if_missing(
            conn, "locations", "company_id TEXT REFERENCES companies(id) ON DELETE CASCADE"
        )
        add_column_if_missing(
            conn, "locations", "responsible_user_id TEXT REFERENCES users(id) ON DELETE SET NULL"
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
        add_column_if_missing(conn, "tasks", "completion_notes TEXT NOT NULL DEFAULT ''")
        add_column_if_missing(conn, "tasks", "photo_before TEXT")
        add_column_if_missing(conn, "tasks", "photo_after TEXT")
        add_column_if_missing(
            conn, "tasks", "completed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL"
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
            "CREATE INDEX IF NOT EXISTS idx_notifications_company_date ON company_notifications(company_id, created_at DESC)"
        )


initialize_database()


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


class UserUpdateInput(BaseModel):
    name: Annotated[str, Field(min_length=2, max_length=120)]
    sector: Annotated[str, Field(min_length=2, max_length=80)]

    @field_validator("name", "sector")
    @classmethod
    def clean_text(cls, value: str) -> str:
        return value.strip()


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
    photo: str | None = None
    responsible: Annotated[str, Field(min_length=1, max_length=100)]
    responsible_user_id: str | None = None
    frequency: str

    @field_validator("name", "responsible")
    @classmethod
    def clean_text(cls, value: str) -> str:
        return value.strip()


class CleaningInput(BaseModel):
    location_id: str
    cleaning_date: date
    status: str
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
        return value.astimezone(timezone.utc)


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
        secure=request.url.scheme == "https",
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


def validate_status(status: str):
    if status not in STATUSES:
        raise HTTPException(status_code=422, detail="Status inválido.")


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
        """SELECT l.*, u.sector AS responsible_sector
            FROM locations l
            LEFT JOIN users u ON u.id = l.responsible_user_id
            WHERE l.id = ? AND l.company_id = ?""",
        (location_id, company_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Local não encontrado nesta empresa.")
    return dict(row)


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
                JOIN users current_user
                    ON current_user.company_id = responsible.company_id
                    AND current_user.id = ?
                WHERE responsible.id = ? AND responsible.company_id = ?
                    AND lower(trim(responsible.sector)) = lower(trim(current_user.sector))""",
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
):
    if responsible_user_id:
        row = conn.execute(
            "SELECT id, name FROM users WHERE id = ? AND company_id = ?",
            (responsible_user_id, company_id),
        ).fetchone()
        if row is None:
            raise HTTPException(
                status_code=422,
                detail="O responsável selecionado não pertence a esta empresa.",
            )
        return dict(row)
    rows = conn.execute(
        """SELECT id, name FROM users
            WHERE company_id = ? AND lower(trim(name)) = lower(trim(?))""",
        (company_id, responsible),
    ).fetchall()
    if len(rows) != 1:
        raise HTTPException(
            status_code=422,
            detail="Selecione um funcionário cadastrado como responsável pelo local.",
        )
    return dict(rows[0])


def register_identifier(account: dict) -> dict:
    result = {"role": account["role"], "name": account["name"], "login": account["login"]}
    result["company"] = account["company"]
    if account["role"] == "user":
        result["sector"] = account["sector"]
    return result


@app.get("/api/health")
def health():
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
                "SELECT name, sector, username FROM users WHERE id = ? AND company_id = ?",
                (session["account_id"], session["company_id"]),
            ).fetchone()
            if user is None:
                raise HTTPException(status_code=401, detail="Esta conta de usuário não existe mais.")
            result = {
                "role": "user",
                "name": user["name"],
                "sector": user["sector"],
                "login": f'{user["username"]}.{company["company_handle"]}.routine',
                "company": company,
            }
    return result


@app.post("/api/auth/logout", status_code=204)
def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax")


@app.get("/api/users")
def list_users(session: dict = Depends(company_only)):
    with connection() as conn:
        company = company_row(conn, session["company_id"])
        rows = conn.execute(
            """SELECT id, name, sector, username, created_at
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
                    (id, company_id, name, sector, username, password_hash, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    user_id,
                    session["company_id"],
                    payload.name,
                    sector_name,
                    payload.username,
                    hash_password(payload.password),
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                ),
            )
        except sqlite3.IntegrityError as error:
            raise HTTPException(status_code=409, detail="Este identificador já está cadastrado nesta empresa.") from error
    return {
        "id": user_id,
        "name": payload.name,
        "sector": sector_name,
        "username": payload.username,
        "login": f'{payload.username}.{company["company_handle"]}.routine',
    }


@app.put("/api/users/{user_id}")
def update_user(user_id: str, payload: UserUpdateInput, session: dict = Depends(company_only)):
    with connection() as conn:
        sector_name = require_company_sector(conn, session["company_id"], payload.sector)
        cursor = conn.execute(
            """UPDATE users SET name = ?, sector = ?
                WHERE id = ? AND company_id = ?""",
            (payload.name, sector_name, user_id, session["company_id"]),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Funcionário não encontrado.")
        row = conn.execute(
            """SELECT u.id, u.name, u.sector, u.username,
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
        "login": f'{row["username"]}.{row["company_handle"]}.routine',
    }


@app.get("/api/tasks")
def list_tasks(session: dict = Depends(current_session)):
    clauses = ["t.company_id = ?"]
    params: list[str] = [session["company_id"]]
    if session["role"] == "user":
        clauses.append(
            """lower(trim(u.sector)) = lower(trim((
                SELECT current_user.sector FROM users current_user
                WHERE current_user.id = ? AND current_user.company_id = ?
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
                ORDER BY CASE WHEN t.completed_at IS NULL THEN 0 ELSE 1 END,
                    t.deadline ASC""",
            params,
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
    with connection() as conn:
        assignee = conn.execute(
            "SELECT id FROM users WHERE id = ? AND company_id = ?",
            (payload.assigned_user_id, session["company_id"]),
        ).fetchone()
        if assignee is None:
            raise HTTPException(status_code=404, detail="Funcionário não encontrado nesta empresa.")
        existing = conn.execute(
            """SELECT assigned_user_id, title, description, deadline, completed_at
                FROM tasks WHERE id = ? AND company_id = ?""",
            (task_id, session["company_id"]),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Demanda não encontrada.")
        if existing["completed_at"] is not None:
            raise HTTPException(status_code=409, detail="Demandas concluídas não podem ser editadas.")
        deadline = payload.deadline.isoformat(timespec="seconds")
        changed = any(
            (
                existing["assigned_user_id"] != payload.assigned_user_id,
                existing["title"] != payload.title,
                existing["description"] != payload.description,
                existing["deadline"] != deadline,
            )
        )
        conn.execute(
            """UPDATE tasks SET assigned_user_id = ?, title = ?, description = ?,
                    deadline = ?, acknowledged_at = CASE WHEN ? THEN NULL ELSE acknowledged_at END
                WHERE id = ? AND company_id = ?""",
            (
                payload.assigned_user_id,
                payload.title,
                payload.description,
                deadline,
                int(changed),
                task_id,
                session["company_id"],
            ),
        )
        row = conn.execute(
            """SELECT t.*, u.name AS assignee_name, u.sector AS assignee_sector,
                    executor.name AS completed_by_name
                FROM tasks t JOIN users u ON u.id = t.assigned_user_id
                LEFT JOIN users executor ON executor.id = t.completed_by_user_id
                WHERE t.id = ? AND t.company_id = ?""",
            (task_id, session["company_id"]),
        ).fetchone()
    return dict(row)


@app.post("/api/tasks/{task_id}/acknowledge")
def acknowledge_task(task_id: str, session: dict = Depends(current_session)):
    if session["role"] != "user":
        raise HTTPException(status_code=403, detail="Somente funcionários podem dar ciência.")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with connection() as conn:
        task = conn.execute(
            """SELECT t.acknowledged_at, t.completed_at, assigned.sector AS assignee_sector,
                    current_user.sector AS current_sector
                FROM tasks t
                JOIN users assigned ON assigned.id = t.assigned_user_id
                JOIN users current_user ON current_user.id = ?
                WHERE t.id = ? AND t.company_id = ?
                    AND assigned.company_id = ? AND current_user.company_id = ?""",
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
        if task["acknowledged_at"] is not None:
            return {"id": task_id, "acknowledged_at": task["acknowledged_at"]}
        cursor = conn.execute(
            """UPDATE tasks SET acknowledged_at = ?
                WHERE id = ? AND company_id = ?
                    AND acknowledged_at IS NULL AND completed_at IS NULL""",
            (now, task_id, session["company_id"]),
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


@app.post("/api/tasks/{task_id}/complete")
def complete_task(
    task_id: str,
    payload: TaskCompletionInput,
    session: dict = Depends(current_session),
):
    if session["role"] != "user":
        raise HTTPException(status_code=403, detail="Somente um funcionário do setor responsável pode concluir a tarefa.")
    photo_filenames = []
    for photo in (payload.photo_before, payload.photo_after):
        match = re.fullmatch(r"/uploads/([a-f0-9]{32}\.(?:jpg|png|webp))", photo)
        if match is None:
            raise HTTPException(status_code=422, detail="As duas fotos devem ser capturadas e enviadas pelo aplicativo.")
        photo_filenames.append(match.group(1))
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with connection() as conn:
        task = conn.execute(
            """SELECT t.acknowledged_at, t.completed_at, assigned.sector AS assignee_sector,
                    current_user.sector AS current_sector
                FROM tasks t
                JOIN users assigned ON assigned.id = t.assigned_user_id
                JOIN users current_user ON current_user.id = ?
                WHERE t.id = ? AND t.company_id = ?
                    AND assigned.company_id = ? AND current_user.company_id = ?""",
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
        if task["acknowledged_at"] is None:
            raise HTTPException(status_code=409, detail="Dê ciência da tarefa antes de concluí-la.")
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
                    AND acknowledged_at IS NOT NULL AND completed_at IS NULL""",
            (
                now,
                payload.notes,
                payload.photo_before,
                payload.photo_after,
                session["account_id"],
                task_id,
                session["company_id"],
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
                ORDER BY n.created_at DESC, n.rowid DESC LIMIT 100""",
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
                (SELECT COUNT(*) FROM cleanings c WHERE c.location_id = l.id) AS cleaning_count,
                (SELECT c.cleaning_date FROM cleanings c WHERE c.location_id = l.id
                    ORDER BY c.cleaning_date DESC, c.created_at DESC LIMIT 1) AS last_cleaned,
                (SELECT c.status FROM cleanings c WHERE c.location_id = l.id
                    ORDER BY c.cleaning_date DESC, c.created_at DESC LIMIT 1) AS last_status
            FROM locations l
            LEFT JOIN users owner ON owner.id = l.responsible_user_id
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
        )
        conn.execute(
            """INSERT INTO locations
                (id, company_id, name, photo, responsible, responsible_user_id, frequency, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                location_id,
                session["company_id"],
                payload.name,
                payload.photo,
                responsible["name"],
                responsible["id"],
                payload.frequency,
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
            ),
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
        )
        conn.execute(
            """UPDATE locations SET name = ?, photo = ?, responsible = ?,
                    responsible_user_id = ?, frequency = ?
                WHERE id = ? AND company_id = ?""",
            (
                payload.name,
                payload.photo,
                responsible["name"],
                responsible["id"],
                payload.frequency,
                location_id,
                session["company_id"],
            ),
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
        if status not in STATUSES | {"Concluída"}:
            raise HTTPException(status_code=422, detail="Filtro de status inválido.")
        if status != "Concluída":
            clauses.append("c.status = ?")
            params.append(status)
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
                COALESCE(u.name, co.fantasy_name) AS created_by_name,
                u.name AS executor_name
            FROM cleanings c
            JOIN locations l ON l.id = c.location_id
            JOIN companies co ON co.id = l.company_id
            LEFT JOIN users u ON u.id = c.created_by_user_id
            WHERE {' AND '.join(clauses)}
                AND (? != 'Concluída')
            ORDER BY c.cleaning_date DESC, c.created_at DESC
            """,
            [*params, status],
        ).fetchall()
        task_clauses = ["t.company_id = ?", "t.completed_at IS NOT NULL"]
        task_params: list[str] = [session["company_id"]]
        if session["role"] == "user":
            task_clauses.append(
                """lower(trim(assigned.sector)) = lower(trim((
                    SELECT current_user.sector FROM users current_user
                    WHERE current_user.id = ? AND current_user.company_id = ?
                )))"""
            )
            task_params.extend([session["account_id"], session["company_id"]])
        if status and status != "Concluída":
            task_clauses.append("0 = 1")
        if search.strip():
            task_clauses.append(
                "(t.title LIKE ? OR t.description LIKE ? OR assigned.name LIKE ? OR executor.name LIKE ?)"
            )
            task_params.extend([f"%{search.strip()}%"] * 4)
        if date_from:
            task_clauses.append("substr(t.completed_at, 1, 10) >= ?")
            task_params.append(date_from)
        if date_to:
            task_clauses.append("substr(t.completed_at, 1, 10) <= ?")
            task_params.append(date_to)
        task_rows = conn.execute(
            f"""SELECT 'task-' || t.id AS id, t.id AS task_id, 'task' AS record_type,
                    substr(t.completed_at, 1, 10) AS cleaning_date,
                    t.completed_at AS completed_at,
                    'Concluída' AS status, t.photo_before, t.photo_after,
                    t.completion_notes AS notes, t.completed_at AS created_at,
                    t.title AS location_name, assigned.name AS responsible,
                    assigned.sector AS responsible_sector,
                    executor.name AS executor_name,
                    executor.name AS created_by_name
                FROM tasks t
                JOIN users assigned ON assigned.id = t.assigned_user_id
                LEFT JOIN users executor ON executor.id = t.completed_by_user_id
                WHERE {' AND '.join(task_clauses)}
                ORDER BY t.completed_at DESC""",
            task_params,
        ).fetchall()
    return sorted(
        [dict(row) for row in (*rows, *task_rows)],
        key=lambda row: (row["cleaning_date"] or "", row["created_at"] or ""),
        reverse=True,
    )


@app.post("/api/history", status_code=201)
def create_cleaning(payload: CleaningInput, session: dict = Depends(current_session)):
    validate_status(payload.status)
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
                payload.status,
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
