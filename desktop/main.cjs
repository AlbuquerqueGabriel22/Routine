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

    apiProcess.once("error", (error) => {
      if (!quitting) showStartupError(`O servidor local do Routiner não pôde iniciar.\n\n${error.message}`);
    });
    apiProcess.once("exit", (code) => {
      if (!quitting) {
        showStartupError(`O servidor local do Routiner foi encerrado inesperadamente (código ${code ?? "desconhecido"}). Feche e abra o aplicativo novamente.`);
      }
    });
  }

  async function waitForApi(port) {
    const healthUrl = `http://127.0.0.1:${port}/api/health`;
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
      if (url.startsWith(`http://127.0.0.1:${serverPort}/uploads/`)) {
        return { action: "allow" };
      }
      return { action: "deny" };
    });
    await mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
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
      serverPort = await findAvailablePort();
      startApi(serverPort);
      await waitForApi(serverPort);
      session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const localOrigin = `http://127.0.0.1:${serverPort}`;
        const allowed = permission === "media"
          && details.mediaTypes?.includes("video")
          && details.requestingUrl?.startsWith(`${localOrigin}/`);
        callback(Boolean(allowed));
      });
      await createMainWindow();
    } catch (error) {
      showStartupError(error.message);
    }
  });

  app.on("before-quit", () => {
    quitting = true;
    if (apiProcess && apiProcess.exitCode === null) apiProcess.kill();
  });

  app.on("window-all-closed", () => app.quit());
}
