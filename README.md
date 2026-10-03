# rules

为 Mihomo 兼容客户端整理的公共规则仓库。规则来源于 MetaCubeX/meta-rules-dat、blackmatrix7/ios_rule_script 和 Loyalsoldier/clash-rules，经过统一解析、去重和后缀最小化后生成。

## 使用方式

ClashMi、Clash Verge Rev、Nikki 等 Mihomo 客户端使用 `rules/mihomo/` 中的规则 provider。节点使用 SS、VMess、VLESS、Trojan、Hysteria 等哪一种协议，不影响规则文件；规则只决定请求进入哪个策略组。

`convert.js` 会引用本仓库的稳定 URL：

```text
https://testingcf.jsdelivr.net/gh/zyxtoworld/rules@main/rules/mihomo/ai.mrs
```

域名和 IP 规则优先使用 Mihomo 原生 MRS：

```yaml
type: http
behavior: domain # 或 ipcidr
format: mrs
```

MRS 不能表达的 `DOMAIN-KEYWORD`、`PROCESS-NAME`、`PROCESS-PATH` 等规则保留在体积很小的 `*-classical.yaml` provider 中。`ads` 固定拆成 `ads.mrs` 和 `ads-2.mrs`，构建脚本会在固定分片超出大小上限时失败，要求同步更新构建布局和 `convert.js`，避免生成未被订阅引用的分片。

## 目录

- `rules/mihomo/*.mrs`：Mihomo 原生 `domain` / `ipcidr` 二进制规则集。
- `rules/mihomo/*-classical.yaml`：无法用 MRS 表达的少量 classical 规则。
- `rules/manifest.json`：来源、分片、格式、行为、文件大小和规则数量；`groups` 是分片合计，`outputs` 是实际文件清单。
- `sources.json`：上游来源清单。
- `scripts/build-rules.mjs`：下载、解析、去重、后缀最小化、MRS 转换和大文件分片脚本。
- `.github/workflows/build-rules.yml`：每周自动更新，也可以手动运行。

构建需要官方 Mihomo 内核提供的 `convert-ruleset` 命令，不把内核提交到仓库。先设置 `MIHOMO_BIN`，再执行：

```powershell
$env:MIHOMO_BIN = 'C:\path\to\mihomo.exe'
node scripts/build-rules.mjs
```

CI 会固定下载官方 Mihomo `v1.19.32` 转换器。构建脚本会校验每个 MRS 输出非空，并清理旧的生成产物。

## 规则策略

- `direct`：MetaCubeX 中国大陆集合、Loyalsoldier direct、国内 Bilibili 补充。
- `ads`：MetaCubeX 广告集合 + Loyalsoldier reject 集合。
- `proxy-extra`：Loyalsoldier proxy 补充；`convert.js` 仍负责排除中国域名和中国 IP。
- `apple`：除上游 Apple 规则外，包含 Apple 官方列出的 Siri、Search、Apple Intelligence 和 Private Cloud Compute 主机；非中国大陆 Apple 流量默认优先走代理，`DIRECT` 仍可手动选择。
- 服务文件按 AI、加密货币、Google、Apple、Microsoft、游戏、媒体、社交、开发、云服务、金融和购物等策略组拆分；媒体文件只聚合已核验的具体服务，避免所有流量进入一个过宽的代理集合。
- `IP-ASN` 规则会在生成时过滤，避免普通 iOS 客户端因 ASN 数据下载阻塞启动。

上游项目的规则内容遵循各自项目的许可证和使用说明；本仓库只维护生成脚本、来源清单和聚合结果。

## 上游与许可证

- [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat)：GPL-3.0，提供 GeoSite 与服务域名数据。
- [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script)：GPL-2.0，提供 Clash classical 服务规则。
- [Loyalsoldier/clash-rules](https://github.com/Loyalsoldier/clash-rules)：GPL-3.0，提供 direct、reject 和 proxy 基础集合。

本仓库的 `LICENSE` 仅覆盖本仓库脚本、元数据和编排内容；生成规则的具体条目仍遵循各上游项目的许可证和使用说明，完整来源与过滤选项记录在 `sources.json`。
