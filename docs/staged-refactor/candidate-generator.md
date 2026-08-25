# TASK-005：候选生成服务

## 1. 任务范围

本任务新增独立候选生成服务：

```python
extract_candidates(profile, bug_type) -> list[AuditCandidate]
```

其中 `profile` 是 TASK-004 生成的 `RepositoryProfile`。两参数形式会根据 profile 中的仓库根路径、语言和 `source_files` 重建 Tree-sitter analyzer，再调用已有 DFBScan extractor；调用方不需要额外构造或传入 `TSAnalyzer`。服务不创建 `DFBScanAgent`，不执行数据流传播、路径验证、完整扫描或 LLM 调用。

完整签名额外提供仅限关键字的 `event_writer` 和 `max_symbolic_workers`，供未来完整流程共享事件序号和并发配置；主调用形式保持原任务规定的两个参数。

## 2. 输入与兼容校验

- `profile` 必须是公共 `RepositoryProfile`，候选继承其 `run_id`、语言和仓库根路径。
- `bug_type` 必须同时符合既有语言/漏洞支持矩阵和 `profile.supported_bug_types`。
- 支持组合保持不变：`Cpp/MLK`、`Cpp/NPD`、`Cpp/UAF`、`Java/NPD`、`Python/NPD`、`Go/NPD`。
- 只重新读取 `profile.source_files` 中列出的源码；文件缺失、不是普通文件或越出仓库根目录时拒绝生成，并输出结构化失败。
- 重建的 analyzer 仅用于当前调用，不放入 `RepositoryProfile`、`AuditCandidate` 或结构化事件。

## 3. 候选生成口径

1. 根据 profile 重建对应语言的 `TSAnalyzer`，再复用相应 `DFBScanExtractor.extract_all()` 提取 source 和 sink。
2. 保留旧 extractor 对路径中包含 `test` 或 `example` 的函数的跳过行为。
3. 对所有提取出的 source 和 sink 建立笛卡尔积，形成不做语义过滤的候选超集。跨函数可达性、真实数据流关系和路径可执行性分别留给 TASK-006 与 TASK-007。
4. source/sink 符号统一换行形式并去除首尾空白，内部表达式内容保持不变。
5. 相同公共身份字段产生的重复候选按 `candidate_id` 去重，并按源码位置、符号、函数名和 ID 稳定排序。
6. 必须调用公共 `make_candidate_id()`；不使用跨进程不稳定的 Python `hash()`。

关系和原因码如下：

| 漏洞类型 | relation | reason_codes |
| --- | --- | --- |
| `NPD` | `must_not_reach` | `NULL_SOURCE_EXTRACTED`、`DEREFERENCE_SINK_EXTRACTED` |
| `UAF` | `must_not_reach` | `DEALLOCATION_SOURCE_EXTRACTED`、`USE_SINK_EXTRACTED` |
| `MLK` | `must_reach` | `ALLOCATION_SOURCE_EXTRACTED`、`DEALLOCATION_SINK_EXTRACTED` |

extractor 当前只提供单行 `Value` 信息，因此 `SourceLocation` 记录一行范围，列号保持 `null`，不向公共对象暴露 Tree-sitter 节点。

## 4. 结构化事件

- 每个去重后的候选发出一次 `candidate_extracted`，事件引用和 payload 使用同一个 `candidate_id`。
- 未传入 `event_writer` 时使用默认 `EventWriter`；串联阶段时应传入共享 writer，以保持事件序号连续。
- 提取或公共结构转换失败时，向 stderr 写安全诊断并发出 `analysis_failed`；错误不包含异常文本、traceback、源码或内部 AST 状态。
- 本阶段不发出 `source_sink_matched`；该事件应由 TASK-006 在确认真实关系后发出。

## 5. 修改文件

- `src/service/__init__.py`
- `src/service/candidate_service.py`
- `src/service/candidate_generator.py`
- `docs/staged-refactor/candidate-generator.md`

未修改 `pi-extension/`、`SecHeur-Agent-pro/`、旧 CLI、旧完整扫描或 `DFBScanAgent`。

## 6. 未验证项与下一步

- 按项目约束，本任务不运行测试套件，不调用 RepoAudit、Tree-sitter 或 LLM。
- profile 源码重载、analyzer 重建、extractor 选择、支持矩阵拒绝、路径规范化、稳定 ID、候选去重/排序、空 source/sink、事件内容和失败降级测试留到 TASK-011，届时标记 `NOT RUN`。
- 笛卡尔积优先保证候选召回率，但大型仓库可能产生较多候选；TASK-006 可依据实际数据流拒绝无效组合，后续如需无损剪枝必须另行记录规则。
- `MLK` 仓库若未提取到任何释放 sink，当前公共 pair 协议无法形成候选；此兼容边界留待 TASK-006/TASK-009 集成时处理，不在本任务中引入虚假 sink。
- 下一步 TASK-006 应实现单候选分析，接收一个 `AuditCandidate`，并逐项转换内部传播事实为公共 `DataFlowStep`/`DataFlowPath`，不得在该服务中重新执行全仓库候选提取。

## 7. 已完成的非测试检查

- Black 格式检查。
- Git 空白错误检查。
- Git 暂存范围和受保护目录检查。

以上仅为静态检查，不表示测试通过。运行时行为仍按上一节留待 TASK-011 验证。

## 8. 原始任务复核修正

2026-08-25 对照原始分阶段 Prompt 复核时发现，首个 TASK-005 提交使用了 `candidate_generator.py` 和 `generate_candidates(repository, bug_type, ts_analyzer)`，没有满足原任务指定的 `candidate_service.py` 与两参数独立调用形式。本次修正增加规定入口 `extract_candidates(profile, bug_type)`，并把原 generator 保留为不从 `service` 包公开导出的内部转换层，避免改写已经推送的 Git 历史。
