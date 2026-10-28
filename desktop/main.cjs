const { app, BrowserWindow, dialog, session } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_SERVER_URL = "https://routine.taildc7b60.ts.net";

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
    if (app.isPackaged) return DEFAULT_SERVER_URL;

    const configPath = path.join(app.getPath("userData"), "server-url.txt");
    const configuredValue = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf8").trim()
      : "";
    if (!configuredValue) return null;

    let url;
    try {
      url = new URL(configuredValue);
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

  async function waitForApi(baseUrl, maxWaitMs = 60_000) {
    const healthUrl = `${baseUrl}/api/health`;
    const deadline = Date.now() + maxWaitMs;
    let lastError;
    while (Date.now() < deadline) {
      if (apiProcess && apiProcess.exitCode !== null) {
        throw new Error(`O servidor local fechou durante a inicialização (código ${apiProcess.exitCode}).`);
      }
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1200) });
        if (response.ok && (await response.json()).status === "ok") return true;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Servidor não respondeu dentro do tempo limite.${lastError ? `\n${lastError.message}` : ""}`);
  }

  async function createMainWindow() {
    mainWindow = new BrowserWindow({
      title: "Routine 3.4",
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

    mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
      // If remote load fails due to no internet, try fallback to local bundled dist
      const { staticDir } = getServerPaths();
      const localIndexPath = path.join(staticDir, "index.html");
      if (fs.existsSync(localIndexPath)) {
        mainWindow.loadFile(localIndexPath).catch(() => {});
      }
    });

    try {
      await mainWindow.loadURL(`${appBaseUrl}/`);
    } catch {
      const { staticDir } = getServerPaths();
      const localIndexPath = path.join(staticDir, "index.html");
      if (fs.existsSync(localIndexPath)) {
        await mainWindow.loadFile(localIndexPath);
      }
    }

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
        try {
          await waitForApi(appBaseUrl, 2500);
        } catch {
          // If remote server is offline or no internet, do not quit: open in offline mode!
          console.warn("Servidor remoto não respondeu na inicialização. Abrindo em modo offline...");
        }
      } else {
        serverPort = await findAvailablePort();
        startApi(serverPort);
        await waitForApi(appBaseUrl, 30_000);
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
        ? `Não foi possível conectar ao servidor compartilhado (${appBaseUrl}).\n\nVerifique se o servidor Debian está ligado e conectado à internet.\n\n${error.message}`
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
