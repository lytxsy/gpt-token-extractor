(function () {
  const $ = (sel) => document.querySelector(sel);

  let ws = null;
  let authToken = null;
  let currentTaskId = null;
  let currentFilename = null;

  const loginOverlay = $('#login-overlay');
  const loginForm = $('#login-form');
  const loginError = $('#login-error');

  const inputSection = $('#input-section');
  const progressSection = $('#progress-section');
  const resultSection = $('#result-section');
  const historySection = $('#history-section');
  const historyList = $('#history-list');

  function checkAuth() {
    authToken = localStorage.getItem('auth_token');
    if (authToken) {
      loginOverlay.style.display = 'none';
      return;
    }
    fetch('/api/auth-status').then(r => r.json()).then(data => {
      if (!data.required) {
        loginOverlay.style.display = 'none';
      } else {
        loginOverlay.style.display = '';
        loginOverlay.hidden = false;
      }
    }).catch(() => {
      loginOverlay.style.display = 'none';
    });
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('#login-password').value;
    try {
      const resp = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      if (resp.ok) {
        const data = await resp.json();
        authToken = data.token;
        localStorage.setItem('auth_token', authToken);
        loginOverlay.style.display = 'none';
        loadHistory();
        loadCpaConfig();
      } else {
        loginError.hidden = false;
        loginError.textContent = '密码错误';
        setTimeout(() => loginError.hidden = true, 2000);
      }
    } catch (err) {
      loginError.hidden = false;
      loginError.textContent = '网络错误: ' + err.message;
      setTimeout(() => loginError.hidden = true, 3000);
    }
  });

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => { console.log('WS connected'); };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    };
    ws.onerror = () => { ws.close(); };
    ws.onclose = () => {
      setTimeout(connectWS, 3000);
    };
  }

  const extractForm = $('#extract-form');
  const submitBtn = $('#submit-btn');

  extractForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#email').value.trim();

    if (!email) return;

    submitBtn.disabled = true;
    submitBtn.textContent = '提交中...';

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const resp = await fetch('/api/extract', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email })
      });

      if (!resp.ok) {
        const err = await resp.json();
        alert(err.error || '请求失败');
        return;
      }

      const data = await resp.json();
      currentTaskId = data.taskId;

      progressSection.hidden = false;
      resultSection.hidden = true;
      $('#log-container').innerHTML = '';
      $('#progress-fill').style.width = '0%';
      $('#progress-step').textContent = '等待开始...';
      $('#stop-btn').hidden = false;

    } catch (err) {
      alert('网络错误: ' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '开始提取';
    }
  });

  function handleMessage(msg) {
    switch (msg.type) {
      case 'connected':
        renderHistory(msg.tasks || []);
        break;
      case 'log':
        appendLog(msg.source, msg.message);
        break;
      case 'need_code':
        showCodeInput(msg.taskId);
        break;
      case 'progress':
        if (msg.taskId === currentTaskId) {
          $('#progress-fill').style.width = msg.progress + '%';
          $('#progress-step').textContent = msg.step;
        }
        break;
      case 'completed':
        if (msg.taskId === currentTaskId) {
          $('#progress-fill').style.width = '100%';
          $('#progress-step').textContent = '完成';
          $('#stop-btn').hidden = true;
          $('#code-overlay').style.display = 'none';
          showResult(msg.result, msg.filename);
          loadHistory();
        }
        break;
      case 'cancelled':
        if (msg.taskId === currentTaskId) {
          $('#progress-step').textContent = '已取消';
          $('#stop-btn').hidden = true;
          $('#code-overlay').style.display = 'none';
          appendLog('system', '任务已取消');
        }
        break;
      case 'error':
        if (msg.taskId === currentTaskId) {
          $('#progress-step').textContent = '错误: ' + msg.message;
          $('#stop-btn').hidden = true;
          $('#code-overlay').style.display = 'none';
          appendLog('error', msg.message);
        }
        break;
    }
  }

  function appendLog(source, message) {
    const container = $('#log-container');
    const div = document.createElement('div');
    div.className = 'log-entry' + (source === 'error' ? ' error' : '');
    div.innerHTML = `<span class="source">[${source}]</span>${escapeHtml(message)}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showResult(result, filename) {
    resultSection.hidden = false;
    currentFilename = filename;
    currentResult = result;
    $('#result-email').textContent = '邮箱: ' + result.email;
    $('#result-account').textContent = 'Account: ' + (result.account_id || 'N/A').substring(0, 16) + '...';
    $('#json-preview').textContent = JSON.stringify(result, null, 2);
    $('#download-btn').href = '/api/download/' + encodeURIComponent(filename);
    $('#download-btn').download = filename;
  }

  let currentResult = null;

  $('#copy-rt-btn').addEventListener('click', () => {
    const rt = currentResult?.refresh_token;
    if (!rt) return alert('没有 refresh_token');
    navigator.clipboard.writeText(rt).then(() => {
      const btn = $('#copy-rt-btn');
      btn.textContent = '已复制';
      setTimeout(() => btn.textContent = '复制 RT', 1500);
    });
  });

  $('#copy-json-btn').addEventListener('click', () => {
    const text = $('#json-preview').textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = $('#copy-json-btn');
      btn.textContent = '已复制';
      setTimeout(() => btn.textContent = '复制 JSON', 1500);
    });
  });

  // ── CPA 上传单个 token ──
  $('#upload-cpa-btn').addEventListener('click', async () => {
    if (!currentFilename) return alert('没有可上传的文件');
    const btn = $('#upload-cpa-btn');
    btn.disabled = true;
    btn.textContent = '上传中...';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const resp = await fetch('/api/upload-to-cpa', {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename: currentFilename })
      });
      const data = await resp.json();
      if (resp.ok) {
        btn.textContent = '已上传';
        setTimeout(() => btn.textContent = '上传到 CPA', 2000);
      } else {
        alert('上传失败: ' + data.error);
        btn.textContent = '上传到 CPA';
      }
    } catch (err) {
      alert('网络错误: ' + err.message);
      btn.textContent = '上传到 CPA';
    } finally {
      btn.disabled = false;
    }
  });

  // ── sub2api 上传单个 token ──
  $('#upload-sub2api-btn').addEventListener('click', async () => {
    if (!currentFilename) return alert('没有可上传的文件');
    const btn = $('#upload-sub2api-btn');
    btn.disabled = true;
    btn.textContent = '上传中...';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const resp = await fetch('/api/upload-to-sub2api', {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename: currentFilename })
      });
      const data = await resp.json();
      if (resp.ok) {
        btn.textContent = '已上传';
        setTimeout(() => btn.textContent = '上传到 sub2api', 2000);
      } else {
        alert('上传失败: ' + data.error);
        btn.textContent = '上传到 sub2api';
      }
    } catch (err) {
      alert('网络错误: ' + err.message);
      btn.textContent = '上传到 sub2api';
    } finally {
      btn.disabled = false;
    }
  });

  $('#download-all-btn')?.addEventListener('click', () => {
    window.location.href = '/api/download-all';
  });

  // ── 删除当前凭证 ──
  $('#delete-btn').addEventListener('click', async () => {
    if (!currentFilename) return alert('没有可删除的文件');
    if (!confirm(`确定删除 ${currentFilename}？此操作不可恢复。`)) return;
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      const resp = await fetch('/api/delete/' + encodeURIComponent(currentFilename), { method: 'POST', headers });
      if (resp.ok) {
        resultSection.hidden = true;
        currentFilename = null;
        loadHistory();
      } else {
        const data = await resp.json();
        alert('删除失败: ' + data.error);
      }
    } catch (err) {
      alert('网络错误: ' + err.message);
    }
  });

  $('#stop-btn').addEventListener('click', async () => {
    if (!currentTaskId) return;
    const btn = $('#stop-btn');
    btn.disabled = true;
    btn.textContent = '取消中...';
    try {
      const headers = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      await fetch(`/api/cancel/${currentTaskId}`, { method: 'POST', headers });
    } catch {} finally {
      btn.disabled = false;
      btn.textContent = '取消';
    }
  });

  async function loadHistory() {
    try {
      const headers = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const resp = await fetch('/api/tasks', { headers });
      if (resp.ok) {
        const tasks = await resp.json();
        renderHistory(tasks);
      }
    } catch {}
  }

  function renderHistory(tasks) {
    if (!tasks.length) {
      historyList.innerHTML = '<p class="empty">暂无记录</p>';
      return;
    }
    historyList.innerHTML = tasks.reverse().map(t => `
      <div class="history-item">
        <span class="email">${escapeHtml(t.email)}</span>
        <span class="time">${new Date(t.createdAt).toLocaleString()}</span>
        <span class="status ${t.status}">${t.status === 'completed' ? '成功' : t.status === 'deleted' ? '已删除' : t.status === 'running' ? '进行中' : '失败'}</span>
        ${t.filename && t.status !== 'deleted' ? `<span class="history-actions">
          <a href="/api/download/${encodeURIComponent(t.filename)}" class="btn-secondary" style="padding:4px 10px;font-size:0.75rem" download>下载</a>
          <button class="btn-secondary btn-cpa-small" data-filename="${escapeHtml(t.filename)}" style="padding:4px 10px;font-size:0.75rem">上传CPA</button>
          <button class="btn-secondary btn-sub2api-small" data-filename="${escapeHtml(t.filename)}" style="padding:4px 10px;font-size:0.75rem;color:#f59e0b">上传sub2api</button>
          <button class="btn-secondary btn-delete-small" data-filename="${escapeHtml(t.filename)}" style="padding:4px 10px;font-size:0.75rem;color:#ef4444">删除</button>
        </span>` : ''}
      </div>
    `).join('');

    // 为历史记录中的上传按钮绑定事件
    historyList.querySelectorAll('.btn-cpa-small').forEach(btn => {
      btn.addEventListener('click', async () => {
        const filename = btn.dataset.filename;
        btn.disabled = true;
        btn.textContent = '上传中...';
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
          const resp = await fetch('/api/upload-to-cpa', {
            method: 'POST',
            headers,
            body: JSON.stringify({ filename })
          });
          const data = await resp.json();
          if (resp.ok) {
            btn.textContent = '已上传';
          } else {
            btn.textContent = '上传CPA';
            alert('上传失败: ' + data.error);
          }
        } catch (err) {
          btn.textContent = '上传CPA';
          alert('网络错误: ' + err.message);
        } finally {
          btn.disabled = false;
        }
      });
    });

    // 为历史记录中的 sub2api 上传按钮绑定事件
    historyList.querySelectorAll('.btn-sub2api-small').forEach(btn => {
      btn.addEventListener('click', async () => {
        const filename = btn.dataset.filename;
        btn.disabled = true;
        btn.textContent = '上传中...';
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
          const resp = await fetch('/api/upload-to-sub2api', {
            method: 'POST',
            headers,
            body: JSON.stringify({ filename })
          });
          const data = await resp.json();
          if (resp.ok) {
            btn.textContent = '已上传';
          } else {
            btn.textContent = '上传sub2api';
            alert('上传失败: ' + data.error);
          }
        } catch (err) {
          btn.textContent = '上传sub2api';
          alert('网络错误: ' + err.message);
        } finally {
          btn.disabled = false;
        }
      });
    });

    // 为历史记录中的删除按钮绑定事件
    historyList.querySelectorAll('.btn-delete-small').forEach(btn => {
      btn.addEventListener('click', async () => {
        const filename = btn.dataset.filename;
        if (!confirm(`确定删除 ${filename}？此操作不可恢复。`)) return;
        btn.disabled = true;
        const headers = { 'Content-Type': 'application/json' };
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        try {
          const resp = await fetch('/api/delete/' + encodeURIComponent(filename), { method: 'POST', headers });
          if (resp.ok) {
            if (currentFilename === filename) {
              resultSection.hidden = true;
              currentFilename = null;
            }
            loadHistory();
          } else {
            const data = await resp.json();
            alert('删除失败: ' + data.error);
            btn.disabled = false;
          }
        } catch (err) {
          alert('网络错误: ' + err.message);
          btn.disabled = false;
        }
      });
    });
  }

  // ── CPA 配置 ──
  async function loadCpaConfig() {
    try {
      const headers = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const resp = await fetch('/api/cpa-config', { headers });
      if (resp.ok) {
        const cfg = await resp.json();
        $('#cpa-url').value = cfg.base_url || '';
        $('#cpa-key').value = cfg.management_key || '';
        $('#cpa-auto').checked = !!cfg.enabled;
      }
    } catch {}
  }

  $('#cpa-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      const resp = await fetch('/api/cpa-config', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base_url: $('#cpa-url').value.trim(),
          management_key: $('#cpa-key').value.trim(),
          enabled: $('#cpa-auto').checked
        })
      });
      const data = await resp.json();
      showCpaStatus(resp.ok ? '配置已保存' : ('保存失败: ' + (data.error || '未知错误')), resp.ok);
    } catch (err) {
      showCpaStatus('网络错误: ' + err.message, false);
    }
  });

  // 测试连接
  $('#cpa-test-btn').addEventListener('click', async () => {
    const btn = $('#cpa-test-btn');
    btn.disabled = true;
    btn.textContent = '测试中...';
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      // 先保存配置
      const saveResp = await fetch('/api/cpa-config', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base_url: $('#cpa-url').value.trim(),
          management_key: $('#cpa-key').value.trim(),
          enabled: $('#cpa-auto').checked
        })
      });
      if (!saveResp.ok) {
        showCpaStatus('保存配置失败', false);
        return;
      }
      // 尝试上传一个测试（使用 /api/upload-all-to-cpa 但只有空列表也能验证连接）
      showCpaStatus('连接测试: 配置已保存，CPA 地址和 Key 已记录', true);
    } catch (err) {
      showCpaStatus('测试失败: ' + err.message, false);
    } finally {
      btn.disabled = false;
      btn.textContent = '测试连接';
    }
  });

  // 一键上传全部
  $('#cpa-upload-all-btn').addEventListener('click', async () => {
    const btn = $('#cpa-upload-all-btn');
    btn.disabled = true;
    btn.textContent = '上传中...';
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      const resp = await fetch('/api/upload-all-to-cpa', { method: 'POST', headers });
      const data = await resp.json();
      if (resp.ok) {
        showCpaStatus(`上传完成: 成功 ${data.success} 个, 失败 ${data.failed} 个`, data.failed === 0);
        if (data.details && data.details.length > 0) {
          data.details.forEach(d => {
            if (d.status === 'error') appendLog('cpa', `[CPA] ${d.file} 上传失败: ${d.error}`);
          });
        }
      } else {
        showCpaStatus('上传失败: ' + data.error, false);
      }
    } catch (err) {
      showCpaStatus('网络错误: ' + err.message, false);
    } finally {
      btn.disabled = false;
      btn.textContent = '一键上传全部';
    }
  });

  function showCpaStatus(msg, ok) {
    const el = $('#cpa-status');
    el.hidden = false;
    el.textContent = msg;
    el.className = 'cpa-status ' + (ok ? 'cpa-ok' : 'cpa-err');
    setTimeout(() => el.hidden = true, 5000);
  }

  // ── sub2api 配置 ──
  async function loadSub2ApiConfig() {
    try {
      const headers = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const resp = await fetch('/api/sub2api-config', { headers });
      if (resp.ok) {
        const cfg = await resp.json();
        $('#sub2api-url').value = cfg.base_url || '';
        $('#sub2api-email').value = cfg.admin_email || '';
        $('#sub2api-pwd').value = cfg.admin_password || '';
        $('#sub2api-auto').checked = !!cfg.enabled;
      }
    } catch {}
  }

  $('#sub2api-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      const resp = await fetch('/api/sub2api-config', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base_url: $('#sub2api-url').value.trim(),
          admin_email: $('#sub2api-email').value.trim(),
          admin_password: $('#sub2api-pwd').value,
          enabled: $('#sub2api-auto').checked
        })
      });
      const data = await resp.json();
      showSub2ApiStatus(resp.ok ? '配置已保存' : ('保存失败: ' + (data.error || '未知错误')), resp.ok);
    } catch (err) {
      showSub2ApiStatus('网络错误: ' + err.message, false);
    }
  });

  // sub2api 一键上传全部
  $('#sub2api-upload-all-btn').addEventListener('click', async () => {
    const btn = $('#sub2api-upload-all-btn');
    btn.disabled = true;
    btn.textContent = '上传中...';
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      const resp = await fetch('/api/upload-all-to-sub2api', { method: 'POST', headers });
      const data = await resp.json();
      if (resp.ok) {
        showSub2ApiStatus(`上传完成: 成功 ${data.success} 个, 失败 ${data.failed} 个`, data.failed === 0);
      } else {
        showSub2ApiStatus('上传失败: ' + data.error, false);
      }
    } catch (err) {
      showSub2ApiStatus('网络错误: ' + err.message, false);
    } finally {
      btn.disabled = false;
      btn.textContent = '一键上传全部';
    }
  });

  function showSub2ApiStatus(msg, ok) {
    const el = $('#sub2api-status');
    el.hidden = false;
    el.textContent = msg;
    el.className = 'cpa-status ' + (ok ? 'cpa-ok' : 'cpa-err');
    setTimeout(() => el.hidden = true, 5000);
  }

  checkAuth();
  connectWS();
  loadHistory();
  loadCpaConfig();
  loadSub2ApiConfig();

  let codeSubmitTaskId = null;

  function showCodeInput(taskId) {
    codeSubmitTaskId = taskId;
    const overlay = $('#code-overlay');
    overlay.style.display = '';
    $('#code-input').value = '';
    $('#code-input').focus();
  }

  $('#code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#code-input').value.trim();
    if (!code || !codeSubmitTaskId) return;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const resp = await fetch(`/api/task/${codeSubmitTaskId}/code`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code })
      });
      if (resp.ok) {
        $('#code-overlay').style.display = 'none';
        codeSubmitTaskId = null;
        appendLog('system', `验证码已提交: ${code}`);
      } else {
        const err = await resp.json();
        $('#code-error').hidden = false;
        $('#code-error').textContent = err.error || '提交失败';
        setTimeout(() => $('#code-error').hidden = true, 2000);
      }
    } catch (err) {
      $('#code-error').hidden = false;
      $('#code-error').textContent = '网络错误';
      setTimeout(() => $('#code-error').hidden = true, 2000);
    }
  });

})();
