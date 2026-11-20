// Small bridge: serves the site and runs the compiled C++ engine.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const ENGINE = path.join(ROOT, "engine", "engine");
const SRC = path.join(ROOT, "engine", "engine.cpp");
const PORT = Number(process.env.PORT || 3000);

function buildEngine() {
  console.log("[engine] compiling C++ core ...");
  const r = spawnSync("g++", ["-O2", "-std=c++17", SRC, "-o", ENGINE], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error("[engine] build failed:\n" + (r.stderr || r.stdout));
    return false;
  }
  console.log("[engine] ready");
  return true;
}

if (!fs.existsSync(ENGINE) || fs.statSync(SRC).mtimeMs > fs.statSync(ENGINE).mtimeMs) {
  if (!buildEngine()) process.exit(1);
}

function runEngine(input) {
  const r = spawnSync(ENGINE, [], { input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr || "engine error");
  return JSON.parse(r.stdout);
}

// Frontend state -> engine protocol lines
function toProtocol(payload) {
  const lines = [];
  const q = payload.query || {};
  lines.push(
    ["Q", q.origin || "isbt", q.destination || "chhotashimla", q.vehicle || "4W",
      String(q.hour ?? 10), String(q.offset ?? 20)].join("|")
  );
  for (const s of payload.spaces || []) {
    lines.push(
      ["S", s.id, s.node, String(s.name || "Community space").replace(/\|/g, " "),
        String(s.capacity || 1), String(s.price || 0),
        (s.vehicles || []).join(","),
        s.covered ? "1" : "0", s.cctv ? "1" : "0", s.guard ? "1" : "0", s.ev ? "1" : "0",
        String(s.popularity ?? 0.85), String(s.owner || "")].join("|")
    );
  }
  for (const [zoneId, count] of Object.entries(payload.booked || {})) {
    if (count > 0) lines.push(["B", zoneId, String(count)].join("|"));
  }
  return lines.join("\n") + "\n";
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/meta") {
    try {
      const data = runEngine("META\n");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  if (url.pathname === "/api/predict" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const data = runEngine(toProtocol(payload));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }

  // static files
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SMART PARK running on http://0.0.0.0:${PORT}`);
});
