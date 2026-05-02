const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  OPENAI_CODEX_CLIENT_ID,
  normalizeSub2ApiConfig,
  isSub2ApiConfigReady,
  missingSub2ApiConfigMessage,
  uploadToSub2Api,
} = require('../lib/sub2apiService');

async function withMockSub2Api(handler, run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        json: body ? JSON.parse(body) : null,
      };
      requests.push(record);
      handler(record, res);
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('normalizeSub2ApiConfig keeps legacy config on email/password mode', () => {
  const cfg = normalizeSub2ApiConfig({
    base_url: 'http://sub2api.local///',
    admin_email: 'admin@example.com',
    admin_password: 'secret',
    enabled: true,
  });

  assert.deepEqual(cfg, {
    base_url: 'http://sub2api.local',
    auth_mode: 'email_password',
    admin_email: 'admin@example.com',
    admin_password: 'secret',
    admin_api_key: '',
    enabled: true,
  });
  assert.equal(isSub2ApiConfigReady(cfg), true);
});

test('isSub2ApiConfigReady validates admin_api_key mode separately', () => {
  assert.equal(isSub2ApiConfigReady({
    base_url: 'http://sub2api.local',
    auth_mode: 'admin_api_key',
    admin_api_key: '',
    admin_email: 'admin@example.com',
    admin_password: 'secret',
  }), false);
  assert.equal(missingSub2ApiConfigMessage({
    base_url: 'http://sub2api.local',
    auth_mode: 'admin_api_key',
  }), '请先配置 sub2api Admin API Key');
  assert.equal(isSub2ApiConfigReady({
    base_url: 'http://sub2api.local',
    auth_mode: 'admin_api_key',
    admin_api_key: 's2a_test',
  }), true);
});

test('uploadToSub2Api uses x-api-key and creates account from refresh token', async () => {
  await withMockSub2Api((record, res) => {
    assert.equal(record.url, '/api/v1/admin/accounts');
    assert.equal(record.headers['x-api-key'], 's2a_test_key');
    assert.equal(record.headers.authorization, undefined);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        id: 123,
        name: record.json.name,
        platform: record.json.platform,
        type: record.json.type,
        status: 'active',
        schedulable: true,
        extra: { email: 'openai@example.com' },
      },
    }));
  }, async (baseUrl, requests) => {
    const result = await uploadToSub2Api({
      base_url: baseUrl,
      auth_mode: 'admin_api_key',
      admin_api_key: 's2a_test_key',
    }, {
      email: 'openai@example.com',
      refresh_token: 'rt_test',
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].json, {
      platform: 'openai',
      type: 'oauth',
      name: 'openai@example.com',
      credentials: {
        refresh_token: 'rt_test',
        client_id: OPENAI_CODEX_CLIENT_ID,
      },
    });
    assert.equal(result.auth_method, 'admin_api_key');
    assert.deepEqual(result.account, {
      id: 123,
      name: 'openai@example.com',
      platform: 'openai',
      type: 'oauth',
      status: 'active',
      schedulable: true,
      email: 'openai@example.com',
    });
  });
});

test('uploadToSub2Api allows explicit account name for manual refresh token upload', async () => {
  await withMockSub2Api((record, res) => {
    assert.equal(record.url, '/api/v1/admin/accounts');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        id: 321,
        name: record.json.name,
        platform: 'openai',
        type: 'oauth',
        status: 'active',
      },
    }));
  }, async (baseUrl, requests) => {
    const result = await uploadToSub2Api({
      base_url: baseUrl,
      auth_mode: 'admin_api_key',
      admin_api_key: 's2a_test_key',
    }, {
      email: 'manual@example.com',
      refresh_token: 'rt_manual',
    }, {
      name: 'Manual OpenAI Account',
    });

    assert.equal(requests[0].json.name, 'Manual OpenAI Account');
    assert.equal(requests[0].json.credentials.refresh_token, 'rt_manual');
    assert.equal(result.account.name, 'Manual OpenAI Account');
    assert.equal(result.account.email, 'manual@example.com');
  });
});

test('uploadToSub2Api preserves email/password login flow', async () => {
  await withMockSub2Api((record, res) => {
    if (record.url === '/api/v1/auth/login') {
      assert.equal(record.method, 'POST');
      assert.deepEqual(record.json, {
        email: 'admin@example.com',
        password: 'admin-secret',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { access_token: 'jwt_test' } }));
      return;
    }

    assert.equal(record.url, '/api/v1/admin/accounts');
    assert.equal(record.headers.authorization, 'Bearer jwt_test');
    assert.equal(record.headers['x-api-key'], undefined);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        id: 456,
        name: 'fallback-name',
        platform: 'openai',
        type: 'oauth',
        status: 'active',
      },
    }));
  }, async (baseUrl, requests) => {
    const result = await uploadToSub2Api({
      base_url: baseUrl,
      admin_email: 'admin@example.com',
      admin_password: 'admin-secret',
    }, {
      refresh_token: 'rt_legacy',
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[1].json.name, 'extracted');
    assert.equal(requests[1].json.credentials.refresh_token, 'rt_legacy');
    assert.equal(result.auth_method, 'email_password');
    assert.equal(result.account.id, 456);
    assert.equal(result.account.email, null);
  });
});

test('uploadToSub2Api fails early when token file has no refresh_token', async () => {
  await withMockSub2Api(() => {
    throw new Error('server should not receive requests');
  }, async (baseUrl, requests) => {
    await assert.rejects(
      uploadToSub2Api({
        base_url: baseUrl,
        auth_mode: 'admin_api_key',
        admin_api_key: 's2a_test_key',
      }, { email: 'openai@example.com' }),
      /缺少 refresh_token/,
    );
    assert.equal(requests.length, 0);
  });
});
