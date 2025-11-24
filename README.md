# lightLLM

A simple and flexible choice to run AI models (LLM) with less spaces

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

8. 在该 conda 环境下安装 GraphRAG（项目仓库 & 环境搭建 —— 非常关键）：
   ```bash
   git clone https://github.com/zhaoyingjun/graphrag-practice-chinese.git
   cd graphrag-practice-chinese
   # 安装项目运行所需的依赖
   pip install -r ./requirements.txt
   # 创建 input 目录，用于构建索引的文本文件默认存放于该目录下
   mkdir -p ./input
   # 初始化，将在 graphrag-practice-chinese 目录中创建 .env 和 settings.yaml
   python -m graphrag.index --init --root ./
   ```
   修改配置文件以符合刚刚安装的 ollama 模型：
   - .env 包含运行 GraphRAG pipeline 所需的环境变量（默认包含 GRAPHRAG_API_KEY=<API_KEY>）。
   - settings.yaml 包含 pipeline 相关设置，根据实际模型路径/名称调整配置以使用 ollama 的模型。

9. 在该环境下安装 MiniRag（推荐从源码安装）：
   ```bash
   # 假设已将 MiniRAG 仓库放在当前目录下
   cd MiniRAG
   pip install -e .
   ```

（结束）
