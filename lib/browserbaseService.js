const axios = require('axios');
const WebSocket = require('ws');

class BrowserbaseService {
  constructor(config, onLog) {
    this.config = config;
    this.onLog = onLog || (() => {});
    this.sessionId = null;
    this.sessionUrl = null;
    this.agentStream = null;
    this.wsConnection = null;
    this.messageId = 1;
    this.pendingCommands = new Map();
  }

  async createSession() {
    const response = await axios.post(
      `${this.config.browserbaseApiUrl}/session`,
      { timezone: 'HKT' },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const data = response.data;
    if (!data.success) throw new Error('创建会话失败');
    this.sessionId = data.sessionId;
    this.sessionUrl = data.sessionUrl;
    const wsMatch = data.sessionUrl.match(/wss=([^&]+)/);
    const wsUrl = wsMatch ? decodeURIComponent(wsMatch[1]) : null;
    this.onLog('browserbase', `会话已创建: ${this.sessionId}`);
    return { sessionId: this.sessionId, sessionUrl: this.sessionUrl, wsUrl };
  }

  async sendAgentGoal(goal) {
    if (!this.sessionId) throw new Error('会话未创建');
    const encodedGoal = encodeURIComponent(goal);
    const model = encodeURIComponent(this.config.agentModel);
    const url = `${this.config.browserbaseApiUrl}/agent/stream?sessionId=${this.sessionId}&goal=${encodedGoal}&model=${model}`;
    this.onLog('agent', 'Agent 任务已发送');
    const response = await axios.get(url, { responseType: 'stream' });
    const stream = response.data;
    this.agentStream = stream;
    let streamClosed = false;
    const closeStream = () => {
      if (streamClosed) return;
      streamClosed = true;
      stream.destroy();
      if (this.agentStream === stream) this.agentStream = null;
    };
    stream.once('data', () => { setTimeout(closeStream, 250); });
    setTimeout(closeStream, 2000);
    stream.resume();
  }

  normalizeWsUrl(wsUrl) {
    if (!wsUrl) return '';
    const decoded = decodeURIComponent(wsUrl);
    return decoded.startsWith('wss://') || decoded.startsWith('ws://') ? decoded : `wss://${decoded}`;
  }

  sendCDPCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.wsConnection || this.wsConnection.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket 未连接'));
      }
      const id = this.messageId++;
      const timeoutId = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error('CDP 命令超时'));
      }, 5000);
      this.pendingCommands.set(id, { resolve, reject, timeoutId });
      try {
        this.wsConnection.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingCommands.delete(id);
        reject(error);
      }
    });
  }

  clearPendingCommands(reason = '连接已关闭') {
    for (const [id, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
      this.pendingCommands.delete(id);
    }
  }

  async getTargets() {
    const result = await this.sendCDPCommand('Target.getTargets');
    return Array.isArray(result?.targetInfos) ? result.targetInfos : [];
  }

  connectToCDP(wsUrl, options = {}) {
    return new Promise((resolve, reject) => {
      const {
        targetMatcher,
        targetLabel,
        onUrlChange,
        onTargetReached,
        timeout = 600000,
        pollInterval = 3000
      } = options;
      const reconnectDelay = 500;
      const staleReconnectMs = 12000;
      const fullWsUrl = this.normalizeWsUrl(wsUrl);
      const description = targetLabel || '目标页面';
      let settled = false;
      let pollTimer = null;
      let reconnectTimer = null;
      const targetUrls = new Map();
      let lastUrlChangeAt = Date.now();
      let lastReconnectAt = 0;
      let pollInFlight = false;
      const timeoutId = setTimeout(() => { cleanup(); settleReject(new Error('CDP 超时')); }, timeout);
      const cleanup = () => {
        clearTimeout(timeoutId);
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (this.wsConnection) {
          this.clearPendingCommands();
          this.wsConnection.close();
          this.wsConnection = null;
        }
      };
      const settleResolve = (v) => { if (!settled) { settled = true; cleanup(); resolve(v); } };
      const settleReject = (e) => { if (!settled) { settled = true; cleanup(); reject(e); } };
      const observeUrl = (key, url) => {
        if (!url || url === 'about:blank' || targetUrls.get(key) === url) return false;
        targetUrls.set(key, url);
        this.onLog('cdp', `URL: ${url}`);
        if (onUrlChange) onUrlChange(url);
        if (targetMatcher && targetMatcher(url)) {
          this.onLog('cdp', `检测到 ${description}`);
          const r = onTargetReached ? onTargetReached(url) : url;
          settleResolve(r || url);
          return true;
        }
        return false;
      };
      const pollTargets = async () => {
        if (pollInFlight || settled || !this.wsConnection || this.wsConnection.readyState !== WebSocket.OPEN) return;
        pollInFlight = true;
        try {
          const targets = await this.getTargets();
          let sawNew = false;
          for (const t of targets) {
            if (t.type && t.type !== 'page') continue;
            const url = t.url || '';
            if (observeUrl(t.targetId || url, url)) return;
            if (url && url !== 'about:blank') sawNew = true;
          }
          if (!sawNew) {
            const now = Date.now();
            if (now - lastUrlChangeAt >= staleReconnectMs && now - lastReconnectAt >= staleReconnectMs) scheduleReconnect('长时间无新 URL');
          }
        } catch {
          const now = Date.now();
          if (now - lastUrlChangeAt >= staleReconnectMs && now - lastReconnectAt >= staleReconnectMs) scheduleReconnect('轮询异常');
        } finally { pollInFlight = false; }
      };
      const scheduleReconnect = (reason) => {
        if (settled || reconnectTimer) return;
        lastReconnectAt = Date.now();
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
      };
      const connect = () => {
        if (settled) return;
        this.wsConnection = new WebSocket(fullWsUrl);
        this.wsConnection.on('open', () => {
          this.messageId = 1;
          lastReconnectAt = Date.now();
          this.wsConnection.send(JSON.stringify({ id: this.messageId++, method: 'Target.setDiscoverTargets', params: { discover: true } }));
          this.onLog('cdp', 'WebSocket 已连接');
          pollTimer = setInterval(pollTargets, pollInterval);
          pollTargets();
        });
        this.wsConnection.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (Object.prototype.hasOwnProperty.call(msg, 'id') && this.pendingCommands.has(msg.id)) {
              const p = this.pendingCommands.get(msg.id);
              clearTimeout(p.timeoutId);
              this.pendingCommands.delete(msg.id);
              msg.error ? p.reject(new Error(msg.error.message || 'CDP 命令失败')) : p.resolve(msg.result);
              return;
            }
            if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
              const info = msg.params?.targetInfo;
              if (info?.type === 'page') {
                observeUrl(info.targetId || info.url || 'page', info.url || '');
                setTimeout(pollTargets, 150);
              }
            }
          } catch {}
        });
        this.wsConnection.on('error', (e) => { this.clearPendingCommands(`连接异常: ${e.message}`); scheduleReconnect('连接异常'); });
        this.wsConnection.on('unexpected-response', (_req, res) => {
          this.clearPendingCommands(`握手失败: HTTP ${res?.statusCode}`);
          if (res?.statusCode === 410) settleReject(new Error('会话已结束'));
          else scheduleReconnect(`握手失败: HTTP ${res?.statusCode}`);
        });
        this.wsConnection.on('close', () => { this.clearPendingCommands(); scheduleReconnect('连接关闭'); });
      };
      connect();
    });
  }

  disconnect() {
    if (this.agentStream) { this.agentStream.destroy(); this.agentStream = null; }
    if (this.wsConnection) { this.wsConnection.close(); this.wsConnection = null; }
  }
}

module.exports = { BrowserbaseService };
