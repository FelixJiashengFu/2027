# DeepSeek 用量看板（iPad PWA）

一个纯静态的小网页，装到 iPad 主屏幕后像 App 一样打开，用来随手看 DeepSeek 账户的余额和消耗趋势。
没有后端、没有构建步骤、没有第三方脚本，整个目录扔到任何 HTTPS 静态托管上就能用。

## 它能看什么，看不了什么

| | |
|---|---|
| ✅ 能 | 总余额 / 充值余额 / 赠送余额、是否可用、**估算的**今日·7 日·30 日消耗、预计还能用几天、每日消耗柱状图、余额走势 |
| ❌ 不能 | 官方 [usage 页](https://platform.deepseek.com/usage) 里按模型、按 token 的明细 |

**为什么不能？** DeepSeek 公开文档里的接口只有 `GET /user/balance`，只返回"现在还剩多少钱"。
usage 页用的是登录态下的内部接口：没有文档、随时可能改。把整个网页嵌进 PWA 也走不通：Safari 对第三方 iframe 的 Cookie / 存储有限制，登录态大概率保不住（我没能在开发环境里验证它是否还禁止 iframe，但前一条就够了）。
所以页脚留了一个直达官方用量页的链接，明细还是点过去看。

**"消耗"是怎么来的？** 本应用每次刷新都会在本机存一个余额快照，相邻两次快照之间总余额的减少量记为消耗：

- 记在**刷新发生的那天**（凌晨刷新一次，夜里的消耗就记到新的一天）。
- 余额**上升**（充值）不算消耗，也不会抵扣。所以两次刷新之间"又充值又花钱"会被**低估**。
- 赠送余额到期作废，余额同样会下降，会被**误算**成消耗。
- **只有打开本应用时才采样**（iOS 不允许 PWA 后台定时跑）。长时间不开，那段时间的消耗会合并记到你下次打开的那天。
- 只有一个快照时显示"—"，而不是 0：没数据和没花钱是两回事。

## 部署（GitHub Pages 为例）

1. 仓库 **Settings → Pages → Build and deploy → Deploy from a branch**，选这个分支和 `/ (root)`。
2. 等一两分钟，访问 `https://<用户名>.github.io/<仓库名>/deepseek-usage/`。

用 Cloudflare Pages / Netlify / Vercel 也行，只要是 HTTPS（Service Worker 和"添加到主屏幕"都要求）。
所有路径都是相对路径，放在子目录下没问题。

## 装到 iPad

1. 用 **Safari** 打开上面的网址 → 点分享按钮 → **添加到主屏幕**。
2. 以后从主屏幕图标打开（独立窗口，没有地址栏）。
3. 首次打开点"填写 API Key"。

> ⚠️ 主屏幕里的 App 和 Safari 标签页的存储是**两份独立的**。Key 要填在主屏幕里的那个 App 里，别在 Safari 里填了半天又纳闷为什么 App 里是空的。

## 安全

- Key 存在这台设备浏览器的 `localStorage` 里，只会发给"设置"里的接口地址（默认 `api.deepseek.com`）。
- 页面没有任何第三方脚本；`index.html` 里的 CSP 禁止加载外部脚本和样式。
- 余额接口用的是普通 API Key，请**当作能花钱的密钥对待**：到 [API Keys](https://platform.deepseek.com/api_keys) 单独新建一个只给本应用用的，iPad 丢了就直接删掉它。
- Service Worker 只缓存本应用自己的静态文件，**不拦截、不缓存**对 DeepSeek 的请求。

## 直连报 CORS 错误怎么办

浏览器直接调用 `api.deepseek.com` 需要对方返回 CORS 头。**我开发时的沙箱访问不了 DeepSeek，没法验证它是否允许**，所以做了兜底：

- 如果刷新时横幅提示"……可能是接口不允许浏览器跨域（CORS）"，就用 [`worker/cors-proxy.js`](worker/cors-proxy.js) 自己部署一个 Cloudflare Worker 转发（免费额度足够，文件头部有步骤）。
- 然后在看板 **设置 → 接口地址** 里填 Worker 的网址。
- Worker 只放行 `GET /user/balance`，不存 Key，不记日志。

如果直连本来就能用，这一节可以当没看见。

## 本地开发

```sh
cd deepseek-usage
python3 -m http.server 8000     # 然后访问 http://localhost:8000 （localhost 允许 Service Worker）
```

改了静态文件清单（增删文件）时，把 `sw.js` 里的 `CACHE` 版本号 +1。
改了文件内容但没改清单，不用动：Service Worker 是"先给缓存、后台更新"，下次打开就是新版。
