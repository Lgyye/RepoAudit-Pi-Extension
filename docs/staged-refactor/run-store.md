# TASK-008：运行状态存储

## 1. 公共接口

本任务新增 `src.storage.RunStore`。默认存储根目录为仓库根目录下的 `runs/`，也可为隔离环境显式传入其他根目录：

```python
from src.storage import RunStore

store = RunStore()
store.create_run(run)
store.save_repository(repository)
store.save_candidates(run_id, candidates)
store.save_paths(run_id, paths)
store.save_validations(run_id, validations)
store.save_events(run_id, events)
store.save_errors(run_id, errors)

snapshot = store.load_snapshot(run_id)
```

`RunSnapshot` 返回反序列化并重新执行公共构造校验的 `AuditRun`、`RepositoryProfile`、候选、路径、验证、事件和错误。也可分别调用 `load_run()`、`load_repository()`、`load_candidates()`、`load_paths()`、`load_validations()`、`load_events()` 和 `load_errors()`。

## 2. 目录与文件格式

`create_run()` 一次性发布以下目录：

```text
runs/<run_id>/
├── run.json
├── repository.json
├── candidates.json
├── paths.json
├── validations.json
├── events.jsonl
└── errors.json
```

- `run.json` 直接保存 `AuditRun.to_dict()`。
- `repository.json` 使用 `{schema_version, run_id, repository}` 信封；检查阶段未保存前 `repository` 为 `null`。
- `candidates.json`、`paths.json`、`validations.json`、`errors.json` 使用 `{schema_version, run_id, <复数键>: []}` 信封。
- `events.jsonl` 每行直接保存一个 `AnalysisEvent` JSON；新运行初始化为空文件。
- `runs/` 加入 `.gitignore`，运行产物不会进入源码提交。

集合保存时按稳定 ID 排序并拒绝重复 ID。所有对象必须与目标 `run_id` 一致；事件序号必须从 1 开始连续递增。

## 3. 原子写入与运行隔离

- `create_run()` 先在 `runs/` 下构建唯一临时目录，7 个文件全部写好后再重命名发布；已有相同 `run_id` 时拒绝覆盖。
- 每次保存 JSON 或整份 JSONL 时，先在目标文件同目录创建唯一临时文件，完成 UTF-8 写入、flush 和 `fsync` 后使用 `os.replace()` 原子替换。
- `append_event()` 在序列化成功并验证下一事件序号后以单行追加，随后 flush 和 `fsync`。
- `run_id` 必须通过公共 ID 校验，因此不能通过 `..`、绝对路径或分隔符越出存储根目录。
- 不同运行始终写入各自的 `<run_id>/`；保存对象的 `run_id` 不匹配时拒绝写入。
- 本任务不自动删除或轮换任何已发布运行目录。

`RunStore` 使用进程内可重入锁保护同一实例的读写。原子替换可防止读取到半个 JSON 文件，但本阶段不承诺多个独立进程同时对同一运行做无冲突合并；分阶段 CLI 的单写者编排留到 TASK-010。

## 4. 加载与协议校验

加载时不直接信任 JSON 字典：

1. 检查 JSON/JSONL 是否可解析；
2. 检查 `schema_version == "1.0.0"`；
3. 检查信封和内部对象的 `run_id`；
4. 逐层重建 `SourceLocation`、`SourceSinkPair`、`DataFlowStep` 等嵌套公共对象；
5. 重新调用公共 dataclass 构造函数，校验路径、行号、连续步骤、枚举和 ID；
6. 事件重新构造嵌套 payload，并检查事件必需字段和引用关系；
7. JSONL 不允许空记录，事件序号必须从 1 连续到记录总数；
8. `load_snapshot()` 检查每条 path 的 candidate 及每个 validation 的 path 引用存在；
9. 运行目录和 7 个状态文件不得是符号链接，解析后必须仍位于存储根目录内。

`repository.json` 尚未写入检查结果时，`load_repository()` 返回结构化的 `RUN_STORE_STAGE_NOT_AVAILABLE` 错误，而不是伪造空 `RepositoryProfile`。

## 5. 结构化错误

缺失目录/文件、损坏 JSON/JSONL、不支持的 schema、跨运行对象、重复 ID、事件序号错误和写入失败均抛出 `RunStoreError`。其 `error` 属性是可序列化的 `StructuredError`，只包含：

- 稳定错误码和公开消息；
- `stage = "storage"`；
- 可用时的 `run_id`；
- 目标文件名、JSONL 行号或期望事件序号等安全细节；
- 异常类型名，不包含异常文本、绝对路径、环境变量或 traceback。

调用方可把该错误加入同一运行的 `errors.json`；存储层不会在读取损坏文件时尝试修改该运行，避免掩盖原始故障。

## 6. 修改文件

- `src/storage/__init__.py`
- `src/storage/run_store.py`
- `docs/staged-refactor/run-store.md`
- `.gitignore`

未修改 README、旧 CLI、旧完整扫描、`DFBScanAgent`、`pi-extension/` 或 `SecHeur-Agent-pro/`。

## 7. 未验证项与下一步

- 按项目约束，本任务不运行测试套件，不调用 RepoAudit、Tree-sitter、Path Validator 或 LLM。
- 原子替换、运行隔离、全部对象往返反序列化、缺失/损坏文件、schema/ID 不匹配、JSONL 序号、并发锁和敏感信息排除测试留到 TASK-011，并标记 `NOT RUN`。
- 当前服务层仍保留 TASK-006/007 的进程内上下文；本任务只建立持久化能力。TASK-009/010 组合阶段应在每个阶段完成后调用 `RunStore`，并在分阶段 CLI 启动时按 `run_id` 恢复公共对象。
- 下一步 TASK-009 应重组完整扫描入口，按顺序组合检查、候选、分析和验证服务，同时保留旧入口与 `detect_info.json`。

本任务只进行格式、差异、JSON 结构和依赖边界等静态检查；这些检查不得描述成“测试通过”。
