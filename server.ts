import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import http from "http";
import path from "path";
import { Client } from "ssh2";

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const PORT = 3000;

  app.use(express.json());

  // API: Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "online", version: "2.4.0-pro" });
  });

  // API: Auto-Discovery (Simulated for this environment)
  app.post("/api/discovery/start", (req, res) => {
    const { subnets, credentials } = req.body;
    console.log(`Starting discovery on ${subnets.join(', ')}`);
    
    // In a real environment, we would use nmap or snmp-scan here
    // For now, we return a mock task ID
    res.json({ taskId: "discovery_" + Date.now(), message: "Discovery process initiated" });
  });

  // API: Get Topology Relationships (LLDP Data Simulation)
  app.get("/api/topology/links", (req, res) => {
    // This would normally query the database or poll switches via SNMP
    const links = [
      { source: "1", target: "2", portA: "Gig1/0/1", portB: "Gig0/1" },
      { source: "2", target: "3", portA: "Gig0/24", portB: "Ten1/0/1" },
      { source: "1", target: "3", portA: "Gig1/0/2", portB: "Ten1/0/2" },
    ];
    res.json(links);
  });

  // Socket.io for Terminal (SSH)
  io.on("connection", (socket) => {
    let sshClient: Client | null = null;

    socket.on("ssh:connect", ({ host, username, password }) => {
      sshClient = new Client();
      sshClient
        .on("ready", () => {
          socket.emit("ssh:status", "connected");
          sshClient?.shell((err, stream) => {
            if (err) return socket.emit("ssh:data", `\r\n*** SSH Shell Error: ${err.message} ***\r\n`);
            
            stream.on("data", (data: Buffer) => {
              socket.emit("ssh:data", data.toString());
            });
            
            socket.on("ssh:input", (input: string) => {
              stream.write(input);
            });

            stream.on("close", () => {
              sshClient?.end();
            });
          });
        })
        .on("error", (err) => {
          socket.emit("ssh:data", `\r\n*** SSH Error: ${err.message} ***\r\n`);
        })
        .connect({ host, port: 22, username, password });
    });

    socket.on("disconnect", () => {
      sshClient?.end();
    });
  });

  // Vite integration
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

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`NETNODE Backend running on http://localhost:${PORT}`);
  });
}

startServer();
