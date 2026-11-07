// 可选：极简 CORS 代理（Cloudflare Workers）。
// 只有当 iPad 上直连 api.deepseek.com 报跨域（CORS）错误时才需要它。
//
// 它只做一件事：把浏览器发来的 GET /user/balance 原样转给 DeepSeek，再补上 CORS 头。
// - 不保存任何东西：API Key 由浏览器每次随请求带来，Worker 不存、不记录。
// - 只放行 /user/balance，其他路径一律 404，所以它没法被拿来调用别的接口。
//
// 部署：Cloudflare 控制台 → Workers & Pages → Create → Hello World → 把本文件内容粘进去 → Deploy。
// 然后把 ALLOWED_ORIGINS 改成你的看板网址（只写到域名，不带路径），
// 并在看板「设置 → 接口地址」里填 Worker 的网址，例如 https://ds-balance.<你的子域>.workers.dev

const UPSTREAM = 'https://api.deepseek.com';
const ALLOWED_ORIGINS = ['https://felixjiashengfu.github.io'];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Headers': 'Authorization, Accept',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const { pathname } = new URL(request.url);
    if (request.method !== 'GET' || pathname !== '/user/balance') {
      return new Response('Not found', { status: 404, headers: cors });
    }

    const upstream = await fetch(`${UPSTREAM}/user/balance`, {
      headers: { Authorization: request.headers.get('Authorization') || '', Accept: 'application/json' },
    });
    const headers = new Headers(cors);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    headers.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
