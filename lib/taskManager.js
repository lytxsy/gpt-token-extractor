const fs = require('fs');
const path = require('path');
const { BrowserbaseService } = require('./browserbaseService');
const { OAuthService } = require('./oauthService');

class TaskManager {
  constructor(config) {
    this.config = config;
    this.tasks = new Map();
    this.outputDir = path.join(process.cwd(), 'tokens');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  createTaskId() {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  getTask(taskId) {
    return this.tasks.get(taskId);
  }

  getAllTasks() {
    return Array.from(this.tasks.values());
  }

  async startExtraction(email, password, wsSend) {
    const taskId = this.createTaskId();
    const logs = [];

    const onLog = (source, message) => {
      const entry = { time: new Date().toISOString(), source, message };
      logs.push(entry);
      wsSend({ type: 'log', taskId, ...entry });
    };

    const task = {
      id: taskId,
      email,
      status: 'running',
      progress: 0,
      step: '初始化',
      logs,
      result: null,
      createdAt: new Date().toISOString()
    };
    this.tasks.set(taskId, task);

    this._runExtraction(taskId, email, password, onLog, wsSend).catch(err => {
      task.status = 'error';
      task.step = err.message;
      wsSend({ type: 'error', taskId, message: err.message });
    });

    return taskId;
  }

  async _runExtraction(taskId, email, password, onLog, wsSend) {
    const task = this.tasks.get(taskId);
    const browserbase = new BrowserbaseService(this.config, onLog);
    const oauth = new OAuthService(this.config, onLog);

    const hasPassword = !!password;
    const modeLabel = hasPassword ? '密码登录' : '验证码登录';

    try {
      task.step = '创建浏览器会话';
      task.progress = 10;
      wsSend({ type: 'progress', taskId, step: task.step, progress: task.progress });

      const session = await browserbase.createSession();

      task.step = `执行 OAuth 登录 (${modeLabel})`;
      task.progress = 20;
      wsSend({ type: 'progress', taskId, step: task.step, progress: task.progress });

      const authUrl = oauth.getAuthUrl();
      const inboxUrl = this.config.inboxProxyUrl || 'https://mail.19980519.xyz/admin';

      let goal;
      if (hasPassword) {
        goal = `导航到${authUrl}，使用${email}作为邮箱，${password}作为密码登录，如果需要验证码则在${inboxUrl}上查看 ${email} 的收件箱获取验证码，选择登录到codex，地址跳转到localhost回调链接后记录当前完整url并结束。每次等待不超过3秒。`;
      } else {
        goal = `导航到${authUrl}，使用${email}作为邮箱，不要输入密码，选择使用验证码登录/发送验证码的方式，然后在${inboxUrl}上查看 ${email} 的收件箱获取验证码并输入，选择登录到codex，地址跳转到localhost回调链接后记录当前完整url并结束。每次等待不超过3秒。`;
      }

      browserbase.sendAgentGoal(goal).catch(e => {
        onLog('agent', `Agent 流异常: ${e.message}`);
      });

      const callbackUrl = await browserbase.connectToCDP(session.wsUrl, {
        targetLabel: 'OAuth 回调',
        targetMatcher: (url) => {
          try {
            const u = new URL(url);
            return u.hostname === 'localhost' && u.port === String(this.config.oauthRedirectPort) && u.pathname === '/auth/callback' && (u.searchParams.has('code') || u.searchParams.has('error'));
          } catch { return false; }
        },
        onUrlChange: (url) => {
          task.progress = Math.min(task.progress + 5, 70);
          wsSend({ type: 'progress', taskId, step: `OAuth 登录中 (${modeLabel})`, progress: task.progress });
        },
        onTargetReached: (url) => url,
        timeout: 600000
      });

      onLog('oauth', `回调 URL: ${callbackUrl}`);

      task.step = '换取 Token';
      task.progress = 80;
      wsSend({ type: 'progress', taskId, step: task.step, progress: task.progress });

      const params = oauth.extractCallbackParams(callbackUrl);
      if (!params || params.error) {
        throw new Error(`OAuth 失败: ${params?.error_description || params?.error || '未知'}`);
      }
      if (!params.code) throw new Error('未找到授权码');

      onLog('oauth', `授权码: ${params.code.substring(0, 10)}...`);

      const tokenData = await oauth.exchangeToken(params.code, email);

      task.step = '保存结果';
      task.progress = 90;
      wsSend({ type: 'progress', taskId, step: task.step, progress: task.progress });

      const filename = `token_${Date.now()}.json`;
      const filepath = path.join(this.outputDir, filename);
      fs.writeFileSync(filepath, JSON.stringify(tokenData, null, 2));

      onLog('result', `Token 已保存: ${filename}`);

      task.status = 'completed';
      task.progress = 100;
      task.step = '完成';
      task.result = tokenData;
      task.filename = filename;
      wsSend({ type: 'completed', taskId, result: tokenData, filename });

    } finally {
      browserbase.disconnect();
    }
  }
}

module.exports = { TaskManager };
