import httpx
from typing import Literal
from ez_agent import FoldableAsyncFunctionTool, MCPClient, FoldableMCPTool

# bilibili_api 是可选依赖；在缺失时提供回退实现以便后端能启动
try:
    from bilibili_api import search
    from bilibili_api.search import SearchObjectType
    _BILIBILI_AVAILABLE = True
except Exception:
    _BILIBILI_AVAILABLE = False

WEATHER_API_KEY = "5470a3ea777f4725881cd72757a468bc"
WEATHER_API_HOST = "kq2pg63hr6.re.qweatherapi.com"


def city_lookup(city_name: str) -> dict:
    url = f"https://{WEATHER_API_HOST}/geo/v2/city/lookup?location={city_name}&key={WEATHER_API_KEY}&number=1"
    response = httpx.get(url)
    return response.json()


@FoldableAsyncFunctionTool
async def get_weather(
    city_name: str,
    time: Literal["now", "24h", "72h" "3d", "7d", "15d", "30d"] = "now",
) -> str:
    """
    获取当前天气，返回值均为公制单位

    :param city_name: 城市名称，支持模糊搜索，可精确到区县
    :param time: 时间，可选值为now、24h、72h、3d、7d、15d、30d，now返回当前天气，h结尾返回未来几小时天气，d结尾返回未来几天天气。默认为now。例如，如果用户问你明天的天气，则此参数可以设置为"24h"。
    :return: 天气信息
    """
    location = city_lookup(city_name).get("location")
    if not location:
        return "城市名称未知"
    location_id = location[0]["id"]
    url = f"https://{WEATHER_API_HOST}/v7/weather/{time}?location={location_id}&key={WEATHER_API_KEY}"
    async with httpx.AsyncClient() as client:
        response = await client.get(url)
    match time:
        case "now":
            return str(response.json()["now"])
        case "24h" | "72h":
            return str(response.json()["hourly"])
        case "3d" | "7d" | "15d" | "30d":
            return str(response.json()["daily"])
        case _:
            return f"Invalid time parameter: {time}"


@FoldableAsyncFunctionTool
async def search_bili(
    keyword: str,
    type: Literal["video", "article", "user", "live", "topic", "ft"] = "video",
    page_size: int = 5,
) -> str:
    """
    搜索bilibili

    :param keyword: 搜索关键词
    :param type: 搜索类型，可选值为video、article、user、live、topic、ft(影视)
    :return: 搜索结果
    """
    search_type_map = {
        "video": SearchObjectType.VIDEO,
        "article": SearchObjectType.ARTICLE,
        "user": SearchObjectType.USER,
        "live": SearchObjectType.LIVE,
        "topic": SearchObjectType.TOPIC,
        "ft": SearchObjectType.FT,
    }
    if not _BILIBILI_AVAILABLE:
        # 回退实现：返回一个提示字符串，避免在没有依赖时抛出异常
        return f"bilibili_api 未安装，无法执行搜索：{keyword}"

    result = await search.search_by_type(
        keyword, search_type=search_type_map[type], page_size=page_size
    )

    return str(result.get("result", result))
