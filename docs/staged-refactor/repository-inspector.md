# TASK-004：仓库检查服务

## 1. 任务范围

本任务新增独立仓库检查服务：

```python
inspect_repository(project_path, language) -> RepositoryProfile
```

服务只执行路径/语言校验、源码发现、Tree-sitter 语法分析和调用图统计。它不创建 `DFBScanAgent`，不调用 LLM，也不运行完整扫描。旧 CLI、旧完整扫描入口和 `DFBScanAgent` 均未修改。

## 2. 接口与运行身份

完整签名为：

```python
inspect_repository(
    project_path,
    language,
    *,
    run_id=None,
    event_writer=None,
    max_symbolic_workers=30,
) -> RepositoryProfile
```

- 两参数主调用会生成新的 UUID `run_id`，并通过默认 `EventWriter` 向 stdout 发出结构化事件。
- 后续分阶段入口可以仅通过关键字传入既有 `run_id` 和共享 `EventWriter`，保证阶段间身份及事件序号连续。
- 检查完成后发出 `repository_inspected`，payload 的 `repository` 为返回的同一个 `RepositoryProfile`。
- 文件读取或硬解析失败时，先向 stderr 写安全诊断，再发出携带 `StructuredError` 的 `analysis_failed`；失败详情只包含仓库相对路径与异常类型，不包含异常文本或 traceback。

## 3. 支持矩阵

| 语言 | 源码扩展名 | 支持漏洞类型 |
| --- | --- | --- |
| `Cpp` | `.cpp`、`.cc`、`.hpp`、`.c`、`.h` | `MLK`、`NPD`、`UAF` |
| `Java` | `.java` | `NPD` |
| `Python` | `.py` | `NPD` |
| `Go` | `.go` | `NPD` |

语言和扩展名匹配继续保持旧入口的大小写规则，避免 TASK-004 隐式改变兼容行为。

## 4. 统计口径

- `source_files`：完成读取、且 Tree-sitter 未发生硬异常的可分析文件，按仓库相对路径排序。
- `file_type_counts`：按 `source_files` 的后缀统计。
- `function_count`：语言专用 `TSAnalyzer.function_env` 中的函数总数。
- `call_relation_count`：调用图中唯一“用户函数 → 用户函数”边与唯一“用户函数 → 库 API”边之和；同一函数对同一目标的重复调用只计一个关系。
- `ignored_directories`：遍历时实际遇到且按旧入口规则过滤的隐藏目录、缓存、构建目录、虚拟环境、依赖目录等，记录完整仓库相对路径。
- `parse_failed_files`：读取失败或 Tree-sitter 抛出硬解析异常的源码路径。Tree-sitter 可恢复并返回含 `ERROR` 节点的语法树仍视为可分析，不计为硬失败。
- 所有源码、忽略目录和失败文件路径统一使用 `/`，且不得逃逸仓库根目录。

## 5. 修改文件

- `src/service/__init__.py`
- `src/service/repository_inspector.py`
- `docs/staged-refactor/repository-inspector.md`

未修改 `pi-extension/`、`SecHeur-Agent-pro/`、旧 CLI、旧完整扫描或 `DFBScanAgent`。

## 6. 未验证项与下一步

- 按项目约束，本任务不运行测试套件，不调用 RepoAudit、Tree-sitter 或 LLM。
- 路径/语言拒绝、忽略目录发现、文件失败降级、函数/调用关系计数、事件内容与 stdout/stderr 隔离的待执行测试留到 TASK-011，届时标记 `NOT RUN`。
- 大型仓库的 `repository_inspected` 事件仍受 TASK-003 的 65,536 bytes 默认限制；超限时由 `EventWriter` 降级为 `analysis_failed`，不截断 JSON。
- 下一步 TASK-005 应在此服务之外提取候选生成逻辑，不得让仓库检查隐式启动候选提取或神经分析。

## 7. 已完成的非测试检查

- Black 格式检查。
- Git 空白错误检查。
- Git 暂存范围和受保护目录检查。

以上仅为静态检查，不表示测试通过。运行时行为仍按上一节留待 TASK-011 验证。
