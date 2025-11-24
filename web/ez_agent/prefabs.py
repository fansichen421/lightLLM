from . import Tool
import time


def get_time_tool():
    def _now(*args, **kwargs):
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())

    return Tool(name="time", func=_now)


def python_script_tool_safer():
    async def _run_script(code: str):
        # Very small, safe-ish sandbox: do not execute arbitrary code.
        # For demo purposes we simply return the code length and a note.
        return f"(simulated) python script length={len(code)}"

    return Tool(name="python_script_safer", func=_run_script)
