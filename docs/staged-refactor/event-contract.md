# TASK-003：结构化事件协议

本文定义 RepoAudit 分阶段分析过程的 JSONL 事件流。事件实现位于 `src/protocol/events.py`，写入器位于 `src/protocol/event_writer.py`，复用 [`data-contracts.md`](data-contracts.md) 的 `1.0.0` 数据协议。

## 1. 通道规则

启用结构化事件的流程必须遵守：

- stdout：只写 `AnalysisEvent` JSONL；每行恰好一个完整 JSON 对象。
- stderr：普通诊断、进度和 EventWriter 自身故障提示。
- 原日志文件：可以继续记录普通日志，但不得复制到事件 stdout。
- 事件不得使用 Markdown、前后缀、进度条或多行 pretty-print。
- JSON 字符串中的换行使用转义字符，不会拆成额外物理行。

`EventWriter()` 默认使用 `sys.stdout` 作为事件流、`sys.stderr` 作为日志流，并拒绝两个参数引用同一个流。`write_log()` 只写日志流。

TASK-001 冻结的旧完整扫描目前仍由旧 `Logger` 输出 stdout；TASK-003 不提前改变旧模式。TASK-009 把完整扫描接入新流程时，必须让普通日志进入 stderr 或原日志文件，只有事件进入 stdout。不得在同一进程的 JSONL 模式中同时使用旧 stdout 日志行为。

## 2. `AnalysisEvent` 信封

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schema_version` | string | 当前为 `1.0.0` |
| `event_type` | string | 本文第 4 节定义的事件名 |
| `sequence` | integer | 单个 `EventWriter` 内从 1 开始连续递增 |
| `run_id` | string/null | 所属运行；仅运行 ID 尚不可用的 `analysis_failed` 可为 null |
| `event_id` | string | `evt_<32 个小写十六进制字符>` |
| `emitted_at` | string | RFC 3339 UTC 时间 |
| `candidate_id` | string/null | 候选级事件的引用 |
| `path_id` | string/null | 路径级事件的引用；出现时必须同时有 candidate ID |
| `payload` | object | 事件专属的 JSON 安全载荷 |

所有候选事件必须有 `candidate_id`；`path_validation_started` 和 `path_validated` 还必须有 `path_id`。公共对象可直接放入 `payload`，写入时会转换为 JSON；Tree-sitter 节点、异常对象和内部状态类会触发安全降级。

单行示例：

```json
{"candidate_id":null,"emitted_at":"2026-08-24T12:00:00Z","event_id":"evt_0123456789abcdef0123456789abcdef","event_type":"run_started","path_id":null,"payload":{"run":{"bug_type":"NPD","completed_at":null,"created_at":"2026-08-24T12:00:00Z","error_ids":[],"language":"Python","repository_root":"C:/work/example","run_id":"run_0123456789abcdef0123456789abcdef","schema_version":"1.0.0","stage":"full_scan","status":"running","updated_at":"2026-08-24T12:00:00Z"}},"run_id":"run_0123456789abcdef0123456789abcdef","schema_version":"1.0.0","sequence":1}
```

## 3. JSONL 写入器

```python
from protocol import EventWriter

writer = EventWriter()
writer.emit(
    "candidate_analysis_started",
    run_id="run_0123456789abcdef0123456789abcdef",
    candidate_id="cand_111122223333444455556666",
)
writer.write_log("Analyzing one candidate")
```

特性：

- 使用锁保护 sequence、事件写入和普通日志写入，避免多个线程交叉半行。
- 每次 `emit()` 只写一次 `JSON + "\n"`，写后默认 flush。
- `emit()` 返回实际写出的事件；发生降级时返回的是 `analysis_failed`。
- 默认最大事件大小为 65,536 UTF-8 bytes，不含行尾换行。
- 可通过 `max_event_bytes` 调低或调高限制，但不得低于 1,024 bytes。
- 超限事件不截断，因为截断会破坏 JSON；写入器改写为小型 `analysis_failed`。
- 事件流写入本身失败时无法在同一流中可靠报告，写入器只向 stderr 输出固定诊断并抛出 `EventWriteError`。

## 4. 事件定义

### `run_started`

- 引用：必须有 `run_id`。
- 必需载荷：`run`，值为 `AuditRun`。
- 时机：运行目录和 `AuditRun` 身份建立后、任何分析阶段开始前。

### `repository_inspected`

- 引用：必须有 `run_id`。
- 必需载荷：`repository`，值为 `RepositoryProfile`。
- 时机：仓库检查结束后；不得隐式启动候选提取或 LLM。

### `candidate_extracted`

- 引用：必须有 `run_id`、`candidate_id`。
- 必需载荷：`candidate`，值为 `AuditCandidate`。
- 时机：一个候选完成规范化和稳定 ID 生成后。

### `candidate_analysis_started`

- 引用：必须有 `run_id`、`candidate_id`。
- 必需载荷：无，可使用空对象。
- 时机：即将对指定候选执行数据流分析时。

### `function_selected`

- 引用：必须有 `run_id`、`candidate_id`。
- 必需载荷：`function_name`、`location`。
- `location`：应为 `SourceLocation`；不得放 Tree-sitter `Node`。
- 时机：选择候选相关函数、调用方或被调用方时。

### `source_sink_matched`

- 引用：必须有 `run_id`、`candidate_id`。
- 必需载荷：`source_sink_pair`，值为 `SourceSinkPair`。
- 时机：候选 source/sink 关系确认后。

### `dataflow_step_found`

- 引用：必须有 `run_id`、`candidate_id`；`path_id` 可选，因为发现步骤时完整路径 ID 可能尚未生成。
- 必需载荷：`step`，值为 `DataFlowStep`。
- 时机：内部传播结果完成公共结构转换后。

### `path_validation_started`

- 引用：必须有 `run_id`、`candidate_id`、`path_id`。
- 必需载荷：无，可使用空对象。
- 时机：验证指定路径之前。

### `path_validated`

- 引用：必须有 `run_id`、`candidate_id`、`path_id`。
- 必需载荷：`validation`，值为 `ValidationResult`。
- 时机：得到 `reachable`、`not_reachable` 或 `inconclusive` 结果后。

### `candidate_rejected`

- 引用：必须有 `run_id`、`candidate_id`。
- 必需载荷：`reason_codes`，值为字符串数组。
- 可选载荷：`summary`，简短公开说明。
- 时机：候选因无路径、不符合关系或其他可公开理由被拒绝时。

### `analysis_failed`

- 引用：`run_id`、`candidate_id`、`path_id` 按失败时已知范围提供；只有该事件允许 null `run_id`。
- 必需载荷：`error`，值为 `StructuredError`。
- 时机：阶段失败、单候选失败、模型解析失败、事件序列化失败或事件超限时。
- 安全：不得包含 API Key、环境变量快照、完整 Prompt、完整模型响应、traceback 或隐藏思维链。

### `run_completed`

- 引用：必须有 `run_id`。
- 必需载荷：
  - `status`：`success_with_findings`、`success_no_findings` 或 `failed`。
  - `finding_count`：非负整数。
  - `error_count`：非负整数。
- 可选载荷：`duration_ms`、`result_paths`。
- 时机：所有请求阶段结束并完成持久化后；一个 run 只应发一次。

## 5. 失败降级

### 序列化失败

当事件类型、ID、必需载荷、payload 类型或嵌套对象不符合协议，`emit()` 捕获错误并输出：

```json
{"candidate_id":null,"emitted_at":"2026-08-24T12:00:01Z","event_id":"evt_11111111111111111111111111111111","event_type":"analysis_failed","path_id":null,"payload":{"error":{"candidate_id":null,"cause_type":"TypeError","code":"EVENT_SERIALIZATION_FAILED","details":{"original_event_type":"repository_inspected"},"error_id":"err_22222222222222222222222222222222","message":"The analysis event could not be serialized.","path_id":null,"retriable":false,"run_id":"run_0123456789abcdef0123456789abcdef","schema_version":"1.0.0","stage":"event_writer"}},"run_id":"run_0123456789abcdef0123456789abcdef","schema_version":"1.0.0","sequence":2}
```

错误对象只记录异常类型名，不记录异常文本或 traceback，以降低泄露风险。

### 大小超限

超限事件改写为 `analysis_failed`，错误码为 `EVENT_SIZE_LIMIT_EXCEEDED`，`details` 仅包含：

```json
{
  "original_event_type": "dataflow_step_found",
  "actual_bytes": 70000,
  "max_event_bytes": 65536
}
```

原始超限 payload 不写 stdout、stderr 或降级事件。

## 6. 消费者规则

- 逐行读取，不得把整个 stdout 当成单个 JSON 文档。
- 每行独立 `json.loads()`；任一行失败都应视为通道污染或截断。
- 使用 `sequence` 检测缺失、重复或乱序，不使用时间戳排序。
- 使用 `event_id` 去重；业务关联使用 run/candidate/path ID。
- 忽略未知可选字段；遇到不支持的主 `schema_version` 时返回结构化错误。
- `analysis_failed` 不一定终止整个 run；以最终 `run_completed` 和 `AuditRun.status` 判断运行结果。
- 不根据事件展示文字推导额外发现，候选、路径和验证对象才是事实来源。

## 7. 未验证项与下一步

- 按项目约束，本任务不运行测试套件，不调用 RepoAudit、Tree-sitter 或 LLM。
- 并发顺序、超限降级、序列化失败和 stdout/stderr 隔离测试留待 TASK-011，届时标记 `NOT RUN`。
- TASK-004 应在独立仓库检查服务完成后发出 `repository_inspected`，并且不得调用 LLM 或完整扫描。
