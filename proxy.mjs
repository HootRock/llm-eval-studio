/* ============================================================================
   本地代理：解决浏览器直连大模型 API 的 CORS 限制。
   零依赖，仅用 Node 内置模块。

     node proxy.mjs                 # 默认 8788
     node proxy.mjs --port 9000

   页面里的 API 地址填 http://localhost:8788/v1/chat/completions 即可。
   真实的上游地址与密钥由本进程转发，不写进网页。

   安全说明：本进程会把请求原样转发到你指定的上游，
   并回显上游响应。请只在本机运行，不要把端口暴露到公网。
   ============================================================================ */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const argv = process.argv.slice(2);
function argOf(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const PORT = Number(argOf('--port', 8788));

// 允许转发的上游主机白名单。留空表示不限制（本机使用）。
// 如需收紧，填入形如 ['api.deepseek.com', 'dashscope.aliyuncs.com']
const ALLOW_HOSTS = [];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Upstream-URL');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(res, code, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url.startsWith('/health')) {
    send(res, 200, { ok: true, service: 'llm-eval-proxy', port: PORT });
    return;
  }

  if (req.method !== 'POST') { send(res, 405, { error: '只接受 POST' }); return; }

  // 上游地址：优先取请求头，其次取路径同名参数
  const upstream = req.headers['x-upstream-url'];
  if (!upstream) {
    send(res, 400, {
      error: '缺少 X-Upstream-URL 请求头',
      hint: '页面上填 http://localhost:' + PORT + '/v1/chat/completions，' +
            '并在「上游地址」里填真实 API 地址'
    });
    return;
  }

  let target;
  try { target = new URL(upstream); }
  catch { send(res, 400, { error: '上游地址无法解析：' + upstream }); return; }

  if (ALLOW_HOSTS.length && !ALLOW_HOSTS.includes(target.hostname)) {
    send(res, 403, { error: '主机不在白名单：' + target.hostname });
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const mod = target.protocol === 'https:' ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    // 只透传鉴权头；X-Upstream-URL 是本代理自用，不转发
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;

    const up = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'POST',
        headers,
        timeout: 120000
      },
      (upRes) => {
        const parts = [];
        upRes.on('data', (c) => parts.push(c));
        upRes.on('end', () => {
          const payload = Buffer.concat(parts);
          res.writeHead(upRes.statusCode || 502, {
            'Content-Type': upRes.headers['content-type'] || 'application/json'
          });
          res.end(payload);
        });
      }
    );

    up.on('timeout', () => { up.destroy(new Error('上游超时')); });
    up.on('error', (e) => send(res, 502, { error: '上游请求失败：' + e.message }));
    up.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('评测代理已启动: http://localhost:' + PORT);
  console.log('  健康检查 : GET  http://localhost:' + PORT + '/health');
  console.log('  转发端点 : POST http://localhost:' + PORT + '/v1/chat/completions');
  console.log('  上游地址 : 由 X-Upstream-URL 请求头指定');
  console.log('');
  console.log('  页面上 API 地址填 http://localhost:' + PORT + '/v1/chat/completions');
  console.log('  按 Ctrl+C 停止');
});
