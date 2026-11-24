from __future__ import annotations

import getpass
import hashlib
import hmac
import secrets
import sqlite3
import sys
from contextlib import closing
from pathlib import Path


DATABASE = Path(__file__).resolve().parent / "data" / "lesson_portal.db"
PASSWORD_ITERATIONS = 200_000
MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 1024


def password_digest(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
    )
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def main() -> int:
    if not DATABASE.is_file():
        print(f"Database not found: {DATABASE}", file=sys.stderr)
        print("Start NextGen Learning Hub once to create its database, then try again.", file=sys.stderr)
        return 1

    try:
        with closing(sqlite3.connect(DATABASE, timeout=10)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN IMMEDIATE")
            administrators = db.execute(
                "SELECT id, name, email FROM users WHERE role = 'admin' ORDER BY id"
            ).fetchall()
            if not administrators:
                print("No administrator account exists to reset.", file=sys.stderr)
                return 1

            print("Administrator accounts:")
            for administrator in administrators:
                print(f"  {administrator['name']} <{administrator['email']}>")
            email = input("Enter the email of the account to reset: ").strip()
            selected = [
                administrator
                for administrator in administrators
                if hmac.compare_digest(administrator["email"].casefold(), email.casefold())
            ]
            if len(selected) != 1:
                print("No administrator account matches that email.", file=sys.stderr)
                return 1

            confirmation = input(
                f"Type RESET to reset {selected[0]['email']}: "
            ).strip()
            if confirmation != "RESET":
                print("Password reset cancelled.")
                return 1

            password = getpass.getpass("New administrator password (12+ characters): ")
            if not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH:
                print(
                    "Password must be between 12 and 1024 characters.",
                    file=sys.stderr,
                )
                return 1
            confirmation_password = getpass.getpass("Confirm new password: ")
            if not hmac.compare_digest(password, confirmation_password):
                print("Passwords do not match.", file=sys.stderr)
                return 1

            db.execute(
                "UPDATE users SET password_hash = ? WHERE id = ? AND role = 'admin'",
                (password_digest(password), selected[0]["id"]),
            )
            db.execute(
                "DELETE FROM sessions WHERE user_id = ?", (selected[0]["id"],)
            )

        print(f"Password reset for {selected[0]['email']}. Sign in with the new password.")
        return 0
    except sqlite3.Error as error:
        print(f"Unable to reset the administrator password: {error}", file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt):
        print("\nPassword reset cancelled.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
