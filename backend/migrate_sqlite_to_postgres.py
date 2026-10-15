from __future__ import annotations

import getpass
import json
import mimetypes
import os
import re
import sqlite3
import urllib.request
import uuid
from http.cookiejar import CookieJar
from pathlib import Path

import psycopg

TABLES = (
    "companies",
    "users",
    "sectors",
    "locations",
    "task_schedules",
    "cleanings",
    "tasks",
    "company_notifications",
)
PHOTO_REFERENCES = (
    ("locations", "photo"),
    ("cleanings", "photo_before"),
    ("cleanings", "photo_after"),
    ("tasks", "photo_before"),
    ("tasks", "photo_after"),
)


def postgres_url() -> str:
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("Configure DATABASE_URL com a URL pública temporária do PostgreSQL Railway.")
    return url.replace("postgres://", "postgresql://", 1) if url.startswith("postgres://") else url


def read_source(source_path: Path, upload_dir: Path):
    if not source_path.is_file():
        raise FileNotFoundError(f"Banco SQLite de origem não encontrado: {source_path}")
    source = sqlite3.connect(source_path)
    source.row_factory = sqlite3.Row
    try:
        tables = {
            row["name"]
            for row in source.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        missing = {"companies", "users"} - tables
        if missing:
            raise RuntimeError(f"A base de origem não contém as tabelas necessárias: {', '.join(sorted(missing))}")

        rows_by_table = {}
        for table in TABLES:
            if table in tables:
                rows_by_table[table] = [
                    dict(row) for row in source.execute(f'SELECT * FROM "{table}"')
                ]

        upload_rows = []
        if "uploads" in tables:
            upload_rows = [dict(row) for row in source.execute("SELECT filename, company_id FROM uploads")]
        invalid_files = [
            row["filename"]
            for row in upload_rows
            if not re.fullmatch(r"[a-f0-9]{32}\.(?:jpg|png|webp)", row["filename"])
        ]
        if invalid_files:
            raise RuntimeError(
                f"{len(invalid_files)} nome(s) de imagem inválido(s) na base de origem."
            )
        missing_files = [
            str(upload_dir / row["filename"])
            for row in upload_rows
            if not (upload_dir / row["filename"]).is_file()
        ]
        if missing_files:
            raise FileNotFoundError(
                f"{len(missing_files)} imagem(ns) não encontrada(s) na pasta {upload_dir}. "
                "Nenhum registro foi importado."
            )
        return rows_by_table, upload_rows
    finally:
        source.close()


def import_rows(database_url: str, rows_by_table: dict[str, list[dict]]) -> int:
    imported = 0
    with psycopg.connect(database_url) as target:
        for table, rows in rows_by_table.items():
            if not rows:
                continue
            target_columns = {
                row[0]
                for row in target.execute(
                    """SELECT column_name FROM information_schema.columns
                        WHERE table_schema = current_schema() AND table_name = %s""",
                    (table,),
                )
            }
            for row in rows:
                columns = [column for column in row if column in target_columns]
                if not columns:
                    continue
                column_sql = ", ".join(f'"{column}"' for column in columns)
                placeholders = ", ".join("%s" for _ in columns)
                target.execute(
                    f'INSERT INTO "{table}" ({column_sql}) VALUES ({placeholders}) ON CONFLICT DO NOTHING',
                    tuple(row[column] for column in columns),
                )
                imported += 1
    return imported


def api_json(opener, url: str, payload: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with opener.open(request, timeout=30) as response:
        return json.load(response)


def upload_file(opener, api_url: str, upload_dir: Path, filename: str) -> str:
    path = upload_dir / filename
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    boundary = f"----RoutinerMigration{uuid.uuid4().hex}"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8")
    body += path.read_bytes()
    body += f"\r\n--{boundary}--\r\n".encode("ascii")
    request = urllib.request.Request(
        f"{api_url}/api/upload",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with opener.open(request, timeout=60) as response:
        result = json.load(response)
    return result["url"]


def migrate_photos(
    database_url: str,
    api_url: str,
    upload_dir: Path,
    upload_rows: list[dict],
    passwords_by_company: dict[str, str],
    companies_by_id: dict[str, dict],
) -> int:
    migrated = 0
    with psycopg.connect(database_url) as target:
        for company_id in passwords_by_company:
            cookies = CookieJar()
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
            company = companies_by_id[company_id]
            login = f'{company["company_handle"]}.routine'
            api_json(
                opener,
                f"{api_url}/api/auth/login-company",
                {"identifier": login, "password": passwords_by_company[company_id]},
            )
            for upload in upload_rows:
                if upload["company_id"] != company_id:
                    continue
                filename = upload["filename"]
                old_url = f"/uploads/{filename}"
                referenced = target.execute(
                    """SELECT EXISTS (
                        SELECT 1 FROM locations WHERE photo = %s
                        UNION ALL SELECT 1 FROM cleanings
                            WHERE photo_before = %s OR photo_after = %s
                        UNION ALL SELECT 1 FROM tasks
                            WHERE photo_before = %s OR photo_after = %s
                    )""",
                    (old_url, old_url, old_url, old_url, old_url),
                ).fetchone()[0]
                if not referenced:
                    continue
                new_url = upload_file(opener, api_url, upload_dir, filename)
                for table, column in PHOTO_REFERENCES:
                    target.execute(
                        f'UPDATE "{table}" SET "{column}" = %s WHERE "{column}" = %s',
                        (new_url, old_url),
                    )
                migrated += 1
    return migrated


def main():
    source_path = Path(os.environ.get("CLEANING_DB_PATH", "backend/cleaning.db"))
    upload_dir = Path(os.environ.get("CLEANING_UPLOAD_DIR", "backend/uploads"))
    api_url = os.environ.get("ROUTINER_MIGRATION_API_URL", "").rstrip("/")
    if not api_url:
        raise RuntimeError("Configure ROUTINER_MIGRATION_API_URL antes de iniciar.")
    if not api_url.startswith("https://"):
        raise ValueError("ROUTINER_MIGRATION_API_URL deve usar HTTPS.")

    database_url = postgres_url()
    rows_by_table, upload_rows = read_source(source_path, upload_dir)
    companies_by_id = {
        company["id"]: company for company in rows_by_table.get("companies", [])
    }
    passwords_by_company = {}
    for company_id in {upload["company_id"] for upload in upload_rows}:
        company = companies_by_id.get(company_id)
        if company is None:
            raise RuntimeError("Há imagens vinculadas a uma empresa ausente na base de origem.")
        password = getpass.getpass(f'Senha da empresa ({company["company_handle"]}.routine): ')
        if not password:
            raise ValueError("A senha não pode ficar vazia.")
        passwords_by_company[company_id] = password

    imported = import_rows(database_url, rows_by_table)
    print(f"Registros importados ou já existentes no PostgreSQL: {imported}.")
    migrated_photos = migrate_photos(
        database_url, api_url, upload_dir, upload_rows, passwords_by_company, companies_by_id
    )
    print(f"Imagens enviadas para o serviço Routiner: {migrated_photos}.")


if __name__ == "__main__":
    main()
