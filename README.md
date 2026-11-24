# NextGen Learning Hub online lessons

A lightweight online-lesson portal with student sign-in, an administrator dashboard, attendance tracking, and a persistent SQLite student database.

## Run locally

Requires Python 3.10 or newer. No packages need to be installed.

```powershell
python server.py
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The SQLite database is created at `data/lesson_portal.db` the first time the server starts and is retained between restarts.

## First-time setup

Create your administrator account from the first-time setup page. Choose a strong password of at least 12 characters. Students can create their own accounts from the sign-in page using **New student? Create an account**; new accounts appear automatically in the administrator's student database. Administrators can also add students from **Students → Add student** or remove an account from the student database. Removing a student permanently deletes their account, sessions, lessons, attendance, and messages after confirmation.

Administrators can view the registered student database, mark attendance by date, and schedule a lesson for at least two selected students at once with a date, time, and meeting link. Each selected student gets an individual lesson and attendance record. Students can mark themselves present or absent for their lesson on the scheduled date before opening its meeting link; the status is recorded in the attendance table for the administrator to review. Students can only mark their own scheduled lessons. The **Messages** area provides private, student-specific conversations between each student and the administrator; students can only access their own conversation. Unread messages show a count beside **Messages** and in the conversation list, with an in-app alert for newly received messages. Opening a conversation marks its messages as read. Passwords are stored as salted PBKDF2 hashes, and sign-in sessions are stored as hashed tokens in SQLite.

## Reset an administrator password

If you forget the administrator password, open PowerShell in this project folder and run:

```powershell
python reset_admin_password.py
```

Follow the prompts to select and confirm the administrator account, then enter a new password of at least 12 characters. Password entry is hidden and is never included in the command or displayed. The reset revokes that administrator's existing sessions; sign in again with the new password.

When updating an existing database, startup removes the built-in sample accounts and their sample attendance records, while keeping other registered student accounts. This is a local app; secure first-time setup before exposing a deployment publicly, and add HTTPS, rate limiting, backups, and a real online-classroom integration.
