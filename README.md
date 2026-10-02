# zyxtoworld/rules

为 Mihomo 兼容客户端整理的公共规则仓库。规则来源于 MetaCubeX/meta-rules-dat、blackmatrix7/ios_rule_script 和 Loyalsoldier/clash-rules，经过统一解析、去重和后缀最小化后生成。

## 使用方式

ClashMi、Clash Verge Rev、Nikki 等 Mihomo 客户端使用 `rules/mihomo/*.yaml` 里的 Clash classical provider。节点使用 SS、VMess、VLESS、Trojan、Hysteria 等哪一种协议，不影响规则文件；规则只决定请求进入哪个策略组。

`convert.js` 会引用本仓库的稳定 URL：

```text
https://raw.githubusercontent.com/zyxtoworld/rules/main/rules/mihomo/ai.yaml
```

生成文件均使用：

```yaml
type: http
behavior: classical
format: yaml
```

## 目录

- `rules/mihomo/`：给 Mihomo/Clash 客户端直接使用的聚合规则。
- `rules/manifest.json`：本次构建时间、来源和条目数量。
- `sources.json`：上游来源清单。
- `scripts/build-rules.mjs`：下载、解析、去重、后缀最小化和生成脚本。
- `.github/workflows/build-rules.yml`：每周自动更新，也可以手动运行。

## 规则策略

- `direct`：MetaCubeX 中国大陆集合、Loyalsoldier direct、国内 Bilibili 补充。
- `ads`：MetaCubeX 广告集合 + Loyalsoldier reject 集合。
- `proxy-extra`：Loyalsoldier proxy 补充；`convert.js` 仍负责排除中国域名和中国 IP。
- 服务文件按 AI、Google、Apple、Microsoft、游戏、媒体、社交、开发、云服务、金融和购物等策略组拆分，避免所有流量进入一个过宽的代理集合。
- `IP-ASN` 规则会在生成时过滤，避免普通 iOS 客户端因 ASN 数据下载阻塞启动。

上游项目的规则内容遵循各自项目的许可证和使用说明；本仓库只维护生成脚本、来源清单和聚合结果。