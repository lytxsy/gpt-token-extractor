const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { TaskManager } = require('./lib/taskManager');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const configPath = path.join(__dirname, 'config', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

config.oauthRedirectPort = parseInt(process.env.OAUTH_REDIRECT_PORT, 10) || config.oauthRedirectPort;
config.mailApiBase = process.env.MAIL_API_BASE || config.mailApiBase;
config.mailAdminKey = process.env.MAIL_ADMIN_KEY || config.mailAdminKey;
config.inboxProxyUrl = process.env.INBOX_PROXY_URL || config.inboxProxyUrl || '';

const taskManager = new TaskManager(config);
const wsClients = new Set();

function broadcastToClients(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

const adminPassword = process.env.ADMIN_PASSWORD || '';
if (adminPassword) {
  const sessions = new Set();
  app.post('/api/login', (req, res) => {
    if (req.body.password === adminPassword) {
      const token = crypto.randomBytes(16).toString('hex');
      sessions.add(token);
      res.json({ ok: true, token });
    } else {
      res.status(401).json({ error: '密码错误' });
    }
  });
  app.use('/api', (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (adminPassword && (!token || !sessions.has(token))) {
      return res.status(401).json({ error: '未登录' });
    }
    next();
  });
}

app.post('/api/extract', async (req, res) => {
  const { email, password } = req.body;
  if (!email) {
    return res.status(400).json({ error: '邮箱必填' });
  }
  const taskId = await taskManager.startExtraction(email, password || '', broadcastToClients);
  res.json({ taskId });
});

app.get('/api/tasks', (req, res) => {
  res.json(taskManager.getAllTasks());
});

app.get('/api/task/:taskId', (req, res) => {
  const task = taskManager.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json(task);
});

app.get('/api/download/:filename', (req, res) => {
  const filepath = path.join(taskManager.outputDir, req.params.filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '文件不存在' });
  res.download(filepath);
});

app.get('/api/download-all', (req, res) => {
  const files = fs.readdirSync(taskManager.outputDir).filter(f => f.startsWith('token_') && f.endsWith('.json'));
  const all = [];
  for (const f of files) {
    try { all.push(JSON.parse(fs.readFileSync(path.join(taskManager.outputDir, f), 'utf8'))); } catch {}
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="all_tokens.json"');
  res.send(JSON.stringify(all, null, 2));
});

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', tasks: taskManager.getAllTasks() }));
  ws.on('close', () => wsClients.delete(ws));
});

const PORT = parseInt(process.env.PORT, 10) || 8090;
server.listen(PORT, () => {
  console.log(`GPT Token Extractor running on http://localhost:${PORT}`);
});
