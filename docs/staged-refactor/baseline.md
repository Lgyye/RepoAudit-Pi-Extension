# TASK-001：重构前行为基线

本文冻结 RepoAudit 在分阶段重构前的入口、参数和输出。后续重构可以新增协议和入口，但不得删除或破坏本文标记为“必须保留”的旧接口。

## 1. 基线身份与 Git 状态

- 记录日期：2026-08-24（Asia/Shanghai）
- 基线提交：`4d0b79c61d8a13e9773e694027f38ca08a18940a`
- 基线提交摘要：`feat: add RepoAudit Pi extension`
- 基线来源分支：`main`，当时与 `origin/main` 对齐
- TASK-001 执行分支：`refactor/repoaudit-staged-engine`
- `origin`：`https://github.com/Lgyye/RepoAudit-Pi-Extension`
- `upstream`：`https://github.com/PurCL/RepoAudit.git`

创建重构分支前，工作区已有以下未提交修改：

```text
 M pi-extension/README.md
 M pi-extension/src/extension/repoaudit-tool.ts
 M pi-extension/src/index.ts
 M pi-extension/tests/extension.test.ts
```

这些修改不是 TASK-001 的一部分，执行本任务时未改动、未暂存，也不得混入本任务提交。

## 2. 必须保留的完整扫描入口

以下旧入口是兼容性表面，分阶段重构期间必须保留：

1. 直接 CLI：`python src/repoaudit.py ...`
2. DFB 完整扫描参数形式：`--scan-type dfbscan`
3. Python 调用链：`main()` → `RepoAudit(args)` → `RepoAudit.start_repo_auditing()` → `DFBScanAgent.start_scan()`
4. MetaScan 调用链：`main()` → `RepoAudit(args)` → `RepoAudit.start_repo_auditing()` → `MetaScanAgent.start_scan()`
5. 辅助脚本：`src/run_repoaudit.sh [PROJECT_PATH] [BUG_TYPE]`

旧调用示例：

```bash
python src/repoaudit.py \
  --scan-type dfbscan \
  --project-path /path/to/project \
  --language Python \
  --model-name claude-3.7 \
  --bug-type NPD \
  --is-reachable \
  --temperature 0.0 \
  --call-depth 3 \
  --max-neural-workers 30
```

重构约束：在新阶段服务和新 CLI 可用后，上述入口仍须可调用；不得删除 `RepoAudit`、`RepoAudit.start_repo_auditing()`、`DFBScanAgent.start_scan()` 或旧参数语法。旧 `detect_info.json` 仍须继续生成。

## 3. `src/repoaudit.py` 的全部 CLI 参数

参数由单个 `argparse.ArgumentParser` 定义，当前没有子命令。

| 参数 | 类型/形式 | 必填 | 默认值 | 当前约束与语义 |
| --- | --- | --- | --- | --- |
| `--scan-type` | 字符串 | 是 | 无 | `argparse` choices：`metascan`、`dfbscan` |
| `--project-path` | 字符串 | 是 | 无 | 待扫描目录；当前代码不在入口处显式检查目录存在性 |
| `--language` | 字符串 | 是 | 无 | 没有 `argparse` choices；实际可用的精确值为 `Cpp`、`Java`、`Python`、`Go` |
| `--max-symbolic-workers` | 整数 | 否 | `30` | 传给 Tree-sitter 分析器的最大并行数 |
| `--model-name` | 字符串 | DFBScan 时是 | `None` | `dfbscan` 缺失时打印错误并退出 1；MetaScan 不使用 |
| `--temperature` | 浮点数 | 否 | `0.5` | LLM 推理温度 |
| `--call-depth` | 整数 | 否 | `3` | 跨函数传播的调用上下文深度上限 |
| `--max-neural-workers` | 整数 | 否 | `1` | DFBScan 的 LLM 并行 worker 数；README 的“默认 30”与源码不一致，以源码默认 `1` 为本基线 |
| `--bug-type` | 字符串 | DFBScan 时是 | `None` | 直接 CLI 大小写敏感，并按语言/漏洞矩阵校验 |
| `--is-reachable` | 布尔开关 | 否 | `False` | 出现时为 `True`；控制收集“source 到达 sink”路径，否则收集“source 未到 sink”路径 |

补充行为：

- `argparse` 负责缺少必填参数、非法 `--scan-type` 和类型转换错误，通常写 stderr 并退出 2。
- RepoAudit 自己的 DFB 参数校验使用 `print()` 写 stdout 并退出 1。
- 直接 CLI 不会规范化 `--language` 或 `--bug-type` 的大小写。
- `--language C` 不可用。尽管底层 `TSAnalyzer` 和旧架构文档提到 C，当前入口只对 `Cpp` 建立 C/C++ 分析器。
- DFBScan 支持矩阵校验发生在路径读取之前；未知语言在该校验处可能触发未捕获的 `KeyError`。

### 辅助脚本参数与固定值

`src/run_repoaudit.sh` 另提供两个位置参数：

| 位置 | 含义 | 默认值 | 处理方式 |
| --- | --- | --- | --- |
| 1 | `PROJECT_PATH` | `../benchmark/Python/toy` | 转为绝对路径并检查目录存在 |
| 2 | `BUG_TYPE` | `NPD` | 转大写，只允许 `MLK`、`NPD`、`UAF` |

脚本固定传入：`language=Python`、`model-name=claude-3.7`、`scan-type=dfbscan`、`temperature=0.0`、`call-depth=3`、`max-neural-workers=30` 和 `--is-reachable`。因此脚本虽然接受 `MLK`/`UAF`，二者会被 Python 支持矩阵拒绝；这是现存行为，不应被误写成已支持。

## 4. 语言与漏洞类型支持矩阵

### 实际入口支持

| `--language` | 扫描的扩展名 | NPD（空/空指针解引用） | MLK（内存泄漏） | UAF（释放后使用） |
| --- | --- | --- | --- | --- |
| `Cpp` | `.cpp`、`.cc`、`.hpp`、`.c`、`.h` | 支持 | 支持 | 支持 |
| `Java` | `.java` | 支持 | 不支持 | 不支持 |
| `Python` | `.py` | 支持 | 不支持 | 不支持 |
| `Go` | `.go` | 支持 | 不支持 | 不支持 |

说明：

- 当前代码用 `Cpp` 同时承载 C 和 C++ 文件；不要把 `C` 记录成可直接传入的语言值。
- `metascan` 使用同样四个语言值，但不接收/使用漏洞类型。
- `NPD`、`UAF` 属于 source-must-not-reach-sink 风格，旧调用通常需要 `--is-reachable`。
- `MLK` 属于 source-must-reach-sink 风格，旧调用应省略 `--is-reachable`。
- CLI 只校验语言/漏洞组合，不校验 `--is-reachable` 是否与漏洞类型匹配。

## 5. 源码发现范围

RepoAudit 递归扫描项目目录，并忽略所有点号开头的目录及以下目录名：

```text
.git .vscode .idea build dist out bin
__pycache__ .pytest_cache .mypy_cache .coverage venv env
target .gradle .m2 .settings classes
CMakeFiles .deps Debug Release obj
vendor pkg
```

源码以 UTF-8 读取并使用 `errors="ignore"`；读取失败时通过 `print()` 输出错误，随后继续遍历。

## 6. 旧 `detect_info.json` 合同

冻结示例见 [`examples/legacy-detect-info.json`](examples/legacy-detect-info.json)。该示例来自基线提交中既有的 Pi 结果解析兼容 fixture，字段形状与 `BugReport.to_dict()` 一致。由于 `result/` 被 Git 忽略，且本机现存历史结果目录中没有实际 `detect_info.json` 文件，因此这里保存的是仓库内既有兼容样例，不声称是本次运行生成物。下节展示的某一次历史日志明确记录了缺少模型 API Key，但这不被外推为其他历史运行没有结果文件的统一原因。

格式特征：

- 顶层是 JSON 对象，不是数组。
- 顶层 key 是报告编号的字符串形式；进程内从 `0` 递增，但消费者不得假设连续。
- 每个报告固定包含 `bug_type`、`buggy_value`、`relevant_functions`、`explanation`、`is_human_confirmed_true`。
- `buggy_value` 是内部 `Value.__str__()` 产生的字符串：`((name, file, line, index), ValueLabel.<LABEL>)`。
- `relevant_functions` 是三个平行数组，依次为文件路径、函数名、函数源码；相同下标组成一项函数记录。
- 当前文件路径通常是扫描时使用的路径，可能为绝对路径。
- `is_human_confirmed_true` 是字符串 `"True"`、`"False"` 或 `"unknown"`，不是 JSON 布尔值。
- 文件使用 4 空格缩进；没有 `schema_version`。

写入时机也属于基线事实：旧并行 DFBScan 仅在至少一个经 Path Validator 判定可达的报告加入状态后写文件，并在后续发现时重写全量对象。零发现或所有候选处理失败时可能没有 `detect_info.json`，但终端仍会打印“已输出”路径。

## 7. 旧日志与控制台输出

DFBScan 日志使用 `YYYY-MM-DD HH:MM:SS,mmm - INFO - message` 格式。`Logger.print_log()` 只写日志文件；`Logger.print_console()` 同时写日志文件和 stdout。`tqdm` 进度条按其默认行为输出。当前普通日志与机器可解析输出尚未分离。

以下是本机 2026-08-14 历史运行的脱敏节选；完整 Prompt/源码正文和绝对仓库路径未复制：

```text
2026-08-14 15:52:14,637 - INFO - Start data-flow bug scanning in parallel...
2026-08-14 15:52:14,637 - INFO - Max number of workers: 1
2026-08-14 15:52:14,637 - INFO - The LLM Tool IntraDataFlowAnalyzer is invoked.
[完整 Prompt 与源码片段省略]
2026-08-14 15:52:14,642 - INFO - claude-3.7 is running
2026-08-14 15:52:14,642 - INFO - Error processing source value: Please set the ANTHROPIC_API_KEY environment variable to use Claude models.
2026-08-14 15:52:14,642 - INFO - 0 bug(s) was/were detected in total.
2026-08-14 15:52:14,642 - INFO - The bug report(s) has/have been dumped to <repo-root>/result/dfbscan/claude-3.7/NPD/Python/toy/2026-08-14-15-52-14-0/detect_info.json
2026-08-14 15:52:14,642 - INFO - The log files are as follows:
2026-08-14 15:52:14,642 - INFO - <repo-root>/log/dfbscan/claude-3.7/NPD/Python/toy/2026-08-14-15-52-14-0/dfbscan.log
```

安全基线：历史日志会写入完整 Prompt、待分析函数源码、模型响应和错误文本。TASK-003 及以后不得把 API Key 写入事件或日志，也不应把完整 Prompt 当作公共事件载荷。

## 8. 当前结果目录结构

DFBScan 在仓库根目录下分别创建日志和结果树：

```text
log/
└── dfbscan/
    └── <model_name>/
        └── <bug_type>/
            └── <language>/
                └── <project_name>/
                    └── <YYYY-MM-DD-HH-MM-SS>-<agent_id>/
                        └── dfbscan.log

result/
└── dfbscan/
    └── <model_name>/
        └── <bug_type>/
            └── <language>/
                └── <project_name>/
                    └── <YYYY-MM-DD-HH-MM-SS>-<agent_id>/
                        └── detect_info.json  # 可能因零发现/失败而缺失
```

MetaScan 使用另一种结果树，日志和 JSON 位于同一目录：

```text
result/
└── metascan/
    └── <language>/
        └── <project_name>/
            └── <YYYY-MM-DD-HH-MM-SS>/
                ├── metascan.log
                └── meta_scan_result.json
```

`log/`、`result**` 和 `*.log` 当前均被 `.gitignore` 忽略。TASK-001 检查时，本机 `result/` 中只有历史目录、没有文件；`log/` 中有 8 个 `dfbscan.log`。

## 9. 重构兼容性检查清单

后续任务至少需要保护以下行为：

- 旧单层 CLI 参数仍可解析，旧 `dfbscan` 完整扫描仍可回退。
- `Cpp`/`Java`/`Python`/`Go` 与现有漏洞矩阵不被缩减。
- 旧 `detect_info.json` 的顶层对象和五个报告字段继续提供。
- 旧结果目录仍可由完整扫描生成；新的 `runs/<run_id>/` 目录只能作为增量能力。
- 普通日志和旧终端摘要可以保留；新增 JSONL 事件必须另行输出并可独立解析。
- 不删除旧 `DFBScanAgent` 实现，也不把内部对象直接暴露为新的公共协议。

## 10. 未验证项与下一步

- 按任务约束，本任务未运行 RepoAudit、未调用 LLM、未运行测试套件。
- 未验证不同平台上的路径分隔符、默认编码和退出码细节。
- 未验证有真实发现时并行写入 `detect_info.json` 的时序。
- 本机历史运行因缺少 `ANTHROPIC_API_KEY` 为失败性样例，不能证明成功扫描行为。
- 下一步应单独执行 TASK-002，先定义稳定公共数据结构；在协议确定前不拆分 `src/agent/dfbscan.py`。
