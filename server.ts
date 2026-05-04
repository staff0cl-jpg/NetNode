import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import http from "http";
import path from "path";
import { Client } from "ssh2";

// In-memory state
let inventory = [
  { id: '1', name: 'CORE-SW-01', vendor: 'Cisco', model: 'Nexus 93180YC', city: 'Moscow', zone: 'DC-East', ip: '10.10.1.1', status: 'offline', uptime: '0d 0h' },
  { id: '2', name: 'DISTR-SW-05', vendor: 'Juniper', model: 'EX4300', city: 'Moscow', zone: 'Floor-3', ip: '10.10.2.5', status: 'offline', uptime: '0d 0h' },
  { id: '4', name: 'MGMT-SW-01', vendor: 'MikroTik', model: 'CRS326', city: 'Kazan', zone: 'Office-A', ip: '172.16.5.1', status: 'offline', uptime: '0d 0h' },
];

let users = [
  { id: '1', username: 'admin', role: 'admin', lastLogin: '2024-05-04 10:15', password: 'admin' },
  { id: '2', username: 'operator_01', role: 'operator', lastLogin: '2024-05-03 16:45', password: 'password' },
];

interface AuditLog {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  details: string;
  category: 'auth' | 'inventory' | 'config' | 'user_mgmt' | 'system';
}

let auditLogs: AuditLog[] = [];

// System Config State
let systemConfig = {
  ldapEnabled: false,
  ldapAdminGroup: 'OU=Admins,DC=company,DC=local',
  ldapOperatorGroup: 'OU=Operators,DC=company,DC=local'
};

const logAction = (user: string, action: string, details: string, category: AuditLog['category']) => {
  const log: AuditLog = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    user,
    action,
    details,
    category
  };
  auditLogs.unshift(log); // Newest first
  if (auditLogs.length > 500) auditLogs.pop(); // Keep last 500 logs
  console.log(`[Audit] [${category.toUpperCase()}] ${user}: ${action} - ${details}`);
};

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const PORT = 3000;

  app.use(express.json());
  
  // Helper: Role Check Middleware (Simulated)
  const checkRole = (roles: string[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const userRole = req.headers["x-user-role"] as string || "viewer";
    if (roles.includes(userRole)) {
      next();
    } else {
      res.status(403).json({ error: "Access Denied: Insufficient permissions." });
    }
  };

  // API: Audit Logs
  app.get("/api/audit-logs", checkRole(['admin']), (req, res) => {
    res.json(auditLogs);
  });

  // API: System Configuration
  app.get("/api/config/system", checkRole(['admin', 'operator']), (req, res) => {
    res.json(systemConfig);
  });

  app.post("/api/config/system", checkRole(['admin']), (req, res) => {
    const actor = req.headers["x-user-name"] as string || "unknown";
    systemConfig = { ...systemConfig, ...req.body };
    logAction(actor, 'System Config Update', `Updated system settings: LDAP ${systemConfig.ldapEnabled}`, 'config');
    res.json({ success: true, config: systemConfig });
  });

  // API: Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "online", version: "2.4.0-pro", timestamp: new Date().toISOString() });
  });

  // API: Get Inventory
  app.get("/api/inventory", (req, res) => {
    res.json(inventory);
  });

  app.post("/api/inventory", checkRole(['admin', 'operator']), (req, res) => {
    const sw = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    const newSwitch = { ...sw, id: Date.now().toString() };
    inventory.push(newSwitch);
    logAction(actor, 'Add Device', `Registered new switch: ${newSwitch.name} (${newSwitch.ip})`, 'inventory');
    res.json(newSwitch);
  });

  app.patch("/api/inventory/:id", checkRole(['admin', 'operator']), (req, res) => {
    const actor = req.headers["x-user-name"] as string || "unknown";
    const index = inventory.findIndex(s => s.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Device not found" });
    
    const oldName = inventory[index].name;
    inventory[index] = { ...inventory[index], ...req.body };
    logAction(actor, 'Update Device', `Updated device configurations for: ${oldName}`, 'inventory');
    res.json(inventory[index]);
  });

  app.delete("/api/inventory/:id", checkRole(['admin']), (req, res) => {
    const actor = req.headers["x-user-name"] as string || "unknown";
    const sw = inventory.find(s => s.id === req.params.id);
    if (sw) {
      logAction(actor, 'Remove Device', `Deleted switch: ${sw.name} (${sw.ip})`, 'inventory');
      inventory = inventory.filter(s => s.id !== req.params.id);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Device not found" });
    }
  });

  // API: User Management
  app.get("/api/users", checkRole(['admin']), (req, res) => {
    // Don't send passwords to frontend
    res.json(users.map(({ password, ...u }) => u));
  });

  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body;
    
    // Check LDAP first if enabled in config
    if (systemConfig.ldapEnabled) {
      logAction(username, 'LDAP Auth Attempt', `Attempting LDAP authentication for ${username}`, 'auth');
      
      // Simulated LDAP Auth Logic
      // In a real system, we'd use 'ldapjs' to bind to AD here
      if (password === 'password') { // Dummy check for demo
        let role = 'viewer';
        // Simulate group lookup: username with 'adm' gets admin, 'op' gets operator
        if (username.toLowerCase().includes('adm')) {
          role = 'admin';
        } else if (username.toLowerCase().includes('op')) {
          role = 'operator';
        }
        
        logAction(username, 'Login Success (LDAP)', `User authenticated via LDAP as ${role}`, 'auth');
        return res.json({ success: true, user: { id: 'ldap_' + username, username, role } });
      }
    }

    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
      logAction(username, 'Login Success', 'User authenticated successfully', 'auth');
      res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } else {
      logAction(username || 'unknown', 'Login Failure', `Failed login attempt for username: ${username || 'unknown'}`, 'auth');
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  });

  app.post("/api/users", checkRole(['admin']), (req, res) => {
    const { username, password, role } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });
    
    const newUser = {
      id: Date.now().toString(),
      username,
      password,
      role: role || 'operator',
      lastLogin: '-'
    };
    users.push(newUser);
    logAction(actor, 'Create User', `Created new user: ${username} with role ${role}`, 'user_mgmt');
    res.json({ success: true, user: newUser });
  });

  app.patch("/api/users/:id", checkRole(['admin']), (req, res) => {
    const { role } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    
    const oldRole = user.role;
    if (role) user.role = role;
    logAction(actor, 'Update User Role', `Updated user ${user.username} role from ${oldRole} to ${role}`, 'user_mgmt');
    res.json({ success: true });
  });

  app.post("/api/users/:id/password", checkRole(['admin']), (req, res) => {
    const { password } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    
    if (password) user.password = password;
    logAction(actor, 'Reset Password', `Reset password for user: ${user.username}`, 'user_mgmt');
    res.json({ success: true, message: "Password updated successfully" });
  });

  app.delete("/api/users/:id", checkRole(['admin']), (req, res) => {
    const actor = req.headers["x-user-name"] as string || "unknown";
    const user = users.find(u => u.id === req.params.id);
    if (user) {
      logAction(actor, 'Delete User', `Deleted user: ${user.username}`, 'user_mgmt');
    }
    users = users.filter(u => u.id !== req.params.id);
    res.json({ success: true });
  });

  // API: LDAP Test
  app.post("/api/auth/ldap/test", checkRole(['admin']), (req, res) => {
    const { host, port, baseDN, adminGroup, operatorGroup } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    
    logAction(actor, 'LDAP Test', `Testing LDAP: ${host}, Admins: ${adminGroup}, Operators: ${operatorGroup}`, 'config');
    
    // Simulate complex check
    setTimeout(() => {
      const isOk = host && host.includes('.') && port && baseDN && baseDN.includes('=');
      if (isOk) {
        res.json({ success: true, message: "LDAP server reached. Group CNs verified and access granted." });
      } else {
        res.status(400).json({ success: false, message: "Invalid LDAP configuration or server unreachable." });
      }
    }, 1500);
  });

  // API: Auto-Discovery
  app.post("/api/discovery/start", checkRole(['admin', 'operator']), (req, res) => {
    const { subnets, username, password } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    logAction(actor, 'Start Discovery', `Initiated network scan on subnets: ${subnets}`, 'inventory');
    
    // Simulate discovery process
    setTimeout(() => {
      const newSwitches = [
        { id: `id-${Date.now()}-1`, name: 'EDGE-SW-12', vendor: 'Huawei', model: 'CloudEngine S5735', city: 'Moscow', zone: 'Floor-4', ip: '192.168.1.12', status: 'online', uptime: '0d 1h' },
        { id: `id-${Date.now()}-2`, name: 'MGMT-SW-02', vendor: 'Arista', model: '7010T', city: 'Kazan', zone: 'Office-B', ip: '172.16.5.2', status: 'online', uptime: '5d 12h' },
      ];
      inventory = [...inventory, ...newSwitches];
      logAction('system', 'Discovery Complete', `Found ${newSwitches.length} new devices.`, 'inventory');
    }, 3000);

    res.json({ taskId: "discovery_" + Date.now(), message: "Discovery process initiated in background." });
  });

  // API: Get Topology Relationships (LLDP Data Simulation)
  app.get("/api/topology/links", (req, res) => {
    const links = [
      { source: "1", target: "2", portA: "Eth1/1", portB: "ge-0/0/1" },
    ];
    
    // If discovery was run, add more links
    if (inventory.length > 2) {
      links.push({ source: "2", target: inventory[2].id, portA: "ge-0/0/24", portB: "Port 1" });
    }
    
    res.json(links);
  });

  // API: SNMP Configuration
  app.post("/api/config/snmp", checkRole(['admin']), (req, res) => {
    const { community, version } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    logAction(actor, 'SNMP Config Update', `Changed SNMP settings (Version: ${version})`, 'config');
    res.json({ success: true, message: "SNMP configuration saved." });
  });

  // API: Trap Receiver Configuration
  app.post("/api/config/trap-receiver", checkRole(['admin']), (req, res) => {
    const { ip, port } = req.body;
    const actor = req.headers["x-user-name"] as string || "unknown";
    logAction(actor, 'Trap Receiver Update', `Updated trap receiver to ${ip}:${port}`, 'config');
    res.json({ success: true, message: "Trap receiver configuration saved." });
  });

  // Socket.io for Terminal (SSH)
  io.on("connection", (socket) => {
    const sessions = new Map<string, { client: Client, stream?: any }>();

    socket.on("ssh:connect", ({ sessionId, host, username, password }) => {
      // Clean up existing session if it exists for this ID
      if (sessions.has(sessionId)) {
        sessions.get(sessionId)?.client.end();
      }

      const sshClient = new Client();
      sessions.set(sessionId, { client: sshClient });

      sshClient
        .on("ready", () => {
          socket.emit("ssh:status", { sessionId, status: "connected" });
          sshClient.shell((err, stream) => {
            if (err) return socket.emit("ssh:data", { sessionId, data: `\r\n*** SSH Shell Error: ${err.message} ***\r\n` });
            
            const session = sessions.get(sessionId);
            if (session) session.stream = stream;

            stream.on("data", (data: Buffer) => {
              socket.emit("ssh:data", { sessionId, data: data.toString() });
            });
            
            stream.on("close", () => {
              sshClient.end();
              sessions.delete(sessionId);
              socket.emit("ssh:status", { sessionId, status: "disconnected" });
            });
          });
        })
        .on("error", (err) => {
          socket.emit("ssh:data", { sessionId, data: `\r\n*** SSH Error: ${err.message} ***\r\n` });
          sessions.delete(sessionId);
        })
        .connect({ host, port: 22, username, password });
    });

    socket.on("ssh:input", ({ sessionId, input }) => {
      const session = sessions.get(sessionId);
      if (session && session.stream) {
        session.stream.write(input);
      }
    });

    socket.on("ssh:disconnect", ({ sessionId }) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.client.end();
        sessions.delete(sessionId);
      }
    });

    socket.on("disconnect", () => {
      sessions.forEach(session => session.client.end());
      sessions.clear();
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
