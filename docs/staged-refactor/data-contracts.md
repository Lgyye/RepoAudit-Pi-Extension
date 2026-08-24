# TASK-002：公共数据协议

本文定义 RepoAudit 分阶段引擎、旧 CLI 兼容层和后续 Pi 插件共同使用的 JSON 协议。Python 实现在 `src/protocol/`，当前协议版本为 `1.0.0`。

## 1. 设计边界

- 每个公共对象都包含 `schema_version`。
- 每个对象都提供 `to_dict()` 和 `to_json()`；输出只包含 JSON 原生类型和嵌套公共对象。
- 公共对象不得包含 Tree-sitter `Node`、Python 异常对象、`Function`、`Value`、`DFBScanState`、调用上下文或其他内部状态类。
- 源码路径相对于被检查仓库根目录，使用 `/` 分隔，禁止绝对路径和 `..`。
- 源码行号、列号和数据流步骤编号均从 1 开始。
- 时间使用 RFC 3339 UTC 字符串，例如 `2026-08-24T11:30:00Z`。
- 代码字段使用稳定的机器可读字符串；展示文本单独放入 `summary`、`description` 或 `message`。
- `StructuredError` 不携带 traceback、API Key、完整 Prompt、完整模型响应或隐藏思维链。

旧 `detect_info.json` 继续遵守 [`baseline.md`](baseline.md) 中冻结的格式；本协议是并行新增的稳定接口，不会替换或删除旧输出。

## 2. 版本规则

`schema_version` 采用语义版本：

- 修订号：只修正文档或放宽兼容校验，不改变已有字段含义。
- 次版本：增加可选字段或新的枚举值，旧消费者仍可解析。
- 主版本：删除/重命名字段、改变字段类型或含义，需要迁移。

消费者必须忽略自己不认识的可选字段，但遇到不支持的主版本时应返回结构化错误。嵌套对象也携带自己的 `schema_version`，以便将来独立迁移。

## 3. 标识符

### `run_id`

- 格式：`run_<32 个小写十六进制字符>`。
- 由 `new_run_id()` 使用 UUID4 创建。
- 标识一次检查或扫描运行；创建后不得改变。
- 示例：`run_0123456789abcdef0123456789abcdef`。

### `candidate_id`

- 格式：`cand_<24 个小写十六进制字符>`。
- 由 `make_candidate_id()` 对规范化身份字段做 SHA-256，并取前 24 位。
- 身份字段：`run_id`、`bug_type`、source/sink 位置、source/sink 符号、关系类型、source/sink 函数名。
- `reason_codes` 和展示文本不参与哈希。
- 在同一个 run 内，相同候选必须得到相同 ID；不同 run 中的同一源码候选使用不同 ID。

### `path_id`

- 格式：`path_<24 个小写十六进制字符>`。
- 由 `make_path_id()` 对 `run_id`、`candidate_id` 和有序步骤身份字段做 SHA-256，并取前 24 位。
- 步骤身份字段：步骤编号、类型、位置、函数名和值。
- `description`、路径状态和 `reason_codes` 不参与哈希。
- 在同一个 candidate 内，相同有序路径必须得到相同 ID。

### `error_id`

- 格式：`err_<32 个小写十六进制字符>`。
- 由 `new_error_id()` 使用 UUID4 创建。
- `AuditRun.error_ids` 只引用 ID，详细错误单独存储。

## 4. 枚举代码

| 字段 | 允许值 |
| --- | --- |
| `AuditRun.status` | `created`、`running`、`completed`、`failed` |
| `AuditRun.stage` | `created`、`inspect`、`candidates`、`analyze`、`validate`、`full_scan` |
| `SourceSinkPair.relation` | `must_reach`、`must_not_reach` |
| `DataFlowPath.status` | `complete`、`partial` |
| `ValidationResult.verdict` | `reachable`、`not_reachable`、`inconclusive` |

验证结论语义：

- `reachable`：已有足够依据认为该 source-to-sink 路径可执行。
- `not_reachable`：已有足够依据认为路径条件冲突或传播被阻断。
- `inconclusive`：信息不足、模型输出无法可靠解析、重试耗尽或验证阶段局部失败。

`verdict` 只表示路径可达性，不直接等同于“漏洞成立”。调用方还必须结合 `SourceSinkPair.relation`：`must_not_reach` 的可达路径通常是缺陷，`must_reach` 的不可达/缺失路径才可能是缺陷。

## 5. 数据结构

### 5.1 `SourceLocation`

表示仓库内的源码范围。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema_version` | string | 是 | 当前为 `1.0.0` |
| `relative_path` | string | 是 | 仓库相对路径，统一 `/` |
| `start_line` | integer | 是 | 起始行，从 1 开始 |
| `end_line` | integer/null | 是 | 结束行；非空时不得小于起始行 |
| `start_column` | integer/null | 是 | 起始列，从 1 开始；未知时为 null |
| `end_column` | integer/null | 是 | 结束列，从 1 开始；未知时为 null |

示例：

```json
{
  "schema_version": "1.0.0",
  "relative_path": "src/service/account.py",
  "start_line": 42,
  "end_line": 42,
  "start_column": 12,
  "end_column": 20
}
```

### 5.2 `SourceSinkPair`

表示候选中的 source、sink 和预期关系。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `source` | SourceLocation | 是 | source 位置 |
| `sink` | SourceLocation | 是 | sink 位置 |
| `source_symbol` | string | 是 | 规范化 source 名称或表达式 |
| `sink_symbol` | string | 是 | 规范化 sink 名称或表达式 |
| `relation` | string | 是 | `must_reach` 或 `must_not_reach` |

示例：

```json
{
  "schema_version": "1.0.0",
  "source": {
    "schema_version": "1.0.0",
    "relative_path": "src/service/account.py",
    "start_line": 42,
    "end_line": 42,
    "start_column": 12,
    "end_column": 20
  },
  "sink": {
    "schema_version": "1.0.0",
    "relative_path": "src/service/account.py",
    "start_line": 57,
    "end_line": 57,
    "start_column": 5,
    "end_column": 18
  },
  "source_symbol": "user",
  "sink_symbol": "user.name",
  "relation": "must_not_reach"
}
```

### 5.3 `RepositoryProfile`

表示不调用 LLM、也不运行完整漏洞扫描时得到的仓库概况。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `run_id` | string | 所属运行 |
| `repository_root` | string | 本机仓库根路径；它不是源码位置字段，可以是绝对路径 |
| `language` | string | `Cpp`、`Java`、`Python` 或 `Go` |
| `source_files` | string[] | 可分析源码文件的相对路径 |
| `file_type_counts` | object | 扩展名到非负文件数的映射 |
| `function_count` | integer | 非负函数数 |
| `call_relation_count` | integer | 非负调用关系数 |
| `ignored_directories` | string[] | 实际忽略的仓库相对目录 |
| `parse_failed_files` | string[] | 解析失败文件的相对路径；错误详情进入 `StructuredError` |
| `supported_bug_types` | string[] | 该语言支持的漏洞类型 |
| `inspected_at` | string | 检查完成时间 |

示例：

```json
{
  "schema_version": "1.0.0",
  "run_id": "run_0123456789abcdef0123456789abcdef",
  "repository_root": "C:/work/example",
  "language": "Python",
  "source_files": [
    "src/service/account.py",
    "src/main.py"
  ],
  "file_type_counts": {
    ".py": 2
  },
  "function_count": 14,
  "call_relation_count": 21,
  "ignored_directories": [
    ".git",
    ".venv"
  ],
  "parse_failed_files": [],
  "supported_bug_types": [
    "NPD"
  ],
  "inspected_at": "2026-08-24T11:30:00Z"
}
```

### 5.4 `AuditRun`

表示一次运行的生命周期，不内嵌仓库概况、候选、路径或错误全文。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `run_id` | string | 运行 ID |
| `repository_root` | string | 本机仓库根路径 |
| `language` | string | 目标语言 |
| `bug_type` | string/null | 未选择漏洞类型时为 null |
| `stage` | string | 当前/最后阶段 |
| `status` | string | 运行状态 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 最后更新时间 |
| `completed_at` | string/null | 结束时间；未结束时为 null |
| `error_ids` | string[] | 关联的结构化错误 ID |

示例：

```json
{
  "schema_version": "1.0.0",
  "run_id": "run_0123456789abcdef0123456789abcdef",
  "repository_root": "C:/work/example",
  "language": "Python",
  "bug_type": "NPD",
  "stage": "analyze",
  "status": "running",
  "created_at": "2026-08-24T11:30:00Z",
  "updated_at": "2026-08-24T11:31:10Z",
  "completed_at": null,
  "error_ids": []
}
```

### 5.5 `AuditCandidate`

表示一个可通过 `candidate_id` 独立引用和分析的漏洞候选。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `run_id` | string | 所属运行 |
| `candidate_id` | string | run 范围内稳定的候选 ID |
| `bug_type` | string | 漏洞类型代码 |
| `source_sink_pair` | SourceSinkPair | source/sink 结构 |
| `source_function` | string/null | source 所在函数 |
| `sink_function` | string/null | sink 所在函数 |
| `reason_codes` | string[] | 候选产生原因；供机器判断，不放长解释 |

示例：

```json
{
  "schema_version": "1.0.0",
  "run_id": "run_0123456789abcdef0123456789abcdef",
  "candidate_id": "cand_111122223333444455556666",
  "bug_type": "NPD",
  "source_sink_pair": {
    "schema_version": "1.0.0",
    "source": {
      "schema_version": "1.0.0",
      "relative_path": "src/service/account.py",
      "start_line": 42,
      "end_line": 42,
      "start_column": 12,
      "end_column": 20
    },
    "sink": {
      "schema_version": "1.0.0",
      "relative_path": "src/service/account.py",
      "start_line": 57,
      "end_line": 57,
      "start_column": 5,
      "end_column": 18
    },
    "source_symbol": "user",
    "sink_symbol": "user.name",
    "relation": "must_not_reach"
  },
  "source_function": "load_user",
  "sink_function": "render_user",
  "reason_codes": [
    "NULL_SOURCE_EXTRACTED",
    "DEREFERENCE_SINK_EXTRACTED"
  ]
}
```

### 5.6 `DataFlowStep`

表示内部传播事实转换后的一个公共步骤。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `step_index` | integer | 从 1 开始且在路径中连续 |
| `kind` | string | 建议使用 `source`、`assignment`、`argument`、`parameter`、`return`、`call`、`sink` |
| `location` | SourceLocation | 该步骤对应的源码位置 |
| `function_name` | string/null | 所在函数 |
| `value` | string/null | 规范化的值或表达式 |
| `description` | string/null | 简短事实说明；不得放隐藏思维链 |

示例：

```json
{
  "schema_version": "1.0.0",
  "step_index": 1,
  "kind": "source",
  "location": {
    "schema_version": "1.0.0",
    "relative_path": "src/service/account.py",
    "start_line": 42,
    "end_line": 42,
    "start_column": 12,
    "end_column": 20
  },
  "function_name": "load_user",
  "value": "user",
  "description": "A nullable return value is assigned to user."
}
```

### 5.7 `DataFlowPath`

表示一个候选的有序传播路径。`partial` 表示分析只得到部分路径，不得被消费者误当作完整验证输入。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `run_id` | string | 所属运行 |
| `candidate_id` | string | 所属候选 |
| `path_id` | string | 候选范围内稳定的路径 ID |
| `steps` | DataFlowStep[] | 至少一个、按 `step_index` 连续排序的步骤 |
| `status` | string | `complete` 或 `partial` |
| `interprocedural` | boolean | 是否跨函数 |
| `reason_codes` | string[] | 分析结果或降级原因 |

示例：

```json
{
  "schema_version": "1.0.0",
  "run_id": "run_0123456789abcdef0123456789abcdef",
  "candidate_id": "cand_111122223333444455556666",
  "path_id": "path_aaaabbbbccccddddeeeeffff",
  "steps": [
    {
      "schema_version": "1.0.0",
      "step_index": 1,
      "kind": "source",
      "location": {
        "schema_version": "1.0.0",
        "relative_path": "src/service/account.py",
        "start_line": 42,
        "end_line": 42,
        "start_column": 12,
        "end_column": 20
      },
      "function_name": "load_user",
      "value": "user",
      "description": "A nullable return value is assigned to user."
    },
    {
      "schema_version": "1.0.0",
      "step_index": 2,
      "kind": "sink",
      "location": {
        "schema_version": "1.0.0",
        "relative_path": "src/service/account.py",
        "start_line": 57,
        "end_line": 57,
        "start_column": 5,
        "end_column": 18
      },
      "function_name": "render_user",
      "value": "user.name",
      "description": "The nullable value is dereferenced."
    }
  ],
  "status": "complete",
  "interprocedural": true,
  "reason_codes": [
    "SOURCE_REACHES_SINK"
  ]
}
```

### 5.8 `ValidationResult`

表示对一个 `path_id` 的独立验证结果。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `run_id` | string | 所属运行 |
| `candidate_id` | string | 所属候选 |
| `path_id` | string | 被验证路径 |
| `verdict` | string | 三态可达性结论 |
| `summary` | string | 简短结论，不含隐藏思维链 |
| `reason_codes` | string[] | 接受、拒绝或不确定原因 |
| `evidence` | string[] | 可公开核对的源码事实 |
| `retry_count` | integer | 非负重试次数 |
| `validator` | string/null | 验证器或模型的公开名称 |
| `validated_at` | string | 验证时间 |

示例：

```json
{
  "schema_version": "1.0.0",
  "run_id": "run_0123456789abcdef0123456789abcdef",
  "candidate_id": "cand_111122223333444455556666",
  "path_id": "path_aaaabbbbccccddddeeeeffff",
  "verdict": "reachable",
  "summary": "No guard prevents the nullable value from reaching the dereference.",
  "reason_codes": [
    "NO_NULL_GUARD",
    "PATH_CONDITIONS_COMPATIBLE"
  ],
  "evidence": [
    "src/service/account.py:42 assigns a nullable value to user.",
    "src/service/account.py:57 dereferences user without a preceding guard."
  ],
  "retry_count": 0,
  "validator": "path-validator",
  "validated_at": "2026-08-24T11:32:00Z"
}
```

### 5.9 `StructuredError`

表示可写入 `errors.json` 或作为 CLI/事件载荷返回的失败。错误文本应对用户有用，但不得复制完整 Prompt、模型原始响应、环境变量或 traceback。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `error_id` | string | 唯一错误 ID |
| `code` | string | 稳定机器错误码 |
| `message` | string | 脱敏后的用户可读说明 |
| `stage` | string | 失败阶段 |
| `retriable` | boolean | 相同输入稍后重试是否可能成功 |
| `details` | object | 仅允许 JSON 原生值的脱敏上下文 |
| `run_id` | string/null | 可用时关联运行 |
| `candidate_id` | string/null | 可用时关联候选 |
| `path_id` | string/null | 可用时关联路径 |
| `cause_type` | string/null | 异常类型名，不含 traceback |

示例：

```json
{
  "schema_version": "1.0.0",
  "code": "MODEL_RESPONSE_PARSE_FAILED",
  "message": "The validator response could not be parsed after retrying.",
  "stage": "validate",
  "error_id": "err_0123456789abcdef0123456789abcdef",
  "retriable": true,
  "details": {
    "retry_count": 2,
    "response_included": false
  },
  "run_id": "run_0123456789abcdef0123456789abcdef",
  "candidate_id": "cand_111122223333444455556666",
  "path_id": "path_aaaabbbbccccddddeeeeffff",
  "cause_type": "ValueError"
}
```

## 6. Python 使用方式

```python
from protocol import SourceLocation

location = SourceLocation(
    relative_path="src/service/account.py",
    start_line=42,
)

payload = location.to_dict()
json_text = location.to_json(indent=2)
```

构造函数会拒绝绝对源码路径、越出仓库的路径、从 0 开始的行列、非法 ID、未知的固定枚举值以及不可 JSON 序列化的 `StructuredError.details`。

## 7. 后续阶段约束

- TASK-003 的事件载荷必须引用或嵌入本协议对象，不得发出内部对象的 `repr()`。
- TASK-004 创建 `RepositoryProfile` 时，`source_files`、忽略目录和解析失败文件必须先转换为相对路径。
- TASK-005 必须调用 `make_candidate_id()`，不得使用 Python `hash()`；后者跨进程不稳定。
- TASK-006 必须调用 `make_path_id()`，并把内部传播记录逐项转换为 `DataFlowStep`。
- TASK-007 只能返回三态 `ValidationResult`，不得输出隐藏思维链、API Key 或完整 Prompt。
- TASK-008 持久化 `to_dict()` 的结果，并在读入时检查 `schema_version` 和 ID 格式。
- TASK-009 必须继续生成旧 `detect_info.json`；公共协议输出是增量能力。

## 8. 本任务验证状态

- 当前环境按执行规则不运行测试。
- TASK-002 未调用 RepoAudit、Tree-sitter 或 LLM。
- JSON 示例和 Python 行为测试留待 TASK-011，届时必须标记 `NOT RUN`，直到测试环境恢复。
