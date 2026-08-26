# TASK-011 待执行测试

本目录中的测试由 TASK-011 准备，但当前没有运行。所有 `unittest.TestCase` 测试类均使用：

```python
@unittest.skip(NOT_RUN_REASON)
```

其中 `NOT_RUN_REASON` 明确以 `NOT RUN:` 开头。恢复测试环境后，应先审阅 fixture 和 mock 边界，再统一移除类级跳过标记并执行测试；在此之前不得把格式或语法检查描述成“测试通过”。

覆盖范围：

- 公共数据结构序列化与稳定 ID；
- JSONL 事件、序号和通道隔离；
- 仓库检查、候选生成、单候选分析和单路径验证；
- RunStore 持久化、恢复、损坏输入和运行隔离；
- 旧 CLI、新分阶段 CLI 和完整扫描兼容；
- 敏感异常文本、Prompt 和原始模型响应泄漏边界；
- `fixtures/vulnerable-python` 与 `fixtures/clean-python`。
