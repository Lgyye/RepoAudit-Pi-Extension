# RepoAudit Pi Extension：SecHeur 第二阶段集成清单

本文只描述后续迁移步骤。本阶段的代码改动全部位于 RepoAudit 仓库；没有修改或验收 `SecHeur-Agent-pro` 的 Docker 镜像、Bridge 或运行时。

## 插件已经提供的能力

- `repoaudit_scan` 名称、三个参数和支持矩阵保持兼容，`promptSnippet` 与 `promptGuidelines` 保留。
- 独立 `runRepoAuditDoctor()` API、`repoaudit-doctor` CLI 和 `npm run doctor`；doctor 不扫描、不访问模型，只报告凭证是否存在。
- 稳定错误码、恢复建议和三态结果；执行失败不会降级为 `success_no_findings`。
- 每 25 秒一次的 `onUpdate` heartbeat，以及对精简 Python JSONL 进度的转发。
- `AbortSignal` 透传、内部扫描 timeout、取消来源区分、有限 grace period 和进程树强制终止。
- 进程内队列加原子文件锁；锁具有 owner token、PID、run ID、创建/心跳时间、stale 恢复和 owner-only release。
- 每次扫描的唯一 run ID、legacy CLI 可选 `--run-id`、严格 artifact 快照与 run ID 目录校验。
- 可独立 TypeScript build、真实 Pi loader 验证和 npm pack 内容检查。

这些能力减少宿主适配代码，但不等于宿主集成或容器部署已经完成。

## SecHeur-Agent-pro 必须完成的修改

以下文件都应在第二阶段、在 `SecHeur-Agent-pro` 仓库中修改并单独评审：

1. 根 `package.json`
   - 把发布后的 RepoAudit extension 包加入 workspace 安装/构建流程，或提供从受控 npm tarball 安装的脚本。
   - 固定包版本和 lockfile；CI 中执行 extension load、doctor（无费用模式）及 pack 安装验证。

2. `packages/secheur-agent/package.json`
   - 将 RepoAudit extension 声明为运行时依赖，而不是只放在开发依赖中。
   - 确保宿主与插件的 `@earendil-works/pi-coding-agent` 版本一致，避免加载两份不兼容的 Extension API。

3. `packages/secheur-agent/src/runtime.ts`
   - 在创建 Pi session 时启用已安装的 RepoAudit extension。
   - 仅允许并透传受控的 `REPOAUDIT_*` 配置；`REPOAUDIT_PYTHON` 必须与宿主现有 `SECHEUR_PYTHON` 分开。
   - 把扫描取消的来源传入插件 runtime options，或把明确 reason 交给 `AbortController.abort(reason)`。

4. `packages/secheur-agent/src/bridge.ts`
   - 保留 `tool_execution_update` 对 output-idle watchdog 的续期；验证 RepoAudit 的 25 秒 heartbeat 能沿 Bridge 到达该分支。
   - watchdog 主动取消时使用明确、稳定的来源，例如 `{ source: "host_watchdog" }`，使插件只在有证据时返回 `HOST_WATCHDOG_ABORTED`。
   - 通过集成测试验证超过默认 600 秒但持续有更新的扫描不会被当作无进展；无更新的扫描仍会按宿主策略中止。

5. `packages/secheur-agent/src/config.ts`
   - 增加 RepoAudit root、Python、模型、timeout、worker、lock 和 heartbeat 配置的 schema/范围校验。
   - Secret 只通过环境或 Secret manager 注入；状态接口只能暴露“是否存在”，不得返回值。
   - 明确宿主 watchdog、插件 `REPOAUDIT_TIMEOUT_MS` 和上游请求 timeout 的优先级。

6. `packages/secheur-agent/src/pi-plugins.ts`
   - 从安装包导出的 `pi.extensions`/入口发现并加载 extension，不依赖 RepoAudit 源码目录或开发机 `node_modules` 布局。
   - 启动失败时保留插件的稳定错误语义，并在宿主日志中记录包版本和加载结果。

7. `Dockerfile`
   - 安装 Python 3.13，基于 `requirements.txt` 创建 RepoAudit 专用 venv，并在镜像构建阶段生成 `lib/build/my-languages.so`。
   - 构建/安装 npm pack 产物；运行镜像不得依赖开发机绝对路径、源码仓库外文件或复制来的虚拟环境。
   - 创建非 root 运行用户以及可写的 `log/`、`result/`、`runs/`、`lock/`，并限制目标仓库挂载的读取范围。

8. `docker-compose.yml`
   - 显式设置 `REPOAUDIT_ROOT`、`REPOAUDIT_REQUIRE_EXPLICIT_ROOT=1`、`REPOAUDIT_PYTHON` 和资源限制变量。
   - 通过 secrets 注入模型凭证；为目标仓库、产物和锁选择明确 volume。
   - 如果多个容器共享一个 runtime，不应把本插件文件锁视为分布式锁；应接入中央队列、数据库 lease 或独立 worker 服务。

9. `.pi/settings.json`
   - 启用安装后的 RepoAudit extension 包/构建产物，禁止引用本地源码绝对路径。
   - 保留其他 penetration-testing extensions 的现有加载顺序，并做工具名冲突检查。

## 推荐迁移和验收顺序

1. 在 RepoAudit 运行 `npm ci --ignore-scripts`、typecheck、单测、真实 extension load、doctor 和 pack 检查。
2. 生成 tarball，在一个干净临时目录安装，确认只依赖包内文件与显式 `REPOAUDIT_ROOT`。
3. 在 SecHeur 加包依赖和 plugin discovery，先做无模型的 schema/load/doctor 集成测试。
4. 接通 runtime 配置与 Secret 注入，再验证用户取消、插件 timeout 和明确 watchdog abort 三条路径。
5. 验证 Bridge 能持续收到 `tool_execution_update`，包括一次超过 600 秒的无费用 fake worker 测试。
6. 构建 Docker 镜像，在容器内运行 doctor、grammar 检查、不可写目录测试和进程树清理测试。
7. 仅使用获准的测试仓库和测试凭证执行真实 LLM smoke test；默认 CI 不运行该测试。
8. 多副本部署前接入中央调度，并验证同一目标/同一 runtime 的容量、隔离、取消与恢复策略。

## 仍由宿主或云端负责

- 插件包的发布、供应链校验和 SecHeur 依赖升级策略。
- Bridge 事件链路、600 秒 watchdog 行为和明确 abort reason 的端到端保证。
- Docker 基础镜像、Python/grammar 构建、非 root 权限、Secret、网络和 volume 配置。
- 多容器中央队列、租约、容量控制、任务恢复、监控告警与 artifact 生命周期。
- 对允许扫描目录、源码发送给外部模型、数据驻留和审计日志的组织策略。
- 真实 LLM、云端 Docker 和 Bridge 的最终验收。

因此，本阶段不得描述为“已完成 SecHeur 集成”“已通过 Bridge 验收”或“已完成 Docker 部署”。
