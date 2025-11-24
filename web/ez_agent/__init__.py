"""Lightweight local replacement for `ez_agent` used by the web demo.

This module implements a compat layer that provides the APIs the `web/backend.py`
expects while remaining installable on Python 3.11. It is a pragmatic shim:
- parses a simple `mcp.json` (if present) and registers MCP servers as callable
  tools via a lightweight `MCPClient`.
- exposes an `Agent` class with methods used by the demo (`load_mcp_config`,
  `get_tool`, `add_tool`, `remove_tool`, `run`, `safe_modify`, `copy`,
  `cleanup`, `stop_generation`).

This is intentionally pragmatic (not a full replacement of upstream `ez-agent`).
If you later want exact upstream behavior, either run in Python 3.13 and install
the real package, or expand this shim accordingly.
"""
from __future__ import annotations
import asyncio
import contextlib
import json
import os
import shlex
import subprocess
from typing import Any, Callable, Dict, Optional

# Use requests for synchronous HTTP calls to local Ollama/OpenAI-compatible endpoints.
try:
    import requests
except Exception:
    requests = None


class Tool:
    def __init__(self, name: str, func: Callable | None = None, description: str = "", parameters: dict | None = None):
        self.name = name
        self._func = func
        self.description = description or ""
        self.parameters = parameters or {}

    def __repr__(self):
        return f"Tool({self.name})"

    async def __call__(self, *args, **kwargs):
        if self._func is None:
            return None
        if asyncio.iscoroutinefunction(self._func):
            return await self._func(*args, **kwargs)
        # run sync function in threadpool to avoid blocking
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, lambda: self._func(*args, **kwargs))

    def to_dict(self):
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


def FoldableAsyncFunctionTool(func=None, **kwargs):
    """Decorator that wraps an async function into a Tool instance.

    Usage in upstream code is decorator style; here we return a Tool instance
    when used as `@FoldableAsyncFunctionTool(name="foo")` or the original
    function if called without kwargs.
    """
    if func is None:
        def _wrap(f):
            name = kwargs.get("name", getattr(f, "__name__", "anon_tool"))
            return Tool(name=name, func=f, description=kwargs.get("description", ""), parameters=kwargs.get("parameters", None))
        return _wrap
    # called directly on a function
    name = kwargs.get("name", getattr(func, "__name__", "anon_tool"))
    return Tool(name=name, func=func, description=kwargs.get("description", ""), parameters=kwargs.get("parameters", None))


class MCPClient:
    """Minimal MCP manager.

    Responsibilities implemented:
    - load config dict (with `mcpServers` mapping)
    - start/stop server processes if a command is defined
    - call a server by running its command with optional payload on stdin

    This is NOT a full MCP protocol implementation, but is sufficient for the
    demo: it allows tools backed by subprocess-based MCP servers defined in
    `mcp.json` to be invoked from the Agent.
    """
    def __init__(self, config: dict | None = None, base_path: str | None = None):
        self.config = config or {}
        self.base_path = base_path or os.getcwd()
        self.servers: Dict[str, dict] = {}
        self.procs: Dict[str, subprocess.Popen] = {}
        if self.config:
            self.load_config(self.config)

    def load_config(self, cfg: dict):
        self.config = cfg
        self.servers = cfg.get("mcpServers", {}) or {}

    def start_server(self, name: str) -> bool:
        info = self.servers.get(name)
        if not info:
            return False
        cmd = info.get("command")
        args = info.get("args") or []
        # Normalize Windows-style cmd + /c npx entries for Linux: try to run the inner command
        if cmd and cmd.lower().endswith("cmd.exe") and args and args[0] == "/c":
            # join rest
            exec_args = args[1:]
            try:
                proc = subprocess.Popen(exec_args, cwd=self.base_path)
                self.procs[name] = proc
                return True
            except Exception:
                return False
        try:
            proc = subprocess.Popen([cmd] + args, cwd=self.base_path)
            self.procs[name] = proc
            return True
        except Exception:
            return False

    def stop_server(self, name: str) -> bool:
        p = self.procs.get(name)
        if not p:
            return False
        try:
            p.terminate()
            p.wait(timeout=2)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
        self.procs.pop(name, None)
        return True

    def call(self, name: str, payload: Optional[str] = None, timeout: int = 5) -> dict:
        """Call server by running its configured command with optional payload on stdin.

        Returns a dict {"ok": bool, "stdout": str, "stderr": str, "rc": int}
        """
        info = self.servers.get(name)
        if not info:
            return {"ok": False, "stdout": "", "stderr": f"no server config for {name}", "rc": -1}
        cmd = info.get("command")
        args = info.get("args") or []
        if cmd and cmd.lower().endswith("cmd.exe") and args and args[0] == "/c":
            exec_args = args[1:]
        else:
            exec_args = [cmd] + args
        try:
            p = subprocess.Popen(exec_args, cwd=self.base_path, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            out, err = p.communicate(input=(payload.encode("utf-8") if payload else None), timeout=timeout)
            return {"ok": True, "stdout": out.decode("utf-8", errors="ignore"), "stderr": err.decode("utf-8", errors="ignore"), "rc": p.returncode}
        except Exception as e:
            return {"ok": False, "stdout": "", "stderr": str(e), "rc": -2}


class FoldableMCPTool(Tool):
    pass


class Agent:
    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        instructions: str | None = None,
        **kwargs,
    ):
        self.model = model
        self.api_key = api_key
        self.base_url = base_url
        self.instructions = instructions
        self.messages: list[dict] = []
        self.tools: list[Tool] = []
        # _tools: name -> Tool (tools discovered from MCP config or registered explicitly)
        self._tools: Dict[str, Tool] = {}

        # stream handler hooks (set by external code)
        self.stream_chunk_handlers: list[Callable[[str], Any]] = []
        self.stream_reasoning_handlers: list[Callable[[str], Any]] = []
        self.response_handlers: list[Callable[[dict], Any]] = []
        self.tool_call_handlers: list[Callable[[dict], Any]] = []

        self._mcp_client: Optional[MCPClient] = None

    async def load_mcp_config(self, path: str):
        """Load a simple mcp.json and register tools exposed by it.

        The implementation is best-effort: it reads `mcpServers` entries and
        creates simple Tool wrappers that call the `MCPClient.call` method.
        """
        try:
            if not os.path.exists(path):
                # nothing to load
                return
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            self._mcp_client = MCPClient(cfg, base_path=os.path.dirname(path) or None)
            # register tools
            for name, info in (cfg.get("mcpServers", {}) or {}).items():
                # create an async callable that calls the MCP server
                async def _call_wrapper(payload: str | None = None, _name=name):
                    # run in executor to avoid blocking event loop
                    loop = asyncio.get_event_loop()
                    return await loop.run_in_executor(None, lambda: self._mcp_client.call(_name, payload))

                t = FoldableMCPTool(name=name, func=_call_wrapper)
                self._tools[name] = t
        except Exception:
            self._tools = {}

    def get_tool(self, name: str):
        return self._tools.get(name)

    def add_tool(self, tool: Any):
        # Accept Tool instances, callables, or plain functions
        if isinstance(tool, Tool):
            if tool not in self.tools:
                self.tools.append(tool)
            return
        if callable(tool):
            # try to infer a name
            name = getattr(tool, "name", getattr(tool, "__name__", "anon"))
            t = Tool(name=name, func=tool)
            if t not in self.tools:
                self.tools.append(t)
            return

    def remove_tool(self, tool: Any):
        try:
            if isinstance(tool, Tool):
                self.tools.remove(tool)
            elif isinstance(tool, str):
                self.tools = [t for t in self.tools if t.name != tool]
            else:
                # unknown, try to remove by identity
                self.tools.remove(tool)
        except Exception:
            pass

    def copy(self) -> "Agent":
        a = Agent(model=self.model, api_key=self.api_key, base_url=self.base_url, instructions=self.instructions)
        a.messages = list(self.messages)
        a.tools = list(self.tools)
        a._tools = dict(self._tools)
        a._mcp_client = self._mcp_client
        return a

    async def cleanup(self):
        # attempt to stop any mcp servers we started
        if self._mcp_client:
            for name in list(self._mcp_client.procs.keys()):
                try:
                    self._mcp_client.stop_server(name)
                except Exception:
                    pass
        await asyncio.sleep(0)

    def stop_generation(self):
        # For the shim, we don't keep a generator thread, so this is a noop.
        return

    @contextlib.asynccontextmanager
    async def safe_modify(self, **kwargs):
        try:
            yield self
        finally:
            await asyncio.sleep(0)

    async def run(self, *args, stream: bool = False, **kwargs):
        """Very small run implementation.

        - If `stream=True`, call stream handlers and response handlers to emulate
          streaming behavior used by the demo frontend.
        - If not streaming, return a short stub string.
        """
        # If a real LLM backend is configured via base_url and requests is available,
        # invoke the OpenAI-compatible chat completions endpoint. Otherwise fall back
        # to the original stub behavior.
        if self.base_url and requests is not None:
            # Build endpoint: accept either base_url ending with /v1 or not
            endpoint = self.base_url.rstrip("/")
            if endpoint.endswith("/v1"):
                endpoint = f"{endpoint}/chat/completions"
            else:
                endpoint = f"{endpoint}/v1/chat/completions"

            # Determine messages: prefer explicit agent.messages, but accept a
            # single string prompt passed in args (common usage in this demo).
            messages_payload = None
            if self.messages:
                # copy to avoid mutating caller's list
                messages_payload = list(self.messages)
            else:
                messages_payload = []
            # If caller provided a string prompt as first positional arg, append it
            if args and isinstance(args[0], str):
                messages_payload.append({"role": "user", "content": args[0]})

            # If thinking is enabled/auto, prepend a system instruct    ion requesting
            # the model to output an explicit reasoning block bounded by markers.
            try:
                thinking_mode = getattr(self, "thinking", None)
                if thinking_mode in ("enabled", "auto"):
                    sys_instr = {
                        "role": "system",
                        "content": (
                            "当你需要展示推理过程时，请在输出中先给出一个单独的推理区块，"
                            "用三个短划线和大写标记包裹：\n---REASONING---\n(在此处给出你的中间推理和证据)\n---END_REASONING---\n随后在推理区块之后给出最终回答。"
                        ),
                    }
                    # Only prepend if not already present
                    if not messages_payload or messages_payload[0].get("role") != "system" or "---REASONING---" not in messages_payload[0].get("content", ""):
                        messages_payload.insert(0, sys_instr)
            except Exception:
                pass

            payload = {
                "model": self.model,
                "messages": messages_payload,
            }

            # Helper: synchronous streaming caller using requests that forwards chunks
            def _sync_stream_call():
                try:
                    # state for reasoning-marker-aware forwarding
                    in_reasoning = False
                    # (we stream reasoning fragments as they arrive)
                    reasoning_buf = ''
                    headers = {"Content-Type": "application/json"}
                    if self.api_key:
                        headers["Authorization"] = f"Bearer {self.api_key}"
                    # ask remote to stream if supported
                    payload_stream = dict(payload)
                    payload_stream["stream"] = True
                    r = requests.post(endpoint, json=payload_stream, headers=headers, timeout=300, stream=True)
                    if not r.ok:
                        # Try non-streaming fallback
                        try:
                            data = r.json()
                            return data, None
                        except Exception:
                            return None, f"http:{r.status_code} {r.text}"

                    # Iterate over event stream / chunked lines and forward verbatim
                    for raw in r.iter_lines(decode_unicode=False):
                        # raw is bytes; decode explicitly as utf-8 to avoid encoding guess errors
                        if raw is None:
                            continue
                        try:
                            line = raw.decode('utf-8', errors='replace')
                        except Exception:
                            try:
                                line = raw.decode('latin1', errors='replace')
                            except Exception:
                                line = str(raw)
                        # strip only trailing CR/LF but preserve leading/trailing spaces in content
                        if line.endswith('\r'):
                            line = line[:-1]
                        line = line.rstrip('\n')
                        if not line:
                            continue
                        # SSE style: lines may start with 'data: '
                        if line.startswith('data:'):
                            payload_line = line[len('data:'):]
                        else:
                            payload_line = line
                        payload_line = payload_line.lstrip()
                        if payload_line == "[DONE]":
                            break

                        # First handle explicit reasoning markers if present (---REASONING--- / ---END_REASONING---)
                        # This allows models that embed a reasoning block in the main content to have that
                        # block forwarded to `stream_reasoning_handlers` while other text goes to chunk handlers.
                        pl = payload_line
                        if pl and ("---REASONING---" in pl or "---END_REASONING---" in pl or in_reasoning):
                            temp = pl
                            # simple state machine to extract reasoning blocks
                            while temp:
                                if not in_reasoning:
                                    sidx = temp.find('---REASONING---')
                                    if sidx == -1:
                                        # no start marker, nothing to do here
                                        break
                                    # forward any text before the reasoning start to chunk handlers
                                    before = temp[:sidx]
                                    if before and before.strip():
                                        for h in list(self.stream_chunk_handlers or []):
                                            try:
                                                res = h(before)
                                                if asyncio.iscoroutine(res):
                                                    try:
                                                        asyncio.run_coroutine_threadsafe(res, async_loop)
                                                    except Exception:
                                                        pass
                                            except Exception:
                                                pass
                                    temp = temp[sidx + len('---REASONING---'):]
                                    in_reasoning = True
                                if in_reasoning:
                                    eidx = temp.find('---END_REASONING---')
                                    if eidx == -1:
                                        # no end marker yet: forward entire temp as reasoning fragment
                                        frag = temp
                                        if frag and frag.strip():
                                            for h in list(self.stream_reasoning_handlers or []):
                                                try:
                                                    res = h(frag)
                                                    if asyncio.iscoroutine(res):
                                                        try:
                                                            asyncio.run_coroutine_threadsafe(res, async_loop)
                                                        except Exception:
                                                            pass
                                                except Exception:
                                                    pass
                                        reasoning_buf += temp
                                        temp = ''
                                        break
                                    else:
                                        frag = temp[:eidx]
                                        if frag and frag.strip():
                                            for h in list(self.stream_reasoning_handlers or []):
                                                try:
                                                    res = h(frag)
                                                    if asyncio.iscoroutine(res):
                                                        try:
                                                            asyncio.run_coroutine_threadsafe(res, async_loop)
                                                        except Exception:
                                                            pass
                                                except Exception:
                                                    pass
                                        # reset reasoning state and continue processing remainder
                                        temp = temp[eidx + len('---END_REASONING---'):]
                                        in_reasoning = False
                                        reasoning_buf = ''
                            # after reasoning processing, if any leftover (not in reasoning) forward as chunk
                            if temp and temp.strip() and not in_reasoning:
                                for h in list(self.stream_chunk_handlers or []):
                                    try:
                                        res = h(temp)
                                        if asyncio.iscoroutine(res):
                                            try:
                                                asyncio.run_coroutine_threadsafe(res, async_loop)
                                            except Exception:
                                                pass
                                    except Exception:
                                        pass
                            # we've processed this payload_line for reasoning/remaining parts
                            # continue to next streamed line
                            continue

                        # Try to parse JSON to extract common fields, but forward exact text verbatim.
                        forwarded = False
                        try:
                            j = json.loads(payload_line)
                            # If JSON contains explicit 'thinking' or 'response', forward those values verbatim
                            if isinstance(j, dict):
                                if 'thinking' in j and j.get('thinking') is not None:
                                    thinking_val = str(j.get('thinking'))
                                    for h in list(self.stream_reasoning_handlers or []):
                                        try:
                                            res = h(thinking_val)
                                            # if handler is async, schedule it on the main loop
                                            if asyncio.iscoroutine(res):
                                                try:
                                                    asyncio.run_coroutine_threadsafe(res, async_loop)
                                                except Exception:
                                                    pass
                                        except Exception:
                                            pass
                                    forwarded = True
                                if 'response' in j and j.get('response') is not None:
                                    resp_val = str(j.get('response'))
                                    for h in list(self.stream_chunk_handlers or []):
                                        try:
                                            h(resp_val)
                                        except Exception:
                                            pass
                                    forwarded = True
                                # OpenAI-style choices: extract any 'content' fields but forward verbatim
                                choices = j.get('choices') if isinstance(j.get('choices'), list) else None
                                if choices:
                                        for ch in choices:
                                            # delta content (OpenAI-style streaming)
                                            delta = ch.get('delta') or {}
                                            # If remote emits a 'reasoning' field in the delta, forward
                                            # it to the reasoning handlers (this is how Ollama streams
                                            # intermediate thoughts in some configurations).
                                            if isinstance(delta, dict) and 'reasoning' in delta and delta.get('reasoning') is not None:
                                                reasoning_val = str(delta.get('reasoning'))
                                                for h in list(self.stream_reasoning_handlers or []):
                                                    try:
                                                        res = h(reasoning_val)
                                                        if asyncio.iscoroutine(res):
                                                            try:
                                                                asyncio.run_coroutine_threadsafe(res, async_loop)
                                                            except Exception:
                                                                pass
                                                    except Exception:
                                                        pass
                                                forwarded = True
                                                # continue processing other choice fields if any
                                                # but prefer reasoning over content when present
                                            if isinstance(delta, dict) and 'content' in delta and delta.get('content') is not None:
                                                for h in list(self.stream_chunk_handlers or []):
                                                    try:
                                                        res = h(str(delta.get('content')))
                                                        if asyncio.iscoroutine(res):
                                                            try:
                                                                asyncio.run_coroutine_threadsafe(res, async_loop)
                                                            except Exception:
                                                                pass
                                                    except Exception:
                                                        pass
                                                forwarded = True
                                                continue
                                        msg = ch.get('message') or {}
                                        if isinstance(msg, dict) and 'content' in msg and msg.get('content') is not None:
                                            for h in list(self.stream_chunk_handlers or []):
                                                try:
                                                    res = h(str(msg.get('content')))
                                                    if asyncio.iscoroutine(res):
                                                        try:
                                                            asyncio.run_coroutine_threadsafe(res, async_loop)
                                                        except Exception:
                                                            pass
                                                except Exception:
                                                    pass
                                            forwarded = True
                                            continue
                        except Exception:
                            # not JSON — we'll forward raw below
                            pass

                        if forwarded:
                            continue

                        # Default: forward the payload_line verbatim to chunk handlers
                        for h in list(self.stream_chunk_handlers or []):
                            try:
                                res = h(payload_line)
                                if asyncio.iscoroutine(res):
                                    try:
                                        asyncio.run_coroutine_threadsafe(res, async_loop)
                                    except Exception:
                                        pass
                            except Exception:
                                pass
                    # After stream end, return sentinel
                    return "[stream_end]", None
                except Exception as e:
                    return None, str(e)

            # Run streaming call in executor if requested
            if stream:
                loop = asyncio.get_event_loop()
                # expose the async loop to the sync worker so it can schedule coroutines
                async_loop = loop
                content, err = await loop.run_in_executor(None, _sync_stream_call)
                if err:
                    # surface error to response handlers
                    final = {"content": f"[ez_agent remote stream error] {err}"}
                    for h in list(self.response_handlers or []):
                        try:
                            res = h(final)
                            if asyncio.iscoroutine(res):
                                await res
                        except Exception:
                            pass
                    return final["content"]

                # On normal stream end, call response handlers with empty/last content
                final = {"content": ""}
                for h in list(self.response_handlers or []):
                    try:
                        res = h(final)
                        if asyncio.iscoroutine(res):
                            await res
                    except Exception:
                        pass
                return final["content"]

            # Non-streaming path: run a normal post and return content
            def _sync_call():
                try:
                    headers = {"Content-Type": "application/json"}
                    if self.api_key:
                        headers["Authorization"] = f"Bearer {self.api_key}"
                    r = requests.post(endpoint, json=payload, headers=headers, timeout=60)
                    if not r.ok:
                        return None, f"http:{r.status_code} {r.text}"
                    try:
                        data = r.json()
                    except Exception:
                        return r.text, None

                    # Handle Ollama native response shape which may include 'response' and 'thinking'
                    if isinstance(data, dict):
                        resp = data.get('response') if 'response' in data else None
                        thinking_part = data.get('thinking') if 'thinking' in data else None
                        if thinking_part is not None:
                            final_combined = ''
                            if thinking_part:
                                final_combined += f"---REASONING---\n{thinking_part.strip()}\n---END_REASONING---\n"
                            if resp:
                                final_combined += resp
                            return final_combined, None

                    if isinstance(data, dict) and data.get('choices'):
                        choice = data['choices'][0]
                        if isinstance(choice.get('message', {}), dict):
                            return choice.get('message', {}).get('content', ''), None
                        return choice.get('text', ''), None

                    return r.text, None
                except Exception as e:
                    return None, str(e)

            loop = asyncio.get_event_loop()
            content, err = await loop.run_in_executor(None, _sync_call)
            if err:
                content = f"[ez_agent remote error] {err}"
            return content or ""

        # Fallback stub behavior when no real HTTP client or base_url configured
        if not stream:
            await asyncio.sleep(0)
            return "[ez_agent stub]"

        try:
            for h in list(self.stream_chunk_handlers or []):
                try:
                    res = h("[chunk] 模拟流式内容")
                    if asyncio.iscoroutine(res):
                        await res
                except Exception:
                    pass

            for h in list(self.stream_reasoning_handlers or []):
                try:
                    res = h("[reasoning] 模拟思考")
                    if asyncio.iscoroutine(res):
                        await res
                except Exception:
                    pass

            final = {"content": "[ez_agent shim 响应]"}
            for h in list(self.response_handlers or []):
                try:
                    res = h(final)
                    if asyncio.iscoroutine(res):
                        await res
                except Exception:
                    pass

            return final["content"]
        except Exception:
            return "[ez_agent stub error]"


__all__ = ["Agent", "Tool", "FoldableAsyncFunctionTool", "MCPClient", "FoldableMCPTool"]
