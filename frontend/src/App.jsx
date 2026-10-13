import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Building2,
  CalendarDays,
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
  LogOut,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  ShieldCheck,
  Search,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";

const FREQUENCIES = ["Diário", "Semanal", "Quinzenal", "Mensal"];
const STATUSES = ["Limpo", "Não limpo"];
const navItems = [
  { id: "dashboard", label: "Visão geral", icon: LayoutDashboard },
  { id: "locations", label: "Locais", icon: Leaf },
  { id: "history", label: "Histórico", icon: ClipboardCheck },
  { id: "team", label: "Equipe", icon: Users, companyOnly: true },
];

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

function todayValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function initials(name = "") {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "—";
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
  const [locations, setLocations] = useState([]);
  const [history, setHistory] = useState([]);
  const [team, setTeam] = useState([]);
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
  const isBoss = account.role === "company";

  const refresh = useCallback(async () => {
    setLoading(true);
    setPageError("");
    try {
      const [locationRows, historyRows, dashboardData, teamRows] = await Promise.all([
        api("/locations"),
        api("/history"),
        api("/dashboard"),
        isBoss ? api("/users") : Promise.resolve([]),
      ]);
      setLocations(locationRows);
      setHistory(historyRows);
      setDashboard(dashboardData);
      setTeam(teamRows);
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
    const matchesQuery = `${entry.location_name} ${entry.responsible} ${entry.notes || ""}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (!statusFilter || entry.status === statusFilter);
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

  async function removeItem(kind, id) {
    const label = kind === "locations" ? "este local e todo o histórico relacionado" : "este registro";
    if (!window.confirm(`Tem certeza de que deseja excluir ${label}? Esta ação não pode ser desfeita.`)) return;
    try {
      await api(`/${kind}/${id}`, { method: "DELETE" });
      setModal(null);
      setToast(kind === "locations" ? "Local excluído." : "Registro excluído.");
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
            <button className="icon-button profile-more" aria-label="Sair da conta" title="Sair" onClick={onLogout}><LogOut size={17} /></button>
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
                placeholder={page === "history" ? "Buscar no histórico..." : page === "locations" ? "Buscar locais..." : "Buscar..."}
                aria-label="Buscar"
              />
              {query && <button type="button" className="search-clear" onClick={() => setQuery("")} aria-label="Limpar busca"><X size={14} /></button>}
              {!query && <kbd>⌘ K</kbd>}
            </label>
            <button className="sync-button" onClick={refresh} disabled={loading} title="Atualizar dados">
              <LoaderCircle size={16} className={loading ? "spin" : ""} />
              <span>Atualizar</span>
            </button>
            {installPrompt && <button className="install-button" onClick={onInstall}><Download size={15} /><span>Instalar app</span></button>}
            <div className="top-avatar" title={account.name}>{initials(account.name)}</div>
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
              loading={loading}
              status={statusFilter}
              setStatus={setStatusFilter}
              onAdd={() => setModal({ type: "cleaning" })}
              onView={(item) => setModal({ type: "record", item })}
            />
          )}
          {page === "team" && isBoss && (
            <TeamPage
              team={team}
              loading={loading}
              company={account.company}
              onAdd={() => setModal({ type: "user" })}
            />
          )}
          {page === "about" && <AboutPage />}
        </div>
      </main>

      {toast && <div className="toast" role="status"><CheckCircle2 size={18} />{toast}</div>}
      {modal?.type === "location" && (
        <LocationForm
          item={modal.item}
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
      {modal?.type === "user" && (
        <UserForm
          company={account.company}
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
      {modal?.type === "record" && (
        <RecordDialog
          item={modal.item}
          onClose={() => setModal(null)}
          onDelete={() => removeItem("history", modal.item.id)}
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
  const [mode, setMode] = useState("login");
  const [role, setRole] = useState("company");
  const [values, setValues] = useState({
    fantasy_name: "",
    company_handle: "",
    email: "",
    identifier: "",
    password: "",
  });
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  useEffect(() => setError(initialError), [initialError]);
  function change(key, value) {
    setValues((current) => ({ ...current, [key]: value }));
    setError("");
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
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand"><span className="auth-brand-mark"><Leaf size={22} /></span><div><strong>Routiner</strong><small>GESTÃO DE LIMPEZA</small></div></div>
        <div className="auth-heading"><span className="eyebrow">{registration ? "COMECE POR AQUI" : "BEM-VINDO DE VOLTA"}</span><h1>{registration ? "Cadastre sua empresa" : "Acesse sua rotina"}</h1><p>{registration ? "Crie o espaço da empresa e convide sua equipe." : "Entre para acompanhar as atividades da sua empresa."}</p></div>
        {!registration && (
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
          ) : (
            <>
              <div className="form-field"><label htmlFor="login-identifier">{role === "company" ? "Login da empresa" : "Login do funcionário"}</label><input id="login-identifier" autoCapitalize="none" autoComplete="username" required maxLength={150} placeholder={role === "company" ? "empresa.routine" : "usuario.empresa.routine"} value={values.identifier} onChange={(event) => change("identifier", event.target.value.toLowerCase().trim())} /><small className="field-hint">{role === "company" ? "O identificador escolhido no cadastro da empresa." : "Formato: usuario.identificador-da-empresa.routine."}</small></div>
              <div className="form-field"><label htmlFor="login-password">Senha</label><input id="login-password" type="password" autoComplete="current-password" required maxLength={128} placeholder="Sua senha" value={values.password} onChange={(event) => change("password", event.target.value)} /></div>
            </>
          )}
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
          <button className="button-primary auth-submit" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" />}{registration ? "Criar empresa" : "Entrar"}<ArrowRight size={16} /></button>
        </form>
        <div className="auth-switch">{registration ? "Sua empresa já tem uma conta?" : "Ainda não tem uma empresa cadastrada?"} <button onClick={() => { setMode(registration ? "login" : "register"); setRole("company"); setError(""); }}> {registration ? "Entrar" : "Cadastrar empresa"}</button></div>
        <div className="auth-footer">Seus dados e registros ficam separados por empresa.</div>
      </section>
      <aside className="auth-aside"><div className="auth-orb orb-a" /><div className="auth-orb orb-b" /><div className="auth-aside-content"><div className="auth-aside-icon"><ClipboardCheck size={25} /></div><span>ROTINA ORGANIZADA. EQUIPE ALINHADA.</span><h2>O cuidado diário,<br />em um só lugar.</h2><p>Gerencie locais, acompanhe as atividades e dê à sua equipe uma rotina mais simples e transparente.</p><div className="auth-benefit"><span><Check size={14} /></span> Um espaço seguro para cada empresa</div><div className="auth-benefit"><span><Check size={14} /></span> Registros identificados por funcionário</div></div></aside>
    </main>
  );
}

function TeamPage({ team, loading, company, onAdd }) {
  return (
    <>
      <PageHeading eyebrow="ADMINISTRAÇÃO DA EMPRESA" title="Sua equipe" description="Gerencie as contas e acompanhe quem registrou cada atividade." action={<button className="button-primary" onClick={onAdd}><Plus size={17} /> Cadastrar funcionário</button>} />
      <section className="company-summary panel"><div className="company-symbol"><Building2 size={20} /></div><div><span>EMPRESA</span><strong>{company.fantasy_name}</strong><small>Login: {company.company_handle}.routine · {company.email}</small></div><span className="admin-badge"><BadgeCheck size={14} /> Administrador</span></section>
      <section className="panel team-panel">
        <div className="section-head"><div><h2>Contas de funcionários</h2><p>Funcionários veem apenas os registros criados pela própria conta.</p></div><span className="result-count">{team.length}</span></div>
        {loading && !team.length ? <LoadingState /> : team.length ? (
          <div className="table-scroll"><table className="history-table team-table"><thead><tr><th>FUNCIONÁRIO</th><th>SETOR</th><th>LOGIN</th><th>CONTA</th></tr></thead><tbody>
            {team.map((member) => <tr key={member.id}><td><span className="table-person"><span className="person-initial">{initials(member.name)}</span><strong>{member.name}</strong></span></td><td>{member.sector}</td><td><code className="login-code">{member.login}</code></td><td><span className="team-status"><span className="status-dot" /> Ativa</span></td></tr>)}
          </tbody></table></div>
        ) : <EmptyState className="team-empty" icon={Users} title="Ainda não há funcionários" description="Cadastre um funcionário para que ele possa entrar e registrar as próprias atividades." action={<button className="button-primary" onClick={onAdd}><Plus size={16} /> Cadastrar primeiro funcionário</button>} />}
      </section>
    </>
  );
}

function UserForm({ company, saving, onClose, onSave }) {
  const [values, setValues] = useState({ name: "", sector: "", username: "", password: "" });
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
      <div className="form-field"><label htmlFor="employee-sector">Setor <span className="required">*</span></label><input id="employee-sector" required minLength={2} maxLength={80} placeholder="Ex.: Cozinha, salão, estoque" value={values.sector} onChange={(event) => setValues({ ...values, sector: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="employee-username">Identificador de usuário <span className="required">*</span></label><div className="handle-input"><input id="employee-username" required minLength={2} maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9\-]{1,29}" placeholder="maria" value={values.username} onChange={(event) => setValues({ ...values, username: event.target.value.toLowerCase() })} /><span>.{company.company_handle}.routine</span></div><small className="field-hint">Login completo: <code>{login}</code></small></div>
      <div className="form-field"><label htmlFor="employee-password">Senha inicial <span className="required">*</span></label><input id="employee-password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" placeholder="Mínimo de 8 caracteres" value={values.password} onChange={(event) => setValues({ ...values, password: event.target.value })} /><small className="field-hint">Compartilhe o login e a senha inicial com o funcionário.</small></div>
      <div className="auth-note"><ShieldCheck size={16} /><span>O funcionário só poderá consultar os registros enviados pelo próprio login. A empresa poderá consultar todos.</span></div>
      {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      <footer className="modal-footer"><span className="footer-spacer" /><button type="button" className="button-secondary" onClick={onClose}>Cancelar</button><button className="button-primary" disabled={saving}>{saving && <LoaderCircle size={16} className="spin" />}Criar conta</button></footer>
    </form>
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

function DashboardPage({ data, loading, locations, history, account, onNavigate, onAddCleaning, onOpenRecord }) {
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
          <button className="welcome-link" onClick={() => onNavigate("locations")}>Ver meus locais <ArrowRight size={16} /></button>
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
          <button className="quick-action" onClick={() => onNavigate("locations")}><span className="quick-icon sage"><Leaf size={18} /></span><span><strong>Explorar locais</strong><small>{locations.length} {locations.length === 1 ? "local cadastrado" : "locais cadastrados"}</small></span><ArrowRight size={16} /></button>
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
  const responsibleOptions = [...new Set(allLocations.map((location) => location.responsible))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  return (
    <>
      <PageHeading eyebrow="ORGANIZAÇÃO" title="Locais da empresa" description={isBoss ? "Gerencie os ambientes e acompanhe a rotina de cada um." : "Consulte os ambientes da empresa e registre as atividades sob seu usuário."} action={isBoss && <button className="button-primary" onClick={onAdd}><Plus size={17} /> Novo local</button>} />
      <div className="toolbar panel">
        <div className="toolbar-copy"><span className="result-count">{locations.length}</span><span>{locations.length === 1 ? "local" : "locais"}{locations.length !== allLocations.length ? ` de ${allLocations.length}` : ""}</span></div>
        <div className="toolbar-filters">
          <div className="filter-control"><Filter size={16} /><select value={frequency} onChange={(event) => setFrequency(event.target.value)} aria-label="Filtrar por frequência"><option value="">Todas as frequências</option>{FREQUENCIES.map((value) => <option key={value}>{value}</option>)}</select><ChevronDown size={14} /></div>
          <div className="filter-control"><Users size={15} /><select value={responsible} onChange={(event) => setResponsible(event.target.value)} aria-label="Filtrar por responsável"><option value="">Todos responsáveis</option>{responsibleOptions.map((value) => <option key={value}>{value}</option>)}</select><ChevronDown size={14} /></div>
          <div className="filter-control"><ImagePlus size={15} /><select value={photo} onChange={(event) => setPhoto(event.target.value)} aria-label="Filtrar por foto"><option value="">Todas as fotos</option><option value="with">Com foto</option><option value="without">Sem foto</option></select><ChevronDown size={14} /></div>
        </div>
      </div>
      {loading && !allLocations.length ? <LoadingState /> : locations.length ? (
        <section className="location-grid">
          {locations.map((location, index) => (
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
                <div className="location-meta"><span><Users size={14} />{location.responsible}</span><span><CalendarDays size={14} />{location.frequency}</span></div>
                <div className="location-card-bottom"><span>{location.cleaning_count === 1 ? "1 registro" : `${location.cleaning_count || 0} registros`} · {formatDate(location.last_cleaned)}</span><button className="text-button compact" onClick={() => onAddCleaning(location)}><Plus size={14} /> Registrar</button></div>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <EmptyState className="large-empty" icon={Leaf} title={allLocations.length ? "Nenhum local encontrado" : "Comece cadastrando um local"} description={allLocations.length ? "Tente mudar a busca ou os filtros aplicados." : "Adicione um ambiente para organizar sua rotina de limpeza."} action={!allLocations.length && <button className="button-primary" onClick={onAdd}><Plus size={17} /> Cadastrar primeiro local</button>} />
      )}
    </>
  );
}

function HistoryPage({ entries, locations, loading, status, setStatus, onAdd, onView }) {
  return (
    <>
      <PageHeading eyebrow="ACOMPANHAMENTO" title="Histórico de limpeza" description="Consulte os registros, status e evidências de cada atividade." action={<button className="button-primary" onClick={onAdd} disabled={!locations.length}><Plus size={17} /> Registrar limpeza</button>} />
      <div className="toolbar panel">
        <div className="toolbar-copy"><span className="result-count">{entries.length}</span><span>{entries.length === 1 ? "registro" : "registros"}</span></div>
        <div className="filter-control"><Filter size={16} /><select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filtrar por status"><option value="">Todos os status</option>{STATUSES.map((value) => <option key={value}>{value}</option>)}</select><ChevronDown size={14} /></div>
      </div>
      <section className="panel history-panel">
        {loading && !entries.length ? <LoadingState /> : entries.length ? (
          <div className="table-scroll"><table className="history-table">
            <thead><tr><th>LOCAL</th><th>RESPONSÁVEL</th><th>DATA</th><th>STATUS</th><th>EVIDÊNCIAS</th><th aria-label="Abrir" /></tr></thead>
            <tbody>{entries.map((entry) => <tr key={entry.id} onClick={() => onView(entry)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && onView(entry)}>
              <td><span className="table-location"><span className="table-location-icon"><Leaf size={15} /></span><strong>{entry.location_name}</strong></span></td>
              <td><span className="table-person"><span className="person-initial">{initials(entry.created_by_name || entry.responsible)}</span>{entry.created_by_name || entry.responsible}</span></td>
              <td>{formatDate(entry.cleaning_date)}</td>
              <td><span className={`status-pill ${entry.status === "Limpo" ? "status-done" : "status-attention"}`}><span className="status-dot" />{entry.status}</span></td>
              <td><span className="evidence-count"><ImagePlus size={15} />{Number(Boolean(entry.photo_before)) + Number(Boolean(entry.photo_after))}/2 fotos</span></td>
              <td><button className="icon-button table-open" onClick={(event) => { event.stopPropagation(); onView(entry); }} aria-label={`Abrir registro de ${entry.location_name}`}><ChevronRight size={17} /></button></td>
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

function ImageField({ label, value, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const preview = useMemo(() => typeof value === "string" ? value : value ? URL.createObjectURL(value) : "", [value]);
  useEffect(() => () => { if (value instanceof File) URL.revokeObjectURL(preview); }, [preview, value]);
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
  return <div className="form-field"><label>{label}</label><label className={`image-upload ${preview ? "has-image" : ""}`}>
    {preview ? <><img src={preview} alt={`Prévia: ${label}`} /><span className="image-change"><Pencil size={14} /> Trocar foto</span></> : <><span className="image-upload-icon">{uploading ? <LoaderCircle className="spin" size={20} /> : <ImagePlus size={20} />}</span><strong>{uploading ? "Enviando imagem…" : "Adicionar foto"}</strong><small>JPG, PNG ou WEBP · até 5 MB</small></>}
    <input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={(event) => upload(event.target.files?.[0])} />
  </label>{uploadError && <span className="field-error">{uploadError}</span>}</div>;
}

function LocationForm({ item, saving, onClose, onSave, onDelete }) {
  const [values, setValues] = useState({ name: item?.name || "", responsible: item?.responsible || "", frequency: item?.frequency || "", photo: item?.photo || "" });
  const [error, setError] = useState("");
  function change(key, value) { setValues((current) => ({ ...current, [key]: value })); }
  async function submit(event) {
    event.preventDefault();
    if (!values.name.trim() || !values.responsible.trim() || !values.frequency) {
      setError("Preencha o nome do local, responsável e frequência.");
      return;
    }
    setError("");
    await onSave({ ...values, name: values.name.trim(), responsible: values.responsible.trim() }, item?.id);
  }
  return <Modal title={item ? "Editar local" : "Novo local"} subtitle="CADASTRO DE AMBIENTE" onClose={onClose}>
    <form className="modal-form" onSubmit={submit}>
      <ImageField label="Foto do local" value={values.photo} onChange={(value) => change("photo", value)} />
      <div className="form-field"><label htmlFor="location-name">O que limpar <span className="required">*</span></label><input id="location-name" autoFocus maxLength={100} placeholder="Ex.: Bancada da cozinha" value={values.name} onChange={(event) => change("name", event.target.value)} /></div>
      <div className="form-row">
        <div className="form-field"><label htmlFor="location-responsible">Responsável <span className="required">*</span></label><input id="location-responsible" maxLength={100} placeholder="Nome do responsável" value={values.responsible} onChange={(event) => change("responsible", event.target.value)} /></div>
        <div className="form-field"><label htmlFor="location-frequency">Frequência <span className="required">*</span></label><select id="location-frequency" value={values.frequency} onChange={(event) => change("frequency", event.target.value)}><option value="">Selecione</option>{FREQUENCIES.map((value) => <option key={value}>{value}</option>)}</select></div>
      </div>
      {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      <footer className="modal-footer">{item && <button type="button" className="button-danger-ghost" onClick={onDelete}><Trash2 size={16} /> Excluir</button>}<span className="footer-spacer" /><button type="button" className="button-secondary" onClick={onClose}>Cancelar</button><button className="button-primary" disabled={saving}>{saving && <LoaderCircle size={16} className="spin" />}{item ? "Salvar alterações" : "Cadastrar local"}</button></footer>
    </form>
  </Modal>;
}

function CleaningForm({ item, initial, locations, saving, onClose, onSave }) {
  const [values, setValues] = useState({
    location_id: item?.location_id || initial?.location_id || locations[0]?.id || "",
    cleaning_date: item?.cleaning_date || todayValue(),
    status: item?.status || "Limpo",
    photo_before: item?.photo_before || "",
    photo_after: item?.photo_after || "",
    notes: item?.notes || "",
  });
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
    {!locations.length ? <div className="modal-empty"><Leaf size={24} /><p>Cadastre um local antes de registrar uma limpeza.</p><button className="button-secondary" onClick={onClose}>Entendi</button></div> : <form className="modal-form" onSubmit={submit}>
      <div className="form-row">
        <div className="form-field"><label htmlFor="cleaning-location">Local <span className="required">*</span></label><select id="cleaning-location" value={values.location_id} onChange={(event) => change("location_id", event.target.value)}><option value="">Selecione um local</option>{locations.map((location) => <option value={location.id} key={location.id}>{location.name} · {location.responsible}</option>)}</select></div>
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

function RecordDialog({ item, onClose, onDelete }) {
  return <Modal title="Detalhes do registro" subtitle="HISTÓRICO DE LIMPEZA" onClose={onClose} wide>
    <div className="record-detail">
      <div className="record-summary"><span className="table-location-icon"><Leaf size={17} /></span><div><strong>{item.location_name}</strong><small>Registrado por: {item.created_by_name || item.responsible || "—"}</small></div><span className={`status-pill ${item.status === "Limpo" ? "status-done" : "status-attention"}`}><span className="status-dot" />{item.status}</span></div>
      <div className="record-date"><CalendarDays size={17} /><span>Data da atividade</span><strong>{formatDate(item.cleaning_date)}</strong></div>
      {item.notes && <div className="record-notes"><span>OBSERVAÇÕES</span><p>{item.notes}</p></div>}
      <div className="record-photos">
        <PhotoView label="Foto antes" photo={item.photo_before} />
        <PhotoView label="Foto depois" photo={item.photo_after} />
      </div>
      <footer className="modal-footer"><button className="button-danger-ghost" onClick={onDelete}><Trash2 size={16} /> Excluir registro</button><span className="footer-spacer" /><button className="button-secondary" onClick={onClose}>Fechar</button></footer>
    </div>
  </Modal>;
}

function PhotoView({ label, photo }) {
  return <div className="photo-view"><span className="photo-label">{label}</span>{photo ? <a href={photo} target="_blank" rel="noreferrer"><img src={photo} alt={label} /><span>Ampliar foto <ArrowUpRight size={13} /></span></a> : <div className="no-photo"><ImagePlus size={22} /><span>Sem foto</span></div>}</div>;
}

function LocationDialog({ item, records, onClose, onEdit, onRegister, onRecord, isBoss }) {
  return <Modal title={item.name} subtitle="DETALHES DO LOCAL" onClose={onClose} wide>
    <div className="location-detail-content">
      {item.photo && <img className="detail-cover" src={item.photo} alt={`Foto de ${item.name}`} />}
      <div className="detail-info-grid"><div><span>O que limpar</span><strong>{item.name}</strong></div><div><span>Responsável</span><strong>{item.responsible}</strong></div><div><span>Frequência</span><strong>{item.frequency}</strong></div><div><span>Última limpeza</span><strong>{formatDate(item.last_cleaned)}</strong></div></div>
      <div className="detail-history-heading"><div><h3>Histórico de limpeza</h3><p>{records.length} {records.length === 1 ? "registro" : "registros"}</p></div><button className="text-button" onClick={onRegister}><Plus size={15} /> Registrar</button></div>
      {records.length ? <div className="detail-record-list">{records.map((record) => <button key={record.id} className="detail-record" onClick={() => onRecord(record)}><span className={`activity-icon ${record.status === "Limpo" ? "done" : "attention"}`}>{record.status === "Limpo" ? <Check size={15} /> : <CircleAlert size={15} />}</span><span className="activity-main"><strong>{formatDate(record.cleaning_date)}</strong><small>{record.created_by_name || "Equipe"}{record.notes ? ` · ${record.notes}` : ""}</small></span><span className={`status-pill ${record.status === "Limpo" ? "status-done" : "status-attention"}`}>{record.status}</span><ChevronRight size={16} /></button>)}</div> : <div className="mini-empty">Ainda não existem registros visíveis para este local.</div>}
      <footer className="modal-footer">{isBoss && <button className="button-secondary" onClick={onEdit}><Pencil size={15} /> Editar local</button>}<span className="footer-spacer" /><button className="button-secondary" onClick={onClose}>Fechar</button><button className="button-primary" onClick={onRegister}><Plus size={16} /> Registrar limpeza</button></footer>
    </div>
  </Modal>;
}

export default App;
