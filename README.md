# RepoAudit

RepoAudit is a repo-level bug detector for general bugs. Currently, it supports the detection of diverse bug types (such as Null Pointer Dereference, Memory Leak, and Use After Free) in multiple programming languages (including C/C++, Java, Python, and Go). It leverages [LLMSCAN](https://github.com/PurCL/LLMSCAN) to parse the codebase and uses LLM to mimic the process of manual code auditing. Compared with existing code auditing tools, RepoAudit offers the following advantages:

- 🛡️ **Compilation-Free Analysis**
- 🌍 **Multi-Lingual Support**
- 🐞 **Multiple Bug Type Detection**
- ⚙️ **Customization Support**

## Pi Agent 插件化扩展

本仓库在保留 RepoAudit 原有代码审计能力的基础上，新增了面向 Pi Agent 的外部插件。插件将 RepoAudit 的 Python 分析运行时封装为 `repoaudit_scan` Tool，使 Agent 能够通过自然语言发起仓库级数据流缺陷审计，无需修改宿主 Agent 源码。

### 组件关系

```text
用户自然语言请求
       ↓
Pi Agent
       ↓ 调用 repoaudit_scan
pi-extension
       ↓ 调用 Python runtime
RepoAudit
       ↓
审计结果（有发现 / 无发现 / 执行失败）
```

### 插件能力

- 以外部 Extension 形式接入 Pi Agent
- 校验目标仓库路径、编程语言和漏洞类型
- 支持超时、取消以及子进程树终止
- 区分“扫描成功且有发现”“扫描成功但无发现”和“执行失败”
- 对返回给 Agent 的结果进行精简和敏感信息过滤

当前支持范围：

| Language | Bug Type |
| --- | --- |
| `Cpp` | `NPD`、`UAF`、`MLK` |
| `Java` | `NPD` |
| `Python` | `NPD` |
| `Go` | `NPD` |

### 快速入口

插件位于 [`pi-extension/`](./pi-extension/)，其 Tool 参数如下：

```ts
{
  repoPath: string;
  language: "Cpp" | "Java" | "Python" | "Go";
  bugType: "MLK" | "NPD" | "UAF";
}
```

完整的环境要求、安装步骤、配置项、启动方式、结果语义及测试命令，请参阅 [Pi Extension 使用文档](./pi-extension/README.md)。

> 说明：本节描述的是本仓库新增的插件化扩展，并非 RepoAudit 上游项目的原生功能。下文保留了上游 RepoAudit 的项目介绍、使用方式、论文与引用信息。

## 分阶段审计引擎

本分支在保留原有 `DFBScanAgent`、旧 CLI 和旧结果格式的同时，增加了可持久化、可按 ID 恢复的 staged 引擎。staged 流程拆分为仓库检查、候选生成、单候选分析和单路径验证，并通过 JSONL 事件与 `runs/<run_id>/` 公开中间状态。

> **验证状态：** staged 引擎目前只完成了格式、语法、协议示例和提交范围等静态检查。`tests/` 中的 32 个用例全部标记为 `NOT RUN`；尚未执行项目测试、RepoAudit、Tree-sitter 实际分析、Path Validator、LLM 或完整扫描。请勿把本节视为运行验证结论，也不要直接用于生产决策。

### 新旧扫描模式

| 模式 | 入口 | 状态与用途 |
| --- | --- | --- |
| `legacy` | 原有参数式 CLI；`--dfb-engine` 默认值 | 保留原始 `DFBScanAgent.start_scan()` 行为，现有调用无需修改 |
| `staged` 完整扫描 | 原有参数式 CLI 加 `--dfb-engine staged`，或使用 `full-scan` 子命令 | 顺序组合四个公共服务，同时保存运行状态和旧 `detect_info.json` |
| `staged` 分阶段调用 | `inspect`、`candidates`、`analyze`、`validate` | 适合外部编排器按稳定 ID 选择和恢复单个阶段 |

`Cpp/MLK` 当前应继续使用默认 `legacy` 引擎。公共协议要求候选同时具有 source 和 sink，因此 staged 引擎尚不能表达“没有到达释放点”或“仓库不存在释放 sink”这种关系缺失；实现没有通过虚假 sink 或伪造路径绕过该限制。

### 完整扫描示例

原有 CLI 默认继续使用 legacy 引擎：

```bash
python src/repoaudit.py \
  --scan-type dfbscan \
  --project-path /path/to/project \
  --language Python \
  --model-name claude-3.7 \
  --bug-type NPD \
  --is-reachable
```

在原有调用上显式选择 staged 引擎：

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

也可以使用新的完整扫描子命令：

```bash
python src/repoaudit.py full-scan \
  --project-path /path/to/project \
  --language Python \
  --bug-type NPD \
  --model-name claude-3.7 \
  --is-reachable \
  --output-format jsonl
```

`NPD`、`UAF` 属于 source-must-not-reach-sink 风格，扫描通常需要 `--is-reachable`；`MLK` 属于 source-must-reach-sink 风格，旧调用通常省略该开关。CLI 仍不会自动判断该开关与漏洞类型是否匹配。

### 分阶段 CLI

所有新子命令都以 JSONL 事件写 stdout，普通诊断写 stderr。`--output-format` 当前唯一允许值和默认值都是 `jsonl`。下例中的 ID 应从上一阶段事件或 `runs/<run_id>/` 中读取，不要手工编造。

```bash
# 1. 创建运行并检查仓库；从 run_started 或 repository_inspected 事件取得 run_id
python src/repoaudit.py inspect \
  --project-path /path/to/project \
  --language Python \
  --output-format jsonl

# 2. 为已检查运行生成候选；从 candidates.json 或 candidate_extracted 取得 candidate_id
python src/repoaudit.py candidates \
  --run-id run_0123456789abcdef0123456789abcdef \
  --bug-type NPD \
  --output-format jsonl

# 3. 只分析一个候选；从 paths.json 或 dataflow_step_found 取得 path_id
python src/repoaudit.py analyze \
  --run-id run_0123456789abcdef0123456789abcdef \
  --candidate-id cand_111122223333444455556666 \
  --model-name claude-3.7 \
  --call-depth 3 \
  --output-format jsonl

# 4. 只验证一条已持久化的完整路径，不重跑候选分析
python src/repoaudit.py validate \
  --run-id run_0123456789abcdef0123456789abcdef \
  --candidate-id cand_111122223333444455556666 \
  --path-id path_aaaabbbbccccddddeeeeffff \
  --model-name claude-3.7 \
  --output-format jsonl
```

非法 `run_id`、`candidate_id` 或 `path_id` 会产生脱敏的 `analysis_failed` 结构化事件并返回非零退出码。多次 CLI 调用会向同一个 `events.jsonl` 追加，事件 `sequence` 延续已有序号。

### 公共数据与事件协议

公共协议版本为 `1.0.0`，主要对象包括：

- `RepositoryProfile` 和 `AuditRun`；
- `AuditCandidate`、`SourceLocation` 和 `SourceSinkPair`；
- `DataFlowStep` 和 `DataFlowPath`；
- `ValidationResult` 和 `StructuredError`。

`run_id` 使用 UUID 派生格式；`candidate_id` 和 `path_id` 由规范化结构通过 SHA-256 确定性生成。源码位置使用仓库相对路径和 `/` 分隔符，行号、列号及步骤编号从 1 开始。公共对象不会暴露 Tree-sitter 节点、内部分析状态、完整 Prompt、模型原始响应或 traceback。

事件流使用一行一个 JSON 的 `AnalysisEvent` 信封，当前定义 `run_started`、`repository_inspected`、`candidate_extracted`、`candidate_analysis_started`、`function_selected`、`source_sink_matched`、`dataflow_step_found`、`path_validation_started`、`path_validated`、`candidate_rejected`、`analysis_failed` 和 `run_completed`。消费者应按 `sequence` 检查连续性，并以最终 `run_completed` 和持久化状态判断完整扫描结果；单个 `analysis_failed` 不一定终止整个运行。

详细字段和消费规则见 [公共数据协议](./docs/staged-refactor/data-contracts.md) 与 [结构化事件协议](./docs/staged-refactor/event-contract.md)。

### 运行目录

默认状态目录位于 RepoAudit 根目录下：

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

JSON 状态采用原子替换写入，事件文件按连续序号追加。不同运行之间会校验对象归属，`runs/` 已加入 `.gitignore`。staged 完整扫描还会继续在旧 `result/dfbscan/.../detect_info.json` 路径生成兼容结果；零发现时明确写入 `{}`。

存储格式见 [RunStore 文档](./docs/staged-refactor/run-store.md)，完整扫描兼容行为见 [完整扫描编排](./docs/staged-refactor/full-scan-orchestration.md)。测试准备状态见 [TASK-011 待执行测试](./tests/README.md)。

### Pi 插件后续对接

当前 Pi 插件仍可继续使用默认 legacy CLI。后续接入 staged 引擎时，建议优先调用 `full-scan`，逐行解析 stdout JSONL，以 `run_id` 关联运行，并结合 `run_completed`、进程退出码和 `runs/<run_id>/` 判断结果；不要把普通 stderr、完整日志、Prompt 或原始模型响应写入 Agent 上下文。

需要交互式编排时，插件可依次调用 `inspect`、`candidates`、单个 `analyze` 和单条 `validate`，并从持久化公共对象读取下一阶段 ID。完整对接边界、已知风险和回滚方法记录在 [分阶段重构最终交接](./docs/staged-refactor/final-handoff.md)。

## News 📰

**[June 2025]** The preprint of "An LLM Agent for Functional Bug Detection in Network Protocols" has been released, providing the technical details of `rfcscan`!

**[May 2025]** 🎉 Our paper "RepoAudit: Automated Code Auditing with Multi-Agent LLM Framework" has been accepted at ICML 2025! 🏆

**[March 2025]** RepoAudit has helped identify over 100 bugs in open-source projects this quarter!

## Agents in RepoAudit

RepoAudit is a multi-agent framework for code auditing. We offer two agent instances in our current version:

- **MetaScanAgent** in `metascan.py`: Scan the project using tree-sitter–powered parsing-based analyzers and obtains the basic syntactic properties of the program.

- **DFBScanAgent** in `dfbscan.py`: Perform inter-procedural data-flow analysis as described in this [preprint](https://arxiv.org/abs/2501.18160). It detects data-flow bugs, including source-must-not-reach-sink bugs (e.g., Null Pointer Dereference) and source-must-reach-sink bugs (e.g., Memory Leak).

We are keeping implementing more agents and will open-source them very soon. Utilizing DFBScanAgent and other agents, we have discovered hundred of confirmed and fixed bugs in open-source community. You can refer to this [bug list](https://repoaudit-home.github.io/bugreports.html).

## Installation

1. Create and activate a conda environment with Python 3.13:

   ```sh
   conda create -n repoaudit python=3.13
   conda activate repoaudit
   ```

2. Install the required dependencies:

   ```sh
   cd RepoAudit
   pip install -r requirements.txt
   ```

3. Ensure you have the Tree-sitter library and language bindings installed:

   ```sh
   cd lib
   python build.py
   ```

4. Configure the OpenAI API key and Anthropic API key:

   ```sh
   export OPENAI_API_KEY=xxxxxx >> ~/.bashrc
   export ANTHROPIC_API_KEY=xxxxxx >> ~/.bashrc
   ```

## Quick Start

Getting started with RepoAudit is simple — you can run a full scan on a project in just a few commands.

### Initialize the Benchmarks (one-time setup)

We provide several prepared benchmark programs in the `benchmark` directory. Some of these are Git submodules, so you may need to initialize them first:

```sh
cd RepoAudit
git submodule update --init --recursive
```

### Run a Scan with the Helper Script

We provide a ready-to-use script:
`src/run_repoaudit.sh`
This script scans a **target project folder** for specific types of bugs using our analysis engine.

You can run the script in several ways:

#### A. **Basic usage** (use default benchmark project and bug type):

```sh
cd src
sh run_repoaudit.sh
```

This will scan the default toy project located at:

```
../benchmark/Python/toy
```

for **NPD** bugs (Null Pointer Dereference).

#### B. **Specify your own project path**:

```sh
sh run_repoaudit.sh /path/to/your/project
```

This will scan the provided project for **NPD** bugs by default.

You can use either a **relative** or **absolute** path.

#### C. **Specify bug type too**:

```sh
sh run_repoaudit.sh /path/to/your/project UAF
```

The second argument lets you choose the **bug type** to scan for. Supported types are:

| Code | Meaning                  |
| ---- | ------------------------ |
| MLK  | Memory Leak              |
| NPD  | Null Pointer Dereference |
| UAF  | Use After Free           |

> ⚠️ Bug type is **case-insensitive** (`npd`, `NPD`, or `NpD` all work).


### View Results

Once the scan finishes, the tool generates **JSON** and **log** files containing the findings.
You can find these files in the output directory printed by the script.

✅ **That's it!**

With just one script, you can quickly run RepoAudit on either a built-in benchmark project or any project path you specify.



## Parallel Auditing Support

For a large repository, a sequential analysis process may be quite time-consuming. To accelerate the analysis, you can choose parallel auditing. Specifically, you can set the option `--max-neural-workers` to a larger value. By default, this option is set to 30 for parallel auditing.
Also, we have set the parsing-based analysis in a parallel mode by default, which is determined by the option `--max-symbolic-workers`. The default maximal number of workers is 30.

## Website, Documentation and Papers

We have open-sourced the implementation of [dfbscan](https://github.com/PurCL/RepoAudit). Other agents in RepoAudit will be released soon. For more information, please visit our website: [RepoAudit: Auditing Code As Human](https://repoaudit-home.github.io/).

For more details about tool usage, project architecture, and extensions of RepoAudit, please refer to the following documents:

- [User Guide](https://github.com/PurCL/RepoAudit/wiki/01.-User-Guide): Detailed instructions on installation, configuration, and usage of RepoAudit, including CLI and webUI usage.

- [Project Architecture](https://github.com/PurCL/RepoAudit/wiki/02.-Project-Architecture): In-depth explanation of RepoAudit's multi-agent framework, including parsing-based analyzers/tools, LLM-driven tools, and agent memory designs.

- [Extension](https://github.com/PurCL/RepoAudit/wiki/03.-How-to-Extend): Guidelines for customizing RepoAudit to support new bug types and programming languages.

- [DeepWiki](https://deepwiki.com/PurCL/RepoAudit): All-in-one documentation generated by [`Devin`](https://devin.ai/).


If you find our research or tools helpful, please cite the following papers. More technical reports/research papers will be released in the future.

```bibtex
@inproceedings{repoaudit2025,
  title={RepoAudit: An Autonomous LLM-Agent for Repository-Level Code Auditing},
  author={Guo, Jinyao* and Wang, Chengpeng* and Xu, Xiangzhe and Su, Zian and Zhang, Xiangyu},
  booktitle={Proceedings of the 42nd International Conference on Machine Learning},
  year={2025},
  note={*Equal contribution}
}

@article{rfcscan2025,
  title={An LLM Agent for Functional Bug Detection in Network Protocols},
  author={Zheng, Mingwei and Wang, Chengpeng and Liu, Xuwei and Guo, Jinyao and Feng, Shiwei and Zhang, Xiangyu},
  journal={arXiv preprint arXiv:2506.00714},
  year={2025}
}
```

## License

This project is licensed under [Purdue license](LICENSE).

## Contact

For any questions or suggestions, please submit issues or pull requests on GitHub. You can also reach out to our maintainers:

- Chengpeng Wang (Purdue University) - [wang6590@purdue.edu](mailto:wang6590@purdue.edu)

- Jinyao Guo (Purdue University) - [guo846@purdue.edu](mailto:guo846@purdue.edu) 

- Zhuo Zhang (Columbia University) - [zz3474@columbia.edu](mailto:zz3474@columbia.edu)
