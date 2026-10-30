# Preferred Sub Generator

[![CI](https://github.com/LeilaoMi/preferred-sub-generator/actions/workflows/ci.yml/badge.svg)](https://github.com/LeilaoMi/preferred-sub-generator/actions/workflows/ci.yml)

给 cmliu 版 [edgetunnel](https://github.com/cmliu/edgetunnel) 用的**国内实测**优选 IP 订阅器。部署在 Cloudflare Pages，靠 GitHub Actions 定时跑，日常维护在手机上就能做完。

它只做一件事：**用中国大陆电信、联通、移动三张网真实测过，挑出连得上你节点的 Cloudflare IP，按固定顺序交给 edgetunnel。** UUID、域名、路径这些节点参数由 edgetunnel 自己保管，本项目不需要，也拿不到。

## 一图看懂

```text
GitHub Actions（定时）
 ├─ Update        每 6 小时：汇总 CF 官方段 + 社区源，官方段先在美国初筛 → 候选池（KV）
 ├─ China Probe   每 2 小时：Globalping 国内三网探针实测候选池，并入手机实测 → 实测记录 + 国内已验证快照
 └─ Host Check    每 6 小时：三网体检你的域名，前几名 IP × 域名组合测（识别 1034 / 重置 / 落地机房）
                         │
手机 cf-termux-pick ─────┘（可选：你自己线路上的实测，回传进 China Probe）

Cloudflare Pages ── /sub ──> edgetunnel（sub://你的域名）──> 客户端
                   按运营商排序，永远 200，出错用快照兜底
```

## 和普通优选器的区别

| | 普通优选器 | 本项目 |
|---|---|---|
| 在哪测 | 美国服务器 / 浏览器 | [Globalping](https://globalping.io) 的**国内三网探针**，外加你手机的实测 |
| 测什么 | TCP 延迟 | TCP 延迟 + **IP × 你的域名组合测**，并记录国内实际落地机房 |
| 分运营商 | 否 | 电信、联通、移动各一份排名，各一个订阅地址 |
| 顺序 | 每次随机 | 固定顺序，带抗抖动 |
| 实测失败时 | 返回空或随机 | 用最后一次国内验证通过的名单兜底 |
| 域名被墙 | 不知道 | 定时三网体检，`/status` 可看 |

## 快速开始（Fork 即用）

1. **Fork** 本仓库，打开 fork 的 **Actions** 页，点「I understand my workflows, go ahead and enable them」。
2. **Settings → Secrets and variables → Actions → Secrets** 新建：
   - `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 控制台右侧栏的账户 ID
   - `CLOUDFLARE_API_TOKEN`：「我的个人资料 → API 令牌」创建，权限勾 **Cloudflare Pages：编辑**、**Workers KV 存储：编辑**（D1 可选）
   - `GLOBALPING_TOKEN`（强烈建议）：[globalping.io](https://globalping.io) 免费注册，国内实测额度高很多
3. Actions 页依次手动运行：**Deploy to Cloudflare Pages** → **Update Preferred Subscription** → **China Probe (Globalping)**。

KV、D1、Pages 项目都会自动查找或创建，不用改文件。部署地址形如 `https://preferred-sub-generator-xxx.pages.dev`，在 Cloudflare Pages 项目页里能看到。

## 接到 edgetunnel

在 edgetunnel 面板的**自定义优选订阅**里填：

```text
sub://你的部署域名
```

**分运营商订阅**：给 Pages 项目再绑三个自定义域名 `ct.你的域名`、`cu.你的域名`、`cm.你的域名`（也认 `dx/lt/yd`），edgetunnel 里填 `sub://cu.你的域名` 这样，就按联通的国内实测排序。edgetunnel 会丢掉 `?` 参数但保留子域名，所以这是 `sub://` 里唯一能选运营商的办法。不绑子域名时，用 `SUB_DEFAULT_ISP` 指定默认运营商。

容易踩的坑：

- edgetunnel 面板的**「随机 IP」开关要关掉**。它默认开着，开着时完全不读你填的优选订阅。
- `sub://` 后面不要加任何 `?` 参数（包括 `?proxyip=true`）。面板的「验证优选 API」可以预览返回的 IP。
- 客户端请用**「自动选择 / url-test」组**，不要固定单个节点。国内到 Cloudflare 的单个 IP 时好时坏是常态，5G 上更明显。

edgetunnel 拉取时，本项目返回 30 个 IP，节点参数是占位值（全 0 UUID、`example.com`），edgetunnel 会换成自己的。请求永远返回 200 并缓存 5 分钟，因为 edgetunnel 遇到非 200 会塞一个 `127.0.0.1` 的假节点。

## vvHan 独立优选来源

`https://你的部署域名/vvhan.txt` 直接读取 cf.vvhan.com 当前使用的原始接口，将电信、联通、移动 IPv4 去重并转换成 `IP:443#vvHan-CT-延迟ms` 格式。延迟来自 vvHan，不能代表你自己的线路。响应和上游请求缓存 5 分钟，最后一次有效结果保存在现有 `SUB_KV` 中，上游异常时自动回退；无有效历史结果时返回 503。

在 EdgeTunnel 的自定义优选列表中，与 `sub://你的部署域名` 分两行并列添加 `https://你的部署域名/vvhan.txt`，继续关闭随机 IP。此入口独立输出 vvHan 三网 IPv4，不受现有候选池的初筛和排名限制。

## 节点名怎么读

节点名里的机房**只来自国内的实测**（Globalping 国内探针的组合测，或手机实测），不会用美国初筛看到的机房，因为同一个 IP 从美国和从国内连，落地机房往往不一样。

| 节点名示例 | 意思 |
|---|---|
| `🇯🇵 日本东京 NRT 95ms 实测 #1` | 国内实测落地在东京，延迟 95ms |
| `🇨🇳 联通 119ms 实测 #2` | 联通网实测通过，但没拿到落地机房，不猜地点 |
| `🌐 未实测 #3` | 这个 IP 没有带延迟的国内实测（手动置顶或兜底名单里的） |
| `[IPv6] 🇭🇰 香港 HKG 60ms 实测 #4` | IPv6 节点 |

Clash 的地区分组也按同一规则归类。

## 配置

全部是 **Actions → Variables**（不是 Secrets），手机浏览器就能填。不填也能跑，填了更准。

| 变量 | 作用 | 示例 |
|---|---|---|
| `SUB_DEFAULT_ISP` | 订阅默认按哪个运营商的实测排序 | `CU`（联通）、`CT`（电信）、`CM`（移动） |
| `CHECK_HOSTS` | 你 edgetunnel 实际用的域名，逗号分隔。开启域名体检和 IP × 域名组合测 | `1.a.com,2.a.com` |
| `VLESS_HOST` | 美国初筛时用的域名，填你的主节点域名 | `1.a.com` |

改不了设置页时，也可以直接编辑 [`config/instance.json`](config/instance.json)：只有键名等于仓库全名（如 `你的用户名/preferred-sub-generator`）时才生效，并会覆盖同名变量；别人 Fork 你的仓库时不会继承。

<details>
<summary>其他可选变量</summary>

| 名称 | 类型 | 作用 |
|---|---|---|
| `GLOBALPING_TOKEN` | Secret | 提高 Globalping 额度 |
| `CN_PROBE_BUDGET` | Variable | 每轮国内实测的 IP 数，有 token 默认 150，没有默认 60 |
| `CN_COMBO_TOP` | Variable | 每轮组合测的 IP 数，默认 10 |
| `SUB_ROTATE_HOSTS` | Variable | `1`：直接订阅时，节点域名轮换为该运营商未被墙的 `CHECK_HOSTS`（这些域名须绑在同一个 edgetunnel 上；对 `sub://` 无效） |
| `ALLOW_RELAY` | Variable | 默认放行社区反代 IP；`0` 只用 Cloudflare 官方 IPv4 |
| `EDGE_BLACKLIST` | Variable | 额外拉黑的网段，逗号分隔 CIDR |
| `PUBLIC_CN_VERIFIED` | Variable | `1`：公开 `/cn-verified`，只含 IP、端口、延迟、成功率、机房 |
| `COMMUNITY_POOL_URL` | Variable | 用别人公开的 `/cn-verified` 做冷启动，永远排在自己数据之后 |
| `PHONE_RESULTS_URL` | Variable | 手机实测结果的地址，默认 `https://raw.githubusercontent.com/你的用户名/cf-termux-pick/main/best-ips.json`，仓库不存在就自动跳过 |
| `TG_BOT_TOKEN` + `TG_CHAT_ID` / `BARK_URL` / `UPDATE_WEBHOOK_URL` | Secret | 可选告警：域名被墙、某网可用节点不足、恢复时推送，同样内容 24 小时只推一次 |

</details>

## 排序规则

1. 只采信最近 3 天的国内实测（`SUB_VERIFIED_DAYS`），24 小时半衰期，北京时间 20–23 点晚高峰的实测权重 ×1.5。
2. 手机 [cf-termux-pick](https://github.com/LeilaoMi/cf-termux-pick) 回传的实测也算：WiFi（自家宽带）×1.5，5G/4G ×1.2；出口不在国内（开着 VPN）跑出来的不收。
3. 延迟按 20ms 分档，失败率加罚；落地在香港、台湾、日本、新加坡、美西加分，绕到欧洲、美东加罚 80ms。
4. 最近一次成功实测越旧越靠后（每 12 小时加罚 10ms，最多 60ms）；快照里超过 7 天没更新的名单不再用来兜底。
5. 国内实测通过的排前面，然后是 `sources/edge/manual.txt` 里的手动置顶，不足 10 个再用过审池补齐。
6. TLS 订阅只保留 TLS 端口（443、8443、2053、2083、2087、2096）。

定时任务的时间（北京时间，GitHub 经常推迟几十分钟到几小时）：Update 约 2:00 / 8:00 / 14:00 / 20:00，China Probe 每 2 小时的半点，Host Check 3:50 / 9:50 / 15:50 / 21:50。CI 每次提交跑全部测试。

## 手机实测

Globalping 的国内探针多在家宽或机房，不等于你的手机网络。想让订阅贴合你自己的线路，用 [cf-termux-pick](https://github.com/LeilaoMi/cf-termux-pick) 在 Termux 里跑，结果推到它的仓库，本项目每轮 China Probe 自动拉取（地址见 `PHONE_RESULTS_URL`，仓库不存在就跳过）。

另一种是本仓库自带的 `scripts/termux-probe.sh`，直接回传到你的部署（需要 D1 和管理 token），见 [docs/termux.md](docs/termux.md)。

## 看状态

打开 `https://你的部署域名/status`：

- `cnProbe`：最近一轮国内实测的时间、测了多少、成功多少，三网各有多少已验证节点。
- `cnHosts`：每个域名在电信、联通、移动下是 `ok`、`unstable` 还是 `blocked`。匿名访问时域名打码，带只读 token 显示全名。

某个运营商显示 `blocked`，说明这个域名在这张网上被封了（通常是 SNI 层面），**换 IP 没用，只能换域名**。

## 安全

- `/sub` 默认公开，但**匿名请求只能用 URL 里自带的节点参数**；服务端模板（`VLESS_*` 环境变量或 KV 里的 `TEMPLATE`）只对带只读 token（`?t=` 或 `Authorization: Bearer`）的请求生效，不会把 UUID 泄露给陌生人。想彻底关掉匿名访问，设 Pages 环境变量 `SUB_PUBLIC=0`。
- 网页设置管理 token（`/setup.html`）需要先在 Cloudflare Pages 环境变量里设 `SETUP_CODE`（至少 8 位）并重新部署，设置时填这个码，防止别人抢先设置。直接配 `SUB_TOKEN` 环境变量的不受影响。
- `/status` 对匿名访问只显示 `1***.example.com` 这样的打码域名，带只读 token 才显示全名。
- 测速反馈里的访客 IP 只存加盐哈希（盐取 `IP_HASH_SALT`，没配就用 `SUB_TOKEN`），没法穷举反查。
- 静态页面自带 `_headers`：禁止被 iframe 嵌入，并带 CSP。

## 已知局限

- **探针跑在宽带上，不等于你的手机网络。** 联通宽带能通的 IP，联通 5G 上可能不稳，用上面的手机实测补。
- **免费二级域名在移动网络上经常被封。** 实测（2026-10-13）`ccwu.cc` 子域名在移动下 10 个中 7 个被封，电信、联通正常。移动用户请准备不同后缀的备用域名。
- **workers.dev 在国内三网都不可用**，不要拿来当节点域名。
- **美国能通不代表国内能通。** 同一个 IP 配同一个域名，美国返回 200，国内可能返回 1034。
- Globalping 有额度限制，手动连续触发任务可能被限流；被限流时保留已有结果，不会清空数据。

## 常见问题

**连接报 `error code: 1034` 或 403？** 这个 IP 不服务你的域名。填好 `CHECK_HOSTS` 后，组合测会自动把这类 IP 排除。

**节点第一次能连，复测超时？** 单个 IP 在国内被限速或临时阻断，客户端改用自动选择组即可。持续出现时，到 `/status` 看对应运营商的已验证节点数。

**订阅里为什么有非 Cloudflare 的 IP？** 那是 cmliu 社区维护的反代 IP，国内稳定性往往更好，也是 cmliu 稳定的原因。流量仍是 TLS 端到端加密，但反代方能看到连接元数据。介意的话设 `ALLOW_RELAY=0`。

**为什么大部分节点落地在美国？** 国内到 Cloudflare 的免费线路多数绕到美西，这是线路决定的，与扫描位置无关。本项目会优先落地更近的机房。

## 其他用法

- **直接订阅（不经过 edgetunnel）**：`/sub?type=clash|stash|singbox|surge|loon|v2rayng|shadowrocket`，需要只读 token，可加 `?isp=cu` 选运营商。不带 `type` 时按客户端 UA 自动识别。
  - `singbox` 输出 sing-box 1.12+ 可直接导入的完整配置；只要出站列表用 `singbox-outbounds`。
  - Surge 不支持 VLESS，`surge` 输出的是 Trojan over WebSocket（edgetunnel 同一路径接受 Trojan，密码就是 UUID）。
  - 只支持 WebSocket 传输的节点。
- **完整 API、环境变量、历史设计**：[docs/reference.md](docs/reference.md)
- **Cloudflare 手动配置**：[docs/cloudflare-setup.md](docs/cloudflare-setup.md)

## 本地开发

```bash
npm test                  # 全部测试
npm run preflight         # 部署前检查
npm run validate:sources  # 检查候选源
```

## 免责声明

本项目仅用于个人学习和私用订阅管理。请遵守当地法律法规。不要把真实节点提交到不可信的公开订阅器。

## 致敬

本项目的节点筛选与输出思路——国内实测、固定名单、反代 IP 兜底稳定性——直接受 [cmliu](https://github.com/cmliu) 的 [edgetunnel](https://github.com/cmliu/edgetunnel) 与 [WorkerVless2sub](https://github.com/cmliu/WorkerVless2sub) 启发，社区优选源也来自 cmliu 及其贡献者的长期维护。感谢 cmliu 和所有为 Cloudflare 优选 IP 生态贡献测速数据的朋友。

## 参考来源

本项目在升级过程中借鉴了以下开源项目的思路与设计（均保留原协议要求）：

| 项目 | 协议 | 借鉴内容 |
|------|------|---------|
| [ymyuuu/IPDB](https://github.com/ymyuuu/IPDB) | MIT | 免费优选 IP 数据源（多源聚合的兜底来源之一） |
| [cmliu/WorkerVless2sub](https://github.com/cmliu/WorkerVless2sub) | Apache-2.0 | 订阅生成器骨架 |
| [cmliu/Socks2Vlesssub](https://github.com/cmliu/Socks2Vlesssub) | Apache-2.0 | 多源聚合思路 |
| [bulianglin/psub](https://github.com/bulianglin/psub) | MIT | 隐私保护的订阅转换思路 |
| [figozhu/Sub-Merger-CFWorker](https://github.com/figozhu/Sub-Merger-CFWorker) | MIT | 节点按规则自动归类到策略组 |
| [baiqigo/baiqi-cf-worker-mihomo](https://github.com/baiqigo/baiqi-cf-worker-mihomo) | Apache-2.0 | 原生 Mihomo provider 生成 |
| [xiaolin-007/CloudFlareScan](https://github.com/xiaolin-007/CloudFlareScan) | MIT | 三阶段测速方法 |
| [byJoey/cfnew-ipdb](https://github.com/byJoey/cfnew-ipdb) | MIT | 结构化 IP 数据库格式 |
| [myth-li/shadowshuttle](https://github.com/myth-li/shadowshuttle) | MIT | 手机端测速页思路 |
| [Royo-Qiao/Cloudflare-Edgetunnel](https://github.com/Royo-Qiao/Cloudflare-Edgetunnel) | MIT（自写部分） | SNI 感知 TLS 测速思路 |

以下项目无开源协议或为 GPL，仅借鉴思路、未复用代码：

| 项目 | 借鉴内容 |
|------|---------|
| [PAICNI/CFBox](https://github.com/PAICNI/CFBox) | 内部原生多客户端格式生成架构 |
| [byJoey/cfnew](https://github.com/byJoey/cfnew) | KV 即时生效、三层 IP 来源 |
| [tianrking/Re_edgetunnel](https://github.com/tianrking/Re_edgetunnel)（GPL-2.0） | 模块化重构思路 |
| [LancelotRar/best-cf-ips](https://github.com/LancelotRar/best-cf-ips) | `IP:端口#国家` 数据格式 |
| [eooce/Merge-sub](https://github.com/eooce/Merge-sub) | URL 解析重组的 IP 替换方式 |

本项目基于 MIT 协议开源（见 [LICENSE](LICENSE)）。
