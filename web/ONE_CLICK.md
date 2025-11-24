一键启动说明
=================

包含脚本：

- `web/start.sh`：在 `lightllm` conda 环境（如可用）中启动后端（uvicorn），可选启动 Ollama 并拉取模型。
- `web/stop.sh`：停止后端和 Ollama（按端口或进程名）。
- `start_all.sh`：项目根的一行调用，等价于 `web/start.sh --all`。

示例用法：

1. 启动后端：
```bash
cd /home/steven/桌面/lightLLM/web
./start.sh --backend
```

2. 启动 Ollama 并尝试拉取模型 `gpt-oss:latest`（如果已安装 ollama）：
```bash
cd /home/steven/桌面/lightLLM/web
./start.sh --ollama gpt-oss:latest
```

3. 同时启动（默认）：
```bash
cd /home/steven/桌面/lightLLM
./start_all.sh
```

4. 停止服务：
```bash
cd /home/steven/桌面/lightLLM/web
./stop.sh
```

日志目录：`/home/steven/桌面/lightLLM/logs`，包含 `web_uvicorn.log` 与 `ollama.log`（如果已启动 Ollama）。

注意：
- 脚本尝试使用 `conda run -n lightllm` 来在指定环境中运行命令（如果 `conda` 可用）。
- 若 Ollama 二进制名或启动方式与你的环境不同，请告知我如何在该机器上启动 Ollama，我可以把脚本适配为你的命令。
