const axios = require('axios');
const crypto = require('crypto');

class OAuthService {
  constructor(config, onLog) {
    this.config = config;
    this.onLog = onLog || (() => {});
    this.clientId = config.oauthClientId;
    this.redirectPort = config.oauthRedirectPort;
    this.redirectUri = `http://localhost:${this.redirectPort}/auth/callback`;
    this.proxy = config.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
    this.codeVerifier = null;
    this.codeChallenge = null;
    this.state = null;
    this.regeneratePKCE();
  }

  generateCodeVerifier() { return crypto.randomBytes(32).toString('base64url'); }
  generateCodeChallenge(verifier) { return crypto.createHash('sha256').update(verifier).digest('base64url'); }

  regeneratePKCE() {
    this.codeVerifier = this.generateCodeVerifier();
    this.codeChallenge = this.generateCodeChallenge(this.codeVerifier);
    this.state = crypto.randomBytes(16).toString('hex');
    this.onLog('oauth', 'PKCE 参数已生成');
  }

  getAuthUrl() {
    const params = new URLSearchParams({
      client_id: this.clientId,
      code_challenge: this.codeChallenge,
      code_challenge_method: 'S256',
      codex_cli_simplified_flow: 'true',
      id_token_add_organizations: 'true',
      prompt: 'login',
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile offline_access',
      state: this.state
    });
    return `https://auth.openai.com/oauth/authorize?${params.toString()}`;
  }

  extractCallbackParams(callbackUrl) {
    try {
      const url = new URL(callbackUrl);
      const params = {
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
        error_description: url.searchParams.get('error_description')
      };
      if (params.state && params.state !== this.state) {
        this.onLog('oauth', `State 不匹配: ${params.state}`);
        return null;
      }
      return params;
    } catch (e) {
      this.onLog('oauth', `解析回调 URL 失败: ${e.message}`);
      return null;
    }
  }

  async exchangeToken(code, email) {
    this.onLog('oauth', '开始用 code 换取 Token');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: this.codeVerifier
    }).toString();
    const axiosOpts = {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    };
    if (this.proxy) {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      axiosOpts.httpsAgent = new HttpsProxyAgent(this.proxy);
      this.onLog('oauth', `使用代理: ${this.proxy.replace(/\/\/.*@/, '//***@')}`);
    }
    const response = await axios.post('https://auth.openai.com/oauth/token', body, axiosOpts);
    const tokens = response.data;
    let accountId = '';
    try {
      const payloadStr = Buffer.from(tokens.access_token.split('.')[1], 'base64').toString('utf8');
      const payload = JSON.parse(payloadStr);
      const apiAuth = payload['https://api.openai.com/auth'] || {};
      accountId = apiAuth.chatgpt_account_id || '';
    } catch (e) {
      this.onLog('oauth', `解析 account_id 失败: ${e.message}`);
    }
    const now = new Date();
    const expiredTime = new Date(now.getTime() + tokens.expires_in * 1000);
    const fmt = (d) => d.toISOString().replace(/\.[0-9]{3}Z$/, '+08:00');
    return {
      access_token: tokens.access_token,
      account_id: accountId,
      disabled: false,
      email,
      expired: fmt(expiredTime),
      id_token: tokens.id_token,
      last_refresh: fmt(now),
      refresh_token: tokens.refresh_token,
      type: 'codex'
    };
  }
}

module.exports = { OAuthService };
