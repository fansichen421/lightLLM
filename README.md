# lightLLM

A simple and flexible choice to run AI models (LLM) with less spaces

Use MiniRAG、graphrag-practice-chinese and web.

## V0.0.2
Use /web/start.sh or /web/start.cmd to start engine!

## V1.0.1

帮我写一个自动脚本配置包 start.sh 帮助客户快速安装这个项目。记住，没有什么装什么。

1. 检查 GPU 是否为以下型号并支持安装 ROCm 7.1（列出的 GPU 支持 ROCm7.1）：
   - AMD Instinct MI355X
   - AMD Instinct MI350X
   - AMD Instinct MI325X
   - AMD Instinct MI300X
   - AMD Instinct MI300A
   - AMD Instinct MI250X
   - AMD Instinct MI250
   - AMD Instinct MI210
   - AMD Instinct MI100
   - AMD Radeon AI PRO R9700
   - AMD Radeon PRO V710
   - AMD Radeon PRO W7900 Dual Slot
   - AMD Radeon PRO W7900
   - AMD Radeon PRO W7800 48GB
   - AMD Radeon PRO W7800
   - AMD Radeon PRO W7700
   - AMD Radeon PRO W6800
   - AMD Radeon PRO V620
   - AMD Radeon RX 9070 XT
   - AMD Radeon RX 9070 GRE
   - AMD Radeon RX 9070
   - AMD Radeon RX 9060 XT
   - AMD Radeon RX 9060
   - AMD Radeon RX 7900 XTX
   - AMD Radeon RX 7900 XT
   - AMD Radeon RX 7900 GRE
   - AMD Radeon RX 7800 XT
   - AMD Radeon RX 7700 XT

   如果不是上述型号，则通知用户无法安装。

2. 检测是否安装 ollama，如果未安装则运行：
   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ```

3. 检查系统版本（只支持 Ubuntu 24.04 或 25.04）。

4. 检测系统 ROCm 版本是否 >= 7.1，如果不是则安装或更新 ROCm 到合适版本。

5. 如果 gpt-oss:latest 与 qwen3:4b 两个模型都没有安装：
   - 如果显存 >= 16GB：执行
     ```bash
     ollama pull gpt-oss:latest
     ```
   - 否则：执行
     ```bash
     ollama pull qwen3:4b
     ```

6. 在用户主目录下创建 LightLLM 文件夹：
   ```bash
   mkdir -p ~/LightLLM
   ```

7. 配置虚拟环境 conda（如果缺少 python、conda 等则先安装）并在该环境中安装依赖：
   - 安装或确保 miniconda/conda 可用。
   - 创建并激活环境，例如：
     ```bash
     conda create -n lightllm python=3.11 -y
     conda activate lightllm
     ```

9. 打开防火墙
10. 修改绝对路径

## 运行（Run / Usage）

本项目提供两种方便的启动脚本：`web/start.sh`（可单独启动后端或 ollama）和仓库根的 `start_all.sh`（便捷包装，默认调用 `web/start.sh --all --foreground`）。

重要变更：`start_all.sh` 默认现在会以前台模式运行（等同于传入 `--foreground` 给 `web/start.sh`），以便在当前终端持续输出后端或 Ollama 的实时日志。

主要用法示例：

- 在项目根直接启动（默认前台，显示日志）：
   ```bash
   cd /path/to/lightLLM
   ./start_all.sh
   # 等价于: ./web/start.sh --all --foreground
   ```

- 只启动后端并保持前台（显示 uvicorn 日志）：
   ```bash
   cd web
   ./start.sh --backend --foreground
   # 或简写：./start.sh --backend --fg
   ```

- 后台启动（将日志写入 logs/xxxx.log 文件）：
   ```bash
   # 后台运行后端，日志写入 logs/web_uvicorn.log
   cd web
   ./start.sh --backend
   ```

注意事项：
- 如果希望同时观察后端与 Ollama 的日志，建议在两个不同终端分别运行：
   - `./start.sh --backend --foreground`（观察后端）
   - `./start.sh --ollama --foreground`（观察 Ollama）
- `start_all.sh` 在前台模式下会使用 `exec` 启动 `start.sh`，因此不会返回到 `start_all.sh` 中后续的等待/自动打开浏览器逻辑；这是有意行为以便终端持续显示日志。
- 若你更想保持原来非阻塞行为，请直接使用 `web/start.sh --backend` 或 `web/start.sh --all`（不加 `--foreground`）。

（结束）
