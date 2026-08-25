# TASK-007：单路径验证服务

## 1. 公共接口

本任务新增：

```python
validate_path(run_id, candidate_id, path_id) -> ValidationResult
```

三个位置参数保持原始总任务规定的公共引用方式。完整 Python 签名另有仅限关键字的 `path_validator` 和 `event_writer`，供组合调用方传入已经配置模型、重试和日志的旧 `PathValidator` 实例，并共享结构化事件序号。

本阶段不猜测模型名称、不读取 API Key，也不创建隐藏默认模型配置。验证完整路径时若未提供 `path_validator=`，服务输出 `VALIDATION_RUNTIME_NOT_CONFIGURED` 的 `StructuredError`，不会调用 LLM。

当前实际组合形式为：

```python
from src.service import validate_path

result = validate_path(
    run_id,
    candidate_id,
    path_id,
    path_validator=configured_path_validator,
)
```

## 2. TASK-008 之前的加载边界

TASK-006 已把候选和生成路径保存在私有、线程安全的进程内运行上下文中。本服务：

1. 按 `run_id` 加载一个运行上下文；
2. 按 `candidate_id` 精确加载一个候选；
3. 只从该候选的路径映射中按 `path_id` 加载一条路径；
4. 验证结束后按同一组三个 ID 暂存一个 `ValidationResult`；
5. 不重新生成候选、不重新分析路径，也不验证同一候选或运行中的其他路径。

这些对象只在当前 Python 进程中存在，不创建 `runs/` 或任何持久化 JSON。TASK-008 可把私有路径/验证结果边界替换为 `RunStore`，而无需修改 `validate_path(run_id, candidate_id, path_id)`。

## 3. 旧验证器复用与三态转换

服务把公共 `DataFlowStep` 转换回旧 `PathValidatorInput` 所需的 `Value` 和函数映射，只保留：

- 仓库内源码路径；
- 从 1 开始的行号；
- 公共 value 和 kind 对应的 `ValueLabel`；
- Tree-sitter analyzer 按源码位置找到的函数。

`DataFlowStep` 没有单独公开旧 `Value.index`。服务会按函数参数、返回值以及函数/API 调用点的行号和规范化 value 回查索引；找到匹配项时按索引和名称稳定选择，否则保留旧 `Value` 的 `-1` 缺省值。转换对象仅在服务内部使用，不进入 `ValidationResult` 或事件，也不修改既定公共协议。

旧 `PathValidatorOutput` 的布尔值转换规则如下。由于旧解析器会把任意 `Answer: <word>` 当作成功并把非精确 `Yes` 归为 `False`，服务在内部对已有响应做一次严格的、不对外输出的 `Answer: Yes/No` 检查，其他答案统一视为不可解析，而不是误报 `not_reachable`。

| 旧输出 | `ValidationResult.verdict` | reason code |
| --- | --- | --- |
| `is_reachable = True` | `reachable` | `PATH_VALIDATOR_REACHABLE` |
| `is_reachable = False` | `not_reachable` | `PATH_VALIDATOR_NOT_REACHABLE` |
| 重试后仍无法解析 | `inconclusive` | `MODEL_RESPONSE_PARSE_FAILED` |
| 路径状态为 `partial` | `inconclusive` | `PARTIAL_PATH_NOT_VALIDATED` |

`partial` 路径不会提交给模型。模型调用抛出异常时输出 `PATH_VALIDATOR_INVOCATION_FAILED` 的结构化错误，不伪造成可达性结论。

## 4. 公开摘要、证据与敏感信息边界

旧 `PathValidatorOutput.explanation_str` 当前保存完整模型响应，可能包含分析过程或 Prompt 派生内容。本服务明确不复制、不返回、不写入结构化事件该字段。

公共结果只包含：

- 根据布尔/解析状态生成的固定简短摘要；
- 首尾路径步骤的仓库相对路径、行号和函数名；
- 公共路径的步骤数和函数数；
- 实际额外查询次数 `retry_count`；
- 固定公开验证器名 `PathValidator`。

不会输出完整 Prompt、完整模型响应、隐藏思维链、环境变量、API Key、traceback 或异常文本。调用旧 `PathValidator` 期间，服务在锁内临时把工具及其模型的 logger 替换为无输出代理，并在 `finally` 中恢复，阻止旧 `LLMTool` 把 Prompt、原始响应或包含响应的 `PathValidatorOutput` 写入旧日志。模型解析失败的 `StructuredError.details` 只记录 `retry_count` 和 `response_included = false`。

## 5. 结构化事件

每次实际验证一条路径时：

1. 加载成功后发出 `path_validation_started`；
2. 返回三态结果时发出带完整公共 `ValidationResult` 的 `path_validated`；
3. 模型响应无法解析时，先发出 `analysis_failed`，再以 `inconclusive` 发出 `path_validated`；
4. ID、加载、路径重建、运行时配置或模型调用失败时，发出脱敏 `analysis_failed` 并抛出携带 `StructuredError` 的服务异常。

## 6. 修改文件

- `src/service/validation_service.py`
- `src/service/analysis_service.py`
- `src/service/__init__.py`
- `docs/staged-refactor/path-validation.md`

未修改旧 CLI、`src/agent/dfbscan.py`、旧 `PathValidator`、`DFBScanAgent`、`pi-extension/` 或 `SecHeur-Agent-pro/`。

## 7. 未验证项与下一步

- 按项目约束，本任务不运行测试套件，不调用 RepoAudit、Tree-sitter、Path Validator 或其他 LLM。
- 三态转换、路径隔离、旧输入重建、重试计数、模型解析失败、敏感信息排除、事件内容和进程内结果登记测试留到 TASK-011，并标记 `NOT RUN`。
- 当前无法用实际模型响应验证旧 `PathValidator` 的重试计数与返回形态；这里只按现有 `LLMTool.total_query_num` 的调用前后差值计算额外重试次数。
- 下一步 TASK-008 应建立持久化 `RunStore`，保存 run、repository、candidates、paths、validations、events 和 errors，并替换当前进程内加载边界。

本任务只进行格式、差异和依赖边界等静态检查；这些检查不得描述成“测试通过”。
