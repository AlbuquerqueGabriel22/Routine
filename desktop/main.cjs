const { app, BrowserWindow, dialog, session } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");

app.setName("Routiner");
if (process.platform === "win32") app.setAppUserModelId("br.com.routiner.desktop");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let apiProcess;
  let mainWindow;
  let quitting = false;
  let serverPort;
  let appBaseUrl;

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  function findAvailablePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close((error) => error ? reject(error) : resolve(port));
      });
    });
  }

  function getServerPaths() {
    if (app.isPackaged) {
      return {
        executable: path.join(process.resourcesPath, "backend", "routiner-api", "routiner-api.exe"),
        staticDir: path.join(process.resourcesPath, "frontend", "dist"),
      };
    }
    const projectRoot = path.resolve(__dirname, "..");
    return {
      executable: path.join(projectRoot, "backend", "dist", "routiner-api", "routiner-api.exe"),
      staticDir: path.join(projectRoot, "frontend", "dist"),
    };
  }

  function getConfiguredServerUrl() {
    const configPath = path.join(app.getPath("userData"), "server-url.txt");
    if (!fs.existsSync(configPath)) return null;

    const value = fs.readFileSync(configPath, "utf8").trim();
    if (!value) return null;

    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Endereço inválido em ${configPath}. Informe a URL HTTPS do servidor.`);
    }
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`Endereço inválido em ${configPath}. Informe somente a origem HTTPS, por exemplo https://routiner.exemplo.ts.net.`);
    }
    return url.origin;
  }

  function startApi(port) {
    const { executable, staticDir } = getServerPaths();
    if (!fs.existsSync(executable)) {
      throw new Error(`Executável da API não encontrado: ${executable}. Gere os arquivos de distribuição novamente.`);
    }
    if (!fs.existsSync(path.join(staticDir, "index.html"))) {
      throw new Error(`Interface do Routiner não encontrada: ${staticDir}. Gere a versão web antes de empacotar.`);
    }

    const dataDir = path.join(app.getPath("userData"), "data");
    const uploadsDir = path.join(dataDir, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    apiProcess = spawn(executable, ["--port", String(port)], {
      cwd: path.dirname(executable),
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CLEANING_DB_PATH: path.join(dataDir, "routiner.db"),
        CLEANING_UPLOAD_DIR: uploadsDir,
        ROUTINER_AUTH_SECRET_FILE: path.join(dataDir, ".auth_secret"),
        ROUTINER_STATIC_DIR: staticDir,
      },
    });
    appBaseUrl = `http://127.0.0.1:${port}`;

    apiProcess.once("error", (error) => {
      if (!quitting) showStartupError(`O servidor local do Routiner não pôde iniciar.\n\n${error.message}`);
    });
    apiProcess.once("exit", (code) => {
      if (!quitting) {
        showStartupError(`O servidor local do Routiner foi encerrado inesperadamente (código ${code ?? "desconhecido"}). Feche e abra o aplicativo novamente.`);
      }
    });
  }

  async function waitForApi(baseUrl) {
    const healthUrl = `${baseUrl}/api/health`;
    const deadline = Date.now() + 60_000;
    let lastError;
    while (Date.now() < deadline) {
      if (apiProcess && apiProcess.exitCode !== null) {
        throw new Error(`O servidor local fechou durante a inicialização (código ${apiProcess.exitCode}).`);
      }
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
        if (response.ok && (await response.json()).status === "ok") return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`A API não ficou pronta em 60 segundos.${lastError ? `\n${lastError.message}` : ""}`);
  }

  async function createMainWindow() {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 900,
      minHeight: 650,
      show: false,
      backgroundColor: "#f5f6f4",
      autoHideMenuBar: true,
      icon: path.join(__dirname, "routiner.ico"),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow.once("ready-to-show", () => mainWindow.show());
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url);
        if (target.origin === new URL(appBaseUrl).origin && target.pathname.startsWith("/uploads/")) {
          return { action: "allow" };
        }
      } catch {
        return { action: "deny" };
      }
      return { action: "deny" };
    });
    await mainWindow.loadURL(`${appBaseUrl}/`);
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  }

  function isAppOrigin(url) {
    try {
      return new URL(url).origin === new URL(appBaseUrl).origin;
    } catch {
      return false;
    }
  }

  function showStartupError(message) {
    if (quitting) return;
    quitting = true;
    if (apiProcess && apiProcess.exitCode === null) apiProcess.kill();
    dialog.showErrorBox("Não foi possível abrir o Routiner", message);
    app.quit();
  }

  app.whenReady().then(async () => {
    try {
      appBaseUrl = getConfiguredServerUrl();
      if (appBaseUrl) {
        await waitForApi(appBaseUrl);
      } else {
        serverPort = await findAvailablePort();
        startApi(serverPort);
        await waitForApi(appBaseUrl);
      }
      session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const allowed = permission === "media"
          && details.mediaTypes?.includes("video")
          && isAppOrigin(details.requestingUrl || "");
        callback(Boolean(allowed));
      });
      await createMainWindow();
    } catch (error) {
      const message = appBaseUrl
        ? `Não foi possível conectar ao servidor compartilhado (${appBaseUrl}).\n\nVerifique se o Debian está ligado e se este dispositivo está conectado ao Tailscale.\n\n${error.message}`
        : `O servidor local do Routiner não pôde iniciar.\n\n${error.message}`;
      showStartupError(message);
    }
  });

  app.on("before-quit", () => {
    quitting = true;
    if (apiProcess && apiProcess.exitCode === null) apiProcess.kill();
  });

  app.on("window-all-closed", () => app.quit());
}
