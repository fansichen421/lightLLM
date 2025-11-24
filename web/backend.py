from contextlib import asynccontextmanager
import os
import asyncio
import sys
import json
import re
from typing import Literal
import uuid
import logging
import shutil
from pathlib import Path
from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect, Request, status, UploadFile, File, Form
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from ez_agent import Agent, Tool
import inspect
from ez_agent import Agent, Tool 
from ez_agent.prefabs import get_time_tool, python_script_tool_safer
from tools import get_weather, search_bili
import subprocess
import shutil


def detect_ollama_models() -> list:
    """Detect local Ollama models by invoking `ollama list` (try JSON first).

    Returns a list of dicts: [{"name": <model_name>, "description": <opt>}]
    """
    models = []
    try:
        if shutil.which("ollama") is None:
            return models
        # Try JSON output first
        try:
            p = subprocess.run(["ollama", "list", "--json"], capture_output=True, text=True, timeout=5)
            if p.returncode == 0 and p.stdout:
                data = json.loads(p.stdout)
                # Accept either list or dict with 'models'
                raw = data if isinstance(data, list) else data.get("models", []) if isinstance(data, dict) else []
                for item in raw:
                    if isinstance(item, dict):
                        name = item.get("name") or item.get("model") or item.get("id")
                        models.append({"name": name, "description": item.get("description", "")})
                    else:
                        models.append({"name": str(item), "description": ""})
                return models
        except Exception:
            pass

        # Fallback: parse plain text output
        try:
            p = subprocess.run(["ollama", "list"], capture_output=True, text=True, timeout=5)
            if p.returncode == 0 and p.stdout:
                for line in p.stdout.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    if line.lower().startswith("name") or line.startswith("-"):
                        continue
                    parts = line.split()
                    if parts:
                        models.append({"name": parts[0], "description": ""})
        except Exception:
            pass
    except Exception:
        return []
    return models


logger = logging.getLogger("uvicorn")
load_dotenv()

# 永远不要删除的联网模型（默认条目）
DEFAULT_EXTERNAL_MODELS = {
    "DeepSeek V3.1": {
        "model_id": "deepseek-v3-1-terminus",
        "thinking_modes": ["disabled", "enabled"],
        "allow_picture": False,
        "base_url": "https://ark.cn-beijing.volces.com/api/v3/",
    },
    "DeepSeek R1": {
        "model_id": "deepseek-r1-250528",
        "thinking_modes": ["enabled"],
        "allow_picture": False,
        "base_url": "https://ark.cn-beijing.volces.com/api/v3/",
    },
    "Doubao Seed 1.6 Lite": {
        "model_id": "doubao-seed-1-6-lite-251015",
        "thinking_modes": ["minimal", "low", "medium", "high"],
        "allow_picture": True,
        "base_url": "https://ark.cn-beijing.volces.com/api/v3/",
    },
    "Doubao Seed 1.6": {
        "model_id": "doubao-seed-1-6-250615",
        "thinking_modes": ["disabled", "enabled", "auto"],
        "allow_picture": True,
        "base_url": "https://ark.cn-beijing.volces.com/api/v3/",
    },
    "Kimi K2": {
        "model_id": "kimi-k2-250905",
        "thinking_modes": ["disabled"],
        "allow_picture": True,
        "base_url": "https://ark.cn-beijing.volces.com/api/v3/",
    },
}


def _merge_and_write_model_list(model_map: dict):
    """Merge detected models with default external models and any existing custom entries,
    then write to `data/model_list.json`.

    Default external models are never removed or overwritten by detected models.
    """
    data_path = os.path.join(os.path.dirname(__file__), "data")
    os.makedirs(data_path, exist_ok=True)
    model_list_path = os.path.join(data_path, "model_list.json")

    # Load existing map if present
    existing = {}
    try:
        if os.path.exists(model_list_path):
            with open(model_list_path, "r", encoding="utf-8") as ef:
                existing = json.load(ef) or {}
    except Exception:
        existing = {}

    final = {}
    # Start with defaults (these must be preserved)
    final.update(DEFAULT_EXTERNAL_MODELS)
    # Preserve any other existing entries that are not part of the defaults
    for k, v in existing.items():
        if k not in final:
            final[k] = v
    # Add newly detected models, overwrite existing entries except protected defaults
    for k, v in (model_map or {}).items():
        if k in DEFAULT_EXTERNAL_MODELS:
            # skip overwriting protected/default entries
            continue
        final[k] = v

    # Write final map
    try:
        with open(model_list_path, "w", encoding="utf-8") as mf:
            json.dump(final, mf, ensure_ascii=False, indent=2)
    except Exception:
        pass

API_KEY = os.getenv("ARK_API_KEY", "")
BASE_URL = os.getenv("ARK_BASE_URL", "http://localhost:11434/v1")
MODEL = os.getenv("AGENT_MODEL", "qwen3:4b")

BLACKMARK_LIST = ["10.19.75.158"]

base_agent = Agent(
    model=MODEL,
    api_key=API_KEY,
    base_url=BASE_URL,
    instructions="你是AI助手，请确保回答尽可能简洁。",
)
base_agent.messages.append(
    {"role": "assistant", "content": "您好！我是AI助手，有什么可以帮助您的吗？"}
)

user_ids: set[str] = set()
user_agents: dict[str, Agent] = {}
active_connections: dict[str, WebSocket] = {}
tools: dict[str, Tool] = {}
user_generation_tasks: dict[str, asyncio.Task] = {}

build_status = {
    "state": "idle",  # idle | pending | running | success | error | cancelled
    "pid": "",
    "started_at": "",
    "returncode": "",
    "finished_at": "",
    "task": ""
}

# 当前构建的进程与任务引用（用于取消/强制重启）
build_process: asyncio.subprocess.Process | None = None
build_task: asyncio.Task | None = None

# Ollama 服务进程引用（如果由本后端启动）
ollama_process: asyncio.subprocess.Process | None = None

# 如果 MCP 加载失败，仍然提供一组本地回退工具，保证前端能展示常用工具
try:
    # 不要覆盖已经存在的工具
    if "python脚本" not in tools:
        tools["python脚本"] = python_script_tool_safer
    if "时间查询" not in tools:
        tools["时间查询"] = get_time_tool
    if "天气查询" not in tools:
        tools["天气查询"] = get_weather
    if "B站搜索" not in tools:
        tools["B站搜索"] = search_bili
except Exception:
    # 忽略导入或赋值时的任何问题，避免阻塞服务启动
    pass


def log_current_state():
    logger.info(f"Total users: {len(user_ids)}")
    logger.info(f"Active connections: {len(active_connections)}")
    logger.info(f"Current agents: {len(user_agents)}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 尝试加载 mcp 配置，但无论是否成功都必须 yield，
    # 否则 Starlette 的 lifespan 会因为 generator 未 yield 而导致启动失败。
    try:
        await base_agent.load_mcp_config("mcp.json")
        assert base_agent._tools
        tools["python脚本"] = python_script_tool_safer
        tools["时间查询"] = get_time_tool
        tools["天气查询"] = get_weather
        tools["B站搜索"] = search_bili
        google_search_tool = base_agent.get_tool("google-search")
        if google_search_tool:
            tools["谷歌搜索"] = google_search_tool
        base_agent.tools = []
        # Detect local Ollama models and write to data/model_list.json for frontend
        try:
            loop = asyncio.get_event_loop()
            models = await loop.run_in_executor(None, detect_ollama_models)
            # Normalize into frontend-expected mapping: { displayName: { model_id, base_url, thinking_modes } }
            model_map = {}
            for m in models:
                name = m.get("name") if isinstance(m, dict) else str(m)
                if not name:
                    continue
                model_map[name] = {
                    "model_id": name,
                    "base_url": BASE_URL,
                    "thinking_modes": ["disabled", "enabled", "auto"],
                    "allow_picture": False,
                }
            # Merge with defaults and existing entries, then write
            try:
                _merge_and_write_model_list(model_map)
            except Exception:
                pass
        except Exception:
            pass
        yield
        await base_agent.cleanup()
    except Exception as e:
        logger.error(f"Failed to load mcp config: {e}")

    try:
        yield
    finally:
        try:
            await base_agent.cleanup()
        except Exception as e:
            logger.debug(f"Error during base_agent.cleanup(): {e}")


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

redirect_app = FastAPI()


@redirect_app.middleware("http")
async def redirect_all_to_https(request: Request, call_next):
    """将所有 HTTP 请求重定向到 HTTPS"""
    https_url = str(request.url).replace("http://", "https://", 1)
    print(f"{https_url=}")
    return RedirectResponse(https_url, status_code=301)


@redirect_app.api_route(
    "/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "WEBSOCKET"]
)
async def catch_all(request: Request, path: str):
    """捕获所有路径并重定向"""
    https_url = str(request.url).replace("http://", "https://", 1)
    print(f"{https_url=}")
    return RedirectResponse(https_url, status_code=301)


# 挂载静态文件目录（前端）
static_dir = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)
app.mount("/static", StaticFiles(directory=static_dir), name="static")
data_dir = os.path.join(os.path.dirname(__file__), "data")
if not os.path.exists(data_dir):
    os.makedirs(data_dir)
app.mount("/data", StaticFiles(directory=data_dir), name="data")

# GraphRAG 知识库路径配置
GRAPH_RAG_ROOT = "./graphrag-practice-chinese/"
GRAPH_RAG_INPUT = os.path.join(GRAPH_RAG_ROOT, "input")
# MiniRAG 按仓库实际位置部署在项目根的 MiniRAG 目录（之前为子模块形式时路径可能不同）
# 如果你的环境把 MiniRAG 放到其他位置，请通过环境变量或直接修改此变量。
MINIRAG_ROOT = "./MiniRAG"

# 确保目录存在
Path(GRAPH_RAG_INPUT).mkdir(parents=True, exist_ok=True)


@app.get("/favicon.ico")
def favicon():
    return FileResponse(os.path.join(static_dir, "favicon.ico"))


@app.post("/api/refresh_models")
async def refresh_models():
    """Detect local Ollama models and write to `data/model_list.json`, return list."""
    try:
        loop = asyncio.get_event_loop()
        models = await loop.run_in_executor(None, detect_ollama_models)
        # Normalize into frontend-expected mapping
        model_map = {}
        for m in models:
            name = m.get("name") if isinstance(m, dict) else str(m)
            if not name:
                continue
            model_map[name] = {
                "model_id": name,
                "base_url": BASE_URL,
                "thinking_modes": ["disabled", "enabled", "auto"],
                "allow_picture": False,
            }
        try:
            _merge_and_write_model_list(model_map)
        except Exception as e:
            return JSONResponse({"status": "error", "message": str(e)}, status_code=500)
        return JSONResponse({"status": "success", "models": model_map})
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


@app.post("/api/start_ollama")
async def api_start_ollama(data: dict = Body("{}")):
    """Start ollama serve in background and optionally pull a model.

    Expected JSON: { "model": "model_id" }
    """
    global ollama_process
    model = None
    try:
        model = (data or {}).get("model")
    except Exception:
        model = None

    if shutil.which("ollama") is None:
        return JSONResponse({"status": "error", "message": "ollama binary not found on PATH"}, status_code=400)

    try:
        # If model provided, try to pull it first (non-fatal)
        if model:
            try:
                p = await asyncio.create_subprocess_exec(
                    "ollama",
                    "pull",
                    model,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await asyncio.wait_for(p.communicate(), timeout=120)
            except Exception:
                # ignore pull errors (may already exist or network issues)
                pass

        # If already started and still running, return success
        if ollama_process is not None:
            # check if process is alive
            rc = await asyncio.sleep(0)  # yield control
            try:
                if ollama_process.returncode is None:
                    return JSONResponse({"status": "success", "message": "ollama already running"})
            except Exception:
                pass

        # Start ollama serve in background
        log_path = os.path.join(os.path.dirname(__file__), "../", "logs")
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        # Launch serve
        proc = await asyncio.create_subprocess_exec(
            "ollama",
            "serve",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=os.path.dirname(__file__),
        )
        ollama_process = proc

        # fire-and-forget: collect a bit of output asynchronously
        async def _drain(proc):
            try:
                if proc.stdout:
                    while True:
                        line = await proc.stdout.readline()
                        if not line:
                            break
                if proc.stderr:
                    await proc.stderr.read()
            except Exception:
                pass

        asyncio.create_task(_drain(proc))

        return JSONResponse({"status": "success", "message": "ollama started"})
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


@app.post("/api/stop_ollama")
async def api_stop_ollama():
    """Stop ollama serve if we started it."""
    global ollama_process
    try:
        if ollama_process is None:
            return JSONResponse({"status": "success", "message": "no local ollama started by server"})
        try:
            ollama_process.terminate()
        except Exception:
            try:
                ollama_process.kill()
            except Exception:
                pass
        try:
            await asyncio.wait_for(ollama_process.wait(), timeout=5)
        except Exception:
            pass
        ollama_process = None
        return JSONResponse({"status": "success", "message": "ollama stopped"})
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


def get_or_create_agent(user_id: str) -> Agent:
    """获取或创建用户的Agent实例"""
    if user_id not in user_ids:
        user_ids.add(user_id)
    if user_id not in user_agents:
        user_agents[user_id] = base_agent.copy()
    return user_agents[user_id]


def remove_agent(user_id: str):
    """移除用户的Agent实例"""
    if user_id in user_agents:
        del user_agents[user_id]


async def setup_stream_handlers(agent: Agent, ws: WebSocket) -> asyncio.Event:
    """设置流式处理器并返回完成事件"""
    stream_done = asyncio.Event()

    async def stream_handler(chunk: str):
        try:
            await ws.send_text(json.dumps({"type": "chunk", "data": chunk}))
        except Exception:
            pass
        finally:
            try:
                with open("/tmp/ws_outgoing.log", "a", encoding="utf-8") as of:
                    of.write(json.dumps({"type": "chunk", "data": chunk}, ensure_ascii=False) + "\n")
            except Exception:
                pass

    async def reasoning_handler(reasoning: str):
        try:
            await ws.send_text(json.dumps({"type": "reasoning", "data": reasoning}))
        except Exception:
            pass
        finally:
            try:
                with open("/tmp/ws_outgoing.log", "a", encoding="utf-8") as of:
                    of.write(json.dumps({"type": "reasoning", "data": reasoning}, ensure_ascii=False) + "\n")
            except Exception:
                pass

    async def response_handler(message_dict) -> None:
        try:
            await ws.send_text(
                json.dumps({"type": "final", "data": message_dict.get("content")})
            )
        except Exception:
            pass
        finally:
            stream_done.set()
            try:
                with open("/tmp/ws_outgoing.log", "a", encoding="utf-8") as of:
                    of.write(json.dumps({"type": "final", "data": message_dict.get("content")}, ensure_ascii=False) + "\n")
            except Exception:
                pass

    async def tool_call_handler(tool_call):
        try:
            # 解析被调用的工具名称，优雅处理找不到的情况
            tool_name = None
            try:
                tool_name = tool_call.get("function", {}).get("name")
            except Exception:
                tool_name = None

            display_name = tool_name or "unknown"
            try:
                # 在注册的 tools 映射中查找 display name（键名）
                display_name = next(
                    (dn for dn, t in tools.items() if getattr(t, "name", None) == tool_name),
                    display_name,
                )
            except Exception:
                pass

            payload = {
                "type": "tool_call",
                "data": f"已调用工具：{display_name}",
                "tool_call_id": tool_call.get("id"),
            }
            await ws.send_text(json.dumps(payload))
        except Exception:
            pass

    agent.stream_chunk_handlers = [stream_handler]
    agent.stream_reasoning_handlers = [reasoning_handler]
    agent.response_handlers = [response_handler]
    agent.tool_call_handlers = [tool_call_handler]

    return stream_done


@app.get("/")
async def index(request: Request):
    if request.client and request.client.host in BLACKMARK_LIST:
        return FileResponse(os.path.join(static_dir, "blocked.html"))
    return FileResponse(os.path.join(static_dir, "index.html"))


@app.get("/api/generate-user-id/{user_id}")
def generate_user_id(user_id):
    if not user_id in user_ids:
        user_id = str(uuid.uuid4())  # 为新连接生成唯一用户ID
    user_ids.add(user_id)
    return {"type": "id", "data": user_id}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """WebSocket 流式对话与强制停止支持"""
    await ws.accept()
    # 初次握手获取 userId
    while True:
        text = await ws.receive_text()
        payload = json.loads(text)
        user_id = payload.get("userId")
        if user_id:
            break
        await asyncio.sleep(0.05)
    user_ids.add(user_id)
    active_connections[user_id] = ws
    log_current_state()

    try:
        agent: Agent = get_or_create_agent(user_id)
        while True:
            # 等待一条包含 messages 的指令
            while True:
                text = await ws.receive_text()
                # 记录原始收到的数据，便于调试前端没有发送 messages 或相关字段的情况
                try:
                    with open("/tmp/ws_raw.log", "a", encoding="utf-8") as rf:
                        rf.write(text.replace("\n", "\\n") + "\n")
                except Exception:
                    pass
                payload = json.loads(text)
                if payload.get("messages"):
                    break
                await asyncio.sleep(0.05)

            # 临时调试：记录收到的 payload 中关键信息，帮助排查前端是否发送了 base_url/thinking_mode
            try:
                debug_entry = {
                    "user_id": user_id,
                    "has_messages": bool(payload.get("messages")),
                    "model": payload.get("model"),
                    "base_url": payload.get("base_url"),
                    "api_key_present": bool(payload.get("api_key")),
                    "thinking_mode": payload.get("thinking_mode"),
                }
                with open("/tmp/ws_payloads.log", "a", encoding="utf-8") as df:
                    df.write(json.dumps(debug_entry, ensure_ascii=False) + "\n")
            except Exception:
                pass

            stream_done = await setup_stream_handlers(agent, ws)

            messages = payload.get("messages")
            temperature = payload.get("temperature", 100) / 100
            frequency_penalty = payload.get("frequency_penalty", 0) / 100
            tool_settings = payload.get("tool_settings", {})
            model = payload.get("model", MODEL)
            thinking_mode = payload.get("thinking_mode", "disabled")

            if messages:
                agent.messages = messages
            agent.model = model
            # 如果前端传来了 base_url 或 api_key，优先使用它们（支持 Ollama 等本地模型后端）
            try:
                incoming_base = payload.get("base_url")
                incoming_key = payload.get("api_key")
                if incoming_base:
                    setattr(agent, "base_url", incoming_base)
                else:
                    # 如果 agent 没有 base_url 属性，确保使用默认 BASE_URL
                    if not getattr(agent, "base_url", None):
                        setattr(agent, "base_url", BASE_URL)
                if incoming_key:
                    setattr(agent, "api_key", incoming_key)
            except Exception:
                pass
            agent.thinking = thinking_mode
            agent.temperature = temperature
            agent.frequency_penalty = frequency_penalty

            # 工具激活/移除
            for tool_name, is_activated in tool_settings.items():
                if tool_name in tools:
                    if is_activated:
                        agent.add_tool(tools[tool_name])
                    else:
                        agent.remove_tool(tools[tool_name])

            # 触发对话（流式）
            try:
                # 我们在 agent.run 中传入 stream=True
                await agent.run(stream=True)
            except Exception as e:
                await ws.send_text(
                    json.dumps(
                        {"type": "error", "data": f"{type(e).__name__}: {e}"}
                    )
                )
                stream_done.set()

            await stream_done.wait()
            # 清理任务引用：如果存在已完成或被取消的生成任务则移除引用
            try:
                t = user_generation_tasks.get(user_id)
                if t is not None:
                    if getattr(t, 'done', lambda: True)():
                        user_generation_tasks.pop(user_id, None)
            except Exception:
                user_generation_tasks.pop(user_id, None)
            await ws.send_text(json.dumps({"type": "finish", "data": ""}))

    except WebSocketDisconnect:
        if user_id in user_agents:
            user_agents[user_id].messages = base_agent.messages.copy()
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        active_connections.pop(user_id, None)
        # 延迟释放 agent 以防快速重连
        await asyncio.sleep(3)
        if user_id not in active_connections:
            remove_agent(user_id)
            logger.info(f"Agent {user_id} removed")
        log_current_state()


@app.post("/clear/{user_id}")
async def clear(user_id: str):
    try:
        user_ids.add(user_id)
        agent = get_or_create_agent(user_id)
        agent.messages = base_agent.messages.copy()
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/tool_list")
def default_tool_list():
    try:
        return {
            "status": "success",
            "tools": list(tools),
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/api/simulate_stream")
async def simulate_stream(payload: dict = Body({})):
    """Simulate streaming messages to a connected frontend WebSocket.

    JSON body example:
      { "user_id": "<userId>",
        "chunks": ["Hello", " world!"],
        "reasoning": ["正在检索相关文档..."] ,
        "delay_ms": 300 }

    This will send a sequence of messages of types: chunk, reasoning, final, finish.
    """
    try:
        user_id = payload.get("user_id")
        if not user_id:
            return JSONResponse({"status": "error", "message": "missing user_id"}, status_code=400)

        ws = active_connections.get(user_id)
        if not ws:
            return JSONResponse({"status": "error", "message": "no active websocket for this user_id"}, status_code=404)

        chunks = payload.get("chunks", []) or []
        reasoning = payload.get("reasoning", []) or []
        delay_ms = int(payload.get("delay_ms", 300))

        async def _runner():
            try:
                # send chunk pieces
                for c in chunks:
                    try:
                        await ws.send_text(json.dumps({"type": "chunk", "data": c}))
                    except Exception:
                        pass
                    await asyncio.sleep(delay_ms / 1000.0)

                # send reasoning blocks
                for r in reasoning:
                    try:
                        await ws.send_text(json.dumps({"type": "reasoning", "data": r}))
                    except Exception:
                        pass
                    await asyncio.sleep(delay_ms / 1000.0)

                # final message and finish
                try:
                    await ws.send_text(json.dumps({"type": "final", "data": "(模拟) 流式完成"}))
                except Exception:
                    pass
                try:
                    await ws.send_text(json.dumps({"type": "finish", "data": ""}))
                except Exception:
                    pass
            except Exception:
                # runner should never raise to crash the request
                pass

        asyncio.create_task(_runner())
        return JSONResponse({"status": "started"})
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


@app.get("/api/active_users")
async def api_active_users():
    """Return list of currently active websocket user IDs (for debugging)."""
    try:
        return JSONResponse({"status": "success", "users": list(active_connections.keys())})
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


@app.post("/api/simulate_stream/broadcast")
async def simulate_stream_broadcast(payload: dict = Body({})):
    """Broadcast simulated stream to all active websocket connections.

    Body same as /api/simulate_stream but without user_id.
    """
    try:
        chunks = payload.get("chunks", []) or []
        reasoning = payload.get("reasoning", []) or []
        delay_ms = int(payload.get("delay_ms", 300))

        if not active_connections:
            return JSONResponse({"status": "error", "message": "no active websocket connections"}, status_code=404)

        async def _runner(ws):
            try:
                for c in chunks:
                    try:
                        await ws.send_text(json.dumps({"type": "chunk", "data": c}))
                    except Exception:
                        pass
                    await asyncio.sleep(delay_ms / 1000.0)
                for r in reasoning:
                    try:
                        await ws.send_text(json.dumps({"type": "reasoning", "data": r}))
                    except Exception:
                        pass
                    await asyncio.sleep(delay_ms / 1000.0)
                try:
                    await ws.send_text(json.dumps({"type": "final", "data": "(模拟) 流式完成"}))
                except Exception:
                    pass
                try:
                    await ws.send_text(json.dumps({"type": "finish", "data": ""}))
                except Exception:
                    pass
            except Exception:
                pass

        # Launch runners for all active connections
        for uid, ws in list(active_connections.items()):
            asyncio.create_task(_runner(ws))

        return JSONResponse({"status": "started", "targets": list(active_connections.keys())})
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


@app.post("/stop_generation/{user_id}")
async def stop_generation(user_id: str):
    """强制停止当前用户的模型生成（流式 Prompt）。"""
    try:
        if user_id in user_agents:
            try:
                user_agents[user_id].stop_generation()
            except Exception:
                pass
        task = user_generation_tasks.get(user_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        ws = active_connections.get(user_id)
        if ws:
            try:
                await ws.send_text(json.dumps({"type": "error", "data": "已强制停止当前生成"}))
                await ws.send_text(json.dumps({"type": "finish", "data": ""}))
            except Exception:
                pass
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


title_agent = Agent(
    base_url=BASE_URL,
    api_key=API_KEY,
    model="qwen3:4b",
    temperature=0.0,
    thinking="disabled",
    instructions="""你是一个标题生成器，请根据以下用户提问生成一个简洁的标题，直接输出标题即可，不要输出其他任何内容。
    - 错误输出: `用户提问生成标题：{你的标题}`
    - 错误输出: `用户的要求是让我输出一个简洁的标题，请直接输出标题即可，不要输出其他任何内容，那么...`
    - 错误输出: `好的，您希望生成的标题是：{你的标题}`
    - 错误输出: `您好！请问有什么可以为您效劳？`（太长了，而且并不像标题）
    - 正确输出: `{你的标题}`

    ### 你可以无视开头的问候内容
    """,
)


@app.post("/generate_title")
async def generate_title(data: dict = Body()):
    try:
        text = data.get("text")
        async with title_agent.safe_modify(merge_messages=False) as _agent:
            _agent.messages = base_agent.messages.copy()
            title = await _agent.run(
                f"请基于以下内容生成简短的标题（你可以无视开头的问候内容），不要输出其他任何内容：\n\n{text}",
            )
            return {"status": "success", "title": title}
    except Exception as e:
        return {"status": "error", "message": str(e)}


build_log_path = os.path.join(GRAPH_RAG_ROOT, "upload_build.log")

async def _cancel_current_build():
    global build_process, build_task
    try:
        if build_process is not None and build_status.get("state") in {"running", "pending"}:
            try:
                build_process.terminate()
            except Exception:
                try:
                    build_process.kill()
                except Exception:
                    pass
            # 等待进程结束，超时则强杀
            try:
                await asyncio.wait_for(build_process.wait(), timeout=5)
            except asyncio.TimeoutError:
                try:
                    build_process.kill()
                except Exception:
                    pass
            build_status["state"] = "cancelled"
            build_status["finished_at"] = str(asyncio.get_event_loop().time())
            with open(build_log_path, "a", encoding="utf-8", errors="ignore") as lf:
                lf.write("\n构建被取消。\n")
        if build_task and not build_task.done():
            build_task.cancel()
            try:
                await build_task
            except Exception:
                pass
    finally:
        build_process = None
        build_task = None

@app.post("/cancel_build")
async def cancel_build():
    if build_status.get("state") not in {"running", "pending"}:
        return JSONResponse({"status": "success", "message": "当前没有进行中的构建"})
    await _cancel_current_build()
    return JSONResponse({"status": "success", "message": "构建已取消"})

@app.post("/upload_kb")
async def upload_kb(files: list[UploadFile] = File(...), force: bool = Form(False)):
    """启动异步构建：清空旧数据 -> 保存文件 -> 后台运行 main.py，前端轮询 /upload_log 与 /build_status"""
    try:
        if build_status.get("state") in {"running", "pending"}:
            if not force:
                return JSONResponse(status_code=409, content={"status": "error", "message": "已有构建任务正在进行"})
            # 强制重启：取消当前构建
            await _cancel_current_build()
            with open(build_log_path, "a", encoding="utf-8", errors="ignore") as lf:
                lf.write("\n已收到 force 请求，正在重启构建...\n")

        # 重置日志文件
        try:
            if os.path.exists(build_log_path):
                os.remove(build_log_path)
        except Exception:
            pass

        # 清空 input 目录
        logger.info(f"清空知识库目录: {GRAPH_RAG_INPUT}")
        if os.path.exists(GRAPH_RAG_INPUT):
            for item in os.listdir(GRAPH_RAG_INPUT):
                item_path = os.path.join(GRAPH_RAG_INPUT, item)
                if os.path.isfile(item_path):
                    os.remove(item_path)
                    logger.info(f"  已删除输入文件: {item}")
                elif os.path.isdir(item_path):
                    shutil.rmtree(item_path)
                    logger.info(f"  已删除输入目录: {item}")

        # 清空旧图谱缓存
        logger.info(f"清空旧知识图谱数据: {GRAPH_RAG_ROOT}")
        if os.path.exists(GRAPH_RAG_ROOT):
            import glob
            patterns = ["*.graphml", "kv_store_*.json", "vdb_*.json", "*.parquet"]
            for pattern in patterns:
                for fp in glob.glob(os.path.join(GRAPH_RAG_ROOT, pattern)):
                    if os.path.isfile(fp):
                        os.remove(fp)
                        logger.info(f"  已删除旧图谱文件: {os.path.basename(fp)}")

        Path(GRAPH_RAG_INPUT).mkdir(parents=True, exist_ok=True)

        saved_files: list[str] = []
        for up in files:
            name = up.filename or "unnamed_file"
            path = os.path.join(GRAPH_RAG_INPUT, name)
            content = await up.read()
            with open(path, "wb") as f:
                f.write(content)
            logger.info(f"  已保存文件: {name} ({len(content)} bytes)")
            saved_files.append(name)

        input_files = [f for f in os.listdir(GRAPH_RAG_INPUT) if os.path.isfile(os.path.join(GRAPH_RAG_INPUT, f))]
        if not input_files:
            return JSONResponse(status_code=400, content={"status": "error", "message": "input 目录为空"})
        logger.info(f"发现 {len(input_files)} 个文件: {input_files}")

        cmd = [
            sys.executable, os.path.join(MINIRAG_ROOT, "main.py"),
            "--workingdir", GRAPH_RAG_ROOT,
            "--datapath", GRAPH_RAG_INPUT
        ]

        build_status.update({
            "state": "pending",
            "pid": "",
            "started_at": "",
            "finished_at": "",
            "returncode": "",
            "task": "构建知识图谱"
        })

        async def run_build():
            build_status["state"] = "running"
            build_status["started_at"] = str(asyncio.get_event_loop().time())
            try:
                global build_process
                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    cwd=MINIRAG_ROOT,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                build_process = process
                build_status["pid"] = str(process.pid)

                # 按行读取 stdout
                async with aiofile_async_writer(build_log_path) as writer:
                    await writer.write(f"执行命令: {' '.join(cmd)}\n")
                    await writer.write(f"工作目录: {MINIRAG_ROOT}\n")
                    if process.stdout is not None:
                        while True:
                            line = await process.stdout.readline()
                            if not line:
                                break
                            await writer.write(line.decode('utf-8', errors='ignore'))
                    # 读取 stderr 全量
                    stderr_data = b""
                    if process.stderr is not None:
                        stderr_data = await process.stderr.read()
                    if stderr_data:
                        await writer.write("\n[stderr]\n")
                        await writer.write(stderr_data.decode('utf-8', errors='ignore'))
                rc = await process.wait()
                build_status["returncode"] = str(rc)
                build_status["finished_at"] = str(asyncio.get_event_loop().time())
                build_status["state"] = "success" if rc == 0 else "error"
            except Exception as e:
                build_status["state"] = "error"
                build_status["finished_at"] = str(asyncio.get_event_loop().time())
                with open(build_log_path, "a", encoding="utf-8", errors="ignore") as lf:
                    lf.write(f"\n构建异常: {e}\n")

        # 简单异步文件写帮助（避免引入额外依赖）
        class aiofile_async_writer:
            def __init__(self, path: str):
                self.path = path
                self.file = None
            async def __aenter__(self):
                self.file = open(self.path, "a", encoding="utf-8", errors="ignore")
                return self
            async def write(self, data: str):
                if self.file is not None:
                    self.file.write(data)
                    self.file.flush()
            async def __aexit__(self, exc_type, exc, tb):
                if self.file is not None:
                    self.file.close()

        global build_task
        build_task = asyncio.create_task(run_build())

        return JSONResponse({
            "status": "success",
            "message": "构建任务已启动" + (" (强制重启)" if force else ""),
            "filename": ", ".join(saved_files),
            "force": force
        })
    except Exception as e:
        build_status["state"] = "error"
        build_status["finished_at"] = str(asyncio.get_event_loop().time())
        logger.error(f"启动构建失败: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

@app.get("/upload_log")
async def get_upload_log():
    try:
        if not os.path.exists(build_log_path):
            return JSONResponse({"status": "success", "log": ""})
        with open(build_log_path, "r", encoding="utf-8", errors="ignore") as f:
            data = f.read()
        return JSONResponse({"status": "success", "log": data})
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

@app.get("/build_status")
async def get_build_status():
    return JSONResponse({"status": "success", "build_status": build_status})


@app.post("/rag_query")
async def rag_query(request: Request):
    """
    使用 MiniRAG 查询知识图谱
    """
    try:
        # 如果服务器环境中未安装 minirag，提前返回可读的错误提示，避免临时脚本报错
        import importlib.util
        if importlib.util.find_spec("minirag") is None:
            return JSONResponse(
                status_code=500,
                content={
                    "status": "error",
                    "message": "MiniRAG 未安装或未配置。请在服务器环境中安装本地 MiniRAG：\n`pip install -e /path/to/MiniRAG` 或 安装依赖 requirements.txt。",
                },
            )
        data = await request.json()
        query_text = data.get("query", "")
        
        if not query_text:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "查询内容不能为空"}
            )
        
        logger.info(f"RAG 查询: {query_text}")
        
        # 使用 MiniRAG 的 Python API 进行查询（需要导入并初始化）
        # 这里简化为调用 rag_cli.py 或直接导入 MiniRAG 模块
        # 暂时使用子进程方式调用查询脚本
        
        # 创建临时查询脚本
        import tempfile
        query_script = f"""
import os
import asyncio
os.environ["OPENAI_API_KEY"] = "sk-dummy"
from minirag import MiniRAG, QueryParam
from minirag.llm.openai import openai_complete
from minirag.llm.hf import hf_embed
from minirag.utils import EmbeddingFunc
from transformers import AutoModel, AutoTokenizer

WORKING_DIR = "{GRAPH_RAG_ROOT}"
LLM_MODEL = "qwen3:4b"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

class _KV:
    def __init__(self, model_name: str):
        self.global_config = {{"llm_model_name": model_name}}

_kv = _KV(LLM_MODEL)

async def llm_func(prompt, system_prompt=None, history_messages=None, **kwargs):
    if history_messages is None:
        history_messages = []
    return await openai_complete(
        prompt,
        system_prompt=system_prompt,
        history_messages=history_messages,
        base_url="http://localhost:11434/v1",
        hashing_kv=_kv,
    )

rag = MiniRAG(
    working_dir=WORKING_DIR,
    llm_model_func=llm_func,
    llm_model_max_token_size=200,
    llm_model_name=LLM_MODEL,
    embedding_func=EmbeddingFunc(
        embedding_dim=384,
        max_token_size=1000,
        func=lambda texts: hf_embed(
            texts,
            tokenizer=AutoTokenizer.from_pretrained(EMBEDDING_MODEL, local_files_only=True),
            embed_model=AutoModel.from_pretrained(EMBEDDING_MODEL, local_files_only=True),
        ),
    ),
)

query = '''{query_text}'''
result = rag.query(query, param=QueryParam(mode="mini"))
print(result)
"""
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(query_script)
            temp_script_path = f.name
        
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable, temp_script_path,
                cwd=MINIRAG_ROOT,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await process.communicate()
            
            stdout_text = stdout.decode('utf-8', errors='ignore')
            stderr_text = stderr.decode('utf-8', errors='ignore')
            
            if process.returncode == 0:
                return JSONResponse({
                    "status": "success",
                    "answer": stdout_text.strip(),
                    "query": query_text
                })
            else:
                logger.error(f"RAG 查询失败: {stderr_text}")
                return JSONResponse(
                    status_code=500,
                    content={
                        "status": "error",
                        "message": "RAG 查询失败",
                        "details": stderr_text
                    }
                )
        finally:
            os.unlink(temp_script_path)
            
    except Exception as e:
        logger.error(f"RAG 查询异常: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


# 兼容旧前端路径：/rag/chat -> /rag_query
@app.post("/rag/chat")
async def rag_chat(request: Request):
    # 直接复用 rag_query 的逻辑
    return await rag_query(request)


# 兼容旧前端上传路径：/rag/upload -> /upload_kb
@app.post("/rag/upload")
async def rag_upload(files: list[UploadFile] = File(...)):
    # 直接调用现有 upload_kb 处理逻辑
    return await upload_kb(files)


# 兼容旧前端日志轮询路径：/rag/upload_log -> /upload_log
@app.get("/rag/upload_log")
def rag_upload_log():
    try:
        build_log_path = os.path.join(GRAPH_RAG_ROOT, "upload_build.log")
        if not os.path.exists(build_log_path):
            return JSONResponse({"status": "success", "log": ""})
        with open(build_log_path, "r", encoding="utf-8", errors="ignore") as f:
            data = f.read()
        return JSONResponse({"status": "success", "log": data})
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


# 定义简单的 RAG 工具
async def rag_tool_func(query: str) -> str:
    """使用知识图谱查询相关信息"""
    return f"RAG工具已接收查询: {query}。请先上传文档并构建知识图谱。"

# 不直接使用 Tool(...) 构造（与 ez_agent.Tool 签名不兼容），后面会用 SimpleTool 注册

class SimpleTool(Tool):
    """A lightweight Tool implementation compatible with ez_agent.Tool abstract API."""
    def __init__(self, name: str, description: str = "", parameters: dict | None = None, func=None, foldable: bool = False):
        self.name = name
        self.description = description or ""
        self.parameters = parameters or {}
        self._func = func
        self.foldable = foldable

    def __repr__(self) -> str:
        return self.name

    def __call__(self, *args, **kwargs):
        if self._func is None:
            return ""
        if inspect.iscoroutinefunction(self._func):
            return self._func(*args, **kwargs)
        return self._func(*args, **kwargs)

    def to_dict(self):
        # Return a ChatCompletionToolParam-compatible dict
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


tools["RAG"] = SimpleTool(
    name="RAG",
    description="使用知识图谱查询相关信息。当用户询问与上传文档相关的问题时使用。",
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "用户的查询问题",
            }
        },
        "required": ["query"],
    },
    func=rag_tool_func,
)
