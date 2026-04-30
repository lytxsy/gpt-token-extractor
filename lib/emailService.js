const axios = require('axios');

class EmailService {
  constructor(config, onLog) {
    this.config = config;
    this.onLog = onLog || (() => {});
    this.apiBase = config.mailApiBase;
    this.adminKey = config.mailAdminKey;
  }

  async createMailbox(name) {
    this.onLog('email', `创建邮箱: ${name}`);
    const resp = await axios.post(
      `${this.apiBase}/admin/new_address`,
      { name, enableRandomSubdomain: true, enablePrefix: false },
      { headers: { 'Content-Type': 'application/json', 'x-admin-auth': this.adminKey }, timeout: 15000 }
    );
    if (resp.status !== 200 && resp.status !== 201) {
      throw new Error(`创建邮箱失败: HTTP ${resp.status}`);
    }
    const data = resp.data;
    const email = data.address || data.email;
    const token = data.jwt || data.token;
    if (!email || !token) throw new Error('API 响应缺少 address 或 token');
    this.onLog('email', `邮箱已创建: ${email}`);
    return { email, token };
  }

  async waitForCode(email, maxAttempts = 60, intervalMs = 5000) {
    this.onLog('email', `等待验证码到达 ${email}...`);
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const resp = await axios.get(
          `${this.apiBase}/admin/mails?limit=50`,
          { headers: { 'x-admin-auth': this.adminKey }, timeout: 15000 }
        );
        if (resp.status === 200) {
          const results = resp.data.results || [];
          const filtered = results.filter(m => m.address === email);
          for (const msg of filtered) {
            const raw = msg.raw || '';
            const match = raw.match(/\b(\d{6})\b/);
            if (match) {
              const code = match[1];
              this.onLog('email', `验证码获取成功: ${code}`);
              return code;
            }
          }
        }
      } catch (e) {
        this.onLog('email', `轮询出错: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, intervalMs));
      this.onLog('email', `等待中... (${i + 1}/${maxAttempts})`);
    }
    throw new Error('等待验证码超时');
  }
}

module.exports = { EmailService };
