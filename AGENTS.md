# OmniRoute 生产运维指南（nnd fork）

> 本仓是 diegosouzapw/OmniRoute 的生产 fork（编号至 nnd.36=上游 v3.8.52 大合并批，2026-10-27 19:0x 上线；nnd.2 镜像曾构建但从未上线——生产 nnd.1→nnd.3，实发 35 代；补丁 #1-#101 在册（#95-#101=51 合并重放丢失族+观测保真，见 155 §二十三）+ 51 合并批收编/重放清单见 155 §十九；#90 错峰生产禁用——GLM 七账号窗同步是操作员故意设计）。
> 上游的代码贡献规范见 `UPSTREAM-GUIDE.md`（拉上游更新时参考）。

## 仓库拓扑（本仓实际结构）

| 仓库           | 远端                                  | 用途                                      |
| -------------- | ------------------------------------- | ----------------------------------------- |
| 主仓（本目录） | github.com/diegosouzapw/OmniRoute     | 上游 fork 基线（只读）                    |
| `deploy/`      | git.nndrobot.com:ai/OmniRoute.git     | **运维正源**：docs/skills/scripts/backups |
| GitLab src 仓  | git.nndrobot.com:ai/OmniRoute-src.git | **二开源码**：nnd 补丁分支                |

## 生产线

- 生产 VPS：172.16.90.229（容器 `omniroute`，端口 20128；**当前版本以 `docker ps` 实测为准**——2026-10-27 19:0x 起 **nnd.36**（上游 v3.8.52 基线），回滚锚 nnd.35；nnd.33 锚库保全在 db_backups/anchors/）
- 发版镜像：`omniroute:v3.8.52-nnd.N`（229 本地构建；⚠️ tag 前缀随上游基线版本走——nnd.31/32 曾沿用旧模板打成 v3.8.50-nnd.N 后重打，大合并后构建命令的 tag 前缀必须同步改；上游大版本合并后需 `--build-arg OMNIROUTE_BUILD_MEMORY_MB=14336`，默认 6G 堆会 OOM）
- 补丁台账：`deploy/docs/155-source-fork-patches.md`
- 生产台账：`deploy/docs/060-production.md`（每笔操作必记）
- 上游合并 SOP：`deploy/skills/omniroute-dev/upstream-merge-sop.md`（**大版本合并必读**，nnd.31 实战定型；51 预案研究档已删、git 历史可查）

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
5. **构建后清缓存**：`docker builder prune --all -f`（cache mount 盲区曾积 108G；普通 -f 清不掉）
6. **重启窗口**：工作时段 08:00-19:00 禁止；例行自动重启=每日 BJ 07:15，发版切换默认晚间安静窗（非晚间须报操作员批准）
7. **所有操作记台账**：源码改动→155，生产操作→060，踩坑经验→skill

## 拉上游更新

```bash
git fetch origin            # ⚠️ 远端名是 origin（无 upstream 远端）
# 小版本：git merge origin/release/vX.Y.Z，AGENTS.md 冲突 → `git checkout --ours AGENTS.md`
# 大版本（>5000 文件）：必读 deploy/skills/omniroute-dev/upstream-merge-sop.md，勿逐块手工解
```

## 详细文档

- 运维手册：`deploy/docs/060-production.md`
- 补丁清单：`deploy/docs/155-source-fork-patches.md`
- 上游代码规范：`UPSTREAM-GUIDE.md`

## 二开审计工具

- **全量清单**：`bash deploy/skills/omniroute-dev/scripts/fork-manifest.sh` — 所有改动文件 × 哪些补丁碰的（⚠️ 51 大合并后全量模式基线口径失真——会把上游合并计入改动面且逐文件模式在大规模下不可用，以 155 台账为准）
- **单文件审计**：`bash deploy/skills/omniroute-dev/scripts/fork-manifest.sh <file>` — 该文件被哪些补丁改过 + 与上游的完整 diff
- **上游影响检查**：`bash deploy/skills/omniroute-dev/scripts/upstream-impact.sh` — 拉上游前跑，看会不会打到我们改过的文件（冲突预警；⚠️ 须显式传参指定新上游区间——NEW 默认值 origin/release/v3.8.51 是已并入基线，裸跑输出纯噪音）
