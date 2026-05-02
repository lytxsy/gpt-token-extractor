const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 加载 .env 文件（本地开发/部署用，不会被提交到 Git）
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  });
}

const { TaskManager } = require('./lib/taskManager');
const {
  normalizeSub2ApiConfig,
  isSub2ApiConfigReady,
  missingSub2ApiConfigMessage,
  uploadToSub2Api,
} = require('./lib/sub2apiService');

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
config.proxy = process.env.PROXY || config.proxy || '';
if (process.env.AUTO_MAIL_DOMAINS) {
  config.autoMailDomains = process.env.AUTO_MAIL_DOMAINS.split(',').map(s => s.trim()).filter(Boolean);
} else {
  config.autoMailDomains = config.autoMailDomains || [];
}

// ── CPA 上传配置 ──
const CPA_CONFIG_PATH = path.join(__dirname, 'config', 'cpa.json');
function loadCpaConfig() {
  try { return JSON.parse(fs.readFileSync(CPA_CONFIG_PATH, 'utf8')); } catch { return null; }
}
function saveCpaConfig(cfg) {
  if (!fs.existsSync(path.join(__dirname, 'config'))) fs.mkdirSync(path.join(__dirname, 'config'), { recursive: true });
  fs.writeFileSync(CPA_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── sub2api 上传配置 ──
const SUB2API_CONFIG_PATH = path.join(__dirname, 'config', 'sub2api.json');
function loadSub2ApiConfig() {
  try { return JSON.parse(fs.readFileSync(SUB2API_CONFIG_PATH, 'utf8')); } catch { return null; }
}
function saveSub2ApiConfig(cfg) {
  if (!fs.existsSync(path.join(__dirname, 'config'))) fs.mkdirSync(path.join(__dirname, 'config'), { recursive: true });
  fs.writeFileSync(SUB2API_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

const taskManager = new TaskManager(config);

  // 注入自动上传回调到 taskManager 的完成流程
const origRunExtraction = taskManager._runExtraction.bind(taskManager);
taskManager._runExtraction = async function(taskId, email, onLog, wsSend, isAborted) {
  await origRunExtraction(taskId, email, onLog, wsSend, isAborted);
  const task = this.tasks.get(taskId);
  if (task && task.status === 'completed' && task.filename) {
    await autoUploadToCpa(task.filename);
    await autoUploadToSub2Api(task.filename);
  }
};

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

// 前端需要知道是否需要登录
app.get('/api/auth-status', (req, res) => {
  res.json({ required: !!adminPassword });
});

app.post('/api/extract', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: '邮箱必填' });
  }
  const taskId = await taskManager.startExtraction(email, broadcastToClients);
  res.json({ taskId });
});

app.get('/api/tasks', (req, res) => {
  res.json(taskManager.getAllTasks());
});

app.post('/api/cancel/:taskId', (req, res) => {
  const ok = taskManager.cancelTask(req.params.taskId);
  res.json({ ok });
});

app.post('/api/task/:taskId/code', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '验证码必填' });
  const ok = taskManager.submitCode(req.params.taskId, code);
  res.json({ ok });
});

app.get('/api/task/:taskId', (req, res) => {
  const task = taskManager.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json(task);
});

app.get('/api/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(taskManager.outputDir, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '文件不存在' });
  res.download(filepath);
});

app.get('/api/download-all', (req, res) => {
  const files = fs.readdirSync(taskManager.outputDir).filter(f => (f.startsWith('codex-') || f.startsWith('token_')) && f.endsWith('.json'));
  const all = [];
  for (const f of files) {
    try { all.push(JSON.parse(fs.readFileSync(path.join(taskManager.outputDir, f), 'utf8'))); } catch {}
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="all_tokens.json"');
  res.send(JSON.stringify(all, null, 2));
});

// ── 删除本地 token 文件 ──
app.post('/api/delete/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(taskManager.outputDir, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '文件不存在' });
  try {
    fs.unlinkSync(filepath);
    // 清理内存中对应任务记录
    for (const [id, task] of taskManager.tasks) {
      if (task.filename === filename) {
        task.filename = null;
        task.status = 'deleted';
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '删除失败: ' + err.message });
  }
});

// ── 删除全部本地 token 文件 ──
app.post('/api/delete-all', (req, res) => {
  const files = fs.readdirSync(taskManager.outputDir).filter(f => (f.startsWith('codex-') || f.startsWith('token_')) && f.endsWith('.json'));
  let deleted = 0;
  for (const f of files) {
    try { fs.unlinkSync(path.join(taskManager.outputDir, f)); deleted++; } catch {}
  }
  res.json({ ok: true, deleted });
});

// ── CPA 配置 CRUD ──
app.get('/api/cpa-config', (req, res) => {
  const cfg = loadCpaConfig();
  res.json(cfg || { base_url: '', management_key: '', enabled: false });
});

app.post('/api/cpa-config', (req, res) => {
  const { base_url, management_key, enabled } = req.body;
  const cfg = {
    base_url: typeof base_url === 'string' ? base_url.replace(/\/+$/, '') : '',
    management_key: typeof management_key === 'string' ? management_key : '',
    enabled: !!enabled,
  };
  saveCpaConfig(cfg);
  res.json({ ok: true, config: cfg });
});

// ── 上传单个 token 到 CPA ──
app.post('/api/upload-to-cpa', async (req, res) => {
  const rawName = req.body.filename;
  if (!rawName) return res.status(400).json({ error: '缺少文件名' });
  const filename = path.basename(rawName);
  const filepath = path.join(taskManager.outputDir, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Token 文件不存在' });

  const cpaConfig = loadCpaConfig();
  if (!cpaConfig || !cpaConfig.base_url || !cpaConfig.management_key) {
    return res.status(400).json({ error: '请先配置 CPA 地址和 Management Key' });
  }

  try {
    const tokenData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const result = await uploadTokenToCpa(cpaConfig, tokenData, filename);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 批量上传所有 token 到 CPA ──
app.post('/api/upload-all-to-cpa', async (req, res) => {
  const cpaConfig = loadCpaConfig();
  if (!cpaConfig || !cpaConfig.base_url || !cpaConfig.management_key) {
    return res.status(400).json({ error: '请先配置 CPA 地址和 Management Key' });
  }

  const files = fs.readdirSync(taskManager.outputDir).filter(f => (f.startsWith('codex-') || f.startsWith('token_')) && f.endsWith('.json'));
  const results = { success: 0, failed: 0, details: [] };

  for (const f of files) {
    try {
      const tokenData = JSON.parse(fs.readFileSync(path.join(taskManager.outputDir, f), 'utf8'));
      await uploadTokenToCpa(cpaConfig, tokenData, f);
      results.success++;
      results.details.push({ file: f, status: 'ok' });
    } catch (err) {
      results.failed++;
      results.details.push({ file: f, status: 'error', error: err.message });
    }
  }
  res.json({ ok: true, ...results });
});

// ── 提取完成后自动上传 ──
async function autoUploadToCpa(filename) {
  const cpaConfig = loadCpaConfig();
  if (!cpaConfig || !cpaConfig.enabled || !cpaConfig.base_url || !cpaConfig.management_key) return;

  const filepath = path.join(taskManager.outputDir, filename);
  if (!fs.existsSync(filepath)) return;

  try {
    const tokenData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    await uploadTokenToCpa(cpaConfig, tokenData, filename);
    broadcastToClients({ type: 'log', source: 'cpa', message: `[CPA] ${filename} 自动上传成功` });
  } catch (err) {
    broadcastToClients({ type: 'log', source: 'cpa', message: `[CPA] 自动上传失败: ${err.message}` });
  }
}

// ── CPA 上传核心逻辑 ──
async function uploadTokenToCpa(cpaConfig, tokenData, filename) {
  const http = require('http');
  const https = require('https');
  const { URL } = require('url');

  const baseUrl = cpaConfig.base_url.replace(/\/+$/, '');
  const uploadUrl = `${baseUrl}/v0/management/auth-files?name=${encodeURIComponent(path.basename(filename))}`;
  const parsed = new URL(uploadUrl);

  const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
  const fileContent = JSON.stringify(tokenData, null, 2);

  // 构建 multipart/form-data body
  const parts = [];
  // file field
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${path.basename(filename)}"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${fileContent}\r\n`
  );
  // end boundary
  parts.push(`--${boundary}--\r\n`);
  const body = parts.join('');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cpaConfig.management_key}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          resolve({ status: resp.statusCode, body: data });
        } else {
          reject(new Error(`CPA 返回 ${resp.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── sub2api 配置 CRUD ──
app.get('/api/sub2api-config', (req, res) => {
  res.json(normalizeSub2ApiConfig(loadSub2ApiConfig()));
});

app.post('/api/sub2api-config', (req, res) => {
  const cfg = normalizeSub2ApiConfig(req.body);
  saveSub2ApiConfig(cfg);
  res.json({ ok: true, config: cfg });
});

// ── 上传单个 token 到 sub2api ──
app.post('/api/upload-to-sub2api', async (req, res) => {
  const rawName = req.body.filename;
  if (!rawName) return res.status(400).json({ error: '缺少文件名' });
  const filename = path.basename(rawName);
  const filepath = path.join(taskManager.outputDir, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Token 文件不存在' });

  const cfg = loadSub2ApiConfig();
  if (!isSub2ApiConfigReady(cfg)) {
    return res.status(400).json({ error: missingSub2ApiConfigMessage(cfg) });
  }

  try {
    const tokenData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const result = await uploadToSub2Api(cfg, tokenData);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 直接提交 refresh_token 到 sub2api ──
app.post('/api/upload-refresh-token-to-sub2api', async (req, res) => {
  const refreshToken = typeof req.body.refresh_token === 'string' ? req.body.refresh_token.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!refreshToken) return res.status(400).json({ error: 'refresh_token 必填' });

  const cfg = loadSub2ApiConfig();
  if (!isSub2ApiConfigReady(cfg)) {
    return res.status(400).json({ error: missingSub2ApiConfigMessage(cfg) });
  }

  try {
    const result = await uploadToSub2Api(cfg, {
      refresh_token: refreshToken,
      email: email || undefined,
    }, {
      name: name || email || generateManualSub2ApiAccountName(),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function generateManualSub2ApiAccountName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    '-',
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('');
  return `manual-rt-${timestamp}-${crypto.randomBytes(3).toString('hex')}`;
}

// ── 批量上传所有 token 到 sub2api ──
app.post('/api/upload-all-to-sub2api', async (req, res) => {
  const cfg = loadSub2ApiConfig();
  if (!isSub2ApiConfigReady(cfg)) {
    return res.status(400).json({ error: missingSub2ApiConfigMessage(cfg) });
  }

  const files = fs.readdirSync(taskManager.outputDir).filter(f => (f.startsWith('codex-') || f.startsWith('token_')) && f.endsWith('.json'));
  const results = { success: 0, failed: 0, details: [] };

  for (const f of files) {
    try {
      const tokenData = JSON.parse(fs.readFileSync(path.join(taskManager.outputDir, f), 'utf8'));
      const uploadResult = await uploadToSub2Api(cfg, tokenData);
      results.success++;
      results.details.push({
        file: f,
        status: 'ok',
        auth_method: uploadResult.auth_method,
        account: uploadResult.account,
      });
    } catch (err) {
      results.failed++;
      results.details.push({ file: f, status: 'error', error: err.message });
    }
  }
  res.json({ ok: true, ...results });
});

// ── 提取完成后自动上传 sub2api ──
async function autoUploadToSub2Api(filename) {
  const cfg = loadSub2ApiConfig();
  if (!cfg || !cfg.enabled || !isSub2ApiConfigReady(cfg)) return;

  const filepath = path.join(taskManager.outputDir, filename);
  if (!fs.existsSync(filepath)) return;

  try {
    const tokenData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const uploadResult = await uploadToSub2Api(cfg, tokenData);
    const account = uploadResult.account || {};
    const accountInfo = account.id ? `，账号 ID: ${account.id}，状态: ${account.status || 'unknown'}` : '';
    const authInfo = uploadResult.auth_method === 'admin_api_key' ? 'x-api-key' : '邮箱/密码';
    broadcastToClients({ type: 'log', source: 'sub2api', message: `[sub2api] ${filename} 自动上传成功（${authInfo}${accountInfo}）` });
  } catch (err) {
    broadcastToClients({ type: 'log', source: 'sub2api', message: `[sub2api] 自动上传失败: ${err.message}` });
  }
}

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', tasks: taskManager.getAllTasks() }));
  ws.on('close', () => wsClients.delete(ws));
});

const PORT = parseInt(process.env.PORT, 10) || 8090;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`GPT Token Extractor running on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  server,
  generateManualSub2ApiAccountName,
};
