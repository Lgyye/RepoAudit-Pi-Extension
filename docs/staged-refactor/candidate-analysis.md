# TASK-006：单候选分析服务

## 1. 公共接口

本任务新增：

```python
analyze_candidate(run_id, candidate_id) -> list[DataFlowPath]
```

稳定身份参数保持原始总任务规定的 `run_id` 与 `candidate_id`，返回当前候选的 `list[DataFlowPath]`。完整 Python 签名另有仅限关键字的 `intra_dataflow_analyzer`、`event_writer` 与 `call_depth`，用于组合阶段传入已有模型配置、共享事件序号和调用深度；它们不改变两个 ID 的公共引用方式。

本阶段不会猜测模型名称、读取 API Key 或自行创建隐藏的默认模型配置。实际调用 `IntraDataFlowAnalyzer` 时，组合调用方必须通过 `intra_dataflow_analyzer=` 提供已配置实例。缺失时服务输出代码为 `ANALYSIS_RUNTIME_NOT_CONFIGURED` 的 `StructuredError`，不运行 LLM。

当前阶段实际组合调用形式为：

```python
from src.service import analyze_candidate

paths = analyze_candidate(
    run_id,
    candidate_id,
    intra_dataflow_analyzer=configured_intra_analyzer,
)
```

## 2. TASK-008 之前的加载边界

原始总任务要求按 `run_id`、`candidate_id` 加载候选，但持久化 `src/storage/run_store.py` 明确留到 TASK-008。本任务采用最小过渡边界：

1. `extract_candidates(profile, bug_type)` 完成后，把同一进程内的 `RepositoryProfile`、Tree-sitter analyzer、候选 ID 索引和 `EventWriter` 登记到 `analysis_service.py` 的私有、线程安全上下文。
2. `analyze_candidate()` 先按 `run_id` 定位上下文，再在该运行的候选映射中精确读取一个 `candidate_id`；不会遍历或分析其他候选。
3. 生成的公共路径按 `candidate_id`、`path_id` 暂存在同一上下文中，保留可达值步骤和跨函数关系，供 TASK-007 的单路径加载边界复用；不会为验证而重跑其他候选。
4. 上下文只存在于当前 Python 进程，不写入 `runs/`，不定义磁盘格式，也不声称支持程序退出后的恢复。
5. TASK-008 可把私有 `_load_candidate_context()` 与路径加载边界替换为 `RunStore` 适配器，而不修改公共 `analyze_candidate(run_id, candidate_id)`。

这也修正了 TASK-005 文档末尾曾写成“接收一个 `AuditCandidate`”的接口偏差。

## 3. 分析范围

服务重新调用对应漏洞类型的已有 extractor，仅用于把公共候选的相对路径、行号和符号精确映射回原内部 source/sink `Value`。随后只从该 source 建立工作队列：

- 获取 source 与 sink 所在函数；
- 收集当前函数的调用点、返回值和目标 sink；
- 复用已有 `IntraDataFlowAnalyzerInput`、`IntraDataFlowAnalyzerOutput` 和 `invoke()`；
- 沿 `Argument -> Parameter`、`Parameter -> Argument`、`Return -> Call Result` 关系传播；
- 使用既有 `CallContext` 约束跨函数调用/返回匹配；
- 仅在传播事实到达指定候选的 sink 时生成路径；
- 不创建 `DFBScanAgent`，不运行 `PathValidator`、完整扫描或其他候选分析。

`IntraDataFlowAnalyzerOutput.reachable_values` 当前以集合保存值，没有保留模型响应中的原始传播顺序。公共转换按文件、行号、值类型、索引和符号稳定排序，以保证相同内部事实生成相同 `DataFlowStep` 顺序和 `path_id`；路径可执行性仍由 TASK-007 验证。

## 4. 公共路径与事件

每个内部值转换为一个 `DataFlowStep`：

- 路径统一为仓库相对 `/` 路径；
- 行号保持从 1 开始；
- `ValueLabel` 转换为 `source`、`sink`、`argument`、`parameter`、`return`、`call_result` 等公开 `kind`；
- 跨函数边界写入公开 description，不暴露 `Node`、`Value`、`Function` 或 `CallContext`；
- `step_index` 从 1 连续编号；
- 调用 `make_path_id()` 生成确定性 `path_id`；
- 跨函数路径标记 `interprocedural = true` 和 `INTERPROCEDURAL_PROPAGATION`。

事件顺序包括：

1. `candidate_analysis_started`；
2. 每个实际选择函数一次 `function_selected`；
3. 确认路径后一次 `source_sink_matched`；
4. 每个公共步骤一个带 `path_id` 的 `dataflow_step_found`；
5. 未找到路径时发出 `candidate_rejected` 和 `SOURCE_SINK_NOT_MATCHED`；
6. 失败时发出包含脱敏 `StructuredError` 的 `analysis_failed`。

## 5. 修改文件

- `src/service/analysis_service.py`
- `src/service/candidate_service.py`
- `src/service/__init__.py`
- `docs/staged-refactor/candidate-analysis.md`
- `docs/staged-refactor/candidate-generator.md`

未修改旧 CLI、`src/agent/dfbscan.py`、`DFBScanAgent`、`pi-extension/` 或 `SecHeur-Agent-pro/`。

## 6. 未验证项与下一步

- 按项目约束，本任务不运行测试套件，不调用 RepoAudit、Tree-sitter 或 LLM。
- 进程内上下文加载、精确候选隔离、内部值映射、函数事件、跨调用/返回传播、稳定步骤排序、稳定 `path_id`、无路径拒绝和结构化失败测试留到 TASK-011，并标记 `NOT RUN`。
- 当前旧 `IntraDataFlowAnalyzer` 本身是模型驱动组件；本任务只建立调用和转换能力，没有实际推理结果可用于运行时验证。
- TASK-007 下一步应按 `run_id`、`candidate_id`、`path_id` 独立加载并验证单条路径，不应在验证服务中重新运行候选分析。

本任务只进行格式、差异和依赖边界等静态检查；这些检查不得描述成“测试通过”。
