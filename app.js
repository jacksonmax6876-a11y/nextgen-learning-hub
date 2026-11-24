const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const today = new Date();
const todayIso = localDate(today);
let currentUser = null;
let dashboard = null;
let currentView = "overview";
let setupRequired = false;
let toastTimer;
let chatConversations = [];
let chatMessages = [];
let activeChatStudentId = null;
let chatInitialized = false;
let chatPollTimer = null;
let chatPolling = false;
let unreadPollTimer = null;
let unreadPolling = false;
let unreadCount = 0;
let unreadMessageConversations = [];
let unreadBaselineReady = false;
let lastObservedMessageIds = new Map();

function localDate(value) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function formatDate(value, options = { month: "short", day: "numeric", year: "numeric" }) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", options).format(new Date(`${value}T12:00:00`));
}

function formatLessonDateTime(value, options = {
  weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
}) {
  return new Intl.DateTimeFormat("en", options).format(new Date(value));
}

function localDateTime(value = new Date()) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function initials(name = "") {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The server returned an invalid response.");
  }
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login") {
      currentUser = null;
      renderLogin();
    }
    throw new Error(payload.error || "Something went wrong. Please try again.");
  }
  return payload;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

function renderLogin(errorMessage = "") {
  stopChatPolling();
  stopUnreadPolling();
  chatInitialized = false;
  chatConversations = [];
  chatMessages = [];
  activeChatStudentId = null;
  unreadCount = 0;
  unreadMessageConversations = [];
  unreadBaselineReady = false;
  lastObservedMessageIds = new Map();
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-aside">
        <a class="brand" href="/" aria-label="NextGen Learning Hub home"><span class="brand-mark">N</span> NextGen Learning Hub</a>
        <div class="aside-copy">
          <div class="eyebrow">A better way to learn</div>
          <h1>Small steps.<br>Big possibilities.</h1>
          <p>Your learning space, thoughtfully designed to help every student find their way forward.</p>
        </div>
        <div class="quote-card"><p>A calm place to learn, grow, and celebrate every step forward.</p></div>
      </section>
      <section class="login-main">
        <div class="login-card">
          <div class="heading-eyebrow">Welcome to your classroom</div>
          <h2>Sign in to NextGen Learning Hub</h2>
          <p class="login-subtitle">Pick up right where your learning journey left off.</p>
          <form id="login-form">
            <div class="form-group">
              <label class="form-label" for="email">Email address</label>
              <input class="field" id="email" name="email" type="email" placeholder="you@example.com" autocomplete="username" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="password">Password</label>
              <div class="input-wrap">
                <input class="field" id="password" name="password" type="password" placeholder="Enter your password" autocomplete="current-password" required>
                <button class="text-button password-toggle" id="password-toggle" type="button">Show</button>
              </div>
            </div>
            <p class="form-error ${errorMessage ? "visible" : ""}" id="login-error" role="alert">${escapeHtml(errorMessage)}</p>
            <button class="primary-button login-submit" type="submit">Sign in <span aria-hidden="true">→</span></button>
          </form>
          <p class="setup-link"><button class="text-button" id="show-student-register" type="button">New student? Create an account</button></p>
          ${setupRequired ? '<p class="setup-link"><button class="text-button" id="show-admin-setup" type="button">First time here? Set up your administrator account</button></p>' : ""}
          <p class="login-footer">A calm, supportive place to learn and grow.</p>
        </div>
      </section>
    </main>`;

  const form = document.querySelector("#login-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const error = document.querySelector("#login-error");
    button.disabled = true;
    button.textContent = "Signing in…";
    error.classList.remove("visible");
    try {
      const result = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({
          email: form.elements.email.value,
          password: form.elements.password.value,
        }),
      });
      currentUser = result.user;
      currentView = "overview";
      await loadDashboard();
    } catch (reason) {
      if (!currentUser) {
        error.textContent = reason.message;
        error.classList.add("visible");
        button.disabled = false;
        button.innerHTML = 'Sign in <span aria-hidden="true">→</span>';
      }
    }
  });

  document.querySelector("#password-toggle").addEventListener("click", (event) => {
    const password = document.querySelector("#password");
    const showing = password.type === "text";
    password.type = showing ? "password" : "text";
    event.currentTarget.textContent = showing ? "Show" : "Hide";
  });

  document.querySelector("#show-admin-setup")?.addEventListener("click", () => renderAdminSetup());
  document.querySelector("#show-student-register").addEventListener("click", () => renderStudentRegister());
}

function renderStudentRegister(errorMessage = "") {
  stopChatPolling();
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-aside">
        <a class="brand" href="/" aria-label="NextGen Learning Hub home"><span class="brand-mark">N</span> NextGen Learning Hub</a>
        <div class="aside-copy">
          <div class="eyebrow">Your learning journey</div>
          <h1>Find your next<br>bright idea.</h1>
          <p>Create a student account to see your lessons, attendance, and private messages from your teacher.</p>
        </div>
        <div class="quote-card"><p>Your own learning space, ready whenever you are.</p></div>
      </section>
      <section class="login-main">
        <div class="login-card">
          <div class="heading-eyebrow">Join your classroom</div>
          <h2>Create a student account</h2>
          <p class="login-subtitle">Register here and sign in to your learning dashboard.</p>
          <form id="register-form">
            <div class="form-group">
              <label class="form-label" for="register-name">Your name</label>
              <input class="field" id="register-name" name="name" maxlength="100" autocomplete="name" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="register-email">Email address</label>
              <input class="field" id="register-email" name="email" type="email" maxlength="254" autocomplete="email" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="register-password">Password</label>
              <input class="field" id="register-password" name="password" type="password" minlength="8" maxlength="1024" autocomplete="new-password" required>
              <span class="field-hint">Use at least 8 characters.</span>
            </div>
            <p class="form-error ${errorMessage ? "visible" : ""}" id="register-error" role="alert">${escapeHtml(errorMessage)}</p>
            <button class="primary-button login-submit" type="submit">Create account <span aria-hidden="true">→</span></button>
          </form>
          <p class="setup-link">Already registered? <button class="text-button" id="show-student-login" type="button">Sign in</button></p>
          <p class="login-footer">Your account is added to the student roster when you register.</p>
        </div>
      </section>
    </main>`;

  document.querySelector("#register-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const error = document.querySelector("#register-error");
    button.disabled = true;
    button.textContent = "Creating account…";
    error.classList.remove("visible");
    try {
      const result = await api("/api/register", {
        method: "POST",
        body: JSON.stringify({
          name: form.elements.name.value,
          email: form.elements.email.value,
          password: form.elements.password.value,
        }),
      });
      currentUser = result.user;
      currentView = "overview";
      chatInitialized = false;
      await loadDashboard();
      showToast("Your student account is ready.");
    } catch (reason) {
      error.textContent = reason.message;
      error.classList.add("visible");
      button.disabled = false;
      button.innerHTML = 'Create account <span aria-hidden="true">→</span>';
    }
  });
  document.querySelector("#show-student-login").addEventListener("click", () => renderLogin());
}

function renderAdminSetup(errorMessage = "") {
  stopChatPolling();
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-aside">
        <a class="brand" href="/" aria-label="NextGen Learning Hub home"><span class="brand-mark">N</span> NextGen Learning Hub</a>
        <div class="aside-copy">
          <div class="eyebrow">Make this space your own</div>
          <h1>Your classroom<br>starts here.</h1>
          <p>Create an administrator account to manage your students, lessons, and attendance.</p>
        </div>
        <div class="quote-card"><p>Your students deserve a learning space that helps them feel supported, seen, and ready to grow.</p></div>
      </section>
      <section class="login-main">
        <div class="login-card">
          <div class="heading-eyebrow">One-time setup</div>
          <h2>Create your administrator account</h2>
          <p class="login-subtitle">This account will manage your student roster and lesson attendance.</p>
          <form id="setup-form">
            <div class="form-group">
              <label class="form-label" for="setup-name">Your name</label>
              <input class="field" id="setup-name" name="name" maxlength="100" autocomplete="name" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="setup-email">Email address</label>
              <input class="field" id="setup-email" name="email" type="email" maxlength="254" autocomplete="email" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="setup-password">Password</label>
              <input class="field" id="setup-password" name="password" type="password" minlength="12" autocomplete="new-password" required>
            </div>
            <p class="form-error ${errorMessage ? "visible" : ""}" id="setup-error" role="alert">${escapeHtml(errorMessage)}</p>
            <button class="primary-button login-submit" type="submit">Create account <span aria-hidden="true">→</span></button>
          </form>
          <p class="setup-link"><button class="text-button" id="show-sign-in" type="button">Already have a student account? Sign in</button></p>
          <p class="login-footer">This setup is available only until an administrator account is created.</p>
        </div>
      </section>
    </main>`;

  document.querySelector("#setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const error = document.querySelector("#setup-error");
    button.disabled = true;
    button.textContent = "Creating account…";
    error.classList.remove("visible");
    try {
      const result = await api("/api/setup/admin", {
        method: "POST",
        body: JSON.stringify({
          name: form.elements.name.value,
          email: form.elements.email.value,
          password: form.elements.password.value,
        }),
      });
      currentUser = result.user;
      setupRequired = false;
      currentView = "overview";
      await loadDashboard();
    } catch (reason) {
      error.textContent = reason.message;
      error.classList.add("visible");
      button.disabled = false;
      button.innerHTML = 'Create account <span aria-hidden="true">→</span>';
    }
  });

  document.querySelector("#show-sign-in").addEventListener("click", () => renderLogin());
}

async function loadDashboard() {
  try {
    dashboard = await api("/api/dashboard");
    renderApp();
  } catch (error) {
    if (currentUser) showToast(error.message, true);
  }
}

function navItems() {
  if (currentUser.role === "admin") {
    return [
      { id: "overview", label: "Overview", icon: "⌂" },
      { id: "attendance", label: "Attendance", icon: "▦" },
      { id: "lessons", label: "Lessons", icon: "◷" },
      { id: "messages", label: "Messages", icon: "✉" },
      { id: "students", label: "Students", icon: "♧" },
    ];
  }
  return [
    { id: "overview", label: "My learning", icon: "⌂" },
    { id: "lessons", label: "My lessons", icon: "◷" },
    { id: "messages", label: "Messages", icon: "✉" },
    { id: "attendance", label: "My attendance", icon: "▦" },
  ];
}

function renderApp() {
  if (!currentUser || !dashboard) return renderLogin();
  const nav = navItems();
  const viewLabel = nav.find((item) => item.id === currentView)?.label || "Overview";
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <a class="brand" href="#" data-view="overview"><span class="brand-mark">N</span> NextGen Learning Hub</a>
        <div class="side-section-label">Workspace</div>
        <nav class="nav-list" aria-label="Main navigation">
          ${nav.map((item) => `
            <button class="nav-item ${item.id === currentView ? "active" : ""}" type="button" data-view="${item.id}">
              <span class="nav-icon" aria-hidden="true">${item.icon}</span><span>${item.label}</span>
              ${item.id === "messages" ? `<span class="message-unread-badge" aria-label="${unreadCount} unread messages" ${unreadCount ? "" : "hidden"}>${unreadCount > 99 ? "99+" : unreadCount}</span>` : ""}
            </button>`).join("")}
        </nav>
        <div class="sidebar-bottom">
          <div class="help-card">
            <strong>Need a hand?</strong>
            <p>Your learning team is here when you need us.</p>
            <button type="button" data-help>Contact support ↗</button>
          </div>
          <div class="profile-mini">
            <span class="profile-avatar">${escapeHtml(initials(currentUser.name))}</span>
            <span class="profile-details"><strong>${escapeHtml(currentUser.name)}</strong><span>${currentUser.role === "admin" ? "Administrator" : "Student"}</span></span>
            <button class="logout-button" id="logout" type="button" aria-label="Sign out" title="Sign out">↗</button>
          </div>
        </div>
      </aside>
      <main class="main-area">
        <header class="topbar">
          <div class="topbar-left">
            <button class="mobile-menu" id="mobile-menu" type="button" aria-label="Open navigation">☰</button>
            <div class="breadcrumb">NextGen Learning Hub <span aria-hidden="true">/</span> <strong>${escapeHtml(viewLabel)}</strong></div>
          </div>
          <div class="topbar-right">
            <span class="today-label">${formatDate(todayIso, { weekday: "long", month: "short", day: "numeric" })}</span>
            <button class="topbar-avatar" type="button" title="${escapeHtml(currentUser.name)}">${escapeHtml(initials(currentUser.name))}</button>
          </div>
        </header>
        <section class="content" id="content">${renderCurrentView()}</section>
      </main>
    </div>`;
  bindShellEvents();
  bindViewEvents();
  bindChatEvents();
  startUnreadPolling();
  if (currentView === "messages") {
    if (!chatInitialized) {
      chatInitialized = true;
      initializeChatView();
    } else if (!chatPollTimer) {
      chatPollTimer = setInterval(pollChatView, 4000);
    }
  } else {
    stopChatPolling();
  }
}

function renderCurrentView() {
  if (currentView === "students" && currentUser.role === "admin") return renderStudents();
  if (currentView === "messages") return renderMessages();
  if (currentView === "lessons") {
    return currentUser.role === "admin" ? renderAdminLessons() : renderStudentLessons();
  }
  if (currentView === "attendance") {
    return currentUser.role === "admin" ? renderAdminAttendance() : renderStudentAttendance();
  }
  return currentUser.role === "admin" ? renderAdminOverview() : renderStudentOverview();
}

function renderAdminOverview() {
  const stats = dashboard.stats;
  return `
    <div class="page-heading">
      <div><div class="heading-eyebrow">Your teaching space</div><h1>Good morning, ${escapeHtml(currentUser.name.split(" ")[0])}</h1><p>Here’s what’s happening with your classroom today.</p></div>
      <button class="secondary-button" type="button" data-view="lessons">＋ &nbsp; Schedule lesson</button>
    </div>
    <div class="metric-grid">
      <article class="metric-card"><div class="metric-top">Registered students <span class="metric-icon">♧</span></div><div class="metric-value">${stats.student_count}</div><div class="metric-note">Active learner accounts</div></article>
      <article class="metric-card"><div class="metric-top">Here today <span class="metric-icon">✓</span></div><div class="metric-value">${stats.present_today}<span style="font-size:13px;color:#99a49d"> / ${stats.student_count}</span></div><div class="metric-note">Present or joined late</div></article>
      <article class="metric-card"><div class="metric-top">Needs follow-up <span class="metric-icon" style="color:#b47a2c;background:#fbf2e4">!</span></div><div class="metric-value">${stats.needs_attention}</div><div class="metric-note">Absent or not yet marked</div></article>
      <article class="metric-card"><div class="metric-top">Attendance rate <span class="metric-icon">↗</span></div><div class="metric-value">${stats.attendance_rate}%</div><div class="metric-note">Today’s classroom attendance</div></article>
    </div>
    <div class="dashboard-grid">
      <section class="panel">
        <div class="panel-header"><div><h2>Today’s attendance</h2><p>Quick view of your registered students</p></div><button class="link-button" type="button" data-view="attendance">Manage attendance →</button></div>
        ${renderAttendanceTable(dashboard.attendance, true)}
      </section>
      <div class="side-stack">
        <section class="panel attendance-summary">
          <h2>Classroom snapshot</h2><p>A little progress, every day.</p>
          <div class="progress-track"><div class="progress-bar" style="width:${stats.attendance_rate}%"></div></div>
          <div class="progress-caption"><span>${stats.present_today} students checked in</span><strong>${stats.attendance_rate}%</strong></div>
        </section>
        <section class="panel attendance-summary">
          <h2>Keep your roster up to date</h2><p>Registered students can sign in to see their lesson and attendance history.</p>
          <button class="secondary-button" style="margin-top:16px" type="button" data-view="students">View student database →</button>
        </section>
      </div>
    </div>`;
}

function renderStudentOverview() {
  const stats = dashboard.stats;
  const attendanceRows = dashboard.attendance.slice(0, 5);
  const nextLesson = dashboard.lessons.find((lesson) => new Date(lesson.starts_at) >= new Date());
  return `
    <div class="page-heading">
      <div><div class="heading-eyebrow">Your learning space</div><h1>Welcome back, ${escapeHtml(currentUser.name.split(" ")[0])}</h1><p>One step at a time. You’re doing great.</p></div>
      <span class="date-pill">◷ &nbsp; ${formatDate(todayIso)}</span>
    </div>
    <div class="metric-grid">
      <article class="metric-card"><div class="metric-top">Attendance rate <span class="metric-icon">↗</span></div><div class="metric-value">${stats.attendance_rate}%</div><div class="metric-note">You’re building a great habit</div></article>
      <article class="metric-card"><div class="metric-top">Lessons attended <span class="metric-icon">✓</span></div><div class="metric-value">${stats.lessons_attended}</div><div class="metric-note">Present or joined late</div></article>
      <article class="metric-card"><div class="metric-top">Lessons recorded <span class="metric-icon">▦</span></div><div class="metric-value">${stats.total_lessons}</div><div class="metric-note">Your learning so far</div></article>
      <article class="metric-card"><div class="metric-top">Next lesson <span class="metric-icon">◷</span></div><div class="metric-value metric-value-small">${nextLesson ? escapeHtml(formatLessonDateTime(nextLesson.starts_at, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : "Not scheduled"}</div><div class="metric-note">${nextLesson ? escapeHtml(nextLesson.title) : "Your teacher will add your next lesson"}</div></article>
    </div>
    <div class="dashboard-grid">
      <section class="panel">
        <div class="panel-header"><div><h2>Your recent attendance</h2><p>A record of your learning journey</p></div><button class="link-button" type="button" data-view="attendance">See all →</button></div>
        ${renderAttendanceTable(attendanceRows)}
      </section>
      <div class="side-stack">
        ${nextLesson ? renderNextLessonCard(nextLesson) : `<section class="panel attendance-summary"><h2>No upcoming lesson</h2><p>Your teacher will add your next lesson and share the meeting link here.</p><button class="secondary-button" style="margin-top:16px" type="button" data-view="lessons">View my lessons →</button></section>`}
        <section class="panel attendance-summary">
          <h2>Showing up adds up</h2><p>Keep your momentum going — every lesson is a new chance to grow.</p>
          <div class="progress-track"><div class="progress-bar" style="width:${stats.attendance_rate}%"></div></div>
          <div class="progress-caption"><span>Your attendance</span><strong>${stats.attendance_rate}%</strong></div>
        </section>
      </div>
    </div>`;
}

function renderNextLessonCard(lesson) {
  return `
    <section class="panel lesson-card">
      <div class="eyebrow">Your next lesson</div>
      <h3>${escapeHtml(lesson.title)}</h3>
      <p>with your NextGen Learning Hub learning group</p>
      <div class="lesson-meta">
        <span>◷ &nbsp; ${escapeHtml(formatLessonDateTime(lesson.starts_at))}</span>
        <span>▣ &nbsp; Live online classroom</span>
      </div>
      ${renderStudentLessonAction(lesson)}
      <button class="link-button lesson-list-link" type="button" data-view="lessons">View all my lessons →</button>
    </section>`;
}

function renderStudentLessons() {
  return `
    <div class="page-heading"><div><div class="heading-eyebrow">Your online classroom</div><h1>My lessons</h1><p>Your upcoming lessons and meeting links, shared by your teacher.</p></div><span class="date-pill">◷ &nbsp; ${dashboard.lessons.length} upcoming</span></div>
    <section class="panel">
      <div class="panel-header"><div><h2>Upcoming lessons</h2><p>All times are shown in your local timezone.</p></div></div>
      ${renderLessonsTable(dashboard.lessons)}
    </section>`;
}

function renderAdminLessons() {
  const students = dashboard.students;
  return `
    <div class="page-heading"><div><div class="heading-eyebrow">Plan your classroom</div><h1>Lessons</h1><p>Schedule a lesson for a student and share its online meeting link.</p></div><span class="date-pill">◷ &nbsp; ${dashboard.lessons.length} upcoming</span></div>
    <section class="form-panel open" id="schedule-lesson-panel">
      <h2>Schedule a lesson</h2>
      ${students.length ? `
        <form class="lesson-form" id="schedule-lesson-form">
          <fieldset class="student-picker">
            <legend>Students <span>Choose at least 2</span></legend>
            <label class="student-option select-all-option"><input id="select-all-students" type="checkbox"><span><strong>All students</strong><small>Select the whole class</small></span></label>
            <div class="student-option-list">${students.map((student) => `
              <label class="student-option">
                <input type="checkbox" name="student_ids" value="${student.id}">
                <span><strong>${escapeHtml(student.name)}</strong><small>${escapeHtml(student.email)}</small></span>
              </label>`).join("")}
            </div>
            <p class="selection-count" id="student-selection-count">0 students selected — choose at least 2.</p>
            <p class="form-error selection-error" id="student-selection-error" role="alert"></p>
          </fieldset>
          <div class="form-group"><label class="form-label" for="lesson-title">Lesson name</label><input class="field" id="lesson-title" name="title" maxlength="120" placeholder="e.g. Creative writing" required></div>
          <div class="form-group"><label class="form-label" for="lesson-start">Date and time</label><input class="field" id="lesson-start" name="starts_at" type="datetime-local" required><span class="field-hint">Shown in your local timezone.</span></div>
          <div class="form-group"><label class="form-label" for="lesson-link">Meeting link</label><input class="field" id="lesson-link" name="meeting_url" type="url" maxlength="2048" placeholder="https://meet.google.com/…" required><span class="field-hint">Paste the full Google Meet, Zoom, or other call link.</span></div>
          <div class="lesson-form-actions"><button class="primary-button" type="submit">＋ &nbsp; Schedule lesson</button></div>
        </form>` : '<div class="empty-state">Register a student first, then you can schedule lessons for them.</div>'}
    </section>
    <section class="panel">
      <div class="panel-header"><div><h2>Upcoming lessons</h2><p>Students will see their own lessons and join links on their dashboard.</p></div></div>
      ${renderLessonsTable(dashboard.lessons, true)}
    </section>`;
}

function renderLessonsTable(lessons, isAdmin = false) {
  if (!lessons.length) {
    return `<div class="empty-state">${isAdmin ? "No upcoming lessons. Schedule one above to share a meeting link with a student." : "No upcoming lessons yet. Your teacher will share the time and meeting link here."}</div>`;
  }
  return `<div class="table-wrap"><table>
    <thead><tr><th>Date and time</th><th>Lesson</th>${isAdmin ? "<th>Student</th><th>Attendance</th><th>Meeting link</th><th></th>" : "<th>Attendance</th><th>Online classroom</th>"}</tr></thead>
    <tbody>${lessons.map((lesson) => `
      <tr>
        <td>${escapeHtml(formatLessonDateTime(lesson.starts_at))}</td>
        <td><strong>${escapeHtml(lesson.title)}</strong></td>
        ${isAdmin
          ? `<td><span class="student-cell"><span class="table-avatar">${escapeHtml(initials(lesson.student_name))}</span><strong>${escapeHtml(lesson.student_name)}</strong></span></td>
            <td>${statusBadge(lesson.attendance_status)}</td>
            <td><a class="table-link" href="${escapeHtml(lesson.meeting_url)}" target="_blank" rel="noopener noreferrer">Open meeting link ↗</a></td>
            <td><button class="cancel-lesson-button" type="button" data-delete-lesson="${lesson.id}">Cancel</button></td>`
          : `<td>${statusBadge(lesson.attendance_status)}</td><td>${renderStudentLessonAction(lesson)}</td>`}
      </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderStudentLessonAction(lesson) {
  const canMarkToday = localDate(new Date(lesson.starts_at)) === todayIso;
  const attendanceStatus = lesson.attendance_status;
  return `
    <div class="lesson-access" data-lesson-id="${lesson.id}">
      <button class="lesson-button" type="button" data-show-checkin>Join your classroom <span aria-hidden="true">→</span></button>
      <div class="lesson-checkin" data-checkin-panel hidden>
        <p>${attendanceStatus ? `Current attendance: ${escapeHtml(attendanceStatus)}. Update if needed.` : "Before joining, mark yourself present or absent."}</p>
        <div class="checkin-actions">
          <button class="checkin-button present" type="button" data-mark-attendance="Present" ${canMarkToday ? "" : "disabled"}>Mark present</button>
          <button class="checkin-button absent" type="button" data-mark-attendance="Absent" ${canMarkToday ? "" : "disabled"}>Mark absent</button>
        </div>
        ${canMarkToday ? "" : '<span class="field-hint">Attendance opens on the lesson date.</span>'}
        <p class="checkin-feedback" data-checkin-feedback role="status"></p>
        ${attendanceStatus === "Present" ? `<a class="table-link" href="${escapeHtml(lesson.meeting_url)}" target="_blank" rel="noopener noreferrer">Open online classroom ↗</a>` : ""}
      </div>
    </div>`;
}

function renderStudentAttendance() {
  return `
    <div class="page-heading"><div><div class="heading-eyebrow">Your learning journey</div><h1>My attendance</h1><p>All your recorded lessons in one place.</p></div><span class="date-pill">▦ &nbsp; ${dashboard.stats.total_lessons} lessons</span></div>
    <section class="panel">
      <div class="panel-header"><div><h2>Attendance history</h2><p>Ask your teacher if you have a question about a record.</p></div></div>
      ${renderAttendanceTable(dashboard.attendance)}
    </section>`;
}

function renderAdminAttendance() {
  return `
    <div class="page-heading"><div><div class="heading-eyebrow">Classroom records</div><h1>Attendance</h1><p>Mark and review attendance for your registered students.</p></div><span class="date-pill">▦ &nbsp; ${dashboard.stats.student_count} students</span></div>
    <section class="panel">
      <div class="attendance-toolbar"><p>Choose a status for each student, then save your changes.</p><input class="date-field" id="attendance-date" type="date" value="${escapeHtml(todayIso)}" aria-label="Attendance date"></div>
      <div id="attendance-manage-table">${renderManageAttendanceTable(dashboard.attendance)}</div>
    </section>`;
}

function renderMessages() {
    if (currentUser.role === "admin") {
      const activeConversation = chatConversations.find(
        (conversation) => Number(conversation.student_id) === Number(activeChatStudentId),
      );
      return `
        <div class="page-heading"><div><div class="heading-eyebrow">Private conversations</div><h1>Messages</h1><p>Talk privately with your students.</p></div></div>
        <div class="chat-layout">
          <aside class="panel chat-conversations">
            <div class="panel-header"><div><h2>Student conversations</h2><p>${chatConversations.length} registered ${chatConversations.length === 1 ? "student" : "students"}</p></div></div>
            <div class="chat-conversation-list" id="chat-conversation-list">${renderConversationList()}</div>
          </aside>
          <section class="panel chat-panel" aria-label="Private student conversation">
            ${activeConversation
              ? `<div class="chat-thread-header"><span class="table-avatar">${escapeHtml(initials(activeConversation.name))}</span><div><strong>${escapeHtml(activeConversation.name)}</strong><small>${escapeHtml(activeConversation.email)}</small></div></div>
                <div class="chat-thread" id="chat-thread">${renderChatMessages()}</div>
                <form class="chat-composer" id="chat-form" data-student-id="${activeConversation.student_id}">
                  <label class="sr-only" for="chat-message">Write a message</label>
                  <textarea id="chat-message" name="body" rows="2" maxlength="2000" placeholder="Write a private message…" required></textarea>
                  <button class="primary-button" type="submit">Send <span aria-hidden="true">→</span></button>
                </form>`
              : `<div class="empty-state chat-empty">Register a student to start a private conversation.</div>`}
          </section>
        </div>`;
    }

    return `
      <div class="page-heading"><div><div class="heading-eyebrow">Private conversation</div><h1>Messages</h1><p>Send a private message to your learning team.</p></div></div>
      <section class="panel chat-panel student-chat-panel" aria-label="Private conversation with your learning team">
        <div class="chat-thread-header"><span class="profile-avatar">N</span><div><strong>NextGen Learning Hub learning team</strong><small>Private conversation</small></div></div>
        <div class="chat-thread" id="chat-thread">${renderChatMessages()}</div>
        <form class="chat-composer" id="chat-form">
          <label class="sr-only" for="chat-message">Write a message</label>
          <textarea id="chat-message" name="body" rows="2" maxlength="2000" placeholder="Write a private message…" required></textarea>
          <button class="primary-button" type="submit">Send <span aria-hidden="true">→</span></button>
        </form>
      </section>`;
}

function renderConversationList() {
    if (!chatInitialized) return '<div class="empty-state">Loading conversations…</div>';
    if (!chatConversations.length) return '<div class="empty-state">No students are registered yet.</div>';
    return chatConversations.map((conversation) => {
      const selected = Number(conversation.student_id) === Number(activeChatStudentId);
      const unread = unreadMessageConversations.find(
        (item) => Number(item.student_id) === Number(conversation.student_id),
      )?.unread_count || 0;
      const preview = conversation.last_message
        ? `${Number(conversation.last_sender_id) === Number(currentUser.id) ? "You: " : ""}${conversation.last_message}`
        : "No messages yet";
      return `<button class="chat-conversation ${selected ? "active" : ""}" type="button" data-chat-student="${conversation.student_id}" aria-current="${selected ? "true" : "false"}">
        <span class="table-avatar">${escapeHtml(initials(conversation.name))}</span>
        <span class="chat-conversation-copy"><strong>${escapeHtml(conversation.name)}</strong><small>${escapeHtml(preview)}</small></span>
        <span class="chat-conversation-meta">${unread ? `<span class="chat-unread-badge" aria-label="${unread} unread messages">${unread > 99 ? "99+" : unread}</span>` : ""}<time>${conversation.last_message_at ? formatChatTime(conversation.last_message_at) : ""}</time></span>
      </button>`;
    }).join("");
}

function renderChatMessages() {
    if (!chatInitialized) return '<div class="empty-state">Loading messages…</div>';
    if (!chatMessages.length) return '<div class="empty-state chat-empty">No messages yet. Start the conversation below.</div>';
    return chatMessages.map((message) => {
      const ownMessage = Number(message.sender_id) === Number(currentUser.id);
      return `<article class="chat-message ${ownMessage ? "outgoing" : "incoming"}">
        <div class="chat-bubble">
          ${ownMessage ? "" : `<strong>${escapeHtml(message.sender_name)}</strong>`}
          <p>${escapeHtml(message.body).replace(/\n/g, "<br>")}</p>
          <time datetime="${escapeHtml(message.created_at)}">${formatChatTime(message.created_at)}</time>
        </div>
      </article>`;
    }).join("");
}

function formatChatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }).format(date);
}

async function initializeChatView() {
    try {
      if (currentUser.role === "admin") {
        const result = await api("/api/messages");
        chatConversations = result.conversations;
        if (!chatConversations.some((conversation) => Number(conversation.student_id) === Number(activeChatStudentId))) {
          activeChatStudentId = chatConversations.length ? Number(chatConversations[0].student_id) : null;
        }
      } else {
        activeChatStudentId = Number(currentUser.id);
      }
      await loadChatMessages();
      await markCurrentConversationRead();
    } catch (error) {
      showToast(error.message, true);
      chatMessages = [];
    }
    if (currentView === "messages") renderApp();
}

async function loadChatMessages() {
    if (currentUser.role === "admin" && activeChatStudentId === null) {
      chatMessages = [];
      return;
    }
    const path = currentUser.role === "admin"
      ? `/api/messages?student_id=${encodeURIComponent(activeChatStudentId)}`
      : "/api/messages";
    const result = await api(path);
    chatMessages = result.messages;
}

async function markCurrentConversationRead() {
  if (currentUser.role === "admin" && activeChatStudentId === null) return;
  await api("/api/messages/read", {
    method: "POST",
    body: JSON.stringify(currentUser.role === "admin" ? { student_id: activeChatStudentId } : {}),
  });
}

async function pollChatView() {
    if (chatPolling || currentView !== "messages" || !currentUser) return;
    chatPolling = true;
    try {
      const thread = document.querySelector("#chat-thread");
      const keepAtBottom = !thread || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
      if (currentUser.role === "admin") {
        const result = await api("/api/messages");
        chatConversations = result.conversations;
        if (!chatConversations.some((conversation) => Number(conversation.student_id) === Number(activeChatStudentId))) {
          activeChatStudentId = chatConversations.length ? Number(chatConversations[0].student_id) : null;
        }
      }
      await loadChatMessages();
      const list = document.querySelector("#chat-conversation-list");
      if (list) list.innerHTML = renderConversationList();
      if (thread) {
        thread.innerHTML = renderChatMessages();
        if (keepAtBottom) thread.scrollTop = thread.scrollHeight;
      }
      await markCurrentConversationRead();
      await refreshUnreadMessages();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      chatPolling = false;
    }
}

function stopChatPolling() {
    if (chatPollTimer) clearInterval(chatPollTimer);
    chatPollTimer = null;
}

function startUnreadPolling() {
  if (unreadPollTimer) return;
  refreshUnreadMessages();
  unreadPollTimer = setInterval(refreshUnreadMessages, 5000);
}

function stopUnreadPolling() {
  if (unreadPollTimer) clearInterval(unreadPollTimer);
  unreadPollTimer = null;
  unreadPolling = false;
}

async function refreshUnreadMessages() {
  if (unreadPolling || !currentUser) return;
  unreadPolling = true;
  try {
    const result = await api("/api/messages/unread");
    const unreadItems = currentUser.role === "admin"
      ? result.conversations
      : (result.latest_message_id ? [{
        student_id: currentUser.id,
        unread_count: result.unread_count,
        latest_message_id: result.latest_message_id,
        name: result.latest_sender_name,
      }] : []);
    const newMessages = [];
    for (const item of unreadItems) {
      const key = Number(item.student_id);
      const latestId = Number(item.latest_message_id);
      const previousId = lastObservedMessageIds.get(key);
      if (unreadBaselineReady && previousId !== undefined && latestId > previousId && item.unread_count > 0) {
        const isOpenThread = currentView === "messages"
          && (currentUser.role !== "admin" || Number(activeChatStudentId) === key);
        if (!isOpenThread) newMessages.push(item.name);
      }
      lastObservedMessageIds.set(key, latestId);
    }

    unreadCount = result.unread_count;
    unreadMessageConversations = currentUser.role === "admin"
      ? result.conversations.filter((item) => item.unread_count > 0)
      : [];
    unreadBaselineReady = true;
    updateUnreadIndicators();
    if (newMessages.length) {
      const names = [...new Set(newMessages.filter(Boolean))];
      showToast(names.length === 1 ? `New message from ${names[0]}.` : `New messages from ${names.length} students.`);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    unreadPolling = false;
  }
}

function updateUnreadIndicators() {
  const badge = document.querySelector(".message-unread-badge");
  if (badge) {
    badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
    badge.hidden = unreadCount === 0;
    badge.setAttribute("aria-label", `${unreadCount} unread messages`);
  }
  const list = document.querySelector("#chat-conversation-list");
  if (list) list.innerHTML = renderConversationList();
}

async function sendChatMessage(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const bodyField = form.elements.body;
    const button = form.querySelector('button[type="submit"]');
    const body = bodyField.value.trim();
    if (!body) return;
    button.disabled = true;
    try {
      await api("/api/messages", {
        method: "POST",
        body: JSON.stringify({
          body,
          ...(form.dataset.studentId ? { student_id: Number(form.dataset.studentId) } : {}),
        }),
      });
      bodyField.value = "";
      await markCurrentConversationRead();
      await pollChatView();
      await refreshUnreadMessages();
      const thread = document.querySelector("#chat-thread");
      if (thread) thread.scrollTop = thread.scrollHeight;
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
      bodyField.focus();
    }
}

function bindChatEvents() {
    document.querySelector("#chat-form")?.addEventListener("submit", sendChatMessage);
    document.querySelector("#chat-conversation-list")?.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-chat-student]");
      if (!button) return;
      activeChatStudentId = Number(button.dataset.chatStudent);
      try {
        await markCurrentConversationRead();
        await loadChatMessages();
        await refreshUnreadMessages();
        renderApp();
        const thread = document.querySelector("#chat-thread");
        if (thread) thread.scrollTop = thread.scrollHeight;
      } catch (error) {
        showToast(error.message, true);
      }
    });
}

function renderStudents() {
  const students = dashboard.students;
  return `
    <div class="page-heading"><div><div class="heading-eyebrow">Your classroom</div><h1>Student database</h1><p>Manage the students registered for your online lessons.</p></div><button class="primary-button" id="show-add-student" type="button">＋ &nbsp; Add student</button></div>
    <section class="form-panel" id="add-student-panel">
      <h2>Register a student</h2>
      <form class="inline-form" id="add-student-form">
        <div class="form-group"><label class="form-label" for="student-name">Student name</label><input class="field" id="student-name" name="name" maxlength="100" placeholder="Full name" required></div>
        <div class="form-group"><label class="form-label" for="student-email">Email address</label><input class="field" id="student-email" name="email" type="email" placeholder="student@example.com" required></div>
        <div class="form-group"><label class="form-label" for="student-password">Temporary password</label><input class="field" id="student-password" name="password" type="text" minlength="8" placeholder="At least 8 characters" required></div>
        <button class="primary-button" type="submit">Register</button>
      </form>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div><h2>Registered students <span style="color:#95a19a;font-size:11px;font-weight:500">(${students.length})</span></h2><p>Student accounts and lesson attendance history</p></div>
        <div class="toolbar"><input class="search-field" id="student-search" type="search" placeholder="Search students…" aria-label="Search students"><span class="date-pill">◷ &nbsp; Joined</span></div>
      </div>
      ${renderStudentTable(students)}
    </section>`;
}

function renderAttendanceTable(records, showEmail = false) {
  if (!records?.length) return '<div class="empty-state">No attendance records yet.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr>${showEmail ? "<th>Student</th>" : "<th>Lesson date</th>"}${showEmail ? "<th>Student email</th>" : ""}<th>${showEmail ? "Status" : "Attendance"}</th>${showEmail ? "" : "<th> "}</th></tr></thead>
    <tbody>${records.map((record) => `
      <tr>
        ${showEmail
          ? `<td><span class="student-cell"><span class="table-avatar">${escapeHtml(initials(record.name))}</span><strong>${escapeHtml(record.name)}</strong></span></td><td>${escapeHtml(record.email)}</td>`
          : `<td>${formatDate(record.date)}</td>`}
        <td>${statusBadge(record.status)}</td>
        ${showEmail ? "" : `<td>${record.status === "Present" || record.status === "Late" ? "Lesson attended" : " "}</td>`}
      </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderManageAttendanceTable(records) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Student</th><th>Email</th><th>Current status</th><th>Update</th></tr></thead>
    <tbody>${records.map((record) => `
      <tr data-student-id="${record.student_id}">
        <td><span class="student-cell"><span class="table-avatar">${escapeHtml(initials(record.name))}</span><strong>${escapeHtml(record.name)}</strong></span></td>
        <td>${escapeHtml(record.email)}</td>
        <td>${statusBadge(record.status)}</td>
        <td><div style="display:flex;align-items:center;gap:7px">
          <select class="status-select" aria-label="Attendance status for ${escapeHtml(record.name)}">
            <option value="">Not marked</option>
            ${["Present", "Late", "Absent", "Excused"].map((status) => `<option value="${status}" ${record.status === status ? "selected" : ""}>${status}</option>`).join("")}
          </select>
          <button class="save-row" type="button" data-save-attendance>Save</button>
        </div></td>
      </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderStudentTable(students) {
  if (!students.length) return '<div class="empty-state">No students are registered yet. Add your first student to get started.</div>';
  return `<div class="table-wrap"><table id="students-table">
    <thead><tr><th>Student</th><th>Email address</th><th>Lessons recorded</th><th>Attendance</th><th>Registered</th><th>Actions</th></tr></thead>
    <tbody>${students.map((student) => {
      const rate = student.lessons ? Math.round((student.attended || 0) / student.lessons * 100) : 0;
      return `<tr data-search="${escapeHtml(`${student.name} ${student.email}`.toLowerCase())}">
        <td><span class="student-cell"><span class="table-avatar">${escapeHtml(initials(student.name))}</span><strong>${escapeHtml(student.name)}</strong></span></td>
        <td>${escapeHtml(student.email)}</td><td>${student.lessons}</td><td>${rate}%</td><td>${formatDate(student.created_at.slice(0, 10))}</td>
        <td><button class="remove-student-button" type="button" data-remove-student="${student.id}" data-student-name="${escapeHtml(student.name)}">Remove</button></td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

function statusBadge(status) {
  const normalized = status || "Not marked";
  const className = normalized === "Not marked" ? "pending" : normalized.toLowerCase();
  return `<span class="badge ${className}">${escapeHtml(normalized)}</span>`;
}

function bindShellEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (button.dataset.view !== "messages") chatInitialized = false;
      currentView = button.dataset.view;
      document.querySelector("#sidebar").classList.remove("open");
      renderApp();
    });
  });
  document.querySelector("#mobile-menu").addEventListener("click", () => {
    document.querySelector("#sidebar").classList.toggle("open");
  });
  document.querySelector("#logout").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
      currentUser = null;
      dashboard = null;
      chatInitialized = false;
      stopChatPolling();
      stopUnreadPolling();
      renderLogin();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  document.querySelector("[data-help]").addEventListener("click", () => showToast("Contact your NextGen Learning Hub learning team for support."));
}

function bindViewEvents() {
  document.querySelectorAll("[data-show-checkin]").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = button.parentElement.querySelector("[data-checkin-panel]");
      panel.hidden = !panel.hidden;
    });
  });
  document.querySelectorAll("[data-mark-attendance]").forEach((button) => {
    button.addEventListener("click", async () => {
      const panel = button.closest("[data-checkin-panel]");
      const lessonAccess = button.closest("[data-lesson-id]");
      const buttons = panel.querySelectorAll("[data-mark-attendance]");
      buttons.forEach((action) => { action.disabled = true; });
      try {
        const result = await api(`/api/lessons/${lessonAccess.dataset.lessonId}/attendance`, {
          method: "POST",
          body: JSON.stringify({ status: button.dataset.markAttendance }),
        });
        showToast(`Attendance marked ${result.status.toLowerCase()}.`);
        await loadDashboard();
        const updatedPanel = document.querySelector(
          `[data-lesson-id="${lessonAccess.dataset.lessonId}"] [data-checkin-panel]`,
        );
        if (updatedPanel) {
          updatedPanel.hidden = false;
          updatedPanel.querySelector("[data-checkin-feedback]").textContent =
            `Your attendance is marked ${result.status.toLowerCase()}.`;
        }
      } catch (error) {
        buttons.forEach((action) => { action.disabled = false; });
        showToast(error.message, true);
      }
    });
  });

  const addButton = document.querySelector("#show-add-student");
  if (addButton) {
    addButton.addEventListener("click", () => {
      const panel = document.querySelector("#add-student-panel");
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) document.querySelector("#student-name").focus();
    });
    document.querySelector("#add-student-form").addEventListener("submit", addStudent);
    document.querySelector("#student-search").addEventListener("input", (event) => {
      const query = event.target.value.trim().toLowerCase();
      document.querySelectorAll("#students-table tbody tr").forEach((row) => {
        row.hidden = !row.dataset.search.includes(query);
      });
    });
    document.querySelectorAll("[data-remove-student]").forEach((button) => {
      button.addEventListener("click", async () => {
        const studentName = button.dataset.studentName;
        if (!window.confirm(`Remove ${studentName} from NextGen Learning Hub? Their login, lessons, attendance, and messages will be permanently deleted.`)) return;
        button.disabled = true;
        try {
          await api(`/api/students/${button.dataset.removeStudent}`, { method: "DELETE" });
          if (Number(activeChatStudentId) === Number(button.dataset.removeStudent)) {
            activeChatStudentId = null;
            chatMessages = [];
            chatInitialized = false;
          }
          lastObservedMessageIds.delete(Number(button.dataset.removeStudent));
          await loadDashboard();
          await refreshUnreadMessages();
          showToast(`${studentName} has been removed.`);
        } catch (error) {
          button.disabled = false;
          showToast(error.message, true);
        }
      });
    });
  }

  const scheduleForm = document.querySelector("#schedule-lesson-form");
  if (scheduleForm) {
    scheduleForm.elements.starts_at.min = localDateTime();
    scheduleForm.addEventListener("submit", scheduleLesson);
    scheduleForm.querySelectorAll('input[name="student_ids"]').forEach((checkbox) => {
      checkbox.addEventListener("change", updateStudentSelection);
    });
    document.querySelector("#select-all-students").addEventListener("change", (event) => {
      scheduleForm.querySelectorAll('input[name="student_ids"]').forEach((checkbox) => {
        checkbox.checked = event.currentTarget.checked;
      });
      updateStudentSelection();
    });
  }
  document.querySelectorAll("[data-delete-lesson]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("Cancel this scheduled lesson?")) return;
      button.disabled = true;
      try {
        await api(`/api/lessons/${button.dataset.deleteLesson}`, { method: "DELETE" });
        showToast("Lesson cancelled.");
        await loadDashboard();
      } catch (error) {
        button.disabled = false;
        showToast(error.message, true);
      }
    });
  });

  const dateInput = document.querySelector("#attendance-date");
  if (dateInput) {
    dateInput.addEventListener("change", async () => {
      try {
        const result = await api(`/api/attendance?date=${encodeURIComponent(dateInput.value)}`);
        document.querySelector("#attendance-manage-table").innerHTML = renderManageAttendanceTable(result.attendance);
        bindAttendanceButtons();
      } catch (error) {
        showToast(error.message, true);
      }
    });
    bindAttendanceButtons();
  }
}

async function scheduleLesson(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const selectedIds = [...form.querySelectorAll('input[name="student_ids"]:checked')]
    .map((checkbox) => Number(checkbox.value));
  const selectionError = document.querySelector("#student-selection-error");
  if (selectedIds.length < 2) {
    selectionError.textContent = "Select at least 2 students for this lesson.";
    selectionError.classList.add("visible");
    return;
  }
  selectionError.textContent = "";
  selectionError.classList.remove("visible");
  button.disabled = true;
  try {
    await api("/api/lessons", {
      method: "POST",
      body: JSON.stringify({
        student_ids: selectedIds,
        title: form.elements.title.value,
        starts_at: new Date(form.elements.starts_at.value).toISOString(),
        meeting_url: form.elements.meeting_url.value,
      }),
    });
    showToast("Lesson scheduled and shared with the student.");
    form.reset();
    await loadDashboard();
  } catch (error) {
    button.disabled = false;
    showToast(error.message, true);
  }
}

function updateStudentSelection() {
  const checkboxes = [...document.querySelectorAll('#schedule-lesson-form input[name="student_ids"]')];
  const checked = checkboxes.filter((checkbox) => checkbox.checked);
  const selectAll = document.querySelector("#select-all-students");
  selectAll.checked = checkboxes.length > 0 && checked.length === checkboxes.length;
  selectAll.indeterminate = checked.length > 0 && checked.length < checkboxes.length;
  document.querySelector("#student-selection-count").textContent =
    `${checked.length} ${checked.length === 1 ? "student" : "students"} selected — choose at least 2.`;
  const selectionError = document.querySelector("#student-selection-error");
  if (checked.length >= 2) {
    selectionError.textContent = "";
    selectionError.classList.remove("visible");
  }
}

function bindAttendanceButtons() {
  document.querySelectorAll("[data-save-attendance]").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest("tr");
      const status = row.querySelector(".status-select").value;
      if (!status) return showToast("Choose an attendance status first.", true);
      const date = document.querySelector("#attendance-date").value;
      button.disabled = true;
      try {
        await api("/api/attendance", {
          method: "POST",
          body: JSON.stringify({ student_id: Number(row.dataset.studentId), date, status }),
        });
        showToast("Attendance saved.");
        await loadDashboard();
        if (currentView === "attendance") {
          const result = await api(`/api/attendance?date=${encodeURIComponent(date)}`);
          document.querySelector("#attendance-manage-table").innerHTML = renderManageAttendanceTable(result.attendance);
          bindAttendanceButtons();
        }
      } catch (error) {
        button.disabled = false;
        showToast(error.message, true);
      }
    });
  });
}

async function addStudent(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/students", {
      method: "POST",
      body: JSON.stringify({
        name: form.elements.name.value,
        email: form.elements.email.value,
        password: form.elements.password.value,
      }),
    });
    showToast("Student registered successfully.");
    form.reset();
    document.querySelector("#add-student-panel").classList.remove("open");
    await loadDashboard();
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
  }
}

async function start() {
  try {
    const result = await api("/api/session");
    currentUser = result.user;
    setupRequired = result.setup_required;
    if (currentUser) await loadDashboard();
    else if (setupRequired) renderAdminSetup();
    else renderLogin();
  } catch (error) {
    app.innerHTML = `<main class="login-main"><div class="login-card"><h2>Unable to connect</h2><p class="login-subtitle">${escapeHtml(error.message)} Start the NextGen Learning Hub server and reload this page.</p></div></main>`;
  }
}

start();
