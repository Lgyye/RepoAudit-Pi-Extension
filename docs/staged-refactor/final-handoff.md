# RepoAudit 分阶段重构最终交接

## 1. 交付状态

TASK-001～011 已在 `refactor/repoaudit-staged-engine` 分支按任务独立提交。TASK-012 只更新根 README 和本交接文档，不修改运行代码、`pi-extension/` 或 `SecHeur-Agent-pro/`。

当前 staged 架构已经建立以下边界：

```text
inspect_repository
        ↓ RepositoryProfile
extract_candidates
        ↓ AuditCandidate[]
analyze_candidate(run_id, candidate_id)
        ↓ DataFlowPath[]
validate_path(run_id, candidate_id, path_id)
        ↓ ValidationResult
```

`run_full_scan()` 顺序组合四个服务；分阶段 CLI 则通过 `RunStore` 在独立进程之间恢复公共状态。旧 `DFBScanAgent`、旧参数式 CLI、旧扫描入口和旧 `detect_info.json` 均保留。

## 2. 稳定公共入口

Python 服务导出：

```python
from service import (
    analyze_candidate,
    extract_candidates,
    inspect_repository,
    validate_path,
)
```

持久化导出：

```python
from storage import DEFAULT_RUNS_ROOT, RunSnapshot, RunStore, RunStoreError
```

完整扫描入口：

```python
from agent.dfbscan import run_full_scan
```

CLI 入口：

```text
python src/repoaudit.py inspect ...
python src/repoaudit.py candidates ...
python src/repoaudit.py analyze ...
python src/repoaudit.py validate ...
python src/repoaudit.py full-scan ...
```

原参数式调用继续存在。没有提供 `--dfb-engine` 时默认 `legacy`；显式传入 `--dfb-engine staged` 才切换组合引擎。

## 3. 协议与持久化边界

公共 schema 当前为 `1.0.0`。集成方应只依赖 `src/protocol/` 导出的公共对象和序列化字段，不应导入以下内部对象：

- Tree-sitter `Node`；
- `Function`、`Value`、`CallContext` 或 `DFBScanState`；
- `analysis_service.py` 的进程级上下文；
- 旧模型工具的 Prompt、原始响应或 logger 状态。

默认运行目录为 `<RepoAudit>/runs/<run_id>/`，包含 `run.json`、`repository.json`、`candidates.json`、`paths.json`、`validations.json`、`events.jsonl` 和 `errors.json`。读取时应校验 `schema_version`、对象所属 `run_id`、ID 格式和事件连续序号；不要只根据文件存在与否推断成功。

分阶段命令创建的运行保持可恢复状态，当前没有单独的 `finalize` 子命令。完整运行的最终三态只由 `full-scan` 输出：

| `run_completed.status` | 含义 |
| --- | --- |
| `success_with_findings` | 完整结束且至少一个路径被接受为 finding |
| `success_no_findings` | 完整结束但没有 accepted finding |
| `failed` | run 级阶段失败 |

对应的 `AuditRun.status` 只使用公共协议允许的 `completed` 或 `failed`。候选或路径级 `analysis_failed` 可以是非致命错误，因此不能单独用它判定整个 run 失败。

## 4. Pi 插件后续对接建议

当前插件的 `repoaudit_scan` Tool 参数可以保持不变：

```ts
{
  repoPath: string;
  language: "Cpp" | "Java" | "Python" | "Go";
  bugType: "MLK" | "NPD" | "UAF";
}
```

建议分两步接入：

1. 保留现有 legacy Adapter 作为默认和回退路径，不改变当前用户调用契约。
2. 新增内部 engine 配置后，将适合的组合路由到 `full-scan`；只有需要人工或 Agent 选择候选/路径时才使用四个分阶段子命令。

staged `full-scan` Adapter 应遵守：

- 通过参数数组启动 Python，继续使用 `shell: false`；
- 逐行解析 stdout，每行必须是一个 `AnalysisEvent` JSON；
- 检查 `schema_version`、`sequence`、`run_id` 和最终 `run_completed`；
- 用 `event_id` 去重，用 run/candidate/path ID 建立业务关联；
- 将 stderr 当作诊断通道，不混入 JSONL 解析；
- 结合退出码、最终事件与 `run.json` 判定状态，不把失败当作零发现；
- 只向 Agent 返回公共候选、路径、验证摘要和必要的源码位置；
- 不返回完整 Prompt、模型原始响应、内部日志、环境变量或 traceback；
- 保留旧 `detect_info.json` 解析作为迁移期兼容能力，而不是 staged 状态的唯一事实来源。

交互式分阶段 Adapter 还需要：

- 从 `inspect` 的事件取得 `run_id`；
- 从 `candidates.json` 或 `candidate_extracted` 取得 `candidate_id`；
- 每次只请求一个 `analyze`，从 `paths.json` 取得该候选的 `path_id`；
- 每次只请求一条 `validate`，不为验证重新运行候选分析；
- 对同一 run 串行写入，保证 `events.jsonl` 的 sequence 连续；
- 在调用之间确认目标仓库没有被移动或改写，否则持久化位置与重建语法上下文可能不一致。

## 5. 已知风险

### 5.1 尚未运行验证

按照本轮任务约束，没有运行项目测试、RepoAudit、Tree-sitter 实际分析、Path Validator、LLM 或完整扫描。`tests/` 中准备了 32 个用例，但所有测试类都使用以 `NOT RUN:` 开头的类级跳过标记。Black、AST 解析、JSON 示例解析和 Git 差异检查均只属于静态检查。

在移除 `NOT RUN` 前，应先恢复依赖、构建 Tree-sitter grammar、审阅 fixture/mock 边界，并在隔离环境中执行；不得直接把待执行用例数量当作覆盖率或通过率。

### 5.2 MLK 表达能力

`SourceSinkPair` 必须同时包含 source 和 sink，而单候选分析只为实际到达指定 sink 的事实生成完整路径。因此 staged 引擎无法把“缺少释放”本身表示为可验证的否定路径，尤其不能处理没有释放 sink 的仓库。`Cpp/MLK` 应继续使用 legacy 引擎。

### 5.3 并发和恢复

- staged `run_full_scan()` 当前顺序处理候选和路径；`max_neural_workers` 仍被接受和校验，但没有启用模型并发。
- `RunStore` 的单实例操作有进程内锁和原子写入，但不承诺多个独立进程同时修改同一 run 时自动合并；外部编排器应坚持单写者。
- 分阶段恢复会从持久化 profile、candidate 和 path 重建内部 analyzer 上下文。目标仓库在阶段之间发生变化时，重建可能失败或得到与初始检查不一致的内部映射。
- 分阶段 CLI 当前没有显式完成 run 的命令；外部系统如需完整三态结论，应优先使用 `full-scan`，或另行设计不改变现有公共 ID 的 finalize 边界。

### 5.4 事件与产物

- 单个事件默认限制为 65,536 UTF-8 bytes。大型 `repository_inspected` 等事件可能安全降级为 `analysis_failed`，不会截断为非法 JSON。
- staged 完整扫描零发现时明确写 `{}`，与 legacy 历史上可能不创建 `detect_info.json` 的行为存在细微差异。
- 相同秒内、相同模型/漏洞/语言/项目的多次完整扫描可能竞争旧结果目录；该路径碰撞尚未运行验证。
- `ValidationResult.verdict` 是路径可达性，不天然等于漏洞结论；消费者必须结合 relation 或完整扫描的 finding 选择规则。

### 5.5 安全与合规

staged 模型调用使用无输出 logger，公共错误只保留异常类型和脱敏上下文。然而源码仍会发送给配置的 LLM 服务。部署前必须确认代码分类、供应商协议、数据驻留、日志权限和产物保留策略满足组织要求。

## 6. 回滚方法

优先使用无代码回滚：保留原参数式命令并省略 `--dfb-engine staged`，即可继续走默认 legacy 引擎。`Cpp/MLK` 必须采用此路径。

如需回滚源码提交：

1. 先确认并保存工作区中的用户修改，尤其是 `pi-extension/`；
2. 创建备份分支；
3. 使用 `git log --oneline 05cee28^..HEAD` 核对本轮任务提交；
4. 对需要撤销的提交按从新到旧顺序执行 `git revert <commit>`；
5. 不使用 `git reset --hard`，也不要通过 checkout 覆盖未提交的用户文件。

只回滚 TASK-012 文档时，直接 revert TASK-012 的独立提交即可，不会改变 staged 运行代码。

## 7. 文档索引

- [重构前行为基线](baseline.md)
- [公共数据协议](data-contracts.md)
- [结构化事件协议](event-contract.md)
- [仓库检查服务](repository-inspector.md)
- [候选生成服务](candidate-generator.md)
- [单候选分析服务](candidate-analysis.md)
- [单路径验证服务](path-validation.md)
- [运行状态存储](run-store.md)
- [完整扫描编排](full-scan-orchestration.md)
- [待执行测试说明](../../tests/README.md)

## 8. 后续工作建议

本轮重构完成后，建议先在独立任务中审计目录和运行产物，再决定删除范围。`tests/`、`docs/staged-refactor/`、`src/protocol/`、`src/service/` 和 `src/storage/` 都是本轮交付的一部分，不应仅因尚未运行而被当作临时文件删除。`runs/`、`log/`、`result*/`、缓存和构建产物属于优先清理候选，但删除前仍应解析实际路径、确认它们未被跟踪，并保留需要归档的审计证据。
