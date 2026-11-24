from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "data" / "lesson_portal.db"
PASSWORD_ITERATIONS = 200_000
SESSION_LIFETIME = timedelta(hours=12)
ATTENDANCE_STATUSES = {"Present", "Absent", "Late", "Excused"}
DEMO_ACCOUNT_EMAILS = (
    "admin@brightpath.edu",
    "maya@student.demo",
    "noah@student.demo",
    "sofia@student.demo",
    "ethan@student.demo",
    "isabella@student.demo",
)


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


@contextmanager
def connect_db():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def password_digest(password: str, salt: bytes | None = None) -> str:
    actual_salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), actual_salt, PASSWORD_ITERATIONS
    )
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${actual_salt.hex()}${digest.hex()}"


def password_matches(password: str, stored: str) -> bool:
    algorithm, iterations, salt_hex, digest_hex = stored.split("$", 3)
    if algorithm != "pbkdf2_sha256":
        return False
    actual = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
    )
    return hmac.compare_digest(actual.hex(), digest_hex)


def initialize_database() -> None:
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    with connect_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin', 'student')),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS attendance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                lesson_date TEXT NOT NULL,
                status TEXT NOT NULL CHECK (
                    status IN ('Present', 'Absent', 'Late', 'Excused')
                ),
                updated_at TEXT NOT NULL,
                marked_by INTEGER REFERENCES users(id),
                UNIQUE (student_id, lesson_date)
            );
            CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS lessons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                starts_at TEXT NOT NULL,
                meeting_url TEXT NOT NULL,
                created_at TEXT NOT NULL,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS message_reads (
                student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                reader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                last_read_message_id INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (student_id, reader_id)
            );
            """
        )
        attendance_columns = {
            row["name"] for row in db.execute("PRAGMA table_info(attendance)")
        }
        if "lesson_id" not in attendance_columns:
            db.execute(
                "ALTER TABLE attendance ADD COLUMN lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL"
            )
        attendance_columns = {
            row["name"]: row for row in db.execute("PRAGMA table_info(attendance)")
        }
        if attendance_columns["marked_by"]["notnull"]:
            db.execute("PRAGMA foreign_keys = OFF")
            try:
                db.execute("BEGIN IMMEDIATE")
                db.execute(
                    """
                    CREATE TABLE attendance_updated (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        lesson_date TEXT NOT NULL,
                        status TEXT NOT NULL CHECK (
                            status IN ('Present', 'Absent', 'Late', 'Excused')
                        ),
                        updated_at TEXT NOT NULL,
                        marked_by INTEGER REFERENCES users(id),
                        UNIQUE (student_id, lesson_date)
                    )
                    """
                )
                db.execute(
                    """
                    INSERT INTO attendance_updated
                        (id, student_id, lesson_date, status, updated_at, marked_by)
                    SELECT id, student_id, lesson_date, status, updated_at, marked_by
                    FROM attendance
                    """
                )
                db.execute("DROP TABLE attendance")
                db.execute("ALTER TABLE attendance_updated RENAME TO attendance")
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.execute("PRAGMA foreign_keys = ON")

        if not db.execute(
            "SELECT 1 FROM app_meta WHERE key = 'demo_accounts_removed_v1'"
        ).fetchone():
            placeholders = ",".join("?" for _ in DEMO_ACCOUNT_EMAILS)
            demo_users = db.execute(
                f"SELECT id, role FROM users WHERE email IN ({placeholders}) COLLATE NOCASE",
                DEMO_ACCOUNT_EMAILS,
            ).fetchall()
            demo_ids = [row["id"] for row in demo_users]
            demo_student_ids = [
                row["id"] for row in demo_users if row["role"] == "student"
            ]
            if demo_ids:
                user_placeholders = ",".join("?" for _ in demo_ids)
                db.execute(
                    f"DELETE FROM sessions WHERE user_id IN ({user_placeholders})",
                    demo_ids,
                )
                if demo_student_ids:
                    student_placeholders = ",".join("?" for _ in demo_student_ids)
                    db.execute(
                        f"DELETE FROM attendance WHERE student_id IN ({student_placeholders})",
                        demo_student_ids,
                    )
                db.execute(
                    f"""
                    UPDATE attendance SET marked_by = NULL
                    WHERE marked_by IN ({user_placeholders})
                    """,
                    demo_ids,
                )
                db.execute(f"DELETE FROM users WHERE id IN ({user_placeholders})", demo_ids)
            db.execute(
                "INSERT INTO app_meta (key, value) VALUES ('demo_accounts_removed_v1', 'true')"
            )


def serialize_user(row: sqlite3.Row) -> dict[str, object]:
    return {"id": row["id"], "name": row["name"], "email": row["email"], "role": row["role"]}


class LessonHandler(BaseHTTPRequestHandler):
    server_version = "NextGenLearningHub/1.0"

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/":
            self._send_file("index.html", "text/html; charset=utf-8")
        elif path == "/styles.css":
            self._send_file("styles.css", "text/css; charset=utf-8")
        elif path == "/app.js":
            self._send_file("app.js", "text/javascript; charset=utf-8")
        elif path == "/api/session":
            user = self._current_user()
            setup_required = not self._has_admin()
            self._send_json(200, {"user": user, "setup_required": setup_required})
        elif path == "/api/dashboard":
            self._send_json(200, self._dashboard(self._require_user()))
        elif path == "/api/students":
            self._require_role("admin")
            self._send_json(200, {"students": self._students()})
        elif path == "/api/attendance":
            self._require_role("admin")
            query = parse_qs(urlsplit(self.path).query)
            selected_date = query.get("date", [date.today().isoformat()])[0]
            self._validate_date(selected_date)
            self._send_json(200, {"attendance": self._attendance_for_date(selected_date)})
        elif path == "/api/lessons":
            user = self._require_user()
            self._send_json(200, {"lessons": self._lessons(user)})
        elif path == "/api/messages":
            user = self._require_user()
            query = parse_qs(urlsplit(self.path).query)
            student_id_values = query.get("student_id", [])
            if user["role"] == "admin" and student_id_values:
                try:
                    student_id = int(student_id_values[0])
                except ValueError:
                    raise ApiError(400, "Choose a valid student.") from None
                self._send_json(200, {"messages": self._messages(student_id)})
            elif user["role"] == "admin":
                self._send_json(200, {"conversations": self._conversations()})
            else:
                self._send_json(200, {"messages": self._messages(int(user["id"]))})
        elif path == "/api/messages/unread":
            self._send_json(200, self._unread_messages(self._require_user()))
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        path = urlsplit(self.path).path
        if path == "/api/login":
            self._login()
        elif path == "/api/register":
            self._register_student()
        elif path == "/api/setup/admin":
            self._setup_admin()
        elif path == "/api/logout":
            token = self._session_token()
            if token:
                with connect_db() as db, db:
                    db.execute(
                        "DELETE FROM sessions WHERE token_hash = ?",
                        (hashlib.sha256(token.encode()).hexdigest(),),
                    )
            self._send_json(
                200,
                {"ok": True},
                extra_headers=[("Set-Cookie", "lesson_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")],
            )
        elif path == "/api/students":
            self._create_student()
        elif path == "/api/attendance":
            self._save_attendance()
        elif path == "/api/lessons":
            self._create_lesson()
        elif re.fullmatch(r"/api/lessons/[1-9]\d*/attendance", path):
            self._mark_lesson_attendance()
        elif path == "/api/messages":
            self._send_message()
        elif path == "/api/messages/read":
            self._mark_messages_read()
        else:
            self._send_json(404, {"error": "Not found"})

    def do_DELETE(self):
        path = urlsplit(self.path).path
        match = re.fullmatch(r"/api/lessons/([1-9]\d*)", path)
        if match is not None:
            self._require_role("admin")
            with connect_db() as db, db:
                result = db.execute("DELETE FROM lessons WHERE id = ?", (int(match.group(1)),))
                if result.rowcount == 0:
                    raise ApiError(404, "Lesson not found.")
            self._send_json(200, {"ok": True})
            return

        match = re.fullmatch(r"/api/students/([1-9]\d*)", path)
        if match is None:
            self._send_json(404, {"error": "Not found"})
            return
        self._require_role("admin")
        student_id = int(match.group(1))
        with connect_db() as db, db:
            student = db.execute(
                "SELECT id FROM users WHERE id = ? AND role = 'student'", (student_id,)
            ).fetchone()
            if student is None:
                raise ApiError(404, "Student not found.")
            db.execute("DELETE FROM sessions WHERE user_id = ?", (student_id,))
            db.execute("DELETE FROM message_reads WHERE student_id = ?", (student_id,))
            db.execute("DELETE FROM messages WHERE student_id = ?", (student_id,))
            db.execute("DELETE FROM attendance WHERE student_id = ?", (student_id,))
            db.execute("DELETE FROM lessons WHERE student_id = ?", (student_id,))
            db.execute("DELETE FROM users WHERE id = ? AND role = 'student'", (student_id,))
        self._send_json(200, {"ok": True})

    def _login(self):
        body = self._read_json()
        email = str(body.get("email", "")).strip()
        password = str(body.get("password", ""))
        with connect_db() as db:
            row = db.execute(
                "SELECT * FROM users WHERE email = ? COLLATE NOCASE", (email,)
            ).fetchone()
            valid = row is not None and password_matches(password, row["password_hash"])
            if not valid:
                raise ApiError(401, "Email or password is incorrect.")
            token = secrets.token_urlsafe(32)
            expires_at = (datetime.now(timezone.utc) + SESSION_LIFETIME).isoformat()
            db.execute("DELETE FROM sessions WHERE expires_at < ?", (datetime.now(timezone.utc).isoformat(),))
            db.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                (hashlib.sha256(token.encode()).hexdigest(), row["id"], expires_at),
            )
        self._send_json(
            200,
            {"user": serialize_user(row)},
            extra_headers=[
                (
                    "Set-Cookie",
                    f"lesson_session={token}; Path=/; Max-Age={int(SESSION_LIFETIME.total_seconds())}; HttpOnly; SameSite=Lax",
                )
            ],
        )

    def _register_student(self):
        body = self._read_json()
        name = str(body.get("name", "")).strip()
        email = str(body.get("email", "")).strip().lower()
        password = str(body.get("password", ""))
        if not name or len(name) > 100:
            raise ApiError(400, "Enter a name between 1 and 100 characters.")
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or len(email) > 254:
            raise ApiError(400, "Enter a valid email address.")
        if not 8 <= len(password) <= 1024:
            raise ApiError(400, "Password must be between 8 and 1024 characters.")
        token = secrets.token_urlsafe(32)
        now = datetime.now(timezone.utc)
        try:
            with connect_db() as db:
                db.execute("BEGIN IMMEDIATE")
                cursor = db.execute(
                    """
                    INSERT INTO users (name, email, password_hash, role, created_at)
                    VALUES (?, ?, ?, 'student', ?)
                    """,
                    (name, email, password_digest(password), now.isoformat()),
                )
                db.execute(
                    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                    (
                        hashlib.sha256(token.encode()).hexdigest(),
                        cursor.lastrowid,
                        (now + SESSION_LIFETIME).isoformat(),
                    ),
                )
                student = db.execute(
                    "SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)
                ).fetchone()
        except sqlite3.IntegrityError:
            raise ApiError(409, "An account with that email is already registered.") from None
        self._send_json(
            201,
            {"user": serialize_user(student)},
            extra_headers=[
                (
                    "Set-Cookie",
                    f"lesson_session={token}; Path=/; Max-Age={int(SESSION_LIFETIME.total_seconds())}; HttpOnly; SameSite=Lax",
                )
            ],
        )

    def _setup_admin(self):
        body = self._read_json()
        name = str(body.get("name", "")).strip()
        email = str(body.get("email", "")).strip().lower()
        password = str(body.get("password", ""))
        if not name or len(name) > 100:
            raise ApiError(400, "Enter a name between 1 and 100 characters.")
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or len(email) > 254:
            raise ApiError(400, "Enter a valid email address.")
        if len(password) < 12:
            raise ApiError(400, "Administrator password must be at least 12 characters.")

        with connect_db() as db:
            db.execute("BEGIN IMMEDIATE")
            if self._has_admin(db):
                raise ApiError(409, "An administrator account has already been set up.")
            now = datetime.now(timezone.utc)
            if db.execute(
                "SELECT 1 FROM users WHERE email = ? COLLATE NOCASE", (email,)
            ).fetchone():
                raise ApiError(409, "An account with that email is already registered.")
            cursor = db.execute(
                """
                INSERT INTO users (name, email, password_hash, role, created_at)
                VALUES (?, ?, ?, 'admin', ?)
                """,
                (name, email, password_digest(password), now.isoformat()),
            )
            token = secrets.token_urlsafe(32)
            db.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                (
                    hashlib.sha256(token.encode()).hexdigest(),
                    cursor.lastrowid,
                    (now + SESSION_LIFETIME).isoformat(),
                ),
            )
            user = db.execute(
                "SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        self._send_json(
            201,
            {"user": serialize_user(user)},
            extra_headers=[
                (
                    "Set-Cookie",
                    f"lesson_session={token}; Path=/; Max-Age={int(SESSION_LIFETIME.total_seconds())}; HttpOnly; SameSite=Lax",
                )
            ],
        )

    def _create_student(self):
        admin = self._require_role("admin")
        body = self._read_json()
        name = str(body.get("name", "")).strip()
        email = str(body.get("email", "")).strip().lower()
        password = str(body.get("password", ""))
        if not name or len(name) > 100:
            raise ApiError(400, "Enter a name between 1 and 100 characters.")
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or len(email) > 254:
            raise ApiError(400, "Enter a valid email address.")
        if len(password) < 8:
            raise ApiError(400, "Password must be at least 8 characters.")
        try:
            with connect_db() as db, db:
                db.execute(
                    """
                    INSERT INTO users (name, email, password_hash, role, created_at)
                    VALUES (?, ?, ?, 'student', ?)
                    """,
                    (
                        name,
                        email,
                        password_digest(password),
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
        except sqlite3.IntegrityError:
            raise ApiError(409, "A student with that email is already registered.") from None
        self._send_json(201, {"ok": True, "students": self._students()})

    def _save_attendance(self):
        admin = self._require_role("admin")
        body = self._read_json()
        student_id = body.get("student_id")
        lesson_date = str(body.get("date", ""))
        status = str(body.get("status", ""))
        self._validate_date(lesson_date)
        if status not in ATTENDANCE_STATUSES:
            raise ApiError(400, "Choose a valid attendance status.")
        if not isinstance(student_id, int) or isinstance(student_id, bool):
            raise ApiError(400, "Choose a registered student.")
        with connect_db() as db, db:
            student = db.execute(
                "SELECT id FROM users WHERE id = ? AND role = 'student'", (student_id,)
            ).fetchone()
            if student is None:
                raise ApiError(404, "Student not found.")
            db.execute(
                """
                INSERT INTO attendance (student_id, lesson_date, status, updated_at, marked_by)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(student_id, lesson_date) DO UPDATE SET
                    status = excluded.status,
                    updated_at = excluded.updated_at,
                    marked_by = excluded.marked_by
                """,
                (student_id, lesson_date, status, datetime.now(timezone.utc).isoformat(), admin["id"]),
            )
        self._send_json(200, {"ok": True})

    def _create_lesson(self):
        admin = self._require_role("admin")
        body = self._read_json()
        student_ids = body.get("student_ids")
        title = str(body.get("title", "")).strip()
        starts_at_value = str(body.get("starts_at", "")).strip()
        meeting_url = str(body.get("meeting_url", "")).strip()

        if (
            not isinstance(student_ids, list)
            or len(student_ids) < 2
            or any(
                not isinstance(student_id, int) or isinstance(student_id, bool)
                for student_id in student_ids
            )
            or len(set(student_ids)) != len(student_ids)
        ):
            raise ApiError(400, "Choose at least two different students.")
        if not title or len(title) > 120:
            raise ApiError(400, "Enter a lesson title between 1 and 120 characters.")
        try:
            starts_at = datetime.fromisoformat(starts_at_value)
        except ValueError:
            raise ApiError(400, "Enter a valid lesson date and time.") from None
        if starts_at.tzinfo is None or starts_at.utcoffset() is None:
            raise ApiError(400, "Lesson time must include a timezone.")
        starts_at = starts_at.astimezone(timezone.utc)
        if starts_at <= datetime.now(timezone.utc):
            raise ApiError(400, "Choose a lesson time in the future.")

        if len(meeting_url) > 2048:
            raise ApiError(400, "Meeting link must be 2048 characters or fewer.")
        try:
            parsed_url = urlsplit(meeting_url)
            valid_host = bool(parsed_url.hostname) and parsed_url.port != 0
        except ValueError:
            valid_host = False
            parsed_url = urlsplit("")
        if (
            parsed_url.scheme not in {"http", "https"}
            or not valid_host
            or parsed_url.username is not None
            or parsed_url.password is not None
        ):
            raise ApiError(400, "Enter a valid http or https meeting link.")

        with connect_db() as db, db:
            placeholders = ",".join("?" for _ in student_ids)
            students = db.execute(
                f"""
                SELECT id FROM users
                WHERE role = 'student' AND id IN ({placeholders})
                """,
                student_ids,
            ).fetchall()
            if len(students) != len(student_ids):
                raise ApiError(404, "One or more selected students were not found.")
            created_at = datetime.now(timezone.utc).isoformat()
            lesson_ids = []
            for student in students:
                cursor = db.execute(
                    """
                    INSERT INTO lessons
                        (student_id, title, starts_at, meeting_url, created_at, created_by)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        student["id"],
                        title,
                        starts_at.isoformat(),
                        meeting_url,
                        created_at,
                        admin["id"],
                    ),
                )
                lesson_ids.append(cursor.lastrowid)
            lesson_placeholders = ",".join("?" for _ in lesson_ids)
            lessons = db.execute(
                f"""
                SELECT l.id, l.student_id, u.name AS student_name, u.email AS student_email, l.title,
                    l.starts_at, l.meeting_url
                FROM lessons l JOIN users u ON u.id = l.student_id
                WHERE l.id IN ({lesson_placeholders})
                ORDER BY u.name COLLATE NOCASE
                """,
                lesson_ids,
            ).fetchall()
        self._send_json(201, {"lessons": [dict(lesson) for lesson in lessons]})

    def _mark_lesson_attendance(self):
        student = self._require_role("student")
        match = re.fullmatch(r"/api/lessons/([1-9]\d*)/attendance", urlsplit(self.path).path)
        if match is None:
            raise ApiError(404, "Lesson not found.")
        lesson_id = int(match.group(1))
        body = self._read_json()
        status = str(body.get("status", ""))
        if status not in {"Present", "Absent"}:
            raise ApiError(400, "Choose Present or Absent.")

        with connect_db() as db, db:
            lesson = db.execute(
                """
                SELECT id, starts_at FROM lessons
                WHERE id = ? AND student_id = ?
                """,
                (lesson_id, student["id"]),
            ).fetchone()
            if lesson is None:
                raise ApiError(404, "Lesson not found.")
            starts_at = datetime.fromisoformat(lesson["starts_at"])
            lesson_date = starts_at.astimezone().date().isoformat()
            if lesson_date != date.today().isoformat():
                raise ApiError(400, "Attendance can only be marked on the lesson date.")
            now = datetime.now(timezone.utc).isoformat()
            db.execute(
                """
                INSERT INTO attendance
                    (student_id, lesson_date, status, updated_at, marked_by, lesson_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(student_id, lesson_date) DO UPDATE SET
                    status = excluded.status,
                    updated_at = excluded.updated_at,
                    marked_by = excluded.marked_by,
                    lesson_id = excluded.lesson_id
                """,
                (student["id"], lesson_date, status, now, student["id"], lesson_id),
            )
        self._send_json(200, {"ok": True, "status": status, "date": lesson_date})

    def _send_message(self):
        user = self._require_user()
        body = self._read_json()
        message_body = str(body.get("body", "")).strip()
        if not message_body or len(message_body) > 2000:
            raise ApiError(400, "Message must be between 1 and 2000 characters.")
        if user["role"] == "admin":
            student_id = body.get("student_id")
            if not isinstance(student_id, int) or isinstance(student_id, bool):
                raise ApiError(400, "Choose a student conversation.")
        else:
            student_id = int(user["id"])

        with connect_db() as db, db:
            student = db.execute(
                "SELECT id FROM users WHERE id = ? AND role = 'student'", (student_id,)
            ).fetchone()
            if student is None:
                raise ApiError(404, "Student conversation not found.")
            cursor = db.execute(
                """
                INSERT INTO messages (student_id, sender_id, body, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    student_id,
                    user["id"],
                    message_body,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            message = db.execute(
                """
                SELECT m.id, m.student_id, m.sender_id, u.name AS sender_name,
                    u.role AS sender_role, m.body, m.created_at
                FROM messages m JOIN users u ON u.id = m.sender_id
                WHERE m.id = ?
                """,
                (cursor.lastrowid,),
            ).fetchone()
        self._send_json(201, {"message": dict(message)})

    def _messages(self, student_id: int) -> list[dict[str, object]]:
        with connect_db() as db:
            student = db.execute(
                "SELECT id FROM users WHERE id = ? AND role = 'student'", (student_id,)
            ).fetchone()
            if student is None:
                raise ApiError(404, "Student conversation not found.")
            rows = db.execute(
                """
                SELECT m.id, m.student_id, m.sender_id, u.name AS sender_name,
                    u.role AS sender_role, m.body, m.created_at
                FROM (
                    SELECT * FROM messages
                    WHERE student_id = ?
                    ORDER BY id DESC LIMIT 100
                ) m
                JOIN users u ON u.id = m.sender_id
                ORDER BY m.id
                """,
                (student_id,),
            )
            return [dict(row) for row in rows]

    def _mark_messages_read(self):
        user = self._require_user()
        body = self._read_json()
        if user["role"] == "admin":
            student_id = body.get("student_id")
            if not isinstance(student_id, int) or isinstance(student_id, bool):
                raise ApiError(400, "Choose a student conversation.")
        else:
            student_id = int(user["id"])
        with connect_db() as db, db:
            student = db.execute(
                "SELECT id FROM users WHERE id = ? AND role = 'student'", (student_id,)
            ).fetchone()
            if student is None:
                raise ApiError(404, "Student conversation not found.")
            last_message = db.execute(
                "SELECT COALESCE(MAX(id), 0) FROM messages WHERE student_id = ?",
                (student_id,),
            ).fetchone()[0]
            db.execute(
                """
                INSERT INTO message_reads (student_id, reader_id, last_read_message_id)
                VALUES (?, ?, ?)
                ON CONFLICT(student_id, reader_id) DO UPDATE SET
                    last_read_message_id = MAX(
                        message_reads.last_read_message_id, excluded.last_read_message_id
                    )
                """,
                (student_id, user["id"], last_message),
            )
        self._send_json(200, {"ok": True})

    def _unread_messages(self, user: dict[str, object]) -> dict[str, object]:
        with connect_db() as db:
            if user["role"] == "admin":
                rows = db.execute(
                    """
                    SELECT s.id AS student_id, s.name,
                        SUM(CASE WHEN m.id > COALESCE(r.last_read_message_id, 0)
                            THEN 1 ELSE 0 END) AS unread_count,
                        MAX(m.id) AS latest_message_id
                    FROM users s
                    JOIN messages m ON m.student_id = s.id AND m.sender_id != ?
                    LEFT JOIN message_reads r
                        ON r.student_id = s.id AND r.reader_id = ?
                    WHERE s.role = 'student'
                    GROUP BY s.id
                    ORDER BY latest_message_id DESC
                    """,
                    (user["id"], user["id"]),
                )
                conversations = [dict(row) for row in rows]
                return {
                    "unread_count": sum(row["unread_count"] for row in conversations),
                    "conversations": conversations,
                }

            student_id = int(user["id"])
            row = db.execute(
                """
                SELECT SUM(CASE WHEN m.id > COALESCE(r.last_read_message_id, 0)
                    THEN 1 ELSE 0 END) AS unread_count, MAX(m.id) AS latest_message_id,
                    (SELECT sender.name
                     FROM messages latest JOIN users sender ON sender.id = latest.sender_id
                     WHERE latest.student_id = ? AND latest.sender_id != ?
                     ORDER BY latest.id DESC LIMIT 1) AS latest_sender_name
                FROM messages m
                LEFT JOIN message_reads r
                    ON r.student_id = m.student_id AND r.reader_id = ?
                WHERE m.student_id = ? AND m.sender_id != ?
                """,
                (student_id, user["id"], user["id"], student_id, user["id"]),
            ).fetchone()
            return {
                "unread_count": row["unread_count"],
                "latest_message_id": row["latest_message_id"],
                "latest_sender_name": row["latest_sender_name"],
            }

    def _conversations(self) -> list[dict[str, object]]:
        with connect_db() as db:
            rows = db.execute(
                """
                SELECT s.id AS student_id, s.name, s.email, s.created_at,
                    m.body AS last_message, m.created_at AS last_message_at,
                    m.sender_id AS last_sender_id
                FROM users s
                LEFT JOIN messages m ON m.id = (
                    SELECT MAX(latest.id) FROM messages latest
                    WHERE latest.student_id = s.id
                )
                WHERE s.role = 'student'
                ORDER BY COALESCE(m.created_at, s.created_at) DESC, s.name COLLATE NOCASE
                """
            )
            return [dict(row) for row in rows]

    def _dashboard(self, user: dict[str, object]) -> dict[str, object]:
        today = date.today().isoformat()
        with connect_db() as db:
            if user["role"] == "admin":
                students = self._students(db)
                attendance = self._attendance_for_date(today, db)
                lessons = self._lessons(user, db)
                present = sum(row["status"] in ("Present", "Late") for row in attendance)
                return {
                    "user": user,
                    "stats": {
                        "student_count": len(students),
                        "present_today": present,
                        "needs_attention": sum(row["status"] in (None, "Absent") for row in attendance),
                        "attendance_rate": round(present / len(students) * 100) if students else 0,
                        "upcoming_lessons": len(lessons),
                    },
                    "students": students,
                    "attendance": attendance,
                    "lessons": lessons,
                    "today": today,
                }
            records = [
                dict(row)
                for row in db.execute(
                    """
                    SELECT lesson_date AS date, status FROM attendance
                        WHERE student_id = ? ORDER BY lesson_date DESC
                    """,
                    (user["id"],),
                )
            ]
            total = db.execute(
                "SELECT COUNT(*) FROM attendance WHERE student_id = ?", (user["id"],)
            ).fetchone()[0]
            present = db.execute(
                """
                SELECT COUNT(*) FROM attendance
                WHERE student_id = ? AND status IN ('Present', 'Late')
                """,
                (user["id"],),
            ).fetchone()[0]
            lessons = self._lessons(user, db)
        return {
            "user": user,
            "stats": {
                "lessons_attended": present,
                "total_lessons": total,
                "attendance_rate": round(present / total * 100) if total else 0,
            },
            "attendance": records,
            "lessons": lessons,
            "today": today,
        }

    def _lessons(
        self, user: dict[str, object], db: sqlite3.Connection | None = None
    ) -> list[dict[str, object]]:
        if db is None:
            with connect_db() as connection:
                return self._lessons(user, connection)
        now = datetime.now(timezone.utc).isoformat()
        if user["role"] == "admin":
            rows = db.execute(
                """
                SELECT l.id, l.student_id, u.name AS student_name, u.email AS student_email,
                    l.title, l.starts_at, l.meeting_url, a.status AS attendance_status
                FROM lessons l JOIN users u ON u.id = l.student_id
                LEFT JOIN attendance a ON a.lesson_id = l.id
                WHERE l.starts_at > ?
                ORDER BY l.starts_at, u.name COLLATE NOCASE
                """,
                (now,),
            )
        else:
            lesson_day_start = datetime.combine(
                datetime.now().astimezone().date(), datetime.min.time()
            ).astimezone(timezone.utc).isoformat()
            rows = db.execute(
                """
                SELECT l.id, l.student_id, l.title, l.starts_at, l.meeting_url,
                    a.status AS attendance_status
                FROM lessons l LEFT JOIN attendance a ON a.lesson_id = l.id
                WHERE l.student_id = ? AND l.starts_at >= ?
                ORDER BY starts_at
                """,
                (user["id"], lesson_day_start),
            )
        return [dict(row) for row in rows]

    def _students(self, db: sqlite3.Connection | None = None) -> list[dict[str, object]]:
        if db is not None:
            rows = db.execute(
                """
                SELECT u.id, u.name, u.email, u.created_at,
                    COUNT(a.id) AS lessons,
                    SUM(CASE WHEN a.status IN ('Present', 'Late') THEN 1 ELSE 0 END) AS attended
                FROM users u LEFT JOIN attendance a ON a.student_id = u.id
                WHERE u.role = 'student'
                GROUP BY u.id ORDER BY u.name COLLATE NOCASE
                """
            )
            return [dict(row) for row in rows]
        with connect_db() as connection:
            return self._students(connection)

    def _attendance_for_date(
        self, selected_date: str, db: sqlite3.Connection | None = None
    ) -> list[dict[str, object]]:
        if db is None:
            with connect_db() as connection:
                return self._attendance_for_date(selected_date, connection)
        rows = db.execute(
            """
            SELECT u.id AS student_id, u.name, u.email, a.status
            FROM users u LEFT JOIN attendance a
                ON a.student_id = u.id AND a.lesson_date = ?
            WHERE u.role = 'student'
            ORDER BY u.name COLLATE NOCASE
            """,
            (selected_date,),
        )
        return [dict(row) for row in rows]

    def _current_user(self) -> dict[str, object] | None:
        token = self._session_token()
        if not token:
            return None
        with connect_db() as db:
            row = db.execute(
                """
                SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > ?
                """,
                (
                    hashlib.sha256(token.encode()).hexdigest(),
                    datetime.now(timezone.utc).isoformat(),
                ),
            ).fetchone()
        return serialize_user(row) if row else None

    def _require_user(self) -> dict[str, object]:
        user = self._current_user()
        if user is None:
            raise ApiError(401, "Please sign in to continue.")
        return user

    def _require_role(self, role: str) -> dict[str, object]:
        user = self._require_user()
        if user["role"] != role:
            raise ApiError(403, "You don't have permission to do that.")
        return user

    def _has_admin(self, db: sqlite3.Connection | None = None) -> bool:
        if db is not None:
            return db.execute(
                "SELECT 1 FROM users WHERE role = 'admin' LIMIT 1"
            ).fetchone() is not None
        with connect_db() as connection:
            return self._has_admin(connection)

    def _session_token(self) -> str | None:
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        morsel = cookie.get("lesson_session")
        return morsel.value if morsel else None

    def _validate_date(self, value: str) -> None:
        try:
            parsed = date.fromisoformat(value)
        except ValueError:
            raise ApiError(400, "Use a valid date in YYYY-MM-DD format.") from None
        if parsed.isoformat() != value:
            raise ApiError(400, "Use a valid date in YYYY-MM-DD format.")

    def _read_json(self) -> dict[str, object]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "Invalid request body.") from None
        if length <= 0 or length > 16_384:
            raise ApiError(400, "Request body must be between 1 and 16384 bytes.")
        try:
            value = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(400, "Request body must be valid JSON.") from None
        if not isinstance(value, dict):
            raise ApiError(400, "Request body must be a JSON object.")
        return value

    def _send_file(self, filename: str, content_type: str) -> None:
        path = ROOT / filename
        data = path.read_bytes()
        self.send_response(200)
        self._headers(content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_json(
        self,
        status: int,
        value: dict[str, object],
        extra_headers: list[tuple[str, str]] | None = None,
    ) -> None:
        payload = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self._headers("application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        for name, header_value in extra_headers or []:
            self.send_header(name, header_value)
        self.end_headers()
        self.wfile.write(payload)

    def _headers(self, content_type: str) -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:")

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except ApiError as error:
            self._send_json(error.status, {"error": error.message})

    def log_message(self, format_string: str, *args) -> None:
        print(f"{self.address_string()} - {format_string % args}")


def main() -> None:
    initialize_database()
    server = ThreadingHTTPServer(("127.0.0.1", 8000), LessonHandler)
    print("NextGen Learning Hub is running at http://127.0.0.1:8000")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping NextGen Learning Hub.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
