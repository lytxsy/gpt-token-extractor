(function () {
  const $ = (sel) => document.querySelector(sel);

  let ws = null;
  let authToken = null;
  let currentTaskId = null;

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
    if (!authToken) {
      loginOverlay.hidden = false;
    }
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
        loginOverlay.hidden = true;
      } else {
        loginError.hidden = false;
        setTimeout(() => loginError.hidden = true, 2000);
      }
    } catch {
      loginOverlay.hidden = true;
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
    ws.onclose = () => {
      setTimeout(connectWS, 3000);
    };
  }

  const extractForm = $('#extract-form');
  const submitBtn = $('#submit-btn');

  extractForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#email').value.trim();
    const password = $('#password').value;

    if (!email) return;

    submitBtn.disabled = true;
    submitBtn.textContent = '提交中...';

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const resp = await fetch('/api/extract', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, password })
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
          showResult(msg.result, msg.filename);
          loadHistory();
        }
        break;
      case 'error':
        if (msg.taskId === currentTaskId) {
          $('#progress-step').textContent = '错误: ' + msg.message;
          $('#stop-btn').hidden = true;
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
    $('#result-email').textContent = '邮箱: ' + result.email;
    $('#result-account').textContent = 'Account: ' + (result.account_id || 'N/A').substring(0, 16) + '...';
    $('#json-preview').textContent = JSON.stringify(result, null, 2);
    $('#download-btn').href = '/api/download/' + encodeURIComponent(filename);
    $('#download-btn').download = filename;
  }

  $('#copy-json-btn').addEventListener('click', () => {
    const text = $('#json-preview').textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = $('#copy-json-btn');
      btn.textContent = '已复制';
      setTimeout(() => btn.textContent = '复制 JSON', 1500);
    });
  });

  $('#download-all-btn').addEventListener('click', () => {
    window.location.href = '/api/download-all';
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
        <span class="status ${t.status}">${t.status === 'completed' ? '成功' : t.status === 'running' ? '进行中' : '失败'}</span>
        ${t.filename ? `<a href="/api/download/${encodeURIComponent(t.filename)}" class="btn-secondary" style="padding:4px 10px;font-size:0.75rem" download>下载</a>` : ''}
      </div>
    `).join('');
  }

  checkAuth();
  connectWS();
  loadHistory();

})();
