# 不是作者的
其实大多数都是 AI 写的。  
SO LLM is the true author of this project.

---

目录
- [项目简介](#项目简介)
- [总体结构](#总体结构)
- [后端（Python 部分）](#后端python-部分)
  - [主要文件与接口](#主要文件与接口)
  - [重要路径 / 环境变量](#重要路径--环境变量)
- [本地 ez_agent（stub）](#本地-ez_agentstub)
- [tools.py（工具定义）](#toolspy工具定义)
- [前端（静态资源）](#前端静态资源)
- [依赖清单](#依赖清单)
- [整体调用链举例](#整体调用链举例)
- [架构图（简要）](#架构图简要)
- [快速启动](#快速启动)

---

## 项目简介
这是一个基于 FastAPI + Uvicorn 的后端服务，提供对话、RAG（GraphRAG / MiniRAG）知识库上传与构建、RAG 查询、以及 WebSocket 流式对话等功能。前端为纯静态页面（HTML/CSS/JS），由后端通过 `/static` 挂载。

本仓库中很多文档/代码由 AI 协助生成或编写，因此 README 也注明“不是作者的”。

---

## 总体结构
- 后端：FastAPI 应用，负责 HTTP / WebSocket 接口、文件上传、触发 MiniRAG 构建、代理旧前端路径等。
- 前端：放在 `static/` 下的纯静态页面（index.html + JS/CSS）。
- MiniRAG / graphrag-practice-chinese：通过子进程调用本地脚本完成图谱构建与查询。
- 本地实现了一个轻量 `ez_agent` stub，用于兼容 Agent / MCP 的调用。

---

## 后端（Python 部分）

### 主要文件与接口
- `backend.py`
  - 定义 FastAPI `app` 和主要 API：
    - `/`：返回前端页面 `static/index.html`
    - `/ws`：WebSocket 双工通道（流式对话、工具调用）
    - `/upload_kb`：上传知识库文件并触发 MiniRAG 构建（清空旧 input、旧图谱缓存，后台起子进程跑 `main.py`）
    - `/upload_log`、`/build_status`：用于轮询构建日志和状态
    - `/rag_query`、`/rag/chat`：对已构建的 RAG 知识库进行查询（调用 MiniRAG）
    - `/rag/upload`、`/rag/upload_log`：兼容旧前端路径，转发到新逻辑
    - `/generate_title`：使用 `title_agent` 为对话生成简短标题

- `tools.py`
  - 定义供 Agent 使用的工具，比如：
    - `get_weather`：调和风天气 API 的天气查询工具（参数：city_name / 时间粒度）
    - `search_bili`：调用 B 站 API 做搜索
  - 使用 `FoldableAsyncFunctionTool` 装饰（由本地 `ez_agent` 提供兼容 shim）

- 其他相关/辅助文件
  - `main.py`（用于 MiniRAG 的图谱构建子进程，仓库外/子项目）
  - `mcp.json`：MCP 工具配置（`base_agent.load_mcp_config("mcp.json")`）

### 重要路径 / 环境变量
- GRAPH_RAG_ROOT、GRAPH_RAG_INPUT、MINIRAG_ROOT：用于与 `graphrag-practice-chinese` / `MiniRAG` 项目交互的目录配置。
- 后端会在上传知识库时清理：
  - 旧 `.graphml`
  - `kv_store_*.json`
  - `vdb_*.json`
  - `.parquet` 等缓存文件

---

## 本地 ez_agent（stub）
目录：`ez_agent/`（轻量实现）
- `__init__.py`
  - 提供最小版的 Agent / Tool 类，包含：
    - `load_mcp_config`（读取 `mcp.json`，读取失败不会导致服务崩溃）
    - `run(stream=True/False)`：支持流式回调（目前为 stub 文本）
    - `safe_modify` 上下文管理器、`copy`、`cleanup`、`stop_generation` 等工具函数
    - 兼容 `FoldableAsyncFunctionTool`、`MCPClient`、`FoldableMCPTool`（当前大多为空壳或直通装饰器）
- `prefabs.py`
  - `get_time_tool()`：返回一个简单的时间工具
  - `python_script_tool_safer()`：返回一个“安全版”Python 脚本执行工具（模拟实现）

该 stub 用于在没有完整 MCP 服务时，使项目仍能启动并提供基本体验。

---

## tools.py（工具定义）
示例（概述）：
- get_weather(city_name, granularity)：调用第三方天气 API（如调和风）
- search_bili(query, page)：使用 `bilibili_api_python` 做 B 站搜索

工具通过 `FoldableAsyncFunctionTool` / MCP 兼容层包装，以便 Agent 在流式调用中使用。

---

## 前端（静态资源）
目录：`static/`

主要文件：
- `index.html`：主页面，包含聊天界面、知识库上传区、日志显示等
- `script.js` / `render.js` / `settings.js` / `history.js`：前端逻辑
  - 建立 `/ws` WebSocket，发送用户输入，接收分块（chunk）、reasoning、final、finish 等事件
  - 上传知识库时调用 `/upload_kb`，轮询 `/upload_log`、`/build_status`
  - 消息渲染、高亮、Katex 渲染、历史记录等
- `style.css` + `themes/`：页面样式与主题
- 第三方库：`katex.min.js` / `highlight.min.js` / `marked.min.js` 等
- `data/`：
  - `model_list.json`：供前端显示/选择模型或配置用的静态数据

---

## 依赖清单
文件：`requirements.txt`（主要依赖）
- Web 框架：fastapi, uvicorn, python-multipart（表单/文件上传）
- WebSocket / HTTP 客户端：websockets, httpx
- 工具生态：bilibili-api-python, volcengine-python-sdk[ark], python-dotenv
- 其他：psutil, pillow, lxml, requests 等

---

## 整体调用链举例
1. 浏览器访问：http://服务器IP:8000/ → `backend.py` 返回 `static/index.html`
2. 前端 `script.js` 建立 `/ws` WebSocket 连接，进行聊天（流式）
3. 上传知识库时：
   - 前端调用 `/upload_kb`（表单 + 文件）
   - 后端清理旧 input / 缓存，并把新文件写入 `GRAPH_RAG_INPUT`
   - 后端使用 `asyncio.create_subprocess_exec` 后台运行 `main.py` 完成图谱构建
   - 前端可轮询 `/upload_log`、`/build_status` 查看进度
4. 用户提问（与文档相关）：
   - 前端调用 `/rag_query`（或旧兼容路径 `/rag/chat`）
   - 后端使用 MiniRAG 读取本地图谱做 RAG 查询，结果返回前端

示例接口用法（概述）：
```text
GET  /                 -> 返回 static/index.html
WS   /ws               -> WebSocket 聊天/流式接口
POST /upload_kb        -> 上传 KB 并触发构建
GET  /upload_log       -> 查询构建日志（轮询）
GET  /build_status     -> 查询构建状态
POST /rag_query        -> RAG 查询
POST /rag/chat         -> 兼容旧前端的 RAG 查询
POST /rag/upload       -> 兼容旧前端的上传接口
GET  /rag/upload_log   -> 兼容旧前端的上传日志轮询
POST /generate_title   -> 为对话生成简短标题
```

---

## 架构图（简要）
（浏览器：静态文件）
Browser / UI  ←── static (index.html, script.js, style.css)

WebSocket / HTTP
↓
FastAPI 后端 (backend.py)
- Rest API
- WebSocket (chat/stream)
- Uploads endpoints
- Tool callbacks

后端会与：
- MiniRAG（子进程）进行图谱构建/查询
- 本地 ez_agent（agent shim）
- 外部 API（volcengine, bilibili, weather 等）

日志与进程监控（uvicorn / nohup / pid files）

---

## 快速启动
示例（在虚拟环境下）：
```bash
pip install -r requirements.txt
# 假设入口在 backend.py 并定义了 app
uvicorn backend:app --host 0.0.0.0 --port 8000 --reload
```

注意：
- 确保 `GRAPH_RAG_ROOT` / `GRAPH_RAG_INPUT` / `MINIRAG_ROOT` 指向正确的路径（根据需要在环境变量或配置文件中设置）
- `mcp.json` 如果不存在或加载失败，`ez_agent` 的 stub 会打印 `Failed to load mcp config` 但不会影响服务启动

---
