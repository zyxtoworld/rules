# rules

为 Mihomo 兼容客户端整理的公共规则仓库。规则来源于多个活跃的 GitHub 规则项目，经过统一解析、去重和后缀最小化后生成；重复或只是二次聚合的仓库不直接重复接入。

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

- `direct`：MetaCubeX 中国大陆集合、Loyalsoldier direct、RuleGo direct、ACL4SSR、NobyDa 和国内服务补充。
- `ads`：MetaCubeX、Loyalsoldier、anti-AD、AWAvenue、RuleGo 和 NobyDa 的广告/恶意/跟踪集合，统一去重并按父域名最小化；Sub-Store 规则顺序中广告拦截位于所有服务和直连规则之前，严格以 `REJECT` 优先。
- `proxy-extra`：Loyalsoldier、RuleGo 和 Rule-for-OCD 的代理补充；`convert.js` 仍负责排除中国域名和中国 IP。
- `ai`：除上游 AI 规则外，补充 RuleGo、SukkaW 和 Claude/Anthropic 服务域名，并统一走 `🤖 AI服务`。
- `apple`：除上游 Apple 规则外，合并 RuleGo、NobyDa、SukkaW、LM-Firefly、scomper 等 Apple、Siri、Search、Apple Intelligence 和 Private Cloud Compute 主机；非中国大陆 Apple 流量默认优先走代理，`DIRECT` 仍可手动选择。
- 服务文件按 AI、OpenAI、Claude、Google、Apple、Microsoft、OneDrive、Disney+、游戏、媒体、社交、开发、云服务、金融和购物等策略组拆分；保留通用 AI/媒体/云服务组作为未单独拆分服务的兜底。
- `IP-ASN` 规则会在生成时过滤，避免普通 iOS 客户端因 ASN 数据下载阻塞启动。

上游项目的规则内容遵循各自项目的许可证和使用说明；本仓库只维护生成脚本、来源清单和聚合结果。

## 上游与许可证

- [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat)：GPL-3.0，提供 GeoSite 与服务域名数据。
- [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script)：GPL-2.0，提供 Clash classical 服务规则。
- [Loyalsoldier/clash-rules](https://github.com/Loyalsoldier/clash-rules)：GPL-3.0，提供 direct、reject 和 proxy 基础集合。
- [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)：MIT，补充 Google DeepMind/Gemini、Apple、iCloud 和 iTunes 原始域名分类。
- [SukkaW/Surge](https://github.com/SukkaW/Surge)：AGPL-3.0，补充人工维护的 AI、Apple、Telegram 和流媒体规则。
- [TG-Twilight/AWAvenue-Ads-Rule](https://github.com/TG-Twilight/AWAvenue-Ads-Rule)：GPL-3.0，补充广告过滤域名。
- [ACL4SSR/ACL4SSR](https://github.com/ACL4SSR/ACL4SSR)：CC-BY-SA-4.0，补充部分游戏、媒体和国内直连域名规则。
- [LM-Firefly/Rules](https://github.com/LM-Firefly/Rules)：GPL-3.0，补充 Apple、游戏、全球媒体和 Microsoft 规则。
- [ConnersHua/RuleGo](https://github.com/ConnersHua/RuleGo)：补充 AI、Apple、Google、Microsoft、媒体、拒绝、代理和社交规则。
- [privacy-protection-tools/anti-AD](https://github.com/privacy-protection-tools/anti-AD)：补充广告域名集合。
- [NobyDa/Script](https://github.com/NobyDa/Script)：补充 Apple、广告、下载和 Bilibili 规则。
- [peiyingyao/Rule-for-OCD](https://github.com/peiyingyao/Rule-for-OCD)：补充开发、Google、Apple、媒体、社交和游戏规则。
- [scomper/surge-list](https://github.com/scomper/surge-list)：补充 Apple、广告、媒体、Telegram 和国内服务规则。
- [lyq2010/clash-ruleset](https://github.com/lyq2010/clash-ruleset)：仅接入 Claude、Binance、Mail 和 Docker 等公共服务增量；个人直连/代理列表不接入。
- [reonokiy/sing-box-ruleset](https://github.com/reonokiy/sing-box-ruleset)：补充 sing-box JSON 格式的 Gemini、OpenAI、Anthropic、Apple、Microsoft 和广告规则。

本仓库的 `LICENSE` 仅覆盖本仓库脚本、元数据和编排内容；生成规则的具体条目仍遵循各上游项目的许可证和使用说明，完整来源与过滤选项记录在 `sources.json`。
