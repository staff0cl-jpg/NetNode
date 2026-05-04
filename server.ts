import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  const PORT = 3000;

  // Mock CLI Logic
  io.on("connection", (socket) => {
    let currentVendor = "HPE";
    
    socket.on("terminal:input", (data) => {
      const input = data.trim();
      let response = "";

      if (!input) {
        response = `\r\n${currentVendor}-Switch# `;
      } else if (input === "help" || input === "?") {
        response = `\r\nAvailable commands:\r\n  show ip int brief\r\n  show version\r\n  conf t\r\n  exit\r\n  help\r\n${currentVendor}-Switch# `;
      } else if (input.startsWith("show version")) {
        response = `\r\n${currentVendor} Operating System Software\r\nVersion 16.10, Build 0001\r\nUptime is 2 weeks, 4 days\r\n${currentVendor}-Switch# `;
      } else if (input.startsWith("show ip int brief")) {
        response = `\r\nInterface  IP-Address  Status  Protocol\r\n1/1        10.0.0.1    up      up\r\n1/2        unassigned  up      up\r\n1/3        unassigned  down    down\r\n${currentVendor}-Switch# `;
      } else {
        response = `\r\n% Unknown command: ${input}\r\n${currentVendor}-Switch# `;
      }
      
      socket.emit("terminal:output", response);
    });

    socket.emit("terminal:output", `\r\n*****************************************************************\r\n*                                                               *\r\n*  Welcome to NetNode Pro Secure Management Interface           *\r\n*  Unauthorized access is strictly prohibited.                  *\r\n*                                                               *\r\n*****************************************************************\r\n\r\n${currentVendor}-Switch# `);
  });

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
