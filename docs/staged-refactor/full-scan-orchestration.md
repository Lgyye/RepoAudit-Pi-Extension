# TASK-009：完整扫描重组

## 1. 新旧引擎切换

旧单层 CLI、参数和默认行为继续保留。新增一个可选参数：

```text
--dfb-engine {legacy,staged}
```

- 默认值为 `legacy`，原命令不增加任何参数时仍执行 `DFBScanAgent.start_scan()`。
- `--dfb-engine staged` 调用新增的 `agent.dfbscan.run_full_scan()`。
- `metascan` 不受该开关影响。
- 旧 `DFBScanAgent`、`start_scan()`、旧结果路径和旧参数均未删除。

示例：

```bash
python src/repoaudit.py \
  --scan-type dfbscan \
  --dfb-engine staged \
  --project-path /path/to/project \
  --language Python \
  --model-name claude-3.7 \
  --bug-type NPD \
  --is-reachable
```

## 2. `run_full_scan()` 顺序

新完整扫描按以下顺序组合已完成的公共服务：

1. 创建 `AuditRun` 和 `runs/<run_id>/`；
2. 发出 `run_started`；
3. `inspect_repository()` 并保存 `repository.json`；
4. `extract_candidates()` 并保存 `candidates.json`；
5. 对每个候选单独调用 `analyze_candidate()`，累计保存 `paths.json`；
6. 对该候选的每条路径单独调用 `validate_path()`，累计保存 `validations.json`；
7. 从结构化事件收集 `StructuredError` 并保存 `errors.json`；
8. 写入旧 `detect_info.json`；
9. 更新 `run.json` 并发出 `run_completed`。

新流程当前按候选和路径顺序执行。旧参数 `--max-neural-workers` 继续接收和校验，但 staged 引擎暂不并发模型请求，以保护单候选隔离、事件顺序和进程内上下文；并发编排需在测试可运行后另行设计。

## 3. 事件、日志与运行存储

- 结构化事件仍通过 `EventWriter` 写 stdout，同时镜像到当前运行的 `events.jsonl`。
- 普通固定诊断写 stderr 或 staged `dfbscan.log`，不进入 stdout。
- staged 模型工具使用无输出 logger，旧 `LLMTool` 不会把完整 Prompt、原始响应或模型分析过程写入 stdout、事件或 staged 日志。
- 每个事件实际写出后同时保存在内存事件索引中；其中的 `analysis_failed` 错误按 `error_id` 去重后保存到 `errors.json`。
- 每次阶段切换和最终完成都会原子更新 `run.json`。

## 4. 错误隔离与完成状态

- 仓库检查、候选生成、模型工具初始化、存储或完整流程适配失败属于 run 级失败；发出脱敏 `analysis_failed`，最终 `run_completed.status = failed`。
- 单个候选分析失败时记录错误并继续下一个候选。
- 单条路径验证失败时记录错误并继续当前候选的其他路径。
- 模型响应解析失败由 TASK-007 返回 `inconclusive`，不计为发现，但对应结构化错误仍写入运行状态。
- 非致命候选/路径错误不会自动终止 run；最终事件的 `error_count` 仍公开错误数量。

完成状态：

| 条件 | `AuditRun.status` | `run_completed.status` |
| --- | --- | --- |
| 完成且至少一个发现 | `completed` | `success_with_findings` |
| 完成且没有发现 | `completed` | `success_no_findings` |
| run 级阶段失败 | `failed` | `failed` |

## 5. 旧 `detect_info.json` 兼容

staged 引擎仍在原 `result/dfbscan/<model>/<bug>/<language>/<project>/<timestamp>-0/` 树下写 `detect_info.json`，包括零发现时的空对象 `{}`。

每个接受的验证结果转换为旧五字段：

- `bug_type`：候选漏洞类型；
- `buggy_value`：候选 source 转为旧 `Value.__str__()`；
- `relevant_functions`：路径步骤映射到 analyzer 中的函数，再交给旧 `BugReport.to_dict()`；
- `explanation`：只使用脱敏的 `ValidationResult.summary`，不复制模型原始响应；
- `is_human_confirmed_true`：保持旧字符串 `"False"`。

文件仍是以字符串报告编号为 key 的顶层 JSON 对象，并以 4 空格缩进写入。staged 写入使用临时文件、flush、`fsync` 和 `os.replace()`，避免半文件。

多个接受路径转换出相同的旧 `BugReport` 时，继续沿用旧状态对象的等价规则去重，再按稳定处理顺序重新编号。

发现判定继续尊重旧 `--is-reachable`：开关为真时接受 `reachable`，否则接受 `not_reachable`。

## 6. 已知兼容边界

- TASK-005 的公共 `SourceSinkPair` 必须同时有 source 和 sink，TASK-006 又只为实际到达指定 sink 的传播事实生成完整路径。因此 staged 引擎当前不能把“未到达释放点”这种关系缺失本身转换成可验证的 `Cpp/MLK` 路径；零 sink 仓库是其中最直接的情况。MLK 扫描应继续使用默认 `legacy` 引擎。这里没有引入虚假 sink、伪造否定路径或改变既定协议。
- staged 引擎只对 TASK-006 已产生的完整路径调用 Path Validator；没有公共路径时不会伪造验证输入。
- staged 日志不再复制完整 Prompt/响应，这是安全收紧；旧 `legacy` 引擎日志行为保持不变。
- staged 零发现时会明确写 `{}`，旧引擎历史上可能不创建文件；消费者看到文件时的顶层对象和五字段形状保持兼容。
- staged 结果路径中的语言、漏洞类型和模型名必须是单个路径组件；包含 `/`、`\\`、`.` 或 `..` 的值会在创建运行产物前被拒绝。旧 `legacy` 引擎不受该收紧影响。

## 7. 修改文件

- `src/agent/dfbscan.py`
- `src/repoaudit.py`
- `docs/staged-refactor/full-scan-orchestration.md`

未修改 README、旧公共协议、`pi-extension/` 或 `SecHeur-Agent-pro/`，也未删除任何旧入口。

## 8. 未验证项与下一步

- 按项目约束，本任务不运行测试套件，不调用 RepoAudit、Tree-sitter、Path Validator 或其他 LLM。
- 新旧开关、事件镜像、阶段持久化、单候选错误隔离、三种完成状态、旧结果转换、敏感日志排除和 MLK 回退边界测试留到 TASK-011，并标记 `NOT RUN`。
- `max_neural_workers` 在 staged 引擎中的并发语义、同秒多次扫描的旧结果目录碰撞以及进程异常中断后的恢复留待后续验证。
- 下一步 TASK-010 应增加 `inspect`、`candidates`、`analyze`、`validate`、`full-scan` 分阶段 CLI，并保留本任务的旧单层兼容模式。

本任务只进行格式、差异和依赖边界等静态检查；这些检查不得描述成“测试通过”。
