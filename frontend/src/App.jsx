import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Bell,
  Building2,
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  Download,
  Filter,
  KeyRound,
  ImagePlus,
  LayoutDashboard,
  Leaf,
  LoaderCircle,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  Moon,
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  ShieldCheck,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  Users,
  X,
} from "lucide-react";

const FREQUENCIES = ["Diário", "Semanal", "Quinzenal", "Mensal"];
const STATUSES = ["Limpo", "Não limpo"];
const WEEKDAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const sameSector = (left, right) => String(left || "").trim().toLocaleLowerCase("pt-BR")
  === String(right || "").trim().toLocaleLowerCase("pt-BR");
const navItems = [
  { id: "dashboard", label: "Visão geral", icon: LayoutDashboard },
  { id: "tasks", label: "Tarefas", icon: ListChecks },
  { id: "locations", label: "Limpeza", icon: Leaf, companyOnly: true },
  { id: "history", label: "Histórico", icon: ClipboardCheck },
  { id: "team", label: "Equipe", icon: Users, companyOnly: true },
];

function formatDeadline(value) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function deadlineUrgency(value, now = Date.now()) {
  const remaining = new Date(value).getTime() - now;
  if (remaining <= 2 * 60 * 60 * 1000) return "urgent";
  if (remaining <= 24 * 60 * 60 * 1000) return "soon";
  if (remaining <= 7 * 24 * 60 * 60 * 1000) return "approaching";
  return "normal";
}

function deadlineCountdown(value, now = Date.now()) {
  const remaining = new Date(value).getTime() - now;
  if (remaining <= 0) return "Prazo vencido";
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);
  if (days) return `Vence em ${days} ${days === 1 ? "dia" : "dias"}`;
  if (hours) return `Vence em ${hours} ${hours === 1 ? "hora" : "horas"}`;
  const minutes = Math.max(1, Math.floor(remaining / (60 * 1000)));
  return `Vence em ${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
    });
  } catch (cause) {
    const error = new Error(
      "Não foi possível conectar à API do Routiner. Confirme que o servidor Python está rodando e tente novamente.",
      { cause },
    );
    error.name = "ApiConnectionError";
    throw error;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = new Error(body?.detail || `Não foi possível completar a operação (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function formatDate(value) {
  if (!value) return "Ainda sem registro";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${value.slice(0, 10)}T12:00:00Z`),
  );
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" })
    .format(new Date(value));
}

function scheduleDescription(scheduleDays, scheduleTime) {
  let days = [];
  try {
    days = Array.isArray(scheduleDays) ? scheduleDays : JSON.parse(scheduleDays || "[]");
  } catch {
    return "Rotina não configurada";
  }
  const selectedDays = days.map((day) => WEEKDAYS[day]).filter(Boolean).join(", ");
  return selectedDays ? `${selectedDays} · ${scheduleTime || "23:59"}` : "Rotina não configurada";
}

function todayValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function initials(name = "") {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "—";
}

function defaultAppearance() {
  return { theme: "system", accent: "#2563eb" };
}

function appearanceStorageKey(account) {
  return `routiner-appearance:${account.login}`;
}

function App() {
  const [account, setAccount] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [installPrompt, setInstallPrompt] = useState(null);

  useEffect(() => {
    api("/auth/me")
      .then(setAccount)
      .catch((error) => {
        if (error.status !== 401) setAuthError(error.message);
      })
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    const onInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const onInstalled = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function logout() {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setAccount(null);
    }
  }

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  if (authLoading) {
    return <div className="auth-loading"><LoaderCircle className="spin" size={24} /><span>Conectando ao Routiner…</span></div>;
  }
  if (!account) {
    return <AuthPage
      initialError={authError}
      onAuthenticated={(nextAccount) => { setAuthError(""); setAccount(nextAccount); }}
    />;
  }
  return <Workspace account={account} onLogout={logout} installPrompt={installPrompt} onInstall={installApp} />;
}

function Workspace({ account, onLogout, installPrompt, onInstall }) {
  const [page, setPage] = useState("dashboard");
  const [mobileNav, setMobileNav] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [appearance, setAppearance] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(appearanceStorageKey(account)) || "{}");
      return {
        ...defaultAppearance(),
        ...saved,
        accent: saved.accent === "#557c68" ? "#2563eb" : saved.accent || defaultAppearance().accent,
      };
    } catch {
      return defaultAppearance();
    }
  });
  const [locations, setLocations] = useState([]);
  const [history, setHistory] = useState([]);
  const [team, setTeam] = useState([]);
  const [sectors, setSectors] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [acknowledgmentTask, setAcknowledgmentTask] = useState(null);
  const [acknowledgmentError, setAcknowledgmentError] = useState("");
  const [taskNow, setTaskNow] = useState(Date.now());
  const [dashboard, setDashboard] = useState(null);
  const [query, setQuery] = useState("");
  const [frequencyFilter, setFrequencyFilter] = useState("");
  const [responsibleFilter, setResponsibleFilter] = useState("");
  const [photoFilter, setPhotoFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [passwordPromptPending, setPasswordPromptPending] = useState(
    account.role === "user" && Boolean(account.initial_password_pending),
  );
  const isBoss = account.role === "company";

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = appearance.theme;
    root.style.setProperty("--custom-accent", appearance.accent);
    try {
      localStorage.setItem(appearanceStorageKey(account), JSON.stringify(appearance));
    } catch (error) {
      setPageError(`Não foi possível salvar as configurações visuais neste dispositivo: ${error.message}`);
    }
  }, [account, appearance]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setPageError("");
    try {
      const [locationRows, historyRows, dashboardData, teamRows, taskRows, notificationRows, sectorRows] = await Promise.all([
        api("/locations"),
        api("/history"),
        api("/dashboard"),
        isBoss ? api("/users") : Promise.resolve([]),
        api("/tasks"),
        isBoss ? api("/notifications") : Promise.resolve([]),
        isBoss ? api("/sectors") : Promise.resolve([]),
      ]);
      setLocations(locationRows);
      setHistory(historyRows);
      setDashboard(dashboardData);
      setTeam(teamRows);
      setSectors(sectorRows);
      setTasks(taskRows);
      setNotifications(notificationRows);
    } catch (error) {
      if (error.status === 401) {
        await onLogout();
        return;
      }
      setPageError(error.message);
    } finally {
      setLoading(false);
    }
  }, [isBoss, onLogout]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setTaskNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (isBoss) return;
    const pending = tasks.find((task) => !task.acknowledged_at && !task.completed_at && !task.missed_at) || null;
    setAcknowledgmentTask((current) => current?.id === pending?.id ? current : pending);
  }, [isBoss, tasks]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const [taskRows, notificationRows] = await Promise.all([
          api("/tasks"),
          isBoss ? api("/notifications") : Promise.resolve([]),
        ]);
        setTasks(taskRows);
        setNotifications(notificationRows);
      } catch (error) {
        if (error.status === 401) await onLogout();
        else setPageError(error.message);
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [isBoss, onLogout]);

  useEffect(() => {
    function focusSearch(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector(".global-search input")?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const visibleLocations = useMemo(() => locations.filter((location) => {
    const matchesQuery = `${location.name} ${location.responsible}`.toLowerCase().includes(query.toLowerCase());
    const matchesPhoto = !photoFilter || (photoFilter === "with" ? Boolean(location.photo) : !location.photo);
    return matchesQuery
      && (!frequencyFilter || location.frequency === frequencyFilter)
      && (!responsibleFilter || location.responsible === responsibleFilter)
      && matchesPhoto;
  }), [locations, query, frequencyFilter, responsibleFilter, photoFilter]);

  const visibleHistory = useMemo(() => history.filter((entry) => {
    const matchesQuery = `${entry.location_name} ${entry.responsible} ${entry.executor_name || ""} ${entry.notes || ""}`.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = !statusFilter
      || (statusFilter === "Concluída" && ["Concluída", "Limpo"].includes(entry.status))
      || entry.status === statusFilter;
    return matchesQuery && matchesStatus;
  }), [history, query, statusFilter]);

  async function saveLocation(values, id) {
    setSaving(true);
    try {
      const method = id ? "PUT" : "POST";
      await api(id ? `/locations/${id}` : "/locations", { method, body: JSON.stringify(values) });
      setModal(null);
      setToast(id ? "Local atualizado." : "Local cadastrado.");
      await refresh();
    } catch (error) {
      setToast(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveCleaning(values, id) {
    setSaving(true);
    try {
      await api("/history", {
        method: "POST",
        body: JSON.stringify(values),
      });
      setModal(null);
      setToast("Limpeza registrada.");
      await refresh();
    } catch (error) {
      setToast(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveTask(values, id) {
    setSaving(true);
    try {
      await api(id ? `/tasks/${id}` : "/tasks", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(values),
      });
      setModal(null);
      setToast(id ? "Demanda atualizada." : "Tarefa criada e atribuída.");
      await refresh();
    } catch (error) {
      throw error;
    } finally {
      setSaving(false);
    }
  }

  async function acknowledgeTask(task) {
    setAcknowledgmentError("");
    try {
      const result = await api(`/tasks/${task.id}/acknowledge`, { method: "POST" });
      setTasks((current) => current.map((item) => item.id === task.id
        ? { ...item, acknowledged_at: result.acknowledged_at }
        : item));
      setToast("Ciência registrada.");
      await refresh();
    } catch (error) {
      setAcknowledgmentError(error.message);
    }
  }

  async function completeTask(task, completion) {
    setSaving(true);
    try {
      const [beforeUpload, afterUpload] = await Promise.all([
        uploadCapturedPhoto(completion.photo_before),
        uploadCapturedPhoto(completion.photo_after),
      ]);
      const result = await api(`/tasks/${task.id}/complete`, {
        method: "POST",
        body: JSON.stringify({
          photo_before: beforeUpload.url,
          photo_after: afterUpload.url,
          notes: completion.notes,
        }),
      });
      setTasks((current) => current.map((item) => item.id === task.id
        ? {
          ...item,
          completed_at: result.completed_at,
          photo_before: beforeUpload.url,
          photo_after: afterUpload.url,
          completion_notes: completion.notes,
        }
        : item));
      setModal(null);
      setToast("Tarefa concluída.");
      await refresh();
    } catch (error) {
      setToast(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function uploadCapturedPhoto(file) {
    if (!(file instanceof File)) throw new Error("Tire as duas fotos antes de concluir a tarefa.");
    const formData = new FormData();
    formData.append("file", file);
    return api("/upload", { method: "POST", body: formData });
  }

  async function readNotification(notification) {
    try {
      await api(`/notifications/${notification.id}/read`, { method: "POST" });
      setNotifications((current) => current.map((item) => item.id === notification.id
        ? { ...item, read_at: new Date().toISOString() }
        : item));
    } catch (error) {
      setPageError(error.message);
    }
  }

  const unreadNotifications = notifications.filter((item) => !item.read_at).length;

  async function removeItem(kind, id) {
    const label = kind === "locations"
      ? "este local e todo o histórico relacionado"
      : kind === "missed-task" ? "esta tarefa vencida do histórico" : "este registro";
    if (!window.confirm(`Tem certeza de que deseja excluir ${label}? Esta ação não pode ser desfeita.`)) return;
    try {
      const path = kind === "missed-task" ? `/tasks/${id}/missed` : `/${kind}/${id}`;
      await api(path, { method: "DELETE" });
      setModal(null);
      setToast(kind === "locations" ? "Local excluído." : kind === "missed-task" ? "Tarefa removida do histórico." : "Registro excluído.");
      await refresh();
    } catch (error) {
      setToast(error.message);
    }
  }

  function navigate(nextPage) {
    setPage(nextPage);
    setQuery("");
    setMobileNav(false);
  }

  function title() {
    return navItems.find((item) => item.id === page)?.label || "Sobre o app";
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Leaf size={20} strokeWidth={2.2} /></div>
            <div><strong>Routiner</strong><span>GESTÃO DE LIMPEZA</span></div>
          <button className="icon-button sidebar-close" onClick={() => setMobileNav(false)} aria-label="Fechar menu"><X size={18} /></button>
        </div>
        <div className="workspace-label">ESPAÇO DE TRABALHO</div>
        <nav className="main-nav" aria-label="Navegação principal">
          {navItems.filter((item) => !item.companyOnly || isBoss).map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-link ${page === id ? "active" : ""}`} onClick={() => navigate(id)}>
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {id === "history" && history.length > 0 && <span className="nav-count">{history.length}</span>}
              {id === "tasks" && tasks.some((task) => !task.completed_at && !task.missed_at) && <span className="nav-count">{tasks.filter((task) => !task.completed_at && !task.missed_at).length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="side-note">
            <div className="side-note-icon"><Sparkles size={17} /></div>
            <strong>Um espaço em ordem</strong>
            <p>Pequenos cuidados, todos os dias.</p>
          </div>
          <button className={`nav-link about-link ${page === "about" ? "active" : ""}`} onClick={() => navigate("about")}>
            <CircleAlert size={18} strokeWidth={1.8} /><span>Sobre o app</span>
          </button>
          <div className="profile">
            <div className="avatar">{initials(account.name)}</div>
            <div className="profile-copy"><strong>{account.name}</strong><span>{isBoss ? "Administrador da empresa" : account.sector}</span></div>
            <button className="icon-button profile-more" aria-label="Abrir perfil" title="Configurações do perfil" onClick={() => setProfileMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button>
          </div>
        </div>
      </aside>

      {mobileNav && <button className="mobile-scrim" aria-label="Fechar menu" onClick={() => setMobileNav(false)} />}

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Abrir menu"><Menu size={20} /></button>
            <span className="breadcrumb">Workspace</span><ChevronRight size={15} className="breadcrumb-chevron" />
            <span className="breadcrumb current">{title()}</span>
          </div>
          <div className="topbar-actions">
            <label className="global-search">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={page === "history" ? "Buscar no histórico..." : page === "locations" ? "Buscar itens..." : page === "tasks" ? "Buscar tarefas..." : "Buscar..."}
                aria-label="Buscar"
              />
              {query && <button type="button" className="search-clear" onClick={() => setQuery("")} aria-label="Limpar busca"><X size={14} /></button>}
              {!query && <kbd>⌘ K</kbd>}
            </label>
            <button className="sync-button" onClick={refresh} disabled={loading} title="Atualizar dados">
              <LoaderCircle size={16} className={loading ? "spin" : ""} />
              <span>Atualizar</span>
            </button>
            {isBoss && (
              <div className="notification-wrap">
                <button
                  className={`icon-button notification-button ${unreadNotifications ? "has-unread" : ""}`}
                  onClick={() => setNotificationsOpen((open) => !open)}
                  aria-label={`Notificações${unreadNotifications ? `: ${unreadNotifications} não lidas` : ""}`}
                  aria-expanded={notificationsOpen}
                  title="Notificações"
                >
                  <Bell size={18} />
                  {unreadNotifications > 0 && <span className="notification-count">{unreadNotifications > 99 ? "99+" : unreadNotifications}</span>}
                </button>
                {notificationsOpen && (
                  <section className="notification-popover" aria-label="Notificações da empresa">
                    <div className="notification-heading"><strong>Notificações</strong><span>{unreadNotifications} não lidas</span></div>
                    {notifications.length ? notifications.map((notification) => (
                      <article className={`notification-item ${notification.read_at ? "read" : ""}`} key={notification.id}>
                        <span className={`notification-event ${notification.event_type}`}>
                          {notification.event_type === "completed" ? <Check size={14} /> : <CheckCircle2 size={14} />}
                        </span>
                        <div className="notification-copy">
                          <strong>{notification.event_type === "completed" ? "Tarefa concluída" : "Ciência registrada"}</strong>
                          <p>{notification.event_type === "completed"
                            ? `Responsável ${notification.assignee_name || "—"} · execução ${notification.actor_name || "Funcionário"} · setor ${notification.actor_sector || "—"} concluiu “${notification.task_title}”`
                            : `${notification.actor_name || "Funcionário"} · setor ${notification.actor_sector || "—"} deu ciência da tarefa de ${notification.assignee_name || "—"} “${notification.task_title}”`} · prazo {formatDeadline(notification.deadline)}</p>
                          <small>{formatDeadline(notification.created_at)}</small>
                        </div>
                        {!notification.read_at && <button className="notification-read" onClick={() => readNotification(notification)}>Marcar como lida</button>}
                      </article>
                    )) : <div className="notification-empty">Ainda não há notificações.</div>}
                  </section>
                )}
              </div>
            )}
            {installPrompt && <button className="install-button" onClick={onInstall}><Download size={15} /><span>Instalar app</span></button>}
            <div className="profile-menu-wrap">
              <button className="top-avatar profile-trigger" title="Abrir perfil" aria-label="Abrir perfil" aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen((open) => !open)}>{initials(account.name)}</button>
              {profileMenuOpen && (
                <div className="profile-menu">
                  <div className="profile-menu-heading"><strong>{account.name}</strong><span>{isBoss ? "Administrador da empresa" : account.sector}</span></div>
                  <button onClick={() => { setProfileMenuOpen(false); setAppearanceOpen(true); }}><Settings size={16} /> Configurações</button>
                  <button onClick={onLogout}><LogOut size={16} /> Sair</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="page-content">
          {pageError && <div className="error-banner"><CircleAlert size={18} /><span>{pageError} Verifique se a API Python está em execução.</span><button onClick={refresh}>Tentar novamente</button></div>}
          {page === "dashboard" && (
            <DashboardPage
              data={dashboard}
              loading={loading}
              locations={locations}
              history={history}
              account={account}
              isBoss={isBoss}
              onNavigate={navigate}
              onAddCleaning={(location) => setModal({ type: "cleaning", initial: location ? { location_id: location.id } : null })}
              onOpenRecord={(record) => setModal({ type: "record", item: record })}
            />
          )}
          {page === "locations" && (
            <LocationsPage
              locations={visibleLocations}
              allLocations={locations}
              loading={loading}
              frequency={frequencyFilter}
              setFrequency={setFrequencyFilter}
              responsible={responsibleFilter}
              setResponsible={setResponsibleFilter}
              photo={photoFilter}
              setPhoto={setPhotoFilter}
              isBoss={isBoss}
              onAdd={() => setModal({ type: "location" })}
              onEdit={(item) => setModal({ type: "location", item })}
              onView={(item) => setModal({ type: "location-detail", item })}
              onAddCleaning={(item) => setModal({ type: "cleaning", initial: { location_id: item.id } })}
            />
          )}
          {page === "history" && (
            <HistoryPage
              entries={visibleHistory}
              locations={locations}
              sectors={sectors}
              isBoss={isBoss}
              loading={loading}
              status={statusFilter}
              setStatus={setStatusFilter}
              onAdd={() => setModal({ type: "cleaning" })}
              onView={(item) => setModal({ type: "record", item })}
            />
          )}
          {page === "tasks" && (
            <TasksPage
              tasks={tasks.filter((task) => `${task.title} ${task.description} ${task.assignee_name} ${task.assignee_sector} ${task.completed_by_name || ""}`.toLowerCase().includes(query.toLowerCase()))}
              loading={loading}
              isBoss={isBoss}
              sectors={sectors}
              now={taskNow}
              onCreate={() => setModal({ type: "task" })}
              onEdit={(task) => setModal({ type: "task", item: task })}
              onComplete={(task) => setModal({ type: "task-execution", item: task })}
            />
          )}
          {page === "team" && isBoss && (
            <TeamPage
              team={team}
              sectors={sectors}
              loading={loading}
              company={account.company}
              tasks={tasks}
              onManageSectors={() => setModal({ type: "sectors" })}
              onAdd={() => setModal({ type: "user" })}
              onEdit={(member) => setModal({ type: "user-edit", item: member })}
            />
          )}
          {page === "about" && <AboutPage />}
        </div>
      </main>

      {toast && <div className="toast" role="status"><CheckCircle2 size={18} />{toast}</div>}
      {passwordPromptPending && (
        <InitialPasswordPrompt
          onComplete={() => setPasswordPromptPending(false)}
        />
      )}
      {acknowledgmentTask && !isBoss && !passwordPromptPending && (
        <AcknowledgmentDialog
          task={acknowledgmentTask}
          now={taskNow}
          error={acknowledgmentError}
          onAcknowledge={() => acknowledgeTask(acknowledgmentTask)}
        />
      )}
      {modal?.type === "location" && (
        <LocationForm
          item={modal.item}
          team={team}
          sectors={sectors}
          saving={saving}
          onClose={() => setModal(null)}
          onSave={saveLocation}
          onDelete={() => removeItem("locations", modal.item.id)}
        />
      )}
      {modal?.type === "cleaning" && (
        <CleaningForm
          item={modal.item}
          initial={modal.initial}
          locations={locations}
          saving={saving}
          onClose={() => setModal(null)}
          onSave={saveCleaning}
        />
      )}
      {modal?.type === "task" && (
        <TaskForm
          item={modal.item}
          team={team}
          saving={saving}
          onClose={() => setModal(null)}
          onSave={saveTask}
        />
      )}
      {modal?.type === "task-execution" && (
        <TaskExecutionForm
          task={modal.item}
          isSubstitute={modal.item.assigned_user_id !== account.account_id}
          saving={saving}
          onClose={() => setModal(null)}
          onSave={(completion) => completeTask(modal.item, completion)}
        />
      )}
      {appearanceOpen && (
        <AppearanceSettings
          appearance={appearance}
          onChange={setAppearance}
          onClose={() => setAppearanceOpen(false)}
        />
      )}
      {modal?.type === "user" && (
        <UserForm
          company={account.company}
          sectors={sectors}
          saving={saving}
          onClose={() => setModal(null)}
          onSave={async (values) => {
            setSaving(true);
            try {
              const created = await api("/users", { method: "POST", body: JSON.stringify(values) });
              setModal(null);
              setToast(`Conta criada: ${created.login}`);
              await refresh();
            } catch (error) {
              throw error;
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
      {modal?.type === "user-edit" && (
        <UserEditForm
          member={modal.item}
          sectors={sectors}
          saving={saving}
          onClose={() => setModal(null)}
          onSave={async (values) => {
            setSaving(true);
            try {
              await api(`/users/${modal.item.id}`, { method: "PUT", body: JSON.stringify(values) });
              setModal(null);
              setToast("Funcionário atualizado.");
              await refresh();
            } catch (error) {
              throw error;
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
      {modal?.type === "sectors" && (
        <SectorManagement
          sectors={sectors}
          saving={saving}
          onClose={() => setModal(null)}
          onAdd={async (name) => {
            setSaving(true);
            try {
              await api("/sectors", { method: "POST", body: JSON.stringify({ name }) });
              setToast("Setor cadastrado.");
              await refresh();
            } finally {
              setSaving(false);
            }
          }}
          onDelete={async (sector) => {
            setSaving(true);
            try {
              await api(`/sectors/${sector.id}`, { method: "DELETE" });
              setToast("Setor excluído.");
              await refresh();
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
      {modal?.type === "record" && (
        <RecordDialog
          item={modal.item}
          isBoss={isBoss}
          onClose={() => setModal(null)}
          onDelete={() => removeItem(
            modal.item.record_type === "task" ? "missed-task" : "history",
            modal.item.record_type === "task" ? modal.item.task_id : modal.item.id,
          )}
        />
      )}
      {modal?.type === "location-detail" && (
        <LocationDialog
          item={modal.item}
          records={history.filter((entry) => entry.location_id === modal.item.id)}
          onClose={() => setModal(null)}
          onEdit={() => setModal({ type: "location", item: modal.item })}
          isBoss={isBoss}
          onRegister={() => setModal({ type: "cleaning", initial: { location_id: modal.item.id } })}
          onRecord={(record) => setModal({ type: "record", item: record })}
        />
      )}
    </div>
  );
}

function AuthPage({ initialError, onAuthenticated }) {
  const [resetToken] = useState(() => new URLSearchParams(window.location.search).get("reset_token") || "");
  const [mode, setMode] = useState(() => resetToken ? "reset" : "login");
  const [role, setRole] = useState("company");
  const [values, setValues] = useState({
    fantasy_name: "",
    company_handle: "",
    email: "",
    identifier: "",
    password: "",
    password_confirmation: "",
  });
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setError(initialError), [initialError]);
  useEffect(() => {
    if (!resetToken) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("reset_token");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [resetToken]);
  function change(key, value) {
    setValues((current) => ({ ...current, [key]: value }));
    setError("");
    setNotice("");
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "register") {
        const account = await api("/auth/register-company", {
          method: "POST",
          body: JSON.stringify({
            fantasy_name: values.fantasy_name,
            company_handle: values.company_handle,
            email: values.email,
            password: values.password,
          }),
        });
        onAuthenticated(account);
      } else if (mode === "forgot") {
        const result = await api("/auth/password-reset/request", {
          method: "POST",
          body: JSON.stringify({
            role,
            identifier: values.identifier,
            email: values.email,
          }),
        });
        setNotice(result.message);
      } else if (mode === "reset") {
        if (values.password !== values.password_confirmation) {
          throw new Error("As senhas não são iguais.");
        }
        const result = await api("/auth/password-reset/confirm", {
          method: "POST",
          body: JSON.stringify({ token: resetToken, password: values.password }),
        });
        setMode("login");
        setRole(result.role);
        setValues((current) => ({ ...current, password: "", password_confirmation: "" }));
        setNotice(result.message);
      } else {
        const account = await api(`/auth/login-${role}`, {
          method: "POST",
          body: JSON.stringify({ identifier: values.identifier, password: values.password }),
        });
        onAuthenticated(account);
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  const registration = mode === "register";
  const heading = registration
    ? ["Cadastre sua empresa", "Crie o espaço da empresa e convide sua equipe."]
    : mode === "forgot"
      ? ["Recuperar acesso", "Informe seu login e o e-mail cadastrado para receber o link."]
      : mode === "reset"
        ? ["Criar nova senha", "Escolha uma senha nova para acessar sua conta."]
        : ["Acesse sua rotina", "Entre para acompanhar as atividades da sua empresa."];
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand"><span className="auth-brand-mark"><Leaf size={22} /></span><div><strong>Routiner</strong><small>GESTÃO DE LIMPEZA</small></div></div>
        <div className="auth-heading"><span className="eyebrow">{registration ? "COMECE POR AQUI" : mode === "reset" ? "REDEFINIÇÃO DE SENHA" : mode === "forgot" ? "RECUPERAÇÃO DE SENHA" : "BEM-VINDO DE VOLTA"}</span><h1>{heading[0]}</h1><p>{heading[1]}</p></div>
        {!registration && mode !== "reset" && (
          <div className="auth-role-switch" aria-label="Tipo de acesso">
            <button type="button" className={role === "company" ? "selected" : ""} onClick={() => { setRole("company"); setValues((current) => ({ ...current, identifier: "" })); setError(""); }}><Building2 size={16} /> Empresa / chefe</button>
            <button type="button" className={role === "user" ? "selected" : ""} onClick={() => { setRole("user"); setValues((current) => ({ ...current, identifier: "" })); setError(""); }}><Users size={16} /> Funcionário</button>
          </div>
        )}
        <form className="auth-form" onSubmit={submit}>
          {registration ? (
            <>
              <div className="form-field"><label htmlFor="company-fantasy">Nome fantasia</label><input id="company-fantasy" autoComplete="organization" required minLength={2} maxLength={120} placeholder="Ex.: Empresa Routine" value={values.fantasy_name} onChange={(event) => change("fantasy_name", event.target.value)} /></div>
              <div className="form-field"><label htmlFor="company-handle">Identificador da empresa</label><div className="handle-input"><input id="company-handle" required minLength={2} maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9\-]{1,39}" placeholder="empresa" value={values.company_handle} onChange={(event) => change("company_handle", event.target.value.toLowerCase())} /><span>.routine</span></div><small className="field-hint">Este será o login exclusivo da empresa.</small></div>
              <div className="form-field"><label htmlFor="company-email">E-mail</label><input id="company-email" type="email" autoComplete="email" required maxLength={254} placeholder="contato@empresa.com.br" value={values.email} onChange={(event) => change("email", event.target.value)} /></div>
              <div className="form-field"><label htmlFor="company-password">Senha <span className="field-hint-inline">mínimo de 8 caracteres</span></label><input id="company-password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} placeholder="Crie uma senha segura" value={values.password} onChange={(event) => change("password", event.target.value)} /></div>
              <div className="auth-note"><ShieldCheck size={16} /><span>O cadastro cria o acesso do chefe. Ele poderá cadastrar funcionários e ver os registros da própria empresa.</span></div>
            </>
          ) : mode === "reset" ? (
            <>
              <div className="form-field"><label htmlFor="reset-password">Nova senha</label><input id="reset-password" type="password" autoFocus required minLength={8} maxLength={128} autoComplete="new-password" placeholder="Mínimo de 8 caracteres" value={values.password} onChange={(event) => change("password", event.target.value)} /></div>
              <div className="form-field"><label htmlFor="reset-password-confirm">Confirme a nova senha</label><input id="reset-password-confirm" type="password" required minLength={8} maxLength={128} autoComplete="new-password" placeholder="Digite a senha novamente" value={values.password_confirmation} onChange={(event) => change("password_confirmation", event.target.value)} /></div>
            </>
          ) : mode === "forgot" ? (
            <>
              <div className="form-field"><label htmlFor="reset-identifier">{role === "company" ? "Login da empresa" : "Login do funcionário"}</label><input id="reset-identifier" autoCapitalize="none" required maxLength={150} placeholder={role === "company" ? "empresa.routine" : "usuario.empresa.routine"} value={values.identifier} onChange={(event) => change("identifier", event.target.value.toLowerCase().trim())} /></div>
              <div className="form-field"><label htmlFor="reset-email">E-mail cadastrado</label><input id="reset-email" type="email" autoComplete="email" required maxLength={254} placeholder="voce@empresa.com.br" value={values.email} onChange={(event) => change("email", event.target.value)} /></div>
            </>
          ) : (
            <>
              <div className="form-field"><label htmlFor="login-identifier">{role === "company" ? "Login da empresa" : "Login do funcionário"}</label><input id="login-identifier" autoCapitalize="none" autoComplete="username" required maxLength={150} placeholder={role === "company" ? "empresa.routine" : "usuario.empresa.routine"} value={values.identifier} onChange={(event) => change("identifier", event.target.value.toLowerCase().trim())} /><small className="field-hint">{role === "company" ? "O identificador escolhido no cadastro da empresa." : "Formato: usuario.identificador-da-empresa.routine."}</small></div>
              <div className="form-field"><label htmlFor="login-password">Senha</label><input id="login-password" type="password" autoComplete="current-password" required maxLength={128} placeholder="Sua senha" value={values.password} onChange={(event) => change("password", event.target.value)} /></div>
              <button type="button" className="text-button auth-forgot-link" onClick={() => { setMode("forgot"); setNotice(""); setError(""); }}>Esqueceu a senha?</button>
            </>
          )}
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
          {notice && <div className="auth-note" role="status"><ShieldCheck size={16} /><span>{notice}</span></div>}
          <button className="button-primary auth-submit" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" />}{registration ? "Criar empresa" : mode === "forgot" ? "Enviar link" : mode === "reset" ? "Salvar nova senha" : "Entrar"}<ArrowRight size={16} /></button>
        </form>
        {mode === "forgot" || mode === "reset" ? <div className="auth-switch"><button onClick={() => { setMode("login"); setError(""); setNotice(""); }}>Voltar para entrar</button></div> : mode === "login" ? <div className="auth-switch">Ainda não tem uma empresa cadastrada? <button onClick={() => { setMode("register"); setRole("company"); setError(""); setNotice(""); }}>Cadastrar empresa</button></div> : <div className="auth-switch">Sua empresa já tem uma conta? <button onClick={() => { setMode("login"); setRole("company"); setError(""); setNotice(""); }}>Entrar</button></div>}
        <div className="auth-footer">Seus dados e registros ficam separados por empresa.</div>
      </section>
      <aside className="auth-aside"><div className="auth-orb orb-a" /><div className="auth-orb orb-b" /><div className="auth-aside-content"><div className="auth-aside-icon"><ClipboardCheck size={25} /></div><span>ROTINA ORGANIZADA. EQUIPE ALINHADA.</span><h2>O cuidado diário,<br />em um só lugar.</h2><p>Gerencie locais, acompanhe as atividades e dê à sua equipe uma rotina mais simples e transparente.</p><div className="auth-benefit"><span><Check size={14} /></span> Um espaço seguro para cada empresa</div><div className="auth-benefit"><span><Check size={14} /></span> Registros identificados por funcionário</div></div></aside>
    </main>
  );
}

function TeamPage({ team, sectors, loading, company, tasks, onManageSectors, onAdd, onEdit }) {
  const [sector, setSector] = useState("");
  const [pendingFilter, setPendingFilter] = useState("");
  const visibleTeam = team.filter((member) => {
    const memberTasks = tasks.filter((task) => task.assigned_user_id === member.id);
    const hasPending = memberTasks.some((task) => !task.completed_at && !task.missed_at);
    return (!sector || sameSector(member.sector, sector))
      && (!pendingFilter || (pendingFilter === "pending" ? hasPending : !hasPending));
  });
  return (
    <>
      <PageHeading eyebrow="ADMINISTRAÇÃO DA EMPRESA" title="Sua equipe" description="Gerencie setores, funcionários e demandas atribuídas." action={<div className="heading-actions"><button className="button-secondary" onClick={onManageSectors}><Settings size={16} /> Setores</button><button className="button-primary" onClick={onAdd}><Plus size={17} /> Cadastrar funcionário</button></div>} />
      <section className="company-summary panel"><div className="company-symbol"><Building2 size={20} /></div><div><span>EMPRESA</span><strong>{company.fantasy_name}</strong><small>Login: {company.company_handle}.routine · {company.email}</small></div><span className="admin-badge"><BadgeCheck size={14} /> Administrador</span></section>
      <section className="panel team-panel">
        <div className="section-head"><div><h2>Contas de funcionários</h2><p>Funcionários veem as tarefas e o histórico do próprio setor.</p></div><span className="result-count">{visibleTeam.length}</span></div>
        <div className="toolbar-filters team-filters">
          <div className="filter-control"><Users size={15} /><select value={sector} onChange={(event) => setSector(event.target.value)} aria-label="Filtrar equipe por setor"><option value="">Todos os setores</option>{sectors.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select><ChevronDown size={14} /></div>
          <div className="filter-control"><Filter size={15} /><select value={pendingFilter} onChange={(event) => setPendingFilter(event.target.value)} aria-label="Filtrar equipe por pendências"><option value="">Todas as situações</option><option value="pending">Com pendências</option><option value="clear">Sem pendências</option></select><ChevronDown size={14} /></div>
        </div>
        {loading && !team.length ? <LoadingState /> : visibleTeam.length ? (
          <div className="table-scroll"><table className="history-table team-table"><thead><tr><th>FUNCIONÁRIO</th><th>SETOR</th><th>LOGIN</th><th>E-MAIL DE RECUPERAÇÃO</th><th>DEMANDAS</th><th>CONTA</th></tr></thead><tbody>
            {visibleTeam.map((member) => <tr key={member.id}><td data-label="Funcionário"><span className="table-person"><span className="person-initial">{initials(member.name)}</span><strong>{member.name}</strong></span></td><td data-label="Setor">{member.sector}</td><td data-label="Login"><code className="login-code">{member.login}</code></td><td data-label="E-mail de recuperação">{member.email || "Não informado"}</td><td data-label="Demandas">{tasks.filter((task) => task.assigned_user_id === member.id && !task.completed_at && !task.missed_at).length} pendentes</td><td data-label="Conta"><span className="team-status"><span className="status-dot" /> Ativa</span> <button className="icon-button" onClick={() => onEdit(member)} aria-label={`Editar ${member.name}`}><Pencil size={15} /></button></td></tr>)}
          </tbody></table></div>
        ) : team.length ? <EmptyState className="team-empty" icon={Filter} title="Nenhum funcionário neste filtro" description="Altere os filtros de setor ou de pendências para ver a equipe." /> : <EmptyState className="team-empty" icon={Users} title="Ainda não há funcionários" description="Cadastre um funcionário para que ele possa entrar e acompanhar as atividades do setor." action={<button className="button-primary" onClick={onAdd}><Plus size={16} /> Cadastrar primeiro funcionário</button>} />}
      </section>
    </>
  );
}

function TasksPage({ tasks, loading, isBoss, sectors, now, onCreate, onEdit, onComplete }) {
  const [sector, setSector] = useState("");
  const sectorTasks = tasks.filter((task) => !isBoss || !sector || sameSector(task.assignee_sector, sector));
  const pending = sectorTasks.filter((task) => !task.completed_at && !task.missed_at);
  const completed = sectorTasks.filter((task) => task.completed_at || task.missed_at);
  return (
    <>
      <PageHeading
        eyebrow={isBoss ? "GESTÃO DA EQUIPE" : "SUA ROTINA"}
        title="Tarefas com prazo"
        description={isBoss
          ? "Atribua tarefas, acompanhe a ciência da equipe e confira as conclusões."
          : "Acompanhe as tarefas do seu setor e registre execuções em apoio à equipe."}
        action={isBoss && <button className="button-primary" onClick={onCreate}><Plus size={17} /> Nova tarefa</button>}
      />
      {isBoss && <div className="toolbar panel"><div className="toolbar-copy"><span className="result-count">{sectorTasks.length}</span><span>{sectorTasks.length === 1 ? "tarefa" : "tarefas"}</span></div><div className="filter-control"><Users size={15} /><select value={sector} onChange={(event) => setSector(event.target.value)} aria-label="Filtrar tarefas por setor"><option value="">Todos os setores</option>{sectors.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select><ChevronDown size={14} /></div></div>}
      {!isBoss && tasks.some((task) => !task.acknowledged_at && !task.completed_at && !task.missed_at) && (
        <div className="task-reminder"><CircleAlert size={17} /> Você tem uma tarefa que precisa de ciência. Confirme o aviso para continuar.</div>
      )}
      <section className="task-section">
        <div className="section-head"><div><h2>Em andamento</h2><p>{pending.length} {pending.length === 1 ? "tarefa pendente" : "tarefas pendentes"}</p></div></div>
        {loading && !tasks.length ? <LoadingState /> : pending.length ? (
          <div className="task-list">
            {pending.map((task) => {
              const urgency = deadlineUrgency(task.deadline, now);
              return (
                <article className="panel task-card" key={task.id}>
                  <div className={`task-alert ${urgency}`} aria-label={urgency === "urgent" ? "Prazo urgente" : "Prazo da tarefa"}>
                    <CircleAlert size={19} />
                  </div>
                  <div className="task-content">
                    <div className="task-title-row"><h3>{task.title}</h3><span className={`status-pill ${task.acknowledged_at ? "status-done" : "status-attention"}`}>{task.acknowledged_at ? "Ciente" : "Aguardando ciência"}</span></div>
                    {task.description && <p className="task-description">{task.description}</p>}
                    <div className="task-meta">
                      <span><Clock3 size={14} />{deadlineCountdown(task.deadline, now)} · {formatDeadline(task.deadline)}</span>
                      <span><Users size={14} />Responsável: {task.assignee_name} · {task.assignee_sector}</span>
                    </div>
                  </div>
                  {!isBoss && task.acknowledged_at && (
                    <button className="button-primary task-complete" onClick={() => onComplete(task)}>
                      <Check size={16} /> Fazer tarefa
                    </button>
                  )}
                  {isBoss && <button className="button-secondary task-complete" onClick={() => onEdit(task)}><Pencil size={15} /> Editar demanda</button>}
                </article>
              );
            })}
          </div>
        ) : <EmptyState className="task-empty" icon={ListChecks} title="Nenhuma tarefa pendente" description={isBoss ? "Crie uma tarefa e defina a pessoa responsável e o prazo." : "Quando a empresa atribuir uma tarefa, ela aparecerá aqui."} action={isBoss && <button className="button-primary" onClick={onCreate}><Plus size={16} /> Criar tarefa</button>} />}
      </section>
      {completed.length > 0 && (
        <section className="task-section completed-tasks">
          <div className="section-head"><div><h2>Concluídas e vencidas</h2><p>{completed.length} {completed.length === 1 ? "registro" : "registros"} finalizados</p></div></div>
          <div className="task-list">
            {completed.map((task) => (
              <article className="panel task-card task-card-complete" key={task.id}>
                <span className={`task-alert ${task.missed_at ? "urgent" : "completed"}`}>{task.missed_at ? <CircleAlert size={18} /> : <Check size={18} />}</span>
                <div className="task-content">
                  <div className="task-title-row"><h3>{task.title}</h3><span className={`status-pill ${task.missed_at ? "status-attention" : "status-done"}`}>{task.missed_at ? "Não feito" : "Concluída"}</span></div>
                  <div className="task-meta">
                    <span><CalendarDays size={14} />{task.missed_at ? "Venceu" : "Concluída"}: {formatDeadline(task.missed_at || task.completed_at)}</span>
                    <span><Users size={14} />Responsável: {task.assignee_name}{task.completed_by_name ? ` · Execução: ${task.completed_by_name}` : ""}</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function TaskForm({ item, team, saving, onClose, onSave }) {
  const defaultDeadline = item ? new Date(item.deadline) : new Date(Date.now() + 60 * 60 * 1000);
  const localDeadline = new Date(defaultDeadline.getTime() - defaultDeadline.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  const [values, setValues] = useState({
    title: item?.title || "",
    description: item?.description || "",
    assigned_user_id: item?.assigned_user_id || "",
    deadline: localDeadline,
  });
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    if (!team.length) {
      setError("Cadastre um funcionário antes de criar uma tarefa.");
      return;
    }
    setError("");
    try {
      await onSave(
        { ...values, title: values.title.trim(), deadline: new Date(values.deadline).toISOString() },
        item?.id,
      );
    } catch (saveError) {
      setError(saveError.message);
    }
  }

  return <Modal title={item ? "Editar demanda" : "Nova tarefa"} subtitle="ATRIBUIÇÃO COM PRAZO" onClose={onClose}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-field"><label htmlFor="task-title">Tarefa <span className="required">*</span></label><input id="task-title" autoFocus required minLength={2} maxLength={120} placeholder="Ex.: Higienizar a área de preparo" value={values.title} onChange={(event) => setValues({ ...values, title: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="task-assignee">Funcionário responsável <span className="required">*</span></label><select id="task-assignee" required value={values.assigned_user_id} onChange={(event) => setValues({ ...values, assigned_user_id: event.target.value })}><option value="">Selecione um funcionário</option>{team.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.sector}</option>)}</select>{!team.length && <small className="field-hint">Cadastre primeiro um funcionário na seção Equipe.</small>}</div>
      <div className="form-field"><label htmlFor="task-deadline">Prazo final — data e hora <span className="required">*</span></label><input id="task-deadline" type="datetime-local" required value={values.deadline} onChange={(event) => setValues({ ...values, deadline: event.target.value })} /><small className="field-hint">O horário será salvo com o fuso local e exibido para a equipe.</small></div>
      <div className="form-field"><label htmlFor="task-description">Detalhes <span className="optional">(opcional)</span></label><textarea id="task-description" rows="3" maxLength={1000} placeholder="Explique o que precisa ser feito…" value={values.description} onChange={(event) => setValues({ ...values, description: event.target.value })} /></div>
      {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      <footer className="modal-footer"><span className="footer-spacer" /><button type="button" className="button-secondary" onClick={onClose}>Cancelar</button><button className="button-primary" disabled={saving || !team.length}>{saving && <LoaderCircle size={16} className="spin" />}{item ? "Salvar alterações" : "Criar tarefa"}</button></footer>
    </form>
  </Modal>;
}

function AppearanceSettings({ appearance, onChange, onClose }) {
  return <Modal title="Configurações de aparência" subtitle="PERSONALIZE SEU ESPAÇO" onClose={onClose}>
    <div className="appearance-settings">
      <p>Escolha como o Routiner deve aparecer neste dispositivo.</p>
      <div className="appearance-options" role="radiogroup" aria-label="Tema">
        {[
          { value: "light", label: "Claro", icon: Sun },
          { value: "dark", label: "Escuro", icon: Moon },
          { value: "system", label: "Sistema", icon: Monitor },
          { value: "custom", label: "Personalizado", icon: Palette },
        ].map(({ value, label, icon: Icon }) => (
          <button
            type="button"
            key={value}
            role="radio"
            aria-checked={appearance.theme === value}
            className={`appearance-option ${appearance.theme === value ? "selected" : ""}`}
            onClick={() => onChange((current) => ({ ...current, theme: value }))}
          >
            <Icon size={18} /><span>{label}</span>{appearance.theme === value && <CheckCircle2 size={15} />}
          </button>
        ))}
      </div>
      {appearance.theme === "custom" && (
        <label className="accent-picker">
          <span>Cor de destaque</span>
          <input type="color" value={appearance.accent} onChange={(event) => onChange((current) => ({ ...current, accent: event.target.value }))} />
        </label>
      )}
      <footer className="modal-footer"><span className="footer-spacer" /><button className="button-primary" onClick={onClose}>Concluir</button></footer>
    </div>
  </Modal>;
}

function TaskExecutionForm({ task, isSubstitute, saving, onClose, onSave }) {
  const [photoBefore, setPhotoBefore] = useState(null);
  const [photoAfter, setPhotoAfter] = useState(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    if (isSubstitute && !notes.trim()) {
      setError("Informe o motivo de estar executando a tarefa no lugar do responsável.");
      return;
    }
    if (!photoBefore || !photoAfter) {
      setError("Tire as fotos de antes e depois para concluir.");
      return;
    }
    setError("");
    await onSave({ photo_before: photoBefore, photo_after: photoAfter, notes });
  }
  return <Modal title="Fazer tarefa" subtitle="EXECUÇÃO DA TAREFA" onClose={onClose} wide>
    <form className="modal-form task-execution-form" onSubmit={submit}>
      <div className="task-execution-summary"><strong>{task.title}</strong><span>{task.description || "Registre a execução da tarefa atribuída."}</span><small>Prazo: {formatDeadline(task.deadline)}</small></div>
      <div className="task-photo-grid">
        <CameraPhotoField label="Foto antes" photo={photoBefore} onChange={setPhotoBefore} />
        <CameraPhotoField label="Foto depois" photo={photoAfter} onChange={setPhotoAfter} />
      </div>
      <div className="form-field"><label htmlFor="task-completion-notes">{isSubstitute ? <>Por que você está executando a tarefa de {task.assignee_name}? <span className="required">*</span></> : "Observações (opcional)"}</label><textarea id="task-completion-notes" required={isSubstitute} maxLength={1000} rows={3} placeholder={isSubstitute ? "Descreva o motivo da execução por outra pessoa…" : "Adicione uma observação (opcional)"} value={notes} onChange={(event) => { setNotes(event.target.value); setError(""); }} /></div>
      {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      <footer className="modal-footer"><span className="footer-spacer" /><button type="button" className="button-secondary" onClick={onClose} disabled={saving}>Cancelar</button><button className="button-primary" disabled={saving}>{saving && <LoaderCircle size={16} className="spin" />}{saving ? "Salvando…" : "Concluir tarefa"}</button></footer>
    </form>
  </Modal>;
}

function CameraPhotoField({ label, photo, onChange }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [error, setError] = useState("");
  const preview = useMemo(() => photo ? URL.createObjectURL(photo) : "", [photo]);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }
  async function openCamera() {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("A câmera não está disponível neste dispositivo.");
      return;
    }
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      setCameraOpen(true);
    } catch (cameraError) {
      setError(`Não foi possível acessar a câmera: ${cameraError.message}`);
    }
  }
  useEffect(() => {
    if (cameraOpen && videoRef.current && streamRef.current) videoRef.current.srcObject = streamRef.current;
  }, [cameraOpen]);
  function capture() {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) {
      setError("A câmera ainda está carregando. Tente novamente em instantes.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setError("Não foi possível preparar a captura da foto.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) {
        setError("Não foi possível capturar a foto. Tente novamente.");
        return;
      }
      onChange(new File([blob], `${label.toLowerCase().replaceAll(" ", "-")}.jpg`, { type: "image/jpeg" }));
      setCameraOpen(false);
      stopCamera();
    }, "image/jpeg", 0.9);
  }
  return <div className="camera-photo-field">
    <div className="camera-photo-label">{label}<span className="required">*</span></div>
    {cameraOpen
      ? <div className="camera-preview"><video ref={videoRef} autoPlay playsInline muted /><button type="button" className="button-primary" onClick={capture}><Camera size={16} /> Capturar</button><button type="button" className="button-secondary" onClick={() => { setCameraOpen(false); stopCamera(); }}>Cancelar câmera</button></div>
      : photo
        ? <div className="captured-photo"><img src={preview} alt={`${label} capturada`} /><div><span>Foto capturada</span><button type="button" className="button-secondary" onClick={() => onChange(null)}>Excluir foto</button><button type="button" className="button-secondary" onClick={openCamera}>Tirar novamente</button></div></div>
        : <button type="button" className="camera-open" onClick={openCamera}><Camera size={21} /><strong>Abrir câmera</strong><small>Use a câmera para capturar a foto</small></button>}
    {error && <span className="field-error">{error}</span>}
  </div>;
}

function AcknowledgmentDialog({ task, now, error, onAcknowledge }) {
  return (
    <div className="modal-backdrop acknowledgment-backdrop">
      <section className="modal acknowledgment-modal" role="dialog" aria-modal="true" aria-labelledby="acknowledgment-title">
        <div className="acknowledgment-symbol"><CircleAlert size={24} /></div>
        <div className="eyebrow">TAREFA COM PRAZO</div>
        <h2 id="acknowledgment-title">Confirme que você viu</h2>
        <p className="acknowledgment-intro">Confirme que você viu o prazo desta tarefa do seu setor. Sua ciência será registrada pela sua conta.</p>
        <div className={`acknowledgment-task ${deadlineUrgency(task.deadline, now)}`}>
          <strong>{task.title}</strong>
          {task.description && <p>{task.description}</p>}
          <span>Responsável: {task.assignee_name} · setor {task.assignee_sector} · prazo {formatDeadline(task.deadline)}</span>
          <b><CircleAlert size={15} />{deadlineCountdown(task.deadline, now)}</b>
        </div>
        {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
        <button className="button-primary acknowledgment-button" onClick={onAcknowledge}><Check size={17} /> Estou ciente</button>
      </section>
    </div>
  );
}

function InitialPasswordPrompt({ onComplete }) {
  const [mode, setMode] = useState("choice");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function keepPassword() {
    setBusy(true);
    setError("");
    try {
      await api("/auth/initial-password/keep", { method: "POST" });
      onComplete();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    setError("");
    if (newPassword !== passwordConfirmation) {
      setError("As senhas novas não são iguais.");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/initial-password/change", {
        method: "POST",
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      onComplete();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="initial-password-popover" role="dialog" aria-modal="false" aria-labelledby="initial-password-title">
      <div className="initial-password-heading">
        <span className="initial-password-icon"><KeyRound size={18} /></span>
        <div><span className="eyebrow">PRIMEIRO ACESSO</span><h2 id="initial-password-title">Senha do funcionário</h2></div>
      </div>
      {mode === "choice" ? (
        <>
          <p>A empresa criou uma senha inicial para sua conta. Você prefere criar uma senha pessoal ou manter a atual?</p>
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
          <div className="initial-password-actions">
            <button type="button" className="button-primary" disabled={busy} onClick={() => { setError(""); setMode("change"); }}>Mudar senha</button>
            <button type="button" className="button-secondary" disabled={busy} onClick={keepPassword}>Manter senha atual</button>
          </div>
        </>
      ) : (
        <form className="initial-password-form" onSubmit={changePassword}>
          <p>Digite a senha inicial e escolha uma nova senha. Ela será salva automaticamente na sua conta.</p>
          <div className="form-field"><label htmlFor="initial-current-password">Senha inicial</label><input id="initial-current-password" type="password" autoComplete="current-password" required maxLength={128} autoFocus value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></div>
          <div className="form-field"><label htmlFor="initial-new-password">Nova senha <span className="field-hint-inline">mínimo de 8 caracteres</span></label><input id="initial-new-password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></div>
          <div className="form-field"><label htmlFor="initial-password-confirmation">Confirme a nova senha</label><input id="initial-password-confirmation" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} /></div>
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
          <div className="initial-password-actions">
            <button type="button" className="button-secondary" disabled={busy} onClick={() => { setError(""); setMode("choice"); }}>Voltar</button>
            <button className="button-primary" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" />} Salvar senha</button>
          </div>
        </form>
      )}
    </section>
  );
}

function UserForm({ company, sectors, saving, onClose, onSave }) {
  const [values, setValues] = useState({ name: "", sector: "", username: "", email: "", password: "" });
  const [error, setError] = useState("");
  const login = values.username ? `${values.username.toLowerCase()}.${company.company_handle}.routine` : `usuario.${company.company_handle}.routine`;
  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await onSave({ ...values, username: values.username.toLowerCase().trim() });
    } catch (submitError) {
      setError(submitError.message);
    }
  }
  return <Modal title="Cadastrar funcionário" subtitle="NOVA CONTA DA EQUIPE" onClose={onClose}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-field"><label htmlFor="employee-name">Nome completo <span className="required">*</span></label><input id="employee-name" autoFocus required minLength={2} maxLength={120} autoComplete="name" placeholder="Nome do funcionário" value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="employee-email">E-mail para recuperação <span className="required">*</span></label><input id="employee-email" type="email" required maxLength={254} autoComplete="email" placeholder="funcionario@empresa.com.br" value={values.email} onChange={(event) => setValues({ ...values, email: event.target.value })} /><small className="field-hint">O link para redefinir a senha será enviado para este endereço.</small></div>
      <div className="form-field"><label htmlFor="employee-sector">Setor <span className="required">*</span></label><select id="employee-sector" required value={values.sector} onChange={(event) => setValues({ ...values, sector: event.target.value })}><option value="">Selecione um setor</option>{sectors.map((sector) => <option key={sector.id} value={sector.name}>{sector.name}</option>)}</select>{!sectors.length && <small className="field-hint">Cadastre um setor no menu Equipe → Setores antes de incluir funcionários.</small>}</div>
      <div className="form-field"><label htmlFor="employee-username">Identificador de usuário <span className="required">*</span></label><div className="handle-input"><input id="employee-username" required minLength={2} maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9\-]{1,29}" placeholder="maria" value={values.username} onChange={(event) => setValues({ ...values, username: event.target.value.toLowerCase() })} /><span>.{company.company_handle}.routine</span></div><small className="field-hint">Login completo: <code>{login}</code></small></div>
      <div className="form-field"><label htmlFor="employee-password">Senha inicial <span className="required">*</span></label><input id="employee-password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" placeholder="Mínimo de 8 caracteres" value={values.password} onChange={(event) => setValues({ ...values, password: event.target.value })} /><small className="field-hint">Compartilhe o login e a senha inicial com o funcionário.</small></div>
      <div className="auth-note"><ShieldCheck size={16} /><span>O funcionário só poderá consultar os registros enviados pelo próprio login. A empresa poderá consultar todos.</span></div>
      {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      <footer className="modal-footer"><span className="footer-spacer" /><button type="button" className="button-secondary" onClick={onClose}>Cancelar</button><button className="button-primary" disabled={saving || !sectors.length}>{saving && <LoaderCircle size={16} className="spin" />}Criar conta</button></footer>
    </form>
  </Modal>;
}

function UserEditForm({ member, sectors, saving, onClose, onSave }) {
  const [values, setValues] = useState({ name: member.name, sector: member.sector, email: member.email || "" });
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await onSave(values);
    } catch (saveError) {
      setError(saveError.message);
    }
  }
  return <Modal title="Editar funcionário" subtitle="EQUIPE E SETOR" onClose={onClose}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-field"><label htmlFor="edit-employee-name">Nome completo</label><input id="edit-employee-name" required minLength={2} maxLength={120} value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="edit-employee-email">E-mail para recuperação</label><input id="edit-employee-email" type="email" required maxLength={254} autoComplete="email" value={values.email} onChange={(event) => setValues({ ...values, email: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="edit-employee-sector">Setor</label><select id="edit-employee-sector" required value={values.sector} onChange={(event) => setValues({ ...values, sector: event.target.value })}>{sectors.map((sector) => <option key={sector.id} value={sector.name}>{sector.name}</option>)}</select></div>
      {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      <footer className="modal-footer"><span className="footer-spacer" /><button type="button" className="button-secondary" onClick={onClose}>Cancelar</button><button className="button-primary" disabled={saving}>{saving && <LoaderCircle size={16} className="spin" />}Salvar alterações</button></footer>
    </form>
  </Modal>;
}

function SectorManagement({ sectors, saving, onClose, onAdd, onDelete }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await onAdd(name.trim());
      setName("");
    } catch (saveError) {
      setError(saveError.message);
    }
  }
  async function remove(sector) {
    setError("");
    try {
      await onDelete(sector);
    } catch (deleteError) {
      setError(deleteError.message);
    }
  }
  return <Modal title="Gerenciar setores" subtitle="ORGANIZAÇÃO DA EQUIPE" onClose={onClose}>
    <div className="modal-form">
      <form className="form-row" onSubmit={submit}>
        <div className="form-field"><label htmlFor="new-sector">Novo setor</label><input id="new-sector" required minLength={2} maxLength={80} placeholder="Ex.: Cozinha" value={name} onChange={(event) => setName(event.target.value)} /></div>
        <button className="button-primary" disabled={saving}><Plus size={16} />Adicionar</button>
      </form>
      {sectors.length ? <div className="sector-list">{sectors.map((sector) => <div className="sector-row" key={sector.id}><strong>{sector.name}</strong><span>{sector.employee_count} funcionários · {sector.location_count} locais</span><button type="button" className="button-danger-ghost" disabled={saving || sector.employee_count > 0 || sector.location_count > 0} onClick={() => remove(sector)}><Trash2 size={15} />Excluir</button></div>)}</div> : <p className="field-hint">Cadastre setores para organizar funcionários e locais.</p>}
      {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      <footer className="modal-footer"><span className="footer-spacer" /><button type="button" className="button-secondary" onClick={onClose}>Fechar</button></footer>
    </div>
  </Modal>;
}

function PageHeading({ eyebrow, title, description, action }) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function DashboardPage({ data, loading, locations, history, account, isBoss, onNavigate, onAddCleaning, onOpenRecord }) {
  const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "long" }).format(new Date());
  const dateLabel = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric" }).format(new Date());
  const completion = data?.locations ? Math.round((data.completed_today / data.locations) * 100) : 0;
  return (
    <>
      <PageHeading eyebrow={weekday} title={`Olá, ${account.name.split(" ")[0]}.`} description={`Aqui está o resumo da sua rotina — ${dateLabel}.`} action={
        <button className="button-primary" onClick={() => onAddCleaning()}><Plus size={17} /> Registrar limpeza</button>
      } />
      <section className="welcome-banner">
        <div className="welcome-copy">
          <div className="welcome-kicker"><span className="live-dot" /> SEU RESUMO DE HOJE</div>
          <h2>Um ambiente cuidado<br />começa por aqui.</h2>
          <p>Acompanhe os locais, organize as frequências<br className="desktop-only" /> e mantenha tudo em dia.</p>
          {isBoss && <button className="welcome-link" onClick={() => onNavigate("locations")}>Ver meus locais <ArrowRight size={16} /></button>}
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
          <div className="art-card"><div className="art-card-top"><span /><span /><span /></div><div className="art-check"><Check size={22} /></div><div className="art-lines"><i /><i /><i /></div></div>
          <div className="art-leaf leaf-one"><Leaf size={44} /></div><div className="art-leaf leaf-two"><Leaf size={28} /></div>
          <div className="art-sparkle sparkle-one">✦</div><div className="art-sparkle sparkle-two">✦</div>
        </div>
      </section>
      <section className="stats-grid" aria-label="Resumo">
        <StatCard label="Locais cadastrados" value={data?.locations ?? 0} hint="na sua rotina" icon={Leaf} tint="sage" loading={loading} />
        <StatCard label="Limpezas registradas" value={data?.total_cleanings ?? 0} hint="no total" icon={ClipboardCheck} tint="blue" loading={loading} />
        <StatCard label="Concluídas hoje" value={data?.completed_today ?? 0} hint="com status limpo" icon={CheckCircle2} tint="green" loading={loading} />
        <StatCard label="Atenção hoje" value={data?.attention_today ?? 0} hint="precisam de cuidado" icon={CircleAlert} tint="amber" loading={loading} />
      </section>
      <div className="dashboard-columns">
        <section className="panel recent-panel">
          <div className="section-head">
            <div><h2>Atividade recente</h2><p>Os últimos registros da sua equipe</p></div>
            <button className="text-button" onClick={() => onNavigate("history")}>Ver histórico <ArrowRight size={15} /></button>
          </div>
          {data?.recent?.length ? (
            <div className="activity-list">
              {data.recent.slice(0, 5).map((record) => (
                <button className="activity-row" key={record.id} onClick={() => onOpenRecord(history.find((item) => item.id === record.id) || record)}>
                  <span className={`activity-icon ${record.status === "Limpo" ? "done" : "attention"}`}>{record.status === "Limpo" ? <Check size={16} /> : <CircleAlert size={16} />}</span>
                  <span className="activity-main"><strong>{record.location_name}</strong><small>{record.responsible}{record.notes ? ` · ${record.notes}` : ""}</small></span>
                  <span className={`status-pill ${record.status === "Limpo" ? "status-done" : "status-attention"}`}>{record.status}</span>
                  <span className="activity-date">{formatDate(record.cleaning_date)}</span>
                  <ChevronRight size={16} className="row-arrow" />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState icon={Clock3} title="Sem atividade por enquanto" description="Os registros de limpeza vão aparecer aqui." />
          )}
        </section>
        <section className="panel quick-panel">
          <div className="section-head"><div><h2>Acesso rápido</h2><p>O que você precisa fazer?</p></div></div>
          {isBoss && <button className="quick-action" onClick={() => onNavigate("locations")}><span className="quick-icon sage"><Leaf size={18} /></span><span><strong>Explorar limpeza</strong><small>{locations.length} {locations.length === 1 ? "item cadastrado" : "itens cadastrados"}</small></span><ArrowRight size={16} /></button>}
          <button className="quick-action" onClick={() => onAddCleaning()}><span className="quick-icon blue"><ClipboardCheck size={18} /></span><span><strong>Registrar limpeza</strong><small>Adicionar ao histórico</small></span><ArrowRight size={16} /></button>
          <div className="quick-tip"><Sparkles size={16} /><span>Registros consistentes ajudam sua equipe a manter uma rotina organizada.</span></div>
        </section>
      </div>
    </>
  );
}

function StatCard({ label, value, hint, icon: Icon, tint, loading }) {
  return <article className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon ${tint}`}><Icon size={18} /></span></div><div className="stat-number">{loading ? <span className="skeleton-number" /> : value}</div><div className="stat-hint">{hint}</div></article>;
}

function LocationsPage({ locations, allLocations, loading, frequency, setFrequency, responsible, setResponsible, photo, setPhoto, isBoss, onAdd, onEdit, onView, onAddCleaning }) {
  const [sector, setSector] = useState("");
  const [cleaningType, setCleaningType] = useState("");
  const [itemId, setItemId] = useState("");
  const sectorOptions = [...new Set(allLocations.map((location) => location.responsible_sector).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "pt-BR"));
  const typeOptions = [...new Set(allLocations
    .filter((location) => !sector || sameSector(location.responsible_sector, sector))
    .map((location) => location.cleaning_type || "Estrutural"))]
    .sort((left, right) => left.localeCompare(right, "pt-BR"));
  const itemOptions = allLocations.filter((location) =>
    (!sector || sameSector(location.responsible_sector, sector))
      && (!cleaningType || (location.cleaning_type || "Estrutural") === cleaningType));
  const responsibleOptions = [...new Set(allLocations
    .filter((location) => (!sector || sameSector(location.responsible_sector, sector))
      && (!cleaningType || (location.cleaning_type || "Estrutural") === cleaningType))
    .map((location) => location.responsible))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const sectorLocations = locations.filter((location) =>
    (!sector || sameSector(location.responsible_sector, sector))
      && (!cleaningType || (location.cleaning_type || "Estrutural") === cleaningType)
      && (!itemId || location.id === itemId));
  return (
    <>
      <PageHeading eyebrow="ORGANIZAÇÃO" title="Limpeza" description={isBoss ? "Cadastre os itens que devem ser limpos e organize-os por setor e tipo de limpeza." : "Consulte os itens de limpeza do seu setor e registre as atividades."} action={isBoss && <button className="button-primary" onClick={onAdd}><Plus size={17} /> Novo item</button>} />
      <div className="toolbar panel cleaning-toolbar">
        <div className="toolbar-copy"><span className="result-count">{sectorLocations.length}</span><span>{sectorLocations.length === 1 ? "item" : "itens"}</span></div>
        <div className="toolbar-filters cleaning-filters">
          <div className="filter-control"><Users size={15} /><select value={sector} onChange={(event) => { setSector(event.target.value); setCleaningType(""); setItemId(""); setResponsible(""); }} aria-label="Filtrar por setor"><option value="">Todos os setores</option>{sectorOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select><ChevronDown size={14} /></div>
          <div className="filter-control"><Filter size={15} /><select value={cleaningType} disabled={!sector} onChange={(event) => { setCleaningType(event.target.value); setItemId(""); setResponsible(""); }} aria-label="Filtrar por tipo de limpeza"><option value="">Todos os tipos</option>{typeOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select><ChevronDown size={14} /></div>
          <div className="filter-control"><Leaf size={15} /><select value={itemId} disabled={!cleaningType} onChange={(event) => setItemId(event.target.value)} aria-label="Filtrar por item a ser limpo"><option value="">Todos os itens</option>{itemOptions.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select><ChevronDown size={14} /></div>
          <div className="filter-control"><Filter size={16} /><select value={frequency} onChange={(event) => setFrequency(event.target.value)} aria-label="Filtrar por frequência"><option value="">Todas as frequências</option>{FREQUENCIES.map((value) => <option key={value}>{value}</option>)}</select><ChevronDown size={14} /></div>
          <div className="filter-control"><Users size={15} /><select value={responsible} onChange={(event) => setResponsible(event.target.value)} aria-label="Filtrar por responsável"><option value="">Todos responsáveis</option>{responsibleOptions.map((value) => <option key={value}>{value}</option>)}</select><ChevronDown size={14} /></div>
          <div className="filter-control"><ImagePlus size={15} /><select value={photo} onChange={(event) => setPhoto(event.target.value)} aria-label="Filtrar por foto"><option value="">Todas as fotos</option><option value="with">Com foto</option><option value="without">Sem foto</option></select><ChevronDown size={14} /></div>
        </div>
      </div>
      {loading && !allLocations.length ? <LoadingState /> : sectorLocations.length ? (
        <section className="location-grid">
          {sectorLocations.map((location, index) => (
            <article className="location-card" key={location.id} style={{ "--card-delay": `${index * 45}ms` }}>
              <div className="location-cover" role="button" tabIndex={0} onClick={() => onView(location)} onKeyDown={(event) => event.key === "Enter" && onView(location)}>
                {location.photo ? <img src={location.photo} alt={`Foto de ${location.name}`} /> : <div className="cover-placeholder"><Leaf size={27} /><span>{initials(location.name)}</span></div>}
                <span className={`status-pill cover-status ${location.last_status === "Limpo" ? "status-done" : location.last_status === "Não limpo" ? "status-attention" : "status-neutral"}`}>
                  {location.last_status || "Sem registros"}
                </span>
                {isBoss && <button className="card-edit" onClick={(event) => { event.stopPropagation(); onEdit(location); }} aria-label={`Editar ${location.name}`}><Pencil size={15} /></button>}
              </div>
              <div className="location-card-body">
                <button className="location-name-button" onClick={() => onView(location)}><h3>{location.name}</h3><ArrowUpRight size={16} /></button>
                <div className="location-meta"><span><Filter size={14} />{location.cleaning_type || "Estrutural"}</span><span><Users size={14} />{location.responsible}</span><span><CalendarDays size={14} />{scheduleDescription(location.schedule_days, location.schedule_time)}</span></div>
                <div className="location-card-bottom"><span>{location.cleaning_count === 1 ? "1 registro" : `${location.cleaning_count || 0} registros`} · {formatDate(location.last_cleaned)}</span><button className="text-button compact" onClick={() => onAddCleaning(location)}><Plus size={14} /> Registrar</button></div>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <EmptyState className="large-empty" icon={Leaf} title={allLocations.length ? "Nenhum item encontrado" : "Comece cadastrando um item"} description={allLocations.length ? "Tente mudar a busca ou os filtros aplicados." : "Cadastre os itens e associe cada um a um setor e tipo de limpeza."} action={!allLocations.length && isBoss && <button className="button-primary" onClick={onAdd}><Plus size={17} /> Cadastrar primeiro item</button>} />
      )}
    </>
  );
}

function HistoryPage({ entries, locations, sectors, isBoss, loading, status, setStatus, onAdd, onView }) {
  const [sector, setSector] = useState("");
  const filteredEntries = entries.filter((entry) => !isBoss || !sector || sameSector(entry.responsible_sector, sector));
  return (
    <>
      <PageHeading eyebrow="ACOMPANHAMENTO" title="Histórico de limpeza" description="Consulte os registros, status e evidências de cada atividade." action={<button className="button-primary" onClick={onAdd} disabled={!locations.length}><Plus size={17} /> Registrar limpeza</button>} />
      <div className="toolbar panel">
        <div className="toolbar-copy"><span className="result-count">{filteredEntries.length}</span><span>{filteredEntries.length === 1 ? "registro" : "registros"}</span></div>
        <div className="toolbar-filters">
          {isBoss && <div className="filter-control"><Users size={15} /><select value={sector} onChange={(event) => setSector(event.target.value)} aria-label="Filtrar histórico por setor"><option value="">Todos os setores</option>{sectors.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select><ChevronDown size={14} /></div>}
          <div className="filter-control"><Filter size={16} /><select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filtrar por status"><option value="">Todos</option><option value="Concluída">Concluídas</option><option value="Não feito">Não feitas</option></select><ChevronDown size={14} /></div>
        </div>
      </div>
      <section className="panel history-panel">
        {loading && !entries.length ? <LoadingState /> : filteredEntries.length ? (
          <div className="table-scroll"><table className="history-table">
            <thead><tr><th>A SER LIMPO</th><th>RESPONSÁVEL</th><th>EXECUÇÃO</th><th>SETOR</th><th>DATA E HORA</th><th>STATUS</th><th>EVIDÊNCIAS</th><th aria-label="Abrir" /></tr></thead>
            <tbody>{filteredEntries.map((entry) => <tr key={entry.id} onClick={() => onView(entry)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && onView(entry)}>
              <td data-label="A ser limpo"><span className="table-location"><span className="table-location-icon"><Leaf size={15} /></span><strong>{entry.location_name}</strong></span></td>
              <td data-label="Responsável"><span className="table-person"><span className="person-initial">{initials(entry.responsible || entry.created_by_name)}</span>{entry.responsible || "—"}</span></td>
              <td data-label="Execução">{entry.executor_name || (entry.status === "Não feito" ? "—" : entry.created_by_name) || "—"}</td>
              <td data-label="Setor">{entry.responsible_sector || "—"}</td>
              <td data-label="Data e hora">{formatDateTime(entry.event_at || entry.created_at)}</td>
              <td data-label="Status"><span className={`status-pill ${entry.status === "Limpo" || entry.status === "Concluída" ? "status-done" : "status-attention"}`}><span className="status-dot" />{entry.status}</span></td>
              <td data-label="Evidências"><span className="evidence-count"><ImagePlus size={15} />{Number(Boolean(entry.photo_before)) + Number(Boolean(entry.photo_after))}/2 fotos</span></td>
              <td data-label="Abrir"><button className="icon-button table-open" onClick={(event) => { event.stopPropagation(); onView(entry); }} aria-label={`Abrir registro de ${entry.location_name}`}><ChevronRight size={17} /></button></td>
            </tr>)}</tbody>
          </table></div>
        ) : <EmptyState className="large-empty" icon={ClipboardCheck} title="Ainda não há registros" description={locations.length ? "Registre uma limpeza para começar a montar o histórico." : "Cadastre um local antes de registrar uma limpeza."} action={locations.length > 0 && <button className="button-primary" onClick={onAdd}><Plus size={17} /> Registrar limpeza</button>} />}
      </section>
    </>
  );
}

function EmptyState({ icon: Icon, title, description, action, className = "" }) {
  return <div className={`empty-state ${className}`}><div className="empty-icon"><Icon size={22} /></div><h3>{title}</h3><p>{description}</p>{action}</div>;
}

function LoadingState() {
  return <div className="loading-state"><LoaderCircle className="spin" size={22} />Carregando dados…</div>;
}

function AboutPage() {
  return (
    <>
      <PageHeading eyebrow="INFORMAÇÕES" title="Sobre o Rotina" description="Uma forma simples e organizada de acompanhar os cuidados do dia a dia." />
      <section className="about-grid">
        <article className="panel about-card about-intro"><div className="about-logo"><Leaf size={24} /></div><div className="eyebrow">ROUTINER · CONTROLE DE LIMPEZA</div><h2>Uma rotina clara<br />para todos.</h2><p>Cadastre ambientes, defina responsáveis e frequências, e mantenha um histórico visual das atividades realizadas.</p></article>
        <article className="panel about-card"><div className="about-feature-icon sage"><LayoutDashboard size={19} /></div><h3>Visão geral</h3><p>Acompanhe os principais indicadores e as atividades mais recentes em um só lugar.</p></article>
        <article className="panel about-card"><div className="about-feature-icon blue"><Leaf size={19} /></div><h3>Gestão de locais</h3><p>Organize ambientes, responsáveis, periodicidade e fotos de referência.</p></article>
        <article className="panel about-card"><div className="about-feature-icon amber"><ClipboardCheck size={19} /></div><h3>Histórico com evidências</h3><p>Registre data, status, observações e fotos de antes e depois da limpeza.</p></article>
        <article className="panel about-card"><div className="about-feature-icon green"><Clock3 size={19} /></div><h3>Feito para sua equipe</h3><p>Uma interface simples e responsiva para consultar as informações no computador ou celular.</p></article>
      </section>
    </>
  );
}

function Modal({ title, subtitle, children, onClose, wide = false }) {
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><div><div className="eyebrow">{subtitle}</div><h2>{title}</h2></div><button className="icon-button modal-close" onClick={onClose} aria-label="Fechar"><X size={19} /></button></header>{children}</section></div>;
}

function ImageField({ label, value, onChange, allowCamera = false }) {
  const galleryInputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const preview = useMemo(() => typeof value === "string" ? value : value ? URL.createObjectURL(value) : "", [value]);
  useEffect(() => () => { if (value instanceof File) URL.revokeObjectURL(preview); }, [preview, value]);
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);
  useEffect(() => {
    if (cameraOpen && videoRef.current && streamRef.current) videoRef.current.srcObject = streamRef.current;
  }, [cameraOpen]);
  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }
  async function openCamera() {
    setUploadError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setUploadError("A câmera não está disponível neste dispositivo.");
      return;
    }
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      setCameraOpen(true);
    } catch (error) {
      setUploadError(`Não foi possível acessar a câmera: ${error.message}`);
    }
  }
  async function upload(file) {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setUploadError("Use uma imagem JPG, PNG ou WEBP.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError("A imagem deve ter até 5 MB.");
      return;
    }
    setUploadError("");
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await api("/upload", { method: "POST", body: formData });
      onChange(result.url);
    } catch (error) {
      setUploadError(error.message);
    } finally {
      setUploading(false);
    }
  }
  function capturePhoto() {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) {
      setUploadError("A câmera ainda está carregando. Tente novamente em instantes.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setUploadError("Não foi possível preparar a captura da foto.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) {
        setUploadError("Não foi possível capturar a foto. Tente novamente.");
        return;
      }
      setCameraOpen(false);
      stopCamera();
      void upload(new File([blob], "foto-do-local.jpg", { type: "image/jpeg" }));
    }, "image/jpeg", 0.9);
  }
  if (allowCamera) {
    return <div className="form-field"><label>{label}</label>
      {cameraOpen ? (
        <div className="camera-preview location-camera">
          <video ref={videoRef} autoPlay playsInline muted />
          <div className="location-photo-actions">
            <button type="button" className="button-primary" disabled={uploading} onClick={capturePhoto}><Camera size={16} /> Tirar foto</button>
            <button type="button" className="button-secondary" onClick={() => { setCameraOpen(false); stopCamera(); }}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div className="location-photo-picker">
          {preview && <img className="location-photo-preview" src={preview} alt={`Prévia: ${label}`} />}
          {uploading && <div className="location-photo-uploading"><LoaderCircle className="spin" size={18} /> Enviando imagem…</div>}
          <div className="location-photo-actions">
            <button type="button" className="button-secondary" disabled={uploading} onClick={() => galleryInputRef.current?.click()}><ImagePlus size={16} />{preview ? "Escolher da galeria" : "Adicionar da galeria"}</button>
            <button type="button" className="button-secondary" disabled={uploading} onClick={openCamera}><Camera size={16} /> Tirar foto</button>
          </div>
          <small className="field-hint">Escolha uma imagem JPG, PNG ou WEBP de até 5 MB ou tire uma foto agora.</small>
          <input ref={galleryInputRef} className="location-gallery-input" type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
        </div>
      )}
      {uploadError && <span className="field-error">{uploadError}</span>}
    </div>;
  }
  return <div className="form-field"><label>{label}</label><label className={`image-upload ${preview ? "has-image" : ""}`}>
    {preview ? <><img src={preview} alt={`Prévia: ${label}`} /><span className="image-change"><Pencil size={14} /> Trocar foto</span></> : <><span className="image-upload-icon">{uploading ? <LoaderCircle className="spin" size={20} /> : <ImagePlus size={20} />}</span><strong>{uploading ? "Enviando imagem…" : "Adicionar foto"}</strong><small>JPG, PNG ou WEBP · até 5 MB</small></>}
    <input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={(event) => upload(event.target.files?.[0])} />
  </label>{uploadError && <span className="field-error">{uploadError}</span>}</div>;
}

function LocationForm({ item, team, sectors, saving, onClose, onSave, onDelete }) {
  const [values, setValues] = useState(() => {
    let scheduleDays = [0, 1, 2, 3, 4, 5];
    try {
      if (item?.schedule_days) scheduleDays = JSON.parse(item.schedule_days);
    } catch {
      scheduleDays = [0, 1, 2, 3, 4, 5];
    }
    return {
      name: item?.name || "",
      cleaning_type: item?.cleaning_type || "Estrutural",
      responsible: item?.responsible || "",
      responsible_user_id: item?.responsible_user_id || "",
      frequency: item?.frequency || "",
      photo: item?.photo || "",
      schedule_days: scheduleDays,
      schedule_time: item?.schedule_time || "23:59",
    };
  });
  const [sector, setSector] = useState(item?.responsible_sector || team.find((member) =>
    member.id === item?.responsible_user_id || member.name === item?.responsible)?.sector || "");
  const sectorTeam = team.filter((member) => Boolean(sector) && member.sector === sector);
  const [error, setError] = useState("");
  function change(key, value) { setValues((current) => ({ ...current, [key]: value })); }
  function toggleDay(day) {
    setValues((current) => ({
      ...current,
      schedule_days: current.schedule_days.includes(day)
        ? current.schedule_days.filter((selected) => selected !== day)
        : [...current.schedule_days, day].sort(),
    }));
  }
  async function submit(event) {
    event.preventDefault();
    const responsible = sectorTeam.find((member) => member.id === values.responsible_user_id);
    if (!values.name.trim() || !values.cleaning_type.trim() || !responsible || !values.schedule_days.length) {
      setError("Preencha o item, o tipo de limpeza, o responsável e ao menos um dia da rotina.");
      return;
    }
    setError("");
    await onSave({
      ...values,
      name: values.name.trim(),
      cleaning_type: values.cleaning_type.trim(),
      sector,
      responsible: responsible.name,
      frequency: values.schedule_days.length === 7 ? "Diário" : "Semanal",
    }, item?.id);
  }
  return <Modal title={item ? "Editar item de limpeza" : "Novo item de limpeza"} subtitle="CADASTRO DE ITEM" onClose={onClose}>
    <form className="modal-form" onSubmit={submit}>
      <ImageField label="Foto do local" value={values.photo} onChange={(value) => change("photo", value)} allowCamera />
      <div className="form-row">
        <div className="form-field"><label htmlFor="location-sector">Setor <span className="required">*</span></label><select id="location-sector" required value={sector} onChange={(event) => { setSector(event.target.value); change("responsible_user_id", ""); }}><option value="">Selecione um setor</option>{sectors.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></div>
        <div className="form-field"><label htmlFor="location-cleaning-type">Tipo de limpeza <span className="required">*</span></label><input id="location-cleaning-type" required minLength={2} maxLength={80} placeholder="Ex.: Estrutural" value={values.cleaning_type} onChange={(event) => change("cleaning_type", event.target.value)} /></div>
      </div>
      <div className="form-field"><label htmlFor="location-name">A ser limpo <span className="required">*</span></label><input id="location-name" autoFocus required minLength={1} maxLength={100} placeholder="Ex.: Chão, paredes, bancada" value={values.name} onChange={(event) => change("name", event.target.value)} /></div>
      <div className="form-field"><label htmlFor="location-responsible">Funcionário responsável <span className="required">*</span></label><select id="location-responsible" required value={values.responsible_user_id} onChange={(event) => change("responsible_user_id", event.target.value)}><option value="">Selecione um funcionário</option>{sectorTeam.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></div>
      <fieldset className="schedule-days-field">
        <legend>Dias da rotina <span className="required">*</span></legend>
        <div className="schedule-days">{WEEKDAYS.map((label, day) => <label className={values.schedule_days.includes(day) ? "selected" : ""} key={label}><input type="checkbox" checked={values.schedule_days.includes(day)} onChange={() => toggleDay(day)} /><span>{label}</span></label>)}</div>
      </fieldset>
      <div className="form-field"><label htmlFor="location-schedule-time">Horário limite <span className="required">*</span></label><input id="location-schedule-time" type="time" required value={values.schedule_time} onChange={(event) => change("schedule_time", event.target.value)} /><small className="field-hint">A tarefa será criada automaticamente para cada dia selecionado. Se não for concluída até esse horário, irá para o histórico como “Não feito”.</small></div>
      {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      <footer className="modal-footer">{item && <button type="button" className="button-danger-ghost" onClick={onDelete}><Trash2 size={16} /> Excluir</button>}<span className="footer-spacer" /><button type="button" className="button-secondary" onClick={onClose}>Cancelar</button><button className="button-primary" disabled={saving}>{saving && <LoaderCircle size={16} className="spin" />}{item ? "Salvar alterações" : "Cadastrar item"}</button></footer>
    </form>
  </Modal>;
}

function CleaningForm({ item, initial, locations, saving, onClose, onSave }) {
  const initialLocationId = item?.location_id || initial?.location_id || "";
  const initialLocation = locations.find((location) => location.id === initialLocationId);
  const [sector, setSector] = useState(initialLocation?.responsible_sector || "");
  const [cleaningType, setCleaningType] = useState(initialLocation?.cleaning_type || "");
  const [values, setValues] = useState({
    location_id: initialLocationId,
    cleaning_date: item?.cleaning_date || todayValue(),
    status: item?.status || "Limpo",
    photo_before: item?.photo_before || "",
    photo_after: item?.photo_after || "",
    notes: item?.notes || "",
  });
  const sectorOptions = [...new Set(locations.map((location) => location.responsible_sector).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "pt-BR"));
  const typeOptions = [...new Set(locations
    .filter((location) => !sector || sameSector(location.responsible_sector, sector))
    .map((location) => location.cleaning_type || "Estrutural"))]
    .sort((left, right) => left.localeCompare(right, "pt-BR"));
  const itemOptions = locations.filter((location) =>
    (!sector || sameSector(location.responsible_sector, sector))
      && (!cleaningType || (location.cleaning_type || "Estrutural") === cleaningType));
  const [error, setError] = useState("");
  function change(key, value) { setValues((current) => ({ ...current, [key]: value })); }
  async function submit(event) {
    event.preventDefault();
    if (!values.location_id || !values.cleaning_date || !values.status) {
      setError("Selecione o local, a data e o status do registro.");
      return;
    }
    setError("");
    await onSave(values, item?.id);
  }
  return <Modal title={item ? "Editar registro" : "Registrar limpeza"} subtitle="HISTÓRICO DE ATIVIDADES" onClose={onClose} wide>
    {!locations.length ? <div className="modal-empty"><Leaf size={24} /><p>Cadastre um item na aba Limpeza antes de registrar uma limpeza.</p><button className="button-secondary" onClick={onClose}>Entendi</button></div> : <form className="modal-form" onSubmit={submit}>
      <div className="form-row">
        <div className="form-field"><label htmlFor="cleaning-sector">Setor <span className="required">*</span></label><select id="cleaning-sector" required value={sector} onChange={(event) => { setSector(event.target.value); setCleaningType(""); change("location_id", ""); }}><option value="">Selecione um setor</option>{sectorOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
        <div className="form-field"><label htmlFor="cleaning-type">Tipo de limpeza <span className="required">*</span></label><select id="cleaning-type" required disabled={!sector} value={cleaningType} onChange={(event) => { setCleaningType(event.target.value); change("location_id", ""); }}><option value="">Selecione um tipo</option>{typeOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
      </div>
      <div className="form-row">
        <div className="form-field"><label htmlFor="cleaning-location">A ser limpo <span className="required">*</span></label><select id="cleaning-location" required disabled={!cleaningType} value={values.location_id} onChange={(event) => change("location_id", event.target.value)}><option value="">Selecione um item</option>{itemOptions.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}</select></div>
        <div className="form-field"><label htmlFor="cleaning-date">Data <span className="required">*</span></label><input id="cleaning-date" type="date" value={values.cleaning_date} onChange={(event) => change("cleaning_date", event.target.value)} /></div>
      </div>
      <div className="form-field"><label>Status <span className="required">*</span></label><div className="status-choice">{STATUSES.map((status) => <button type="button" key={status} onClick={() => change("status", status)} className={`status-option ${values.status === status ? `selected ${status === "Limpo" ? "selected-done" : "selected-attention"}` : ""}`}><span className={`choice-icon ${status === "Limpo" ? "done" : "attention"}`}>{status === "Limpo" ? <Check size={15} /> : <CircleAlert size={15} />}</span><span><strong>{status}</strong><small>{status === "Limpo" ? "Atividade concluída" : "Precisa ser refeita"}</small></span>{values.status === status && <CheckCircle2 size={17} className="choice-check" />}</button>)}</div></div>
      <div className="form-row image-fields"><ImageField label="Foto antes" value={values.photo_before} onChange={(value) => change("photo_before", value)} /><ImageField label="Foto depois" value={values.photo_after} onChange={(value) => change("photo_after", value)} /></div>
      <div className="form-field"><label htmlFor="cleaning-notes">Observações <span className="optional">(opcional)</span></label><textarea id="cleaning-notes" rows="3" maxLength={1000} placeholder="Adicione algum detalhe sobre esta atividade…" value={values.notes} onChange={(event) => change("notes", event.target.value)} /></div>
      {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      <footer className="modal-footer"><span className="footer-spacer" /><button type="button" className="button-secondary" onClick={onClose}>Cancelar</button><button className="button-primary" disabled={saving}>{saving && <LoaderCircle size={16} className="spin" />}{item ? "Salvar alterações" : "Registrar atividade"}</button></footer>
    </form>}
  </Modal>;
}

function RecordDialog({ item, isBoss, onClose, onDelete }) {
  const isMissedTask = item.record_type === "task" && item.status === "Não feito";
  const activityDate = item.record_type === "task"
    ? item.completed_at || item.missed_at
    : item.event_at || item.created_at;
  return <Modal title={item.record_type === "task" ? "Detalhes da tarefa" : "Detalhes do registro"} subtitle={item.record_type === "task" ? "HISTÓRICO DE TAREFAS" : "HISTÓRICO DE LIMPEZA"} onClose={onClose} wide>
    <div className="record-detail">
      <div className="record-summary"><span className="table-location-icon">{item.record_type === "task" ? <Check size={17} /> : <Leaf size={17} />}</span><div><strong>{item.location_name}</strong><small>Responsável: {item.responsible || "—"} · Execução: {item.executor_name || item.created_by_name || "—"}</small></div><span className={`status-pill ${item.status === "Limpo" || item.status === "Concluída" ? "status-done" : "status-attention"}`}><span className="status-dot" />{item.status}</span></div>
      <div className="record-date"><CalendarDays size={17} /><span>{isMissedTask ? "Prazo vencido" : item.record_type === "task" ? "Data da conclusão" : "Data da atividade"}</span><strong>{formatDateTime(activityDate)}</strong></div>
      {item.notes && <div className="record-notes"><span>OBSERVAÇÕES</span><p>{item.notes}</p></div>}
      <div className="record-photos">
        <PhotoView label="Foto antes" photo={item.photo_before} />
        <PhotoView label="Foto depois" photo={item.photo_after} />
      </div>
      <footer className="modal-footer">{(item.record_type !== "task" || (isBoss && isMissedTask)) && <button className="button-danger-ghost" onClick={onDelete}><Trash2 size={16} /> {isMissedTask ? "Remover do histórico" : "Excluir registro"}</button>}<span className="footer-spacer" /><button className="button-secondary" onClick={onClose}>Fechar</button></footer>
    </div>
  </Modal>;
}

function PhotoView({ label, photo }) {
  return <div className="photo-view"><span className="photo-label">{label}</span>{photo ? <a href={photo} target="_blank" rel="noreferrer"><img src={photo} alt={label} /><span>Ampliar foto <ArrowUpRight size={13} /></span></a> : <div className="no-photo"><ImagePlus size={22} /><span>Sem foto</span></div>}</div>;
}

function LocationDialog({ item, records, onClose, onEdit, onRegister, onRecord, isBoss }) {
  return <Modal title={item.name} subtitle="DETALHES DO ITEM DE LIMPEZA" onClose={onClose} wide>
    <div className="location-detail-content">
      {item.photo && <img className="detail-cover" src={item.photo} alt={`Foto de ${item.name}`} />}
      <div className="detail-info-grid"><div><span>A ser limpo</span><strong>{item.name}</strong></div><div><span>Setor</span><strong>{item.responsible_sector || "—"}</strong></div><div><span>Tipo de limpeza</span><strong>{item.cleaning_type || "Estrutural"}</strong></div><div><span>Responsável</span><strong>{item.responsible}</strong></div><div><span>Rotina</span><strong>{scheduleDescription(item.schedule_days, item.schedule_time)}</strong></div><div><span>Última limpeza</span><strong>{formatDate(item.last_cleaned)}</strong></div></div>
      <div className="detail-history-heading"><div><h3>Histórico de limpeza</h3><p>{records.length} {records.length === 1 ? "registro" : "registros"}</p></div><button className="text-button" onClick={onRegister}><Plus size={15} /> Registrar</button></div>
      {records.length ? <div className="detail-record-list">{records.map((record) => <button key={record.id} className="detail-record" onClick={() => onRecord(record)}><span className={`activity-icon ${record.status === "Limpo" ? "done" : "attention"}`}>{record.status === "Limpo" ? <Check size={15} /> : <CircleAlert size={15} />}</span><span className="activity-main"><strong>{formatDate(record.cleaning_date)}</strong><small>{record.created_by_name || "Equipe"}{record.notes ? ` · ${record.notes}` : ""}</small></span><span className={`status-pill ${record.status === "Limpo" ? "status-done" : "status-attention"}`}>{record.status}</span><ChevronRight size={16} /></button>)}</div> : <div className="mini-empty">Ainda não existem registros visíveis para este local.</div>}
      <footer className="modal-footer">{isBoss && <button className="button-secondary" onClick={onEdit}><Pencil size={15} /> Editar item</button>}<span className="footer-spacer" /><button className="button-secondary" onClick={onClose}>Fechar</button><button className="button-primary" onClick={onRegister}><Plus size={16} /> Registrar limpeza</button></footer>
    </div>
  </Modal>;
}

export default App;
