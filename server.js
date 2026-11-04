"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createApiHandler, jsonResponse } = require("./api");
const { createUserService } = require("./users");

const ROOT = __dirname;
const DEFAULT_DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(ROOT, "data", "store.json"));
const DEFAULT_PUBLIC_DIR = path.join(ROOT, "public");
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(publicDir, pathname, res, headOnly = false) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const resolved = path.resolve(publicDir, relative);
  if (!resolved.startsWith(`${publicDir}${path.sep}`)) {
    jsonResponse(res, 404, { error: "Not found" });
    return;
  }
  try {
    const data = await fs.readFile(resolved);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(resolved)] || "application/octet-stream",
      "Content-Length": data.length,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": [".html", ".js", ".css"].includes(path.extname(resolved))
        ? "no-cache"
        : "public, max-age=3600",
    });
    res.end(headOnly ? undefined : data);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      jsonResponse(res, 404, { error: "Not found" });
      return;
    }
    throw error;
  }
}

function createApplication(options = {}) {
  const dataFile = path.resolve(options.dataFile || DEFAULT_DATA_FILE);
  const publicDir = path.resolve(options.publicDir || DEFAULT_PUBLIC_DIR);
  const userService = createUserService(dataFile);
  const api = createApiHandler(userService);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await api.handle(req, res, url);
        return;
      }
      if (url.pathname === "/docs.html") {
        res.writeHead(302, { Location: "/?tab=docs", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        jsonResponse(res, 405, { error: "Method not allowed" });
        return;
      }
      await serveStatic(publicDir, url.pathname, res, req.method === "HEAD");
    } catch (error) {
      if (!res.headersSent) {
        jsonResponse(res, error.status || 500, {
          error: error.status ? error.message : "Internal server error",
        });
      } else {
        res.destroy(error);
      }
      if (!error.status) console.error(error);
    }
  });

  return {
    server,
    start(host = process.env.HOST || "0.0.0.0", port = Number(process.env.PORT || 3000)) {
      return new Promise((resolve, reject) => {
        userService.load().then(() => {
          server.once("error", reject);
          server.listen(port, host, () => {
            server.removeListener("error", reject);
            console.log(`RNGdle AI listening on http://${host}:${port}`);
            console.log(`Persistent store: ${dataFile}`);
            resolve(server);
          });
        }, reject);
      });
    },
  };
}

const application = createApplication();

if (require.main === module) {
  application.start().catch((error) => {
    console.error("Failed to start server:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  createApplication,
  server: application.server,
  start: application.start,
};
