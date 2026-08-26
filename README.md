# RepoAudit

RepoAudit 是一个面向仓库级代码审计的多智能体工具。它使用 Tree-sitter 分析代码结构，并结合大语言模型追踪跨函数数据流，用于发现空指针解引用、内存泄漏和释放后使用等缺陷。分析过程无需编译目标项目。

## 支持范围

| 语言参数 | 空指针解引用 `NPD` | 内存泄漏 `MLK` | 释放后使用 `UAF` |
| --- | --- | --- | --- |
| `Cpp` | 支持 | 支持 | 支持 |
| `Java` | 支持 | — | — |
| `Python` | 支持 | — | — |
| `Go` | 支持 | — | — |

## 安装

1. 克隆仓库并初始化 benchmark 子模块：

   ```bash
   git clone <repo-url> RepoAudit
   cd RepoAudit
   git submodule update --init --recursive
   ```

2. 创建 Python 环境并安装依赖：

   ```bash
   conda create -n repoaudit python=3.13
   conda activate repoaudit
   pip install -r requirements.txt
   ```

3. 构建 Tree-sitter 语言库：

   ```bash
   cd lib
   python build.py
   cd ..
   ```

   运行时需要生成的 `lib/build/my-languages.so`。

4. 按所选模型配置 API Key，例如：

   ```bash
   export OPENAI_API_KEY="your-key"
   export ANTHROPIC_API_KEY="your-key"
   ```

## 扫描模式

RepoAudit 保留原有 legacy 引擎，同时提供可持久化、可分阶段恢复的 staged 引擎。

| 模式 | 入口 | 适用场景 |
| --- | --- | --- |
| legacy | 原参数式 CLI；`--dfb-engine` 默认值 | 保持原有 `DFBScanAgent`、结果目录和 `detect_info.json` 兼容性 |
| staged 完整扫描 | `full-scan`，或原参数式 CLI 加 `--dfb-engine staged` | 按顺序完成检查、候选生成、候选分析和路径验证，并保存公共运行状态 |
| staged 分阶段调用 | `inspect`、`candidates`、`analyze`、`validate` | 外部编排器按稳定 ID 选择、暂停和恢复单个阶段 |

> `Cpp/MLK` 目前应使用 legacy。staged 公共协议要求候选同时具有 source 和 sink，暂时不能表达“未到达释放点”或“仓库中不存在释放 sink”这类关系缺失。

> 当前 staged 引擎尚未完成运行测试，不应直接用于生产决策。

## 基础使用

### legacy 完整扫描

默认 `dfb-engine` 为 `legacy`，现有调用无需修改：

```bash
python src/repoaudit.py \
  --scan-type dfbscan \
  --project-path /path/to/project \
  --language Python \
  --model-name claude-3.7 \
  --bug-type NPD \
  --is-reachable
```

`NPD` 和 `UAF` 通常使用 `--is-reachable`；legacy `MLK` 通常省略该参数。

### staged 完整扫描

使用 `full-scan` 子命令：

```bash
python src/repoaudit.py full-scan \
  --project-path /path/to/project \
  --language Python \
  --bug-type NPD \
  --model-name claude-3.7 \
  --is-reachable \
  --output-format jsonl
```

也可以沿用原参数式 CLI 并显式选择 staged：

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

### staged 分阶段调用

每一步都将状态保存到同一个 `run_id`。示例 ID 仅展示格式，实际值应从上一阶段事件或运行目录中读取。

```bash
# 1. 检查仓库并取得 run_id
python src/repoaudit.py inspect \
  --project-path /path/to/project \
  --language Python \
  --output-format jsonl

# 2. 生成候选并取得 candidate_id
python src/repoaudit.py candidates \
  --run-id run_0123456789abcdef0123456789abcdef \
  --bug-type NPD \
  --output-format jsonl

# 3. 分析一个候选并取得 path_id
python src/repoaudit.py analyze \
  --run-id run_0123456789abcdef0123456789abcdef \
  --candidate-id cand_111122223333444455556666 \
  --model-name claude-3.7 \
  --call-depth 3 \
  --output-format jsonl

# 4. 验证一条已持久化路径
python src/repoaudit.py validate \
  --run-id run_0123456789abcdef0123456789abcdef \
  --candidate-id cand_111122223333444455556666 \
  --path-id path_aaaabbbbccccddddeeeeffff \
  --model-name claude-3.7 \
  --output-format jsonl
```

## JSONL 输出与运行目录

staged 子命令遵循以下输出约定：

- stdout 仅写入一行一个 JSON 对象的结构化事件；
- stderr 写入普通诊断信息；
- 多次调用会向同一事件文件追加，并延续 `sequence`；
- 非法 `run_id`、`candidate_id` 或 `path_id` 会输出脱敏的 `analysis_failed` 事件并返回非零退出码。

默认运行状态保存在：

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

staged 完整扫描还会在原 `result/dfbscan/.../detect_info.json` 路径生成 legacy 兼容结果。

## 公共协议与详细文档

公共协议版本为 `1.0.0`，主要对象包括：

- `RepositoryProfile`、`AuditRun`；
- `AuditCandidate`、`SourceLocation`、`SourceSinkPair`；
- `DataFlowStep`、`DataFlowPath`；
- `ValidationResult`、`StructuredError`。

`run_id` 使用 UUID 派生格式，`candidate_id` 和 `path_id` 由规范化内容确定性生成。公共对象不公开 Tree-sitter 节点、内部分析状态、完整 Prompt、模型原始响应或 traceback。

详细说明：

- [公共数据协议](./docs/staged-refactor/data-contracts.md)
- [结构化事件协议](./docs/staged-refactor/event-contract.md)
- [运行状态存储](./docs/staged-refactor/run-store.md)
- [完整扫描编排与 legacy 兼容](./docs/staged-refactor/full-scan-orchestration.md)
- [分阶段重构交接与已知风险](./docs/staged-refactor/final-handoff.md)

## Pi Agent 插件

外部插件位于 [`pi-extension/`](./pi-extension/)，向 Pi Agent 注册 `repoaudit_scan` Tool，通过子进程调用 RepoAudit Python 运行时。插件继续兼容 legacy CLI，同时提供独立 doctor、唯一 run ID、长任务 heartbeat、进程树取消、跨进程文件锁、稳定错误语义、结果归一化和敏感信息过滤。

Tool 的核心参数为：

```ts
{
  repoPath: string;
  language: "Cpp" | "Java" | "Python" | "Go";
  bugType: "MLK" | "NPD" | "UAF";
}
```

安装、配置和结果语义见 [Pi Extension 使用文档](./pi-extension/README.md)；后续宿主与容器改造见 [SecHeur 第二阶段集成清单](./docs/secheur-integration.md)。

## 项目资源

- [RepoAudit 项目网站](https://repoaudit-home.github.io/)
- [上游用户指南](https://github.com/PurCL/RepoAudit/wiki/01.-User-Guide)
- [项目架构](./docs/architecture.md)
- [扩展指南](./docs/extension.md)

本项目使用 [Purdue License](./LICENSE)。
