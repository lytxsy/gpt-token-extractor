const http = require('http');
const https = require('https');

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function normalizeSub2ApiConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const authMode = cfg.auth_mode === 'admin_api_key' ? 'admin_api_key' : 'email_password';
  return {
    base_url: typeof cfg.base_url === 'string' ? cfg.base_url.replace(/\/+$/, '') : '',
    auth_mode: authMode,
    admin_email: typeof cfg.admin_email === 'string' ? cfg.admin_email : '',
    admin_password: typeof cfg.admin_password === 'string' ? cfg.admin_password : '',
    admin_api_key: typeof cfg.admin_api_key === 'string' ? cfg.admin_api_key : '',
    enabled: !!cfg.enabled,
  };
}

function isSub2ApiConfigReady(cfg) {
  const normalized = normalizeSub2ApiConfig(cfg);
  if (!normalized.base_url) return false;
  if (normalized.auth_mode === 'admin_api_key') return !!normalized.admin_api_key;
  return !!normalized.admin_email && !!normalized.admin_password;
}

function missingSub2ApiConfigMessage(cfg) {
  const normalized = normalizeSub2ApiConfig(cfg);
  if (!normalized.base_url) return '请先配置 sub2api 地址';
  if (normalized.auth_mode === 'admin_api_key') return '请先配置 sub2api Admin API Key';
  return '请先配置 sub2api 地址和管理员账号';
}

function parseJsonBody(body, fallbackMessage) {
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    throw new Error(fallbackMessage);
  }
}

function doRequest(url, opts, body) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, opts, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => resolve({ statusCode: resp.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function uploadToSub2Api(sub2ApiConfig, tokenData, options = {}) {
  const { URL } = require('url');
  const cfg = normalizeSub2ApiConfig(sub2ApiConfig);

  let adminHeaders;
  let authMethod;

  if (cfg.auth_mode === 'admin_api_key') {
    adminHeaders = { 'x-api-key': cfg.admin_api_key };
    authMethod = 'admin_api_key';
  } else {
    const loginUrl = new URL('/api/v1/auth/login', cfg.base_url);
    const loginBody = JSON.stringify({ email: cfg.admin_email, password: cfg.admin_password });

    const loginResult = await doRequest(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginBody) },
    }, loginBody);

    if (loginResult.statusCode !== 200) {
      throw new Error(`sub2api 登录失败 ${loginResult.statusCode}: ${loginResult.body}`);
    }

    const loginData = parseJsonBody(loginResult.body, 'sub2api 登录返回非 JSON 响应');
    const jwt = loginData?.data?.access_token;
    if (!jwt) throw new Error('sub2api 登录返回无 token');
    adminHeaders = { 'Authorization': `Bearer ${jwt}` };
    authMethod = 'email_password';
  }

  const accountUrl = new URL('/api/v1/admin/accounts', cfg.base_url);
  const refreshToken = tokenData.refresh_token;
  if (!refreshToken) throw new Error('Token 文件缺少 refresh_token');

  const accountBody = JSON.stringify({
    platform: 'openai',
    type: 'oauth',
    name: options.name || tokenData.email || 'extracted',
    credentials: {
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    },
  });

  const createResult = await doRequest(accountUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...adminHeaders,
      'Content-Length': Buffer.byteLength(accountBody),
    },
  }, accountBody);

  if (createResult.statusCode >= 400) {
    throw new Error(`sub2api 创建账号失败 ${createResult.statusCode}: ${createResult.body}`);
  }

  const responseBody = parseJsonBody(createResult.body, 'sub2api 创建账号返回非 JSON 响应');
  const account = responseBody?.data || responseBody;
  return {
    status: createResult.statusCode,
    body: createResult.body,
    auth_method: authMethod,
    account: {
      id: account?.id ?? null,
      name: account?.name ?? null,
      platform: account?.platform ?? null,
      type: account?.type ?? null,
      status: account?.status ?? null,
      schedulable: account?.schedulable ?? null,
      email: account?.extra?.email || tokenData.email || null,
    },
  };
}

module.exports = {
  OPENAI_CODEX_CLIENT_ID,
  normalizeSub2ApiConfig,
  isSub2ApiConfigReady,
  missingSub2ApiConfigMessage,
  uploadToSub2Api,
};
