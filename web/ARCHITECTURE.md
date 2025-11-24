# web 项目架构说明（概要）

该文档概述 `web` 项目的组件、调用与部署要点，便于在当前 `lightllm` conda 环境（Python 3.11）中运行与调试。

## 组件关系（简洁版）

- 浏览器（前端静态资源）
  - `web/static/`：前端 HTML/JS/CSS，连接后端的 HTTP 与 WebSocket。
- FastAPI 后端
  - `web/backend.py`：主服务，暴露：
    - REST 接口：`/upload_kb`、`/build_status`、`/rag_query` 等
    - WebSocket：`/ws`（流式对话）
    - 静态文件挂载：`/static`、`/data`
  - 运行：`python -m uvicorn backend:app --host 0.0.0.0 --port 8000 --reload`
- Agent 层（本地 shim）
  - `web/ez_agent/__init__.py`：为当前 Python 3.11 环境提供兼容层，包含：
    - `Agent`、`Tool`、`MCPClient`、`FoldableAsyncFunctionTool` 等
    - 能加载 `mcp.json` 并将 `mcpServers` 注册为可调用 Tool（通过 `MCPClient.call` 执行命令）
- MiniRAG（子进程）
  - 位于：`/home/steven/桌面/graphrag-practice-chinese/MiniRAG`
  - 后端通过 subprocess 启动 `main.py` 构建知识图谱，输出到 `upload_build.log`。
- MCP Servers（本地 mock）
  - `web/mcp.json` 指向 `./mcp_servers/google-search.sh`（当前为 mock 脚本），可替换为真实命令。

## 主要文件与路径

- 后端：`web/backend.py`
- Agent shim：`web/ez_agent/__init__.py`, `web/ez_agent/prefabs.py`
- 静态前端：`web/static/*`
- MCP 配置：`web/mcp.json`；本地 mock：`web/mcp_servers/google-search.sh`
- MiniRAG 根：`/home/steven/桌面/graphrag-practice-chinese/MiniRAG`
- 构建日志：`/home/steven/桌面/graphrag-practice-chinese/graphrag-practice-chinese/upload_build.log`
- Uvicorn 日志：`/tmp/web_uvicorn.log`

## 典型操作流程（上传并构建）

1. 前端向 `/upload_kb` 上传文件（multipart POST）。
2. 后端保存文件到 `GRAPH_RAG_INPUT` 并异步启动 MiniRAG 子进程：
   ```text
   python /path/to/MiniRAG/main.py --workingdir <GRAPH_RAG_ROOT> --datapath <GRAPH_RAG_INPUT>
   ```
3. 子进程 stdout/stderr 写入 `upload_build.log`，前端可以轮询 `/upload_log` 或 `/build_status` 获取状态。

## 日常命令

```bash
# 激活环境并启动服务
source "$HOME/miniconda3/etc/profile.d/conda.sh"
conda activate lightllm
cd /home/steven/桌面/lightLLM/web
python -m uvicorn backend:app --host 0.0.0.0 --port 8000 --reload

# 查看后端日志
tail -f /tmp/web_uvicorn.log

# 查看 MiniRAG 构建日志
tail -f /home/steven/桌面/graphrag-practice-chinese/graphrag-practice-chinese/upload_build.log

# 取消构建（如果需要）
curl -X POST http://127.0.0.1:8000/cancel_build

# 构建状态
curl http://127.0.0.1:8000/build_status | jq .
```

## 已做的兼容性改动（为在当前 env 可运行）

- 实现了 `web/ez_agent` shim：提供 MCP 加载并把 `mcpServers` 注册为 Tool（使用本地脚本或命令执行）。
- 将 `web/mcp.json` 指向本地 mock 脚本 `web/mcp_servers/google-search.sh`，用于在不安装 node/npm 的情况下演示 MCP 工具。
- 根据 MiniRAG 的 `requirements.txt` 在当前 env 安装了必要依赖（示例：`rouge`, `sentence-transformers`），以便 MiniRAG 子进程能运行。

## 限制与可选改进

- 当前 `ez_agent` 为轻量 shim，非上游完整实现；若需要完整 MCP 协议或更复杂的工具管理，建议在 Python 3.13 环境安装官方 `ez-agent`，或继续扩展 shim。 
- `mcp.json` 可恢复为真实命令（如 `npx google-search-mcp`），但需在系统安装 Node/npm 并能在服务器上运行。
- MiniRAG 运行可能触发较大的模型下载/内存/GPU 使用，部署到生产前请评估资源与超时策略。

---

如需我把 `mcp.json` 恢复为调用真实 MCP、或把当前 mock 脚本替换为一个 HTTP 代理，我可以继续实现并测试。