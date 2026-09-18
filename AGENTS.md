# OmniRoute 生产运维指南（nnd fork）

> 本仓是 diegosouzapw/OmniRoute 的生产 fork（已偏离 17 个发版、42 个补丁）。
> 上游的代码贡献规范见 `UPSTREAM-GUIDE.md`（拉上游更新时参考）。

## 仓库拓扑（本仓实际结构）

| 仓库           | 远端                                  | 用途                                      |
| -------------- | ------------------------------------- | ----------------------------------------- |
| 主仓（本目录） | github.com/diegosouzapw/OmniRoute     | 上游 fork 基线（只读）                    |
| `deploy/`      | git.nndrobot.com:ai/OmniRoute.git     | **运维正源**：docs/skills/scripts/backups |
| GitLab src 仓  | git.nndrobot.com:ai/OmniRoute-src.git | **二开源码**：nnd 补丁分支                |

## 生产线

- 生产 VPS：172.16.90.229（容器 `omniroute`，端口 20128）
- 发版镜像：`omniroute:v3.8.50-nnd.N`（229 本地构建）
- 补丁台账：`deploy/docs/155-source-fork-patches.md`
- 生产台账：`deploy/docs/060-production.md`（每笔操作必记）

## Skill 体系（4 个）

| Skill            | 触发词                           |
| ---------------- | -------------------------------- |
| `omniroute-dev`  | 发版/上线/补丁/测上游/直连对比   |
| `omniroute-ops`  | 查日志/改配置/内存/很慢/配额/MCP |
| `omniroute-wiki` | 项目/文档/用量/协作              |
| `zcode-tools`    | ZCode/cron/插件                  |

正源在 `deploy/skills/`，post-commit hook 自动同步到 `~/.agents/skills/`。

## 硬纪律

1. **写操作先报批**：改生产配置/重启/发版 → 报操作员（nnd）批准
2. **上游无错公理**：URL 正确前提下上游永远无错，一切差值是我们的缺陷
3. **发版必过四象限**：工具/视觉/思考/非流式 × claude/openai 八格全绿才准切生产
4. **测试 key 用完必删**；不留禁用态同前缀 key
5. **构建后清缓存**：`docker builder prune -f`（磁盘塞满事故教训）
6. **重启窗口**：工作时段 08:00-19:00 禁止，仅每日 BJ 07:15
7. **所有操作记台账**：源码改动→155，生产操作→060，踩坑经验→skill

## 拉上游更新

```bash
git fetch upstream
git merge upstream/release/vX.Y.Z
# AGENTS.md 会冲突 → `git checkout --ours AGENTS.md`（保留我们的版本）
```

## 详细文档

- 运维手册：`deploy/docs/060-production.md`
- 补丁清单：`deploy/docs/155-source-fork-patches.md`
- 上游代码规范：`UPSTREAM-GUIDE.md`

## 二开审计工具

- **全量清单**：`bash skills/omniroute-dev/scripts/fork-manifest.sh` — 所有改动文件 × 哪些补丁碰的
- **单文件审计**：`bash skills/omniroute-dev/scripts/fork-manifest.sh <file>` — 该文件被哪些补丁改过 + 与上游的完整 diff
- **上游影响检查**：`bash skills/omniroute-dev/scripts/upstream-impact.sh` — 拉上游前跑，看会不会打到我们改过的文件（冲突预警）
