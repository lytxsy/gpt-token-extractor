const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());
const http = require('http');
const fs = require('fs');
const path = require('path');

class BrowserService {
  constructor(config, onLog) {
    this.config = config;
    this.onLog = onLog || (() => {});
    this.browser = null;
    this.page = null;
    this.callbackServer = null;
    this.callbackUrl = null;
  }

  async launch() {
    this.onLog('browser', '启动无头浏览器...');
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900',
      '--no-zygote',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-blink-features=AutomationControlled'
    ];
    const launchOpts = { headless: true, args };
    if (this.config.proxy) {
      args.push(`--proxy-server=${this.config.proxy}`);
      this.onLog('browser', `浏览器代理: ${this.config.proxy.replace(/\/\/.*@/, '//***@')}`);
    }
    this.browser = await puppeteer.launch(launchOpts);
    this.page = await this.browser.newPage();
    await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await this.page.setViewport({ width: 1280, height: 900 });
    this.onLog('browser', '浏览器已启动');
    return this.page;
  }

  async navigateToOAuth(authUrl) {
    this.onLog('browser', '导航到 OAuth 页面...');
    await this.page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    this.onLog('browser', `当前页面: ${this.page.url()}`);
  }

  async fillEmail(email) {
    this.onLog('browser', '填写邮箱...');
    await this.page.waitForSelector('input[name="email"], input[type="email"], input[name="username"]', { timeout: 15000 });
    const emailInput = await this.page.$('input[name="email"], input[type="email"], input[name="username"]');
    if (!emailInput) throw new Error('找不到邮箱输入框');
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(email, { delay: 50 });
    this.onLog('browser', `邮箱已填写: ${email}`);

    await this.clickButton(['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("继续")']);
    await new Promise(r => setTimeout(r, 3000));

    const url = this.page.url();
    const title = await this.page.title().catch(() => '');
    this.onLog('browser', `邮箱提交后页面: ${url} | 标题: ${title}`);
  }

  async fillPassword(password) {
    this.onLog('browser', '填写密码...');
    await this.page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 10000 });
    const pwInput = await this.page.$('input[name="password"], input[type="password"]');
    if (!pwInput) throw new Error('找不到密码输入框');
    await pwInput.click({ clickCount: 3 });
    await pwInput.type(password, { delay: 50 });
    this.onLog('browser', '密码已填写');
    await this.clickButton(['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("继续")']);
    await new Promise(r => setTimeout(r, 3000));

    const url = this.page.url();
    const title = await this.page.title().catch(() => '');
    this.onLog('browser', `密码提交后页面: ${url} | 标题: ${title}`);
  }

  async waitForVerificationInput(timeout = 15000) {
    // 尝试多种选择器
    const selectors = [
      'input[name="code"]',
      'input[autocomplete="one-time-code"]',
      'input[type="number"]',
      'input[inputmode="numeric"]',
      'input[aria-label*="code" i]',
      'input[aria-label*="验证" i]',
      'input[id*="code" i]',
      'input[id*="otp" i]',
      'input[data-testid*="code" i]'
    ];
    for (const sel of selectors) {
      try {
        await this.page.waitForSelector(sel, { timeout: 3000 });
        this.onLog('browser', `找到验证码输入框: ${sel}`);
        return sel;
      } catch {}
    }
    // 最后手段：列出页面上所有 text content
    const inputs = await this.page.evaluate(() => {
      const inputInfo = Array.from(document.querySelectorAll('input')).map(el => ({
        name: el.name,
        type: el.type,
        id: el.id,
        autocomplete: el.autocomplete,
        placeholder: el.placeholder,
        ariaLabel: el.getAttribute('aria-label')
      }));
      // Also get all button/link text
      const clickables = Array.from(document.querySelectorAll('button, a, [role="button"], [tabindex]:not(input)')).map(el => ({
        tag: el.tagName,
        text: (el.innerText || '').substring(0, 80)
      })).filter(e => e.text.trim());
      return { inputs: inputInfo, clickables, bodyText: document.body.innerText.substring(0, 500) };
    });
    this.onLog('browser', `页面上的 input: ${JSON.stringify(inputs.inputs)}`);
    this.onLog('browser', `可点击元素: ${JSON.stringify(inputs.clickables)}`);
    this.onLog('browser', `页面文本: ${inputs.bodyText}`);
    return null;
  }

  async fillVerificationCode(code) {
    this.onLog('browser', '填写验证码...');
    const matched = await this.waitForVerificationInput();
    if (!matched) {
      await this.saveDebugScreenshot();
      throw new Error('找不到验证码输入框，已保存截图');
    }
    const codeInput = await this.page.$(matched);
    await codeInput.click({ clickCount: 3 });
    await codeInput.type(code, { delay: 80 });
    this.onLog('browser', `验证码已填写: ${code}`);
    await new Promise(r => setTimeout(r, 1000));
    await this.clickButton(['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Verify")', 'button:has-text("验证")']);

    // 等待页面跳转，不再只是固定等待
    await new Promise(r => setTimeout(r, 2000));
    const url = this.page.url();
    this.onLog('browser', `验证码提交后页面: ${url}`);

    // 如果停留在验证页面，检查是否有错误提示
    if (url.includes('email-verification') || url.includes('verification')) {
      const errText = await this.page.evaluate(() => {
        const errors = document.querySelectorAll('[role="alert"], .error, [class*="error"], [id*="error"]');
        const texts = [];
        errors.forEach(e => { const t = e.innerText?.trim(); if (t) texts.push(t); });
        return texts.join(' | ') || document.body.innerText.substring(0, 300);
      });
      this.onLog('browser', `页面提示: ${errText}`);
      if (errText.toLowerCase().includes('incorrect') || errText.includes('错误') || errText.includes('无效')) {
        throw new Error(`验证码无效: ${errText}`);
      }
      await new Promise(r => setTimeout(r, 5000));
      const newUrl = this.page.url();
      this.onLog('browser', `等待后页面: ${newUrl}`);
      if (newUrl.includes('email-verification') || newUrl.includes('verification')) {
        throw new Error('验证码提交后未能跳转，可能验证码已过期或无效');
      }
    }
  }

  async clickLoginToCodex() {
    this.onLog('browser', '尝试点击登录到 Codex...');
    await new Promise(r => setTimeout(r, 2000));
    const url = this.page.url();
    this.onLog('browser', `当前页面: ${url}`);
    try {
      await this.clickButton(['button:has-text("Codex")', 'button:has-text("Allow")', 'button:has-text("Continue")', 'button[type="submit"]']);
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      this.onLog('browser', `Codex 确认步骤: ${e.message}`);
    }
  }

  async clickButton(selectors) {
    for (const sel of selectors) {
      try {
        if (sel.includes(':has-text(')) {
          const match = sel.match(/:has-text\("(.+?)"\)/);
          if (match) {
            const text = match[1];
            const base = sel.replace(/:has-text\("(.+?)"\)/, '');
            const elements = await this.page.$$(base || 'button, a, [role="button"], span, div');
            for (const el of elements) {
              const inner = await this.page.evaluate(e => e.innerText, el).catch(() => '');
              if (inner.includes(text)) {
                await el.click();
                this.onLog('browser', `点击按钮: ${text}`);
                return;
              }
            }
          }
        } else {
          const btn = await this.page.$(sel);
          if (btn) {
            const text = await this.page.evaluate(e => e.innerText, btn).catch(() => sel);
            await btn.click();
            this.onLog('browser', `点击按钮: ${text || sel}`);
            return;
          }
        }
      } catch {}
    }
    this.onLog('browser', '未找到匹配按钮');
  }

  async waitForCallback(redirectPort, isAborted, timeout = 600000) {
    this.onLog('browser', `等待 localhost:${redirectPort} 回调...`);

    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (isAborted && isAborted()) {
        this.onLog('browser', '任务已取消，停止等待回调');
        return null;
      }
      // 先检查服务器端是否已收到回调
      if (this.callbackUrl) {
        this.onLog('browser', `捕获回调: ${this.callbackUrl}`);
        return this.callbackUrl;
      }
      // 再检查浏览器 URL
      const url = this.page.url();
      if (url.includes(`localhost:${redirectPort}`) && url.includes('/auth/callback')) {
        this.onLog('browser', `浏览器捕获回调: ${url}`);
        return url;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('等待 OAuth 回调超时');
  }

  async getPageUrl() {
    return this.page ? this.page.url() : '';
  }

  async saveDebugScreenshot() {
    if (!this.page) return;
    try {
      const dir = path.join(process.cwd(), 'debug');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `screenshot_${Date.now()}.png`);
      await this.page.screenshot({ path: file, fullPage: true });
      this.onLog('browser', `调试截图已保存: ${file}`);
    } catch (e) {
      this.onLog('browser', `截图失败: ${e.message}`);
    }
  }

  async takeScreenshot() {
    if (!this.page) return null;
    try {
      return await this.page.screenshot({ encoding: 'base64' });
    } catch {
      return null;
    }
  }

  async startCallbackServer(port) {
    if (this.callbackServer) return;
    this.callbackUrl = null;
    return new Promise((resolve, reject) => {
      this.callbackServer = http.createServer((req, res) => {
        const fullUrl = `http://localhost:${port}${req.url}`;
        if (req.url.includes('/auth/callback')) {
          this.onLog('browser', `回调服务器收到请求: ${fullUrl}`);
          this.callbackUrl = fullUrl;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authorization Complete</h1><p>You can close this window.</p></body></html>');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      this.callbackServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this.onLog('browser', `端口 ${port} 已被占用，尝试复用`);
          resolve(); // 端口已被占用，可能之前没清理干净
        } else {
          reject(err);
        }
      });
      this.callbackServer.listen(port, '127.0.0.1', () => {
        this.onLog('browser', `OAuth 回调服务器已启动: localhost:${port}`);
        resolve();
      });
    });
  }

  stopCallbackServer() {
    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
    }
    this.callbackUrl = null;
  }

  async disconnect() {
    this.stopCallbackServer();
    if (this.browser) {
      try {
        await this.browser.close();
        this.onLog('browser', '浏览器已关闭');
      } catch {}
      this.browser = null;
      this.page = null;
    }
  }
}

module.exports = { BrowserService };
