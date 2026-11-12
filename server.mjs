/* ============================================================================
   评测平台服务端。零依赖，只用 Node 内置模块。

   职责：
     1. 托管静态页面（与 API 同源 —— 于是完全没有 CORS 问题）
     2. 转发模型请求。API 密钥只存在于服务端环境变量，
        浏览器永远拿不到，也永远不需要填。

   启动：
     LLM_API_KEY=sk-xxx LLM_BASE_URL=https://api.deepseek.com/v1/chat/completions \
     LLM_MODELS=deepseek-chat node server.mjs

   完整配置见文件末尾的 CONFIG 说明，或 README。

   安全设计（公网可访问的前提）：
     · 密钥仅从环境变量读取，不写进代码、不返回给客户端、不出现在错误信息里
     · 客户端传什么鉴权头都会被丢弃，密钥一律由服务端注入
     · 模型名必须命中白名单，防止用你的额度调用高价模型
     · 请求体大小、max_tokens、并发、超时都有上限，控制费用
     · 按 IP 限流 + 全局每日总量上限，防止被刷
     · 静态文件做了路径穿越防护
   ============================================================================ */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------------------
   配置：全部来自环境变量，代码里不放任何密钥
   --------------------------------------------------------------------------- */
const CFG = {
  port: Number(process.env.PORT || 8788),
  host: process.env.HOST || '0.0.0.0',

  // 上游接口。支持任意 OpenAI 兼容的 /chat/completions
  baseUrl: process.env.LLM_BASE_URL || '',
  apiKey: process.env.LLM_API_KEY || '',

  // 允许前端选择的模型，逗号分隔；第一个为默认
  models: (process.env.LLM_MODELS || '').split(',').map(s => s.trim()).filter(Boolean),

  // 费用与稳定性上限
  maxTokens: Number(process.env.MAX_TOKENS || 512),
  maxBodyKB: Number(process.env.MAX_BODY_KB || 128),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 60000),

  // 限流：每个 IP 在窗口内允许的请求数
  ratePerIp: Number(process.env.RATE_PER_IP || 60),
  rateWindowMs: Number(process.env.RATE_WINDOW_MS || 300000),

  // 全局每日请求上限（跨所有访客），到顶后拒绝并提示稍后再试
  dailyCap: Number(process.env.DAILY_CAP || 3000),

  // 静态目录
  root: process.env.STATIC_ROOT || HERE,

  // 允许的前端来源，逗号分隔；留空表示不限（同源部署时无妨）
  allowOrigins: (process.env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
};

/* 启动自检：缺关键配置就直接拒绝启动，避免线上才发现 */
function preflight() {
  const problems = [];
  if (!CFG.apiKey) problems.push('缺少 LLM_API_KEY（模型密钥）');
  if (!CFG.baseUrl) problems.push('缺少 LLM_BASE_URL（上游接口地址）');
  if (!CFG.models.length) problems.push('缺少 LLM_MODELS（允许的模型名，逗号分隔）');
  if (CFG.baseUrl && !/^https?:\/\//.test(CFG.baseUrl)) {
    problems.push('LLM_BASE_URL 必须以 http:// 或 https:// 开头');
  }
  return problems;
}

/* ---------------------------------------------------------------------------
   限流与配额。内存实现，够单实例用。
   多实例部署时应换成 Redis 之类的共享存储。
   --------------------------------------------------------------------------- */
const ipHits = new Map();          // ip -> [timestamp, ...]
let dayKey = todayKey();
let dayCount = 0;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function clientIp(req) {
  // 反向代理后取 X-Forwarded-For 的第一段；直连时用 socket 地址
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function takeToken(req) {
  const today = todayKey();
  if (today !== dayKey) { dayKey = today; dayCount = 0; }

  if (dayCount >= CFG.dailyCap) {
    return { ok: false, code: 429, msg: '今日评测额度已用完，请稍后再试。' };
  }

  const ip = clientIp(req);
  const now = Date.now();
  let hits = ipHits.get(ip) || [];
  hits = hits.filter(t => now - t < CFG.rateWindowMs);
  if (hits.length >= CFG.ratePerIp) {
    const wait = Math.ceil((CFG.rateWindowMs - (now - hits[0])) / 1000);
    ipHits.set(ip, hits);
    return { ok: false, code: 429, msg: `请求过于频繁，请 ${wait} 秒后重试。` };
  }
  hits.push(now);
  ipHits.set(ip, hits);
  dayCount++;
  return { ok: true };
}

// 定期清理，避免 Map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of ipHits) {
    const alive = hits.filter(t => now - t < CFG.rateWindowMs);
    if (alive.length) ipHits.set(ip, alive); else ipHits.delete(ip);
  }
}, 60000).unref();

/* ---------------------------------------------------------------------------
   响应工具
   --------------------------------------------------------------------------- */
function corsFor(req) {
  const origin = req.headers.origin || '';
  if (!CFG.allowOrigins.length) {
    // 同源部署不需要 CORS 头；带上也无害
    return origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};
  }
  if (CFG.allowOrigins.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
  }
  return {};
}

function sendJSON(req, res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, corsFor(req), extra || {}));
  res.end(body);
}

/* 错误信息脱敏：绝不把密钥或上游原文直接抛给客户端 */
function safeMessage(e, status) {
  if (status === 401 || status === 403) return '服务端模型凭证无效或权限不足，请联系管理员。';
  if (status === 429) return '上游接口限流，请稍后重试。';
  if (status && status >= 500) return '上游接口暂时不可用，请稍后重试。';
  if (e && e.code === 'TIMEOUT') return '上游响应超时，请稍后重试。';
  if (e && e.code === 'ENOTFOUND') return '无法解析上游地址，请联系管理员检查配置。';
  return '评测请求失败，请稍后重试。';
}

/* ---------------------------------------------------------------------------
   /api/config —— 只返回非敏感信息：可用模型、上限
   --------------------------------------------------------------------------- */
function handleConfig(req, res) {
  const configured = Boolean(CFG.apiKey && CFG.baseUrl && CFG.models.length);
  sendJSON(req, res, 200, {
    configured: configured,
    models: CFG.models,
    limits: {
      maxTokens: CFG.maxTokens,
      ratePerIp: CFG.ratePerIp,
      rateWindowSec: Math.round(CFG.rateWindowMs / 1000)
    }
  });
}

/* ---------------------------------------------------------------------------
   /api/chat —— 用服务端密钥转发一次对话
   只接受白名单内的字段；客户端传来的任何鉴权信息一律丢弃。
   --------------------------------------------------------------------------- */
function handleChat(req, res) {
  if (!CFG.apiKey || !CFG.baseUrl) {
    return sendJSON(req, res, 503, {
      error: '服务端未配置模型接口，在线评测暂不可用。可先使用「预览结果」。'
    });
  }

  let raw = '';
  const limit = CFG.maxBodyKB * 1024;
  let tooBig = false;

  req.on('data', chunk => {
    if (tooBig) return;
    raw += chunk;
    if (raw.length > limit) {
      tooBig = true;
      sendJSON(req, res, 413, { error: '请求体过大。' });
      req.destroy();
    }
  });

  req.on('end', () => {
    if (tooBig) return;

    let body;
    try { body = JSON.parse(raw || '{}'); }
    catch { return sendJSON(req, res, 400, { error: '请求体不是合法 JSON。' }); }

    // 入参校验：只取我们认识的字段
    const model = String(body.model || '');
    if (!CFG.models.includes(model)) {
      return sendJSON(req, res, 400, {
        error: '该模型不在允许列表内。',
        models: CFG.models
      });
    }

    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > 32) {
      return sendJSON(req, res, 400, { error: 'messages 字段不合法。' });
    }

    // 限流放在校验之后、真正转发之前
    const gate = takeToken(req);
    if (!gate.ok) return sendJSON(req, res, gate.code, { error: gate.msg });

    // 组装上游请求。密钥在这里注入 —— 这是唯一出现密钥的地方。
    const payload = {
      model: model,
      messages: messages,
      temperature: Math.max(0, Math.min(2, Number(body.temperature) || 0)),
      max_tokens: CFG.maxTokens,
      stream: false
    };
    if (Array.isArray(body.tools) && body.tools.length) {
      payload.tools = body.tools.slice(0, 12);
      payload.tool_choice = 'auto';
    }

    let target;
    try { target = new URL(CFG.baseUrl); }
    catch { return sendJSON(req, res, 500, { error: '服务端上游地址配置有误。' }); }

    const mod = target.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(payload));
    const started = Date.now();

    const up = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        Authorization: 'Bearer ' + CFG.apiKey   // ← 服务端注入
      },
      timeout: CFG.requestTimeoutMs
    }, upRes => {
      const parts = [];
      upRes.on('data', c => parts.push(c));
      upRes.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        const status = upRes.statusCode || 502;

        if (status < 200 || status >= 300) {
          // 上游错误：只回传脱敏后的说明，不回传上游原文（可能含敏感信息）
          console.error('[upstream %d] %s', status, text.slice(0, 300));
          return sendJSON(req, res, status, { error: safeMessage(null, status) });
        }

        let json;
        try { json = JSON.parse(text); }
        catch {
          return sendJSON(req, res, 502, { error: '上游返回了非 JSON 内容。' });
        }

        // 原样回传 choices，前端逻辑无需改动
        sendJSON(req, res, 200, {
          choices: json.choices || [],
          usage: json.usage || null,
          elapsedMs: Date.now() - started
        });
      });
    });

    up.on('timeout', () => {
      up.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
    });
    up.on('error', err => {
      console.error('[upstream error]', err.code || err.message);
      sendJSON(req, res, 502, { error: safeMessage(err) });
    });
    up.end(data);
  });
}

/* ---------------------------------------------------------------------------
   静态文件。含路径穿越防护。
   --------------------------------------------------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

// 不允许通过静态服务访问的文件
const DENY = new Set(['server.mjs', 'proxy.mjs']);

function handleStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 归一化后必须仍在 root 内，挡住 ../ 穿越
  const resolved = path.resolve(CFG.root, '.' + rel);
  if (!resolved.startsWith(CFG.root)) {
    return sendJSON(req, res, 403, { error: '禁止访问。' });
  }

  const base = path.basename(resolved);
  if (DENY.has(base) || base.startsWith('.')) {
    return sendJSON(req, res, 404, { error: '未找到。' });
  }

  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) {
      return sendJSON(req, res, 404, { error: '未找到。' });
    }
    const ext = path.extname(resolved).toLowerCase();
    const headers = Object.assign({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size
    }, corsFor(req));

    // HTML 不缓存，改版后访客立即拿到新版
    headers['Cache-Control'] = ext === '.html'
      ? 'no-cache'
      : 'public, max-age=3600';

    res.writeHead(200, headers);
    fs.createReadStream(resolved).pipe(res);
  });
}

/* ---------------------------------------------------------------------------
   路由
   --------------------------------------------------------------------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, Object.assign({
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }, corsFor(req)));
    return res.end();
  }

  if (pathname === '/api/config' && req.method === 'GET') return handleConfig(req, res);
  if (pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);
  if (pathname.startsWith('/api/')) return sendJSON(req, res, 404, { error: '未知接口。' });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJSON(req, res, 405, { error: '方法不允许。' });
  }
  handleStatic(req, res, pathname);
});

const problems = preflight();
server.listen(CFG.port, CFG.host, () => {
  const shown = CFG.host === '0.0.0.0' ? 'localhost' : CFG.host;
  console.log('评测平台已启动: http://%s:%d', shown, CFG.port);
  console.log('');
  if (problems.length) {
    console.log('⚠ 在线评测不可用，缺少配置：');
    problems.forEach(p => console.log('   · ' + p));
    console.log('   （预览结果页仍可正常访问）');
  } else {
    console.log('在线评测：已启用');
    console.log('  模型    : %s', CFG.models.join(', '));
    console.log('  上限    : max_tokens=%d · 每 IP %d 次 / %d 秒 · 每日 %d 次',
      CFG.maxTokens, CFG.ratePerIp, Math.round(CFG.rateWindowMs / 1000), CFG.dailyCap);
    // 只显示密钥长度与尾四位，便于确认加载了哪把钥匙，不足以泄露
    console.log('  密钥    : 已加载（%d 字符，尾号 …%s）',
      CFG.apiKey.length, CFG.apiKey.slice(-4));
  }
  console.log('');
  console.log('按 Ctrl+C 停止');
});
