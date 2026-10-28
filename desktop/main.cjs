const { app, BrowserWindow, dialog, session } = require("electron");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_SERVER_URL = "https://routine.taildc7b60.ts.net";

app.setName("Routiner");
if (process.platform === "win32") app.setAppUserModelId("br.com.routiner.desktop");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow;
  let localServer;
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
        staticDir: path.join(process.resourcesPath, "frontend", "dist"),
      };
    }
    const projectRoot = path.resolve(__dirname, "..");
    return {
      staticDir: path.join(projectRoot, "frontend", "dist"),
    };
  }

  function getConfiguredServerUrl() {
    if (app.isPackaged) return DEFAULT_SERVER_URL;

    const configPath = path.join(app.getPath("userData"), "server-url.txt");
    const configuredValue = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf8").trim()
      : "";
    if (!configuredValue) return DEFAULT_SERVER_URL;

    try {
      const url = new URL(configuredValue);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return url.origin;
      }
    } catch {}
    return DEFAULT_SERVER_URL;
  }

  function createLocalServer(staticDir, remoteServerUrl) {
    return http.createServer((req, res) => {
      let reqUrl;
      try {
        reqUrl = new URL(req.url, "http://127.0.0.1");
      } catch {
        res.writeHead(400);
        res.end("Bad Request");
        return;
      }

      // Proxy API and Uploads to the remote server
      if (reqUrl.pathname.startsWith("/api/") || reqUrl.pathname.startsWith("/uploads/")) {
        const targetUrl = new URL(reqUrl.pathname + reqUrl.search, remoteServerUrl);
        const isHttps = targetUrl.protocol === "https:";
        const transport = isHttps ? https : http;

        const proxyHeaders = {
          ...req.headers,
          host: targetUrl.host,
        };
        if (proxyHeaders.origin) proxyHeaders.origin = targetUrl.origin;
        if (proxyHeaders.referer) proxyHeaders.referer = targetUrl.href;

        const proxyReq = transport.request(
          targetUrl,
          {
            method: req.method,
            headers: proxyHeaders,
            timeout: 3500,
          },
          (proxyRes) => {
            const responseHeaders = { ...proxyRes.headers };
            // Rewrite cookie security so local 127.0.0.1 accepts the session
            if (responseHeaders["set-cookie"]) {
              responseHeaders["set-cookie"] = responseHeaders["set-cookie"].map((cookie) =>
                cookie.replace(/;\s*Secure/gi, "").replace(/;\s*Domain=[^;]+/gi, "")
              );
            }
            res.writeHead(proxyRes.statusCode, responseHeaders);
            proxyRes.pipe(res);
          }
        );

        proxyReq.on("timeout", () => {
          proxyReq.destroy();
          if (!res.headersSent) {
            res.writeHead(504, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ detail: "Tempo limite ao conectar com o servidor." }));
          }
        });

        proxyReq.on("error", () => {
          if (!res.headersSent) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ detail: "Servidor offline ou sem conexão com a internet." }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // Static file serving from frontend/dist
      let pathname = decodeURIComponent(reqUrl.pathname);
      if (pathname === "/") pathname = "/index.html";

      let filePath = path.join(staticDir, pathname);

      // If file doesn't exist, fallback to index.html (SPA routing)
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(staticDir, "index.html");
      }

      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000",
      });
      fs.createReadStream(filePath).pipe(res);
    });
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
    dialog.showErrorBox("Não foi possível abrir o Routiner", message);
    app.quit();
  }

  app.whenReady().then(async () => {
    try {
      const { staticDir } = getServerPaths();
      const indexPath = path.join(staticDir, "index.html");
      if (!fs.existsSync(indexPath)) {
        throw new Error(`Interface do Routiner não encontrada em: ${staticDir}. Gere o build antes de iniciar.`);
      }

      const remoteServerUrl = getConfiguredServerUrl();

      serverPort = await findAvailablePort();
      localServer = createLocalServer(staticDir, remoteServerUrl);
      await new Promise((resolve, reject) => {
        localServer.once("error", reject);
        localServer.listen(serverPort, "127.0.0.1", resolve);
      });

      appBaseUrl = `http://127.0.0.1:${serverPort}`;

      session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const allowed = permission === "media"
          && details.mediaTypes?.includes("video")
          && isAppOrigin(details.requestingUrl || "");
        callback(Boolean(allowed));
      });

      await createMainWindow();
    } catch (error) {
      showStartupError(`O servidor local do Routiner não pôde iniciar.\n\n${error.message}`);
    }
  });

  app.on("before-quit", () => {
    quitting = true;
    if (localServer) {
      try {
        localServer.close();
      } catch {}
    }
  });

  app.on("window-all-closed", () => app.quit());
}
