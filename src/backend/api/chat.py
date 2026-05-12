"""Multi-turn teacher dialogue for iterating on integration decisions."""
from fastapi import APIRouter
from pydantic import BaseModel

from core.llm import multi_turn

router = APIRouter(prefix="/api/chat", tags=["chat"])

_sessions: dict[str, list[dict]] = {}

SYSTEM = """你是一个学科知识整合助手，帮助教师审查和修改多本教材的知识整合方案。

你可以：
1. 解释为什么某些知识点被合并或删除
2. 根据教师要求保留某个知识点（回复包含 ACTION:KEEP:<decision_id>）
3. 根据教师要求拆分某个合并（回复包含 ACTION:SPLIT:<decision_id>）
4. 回答关于整合方案的问题

回答要简洁专业，使用中文。如果需要执行操作，在回答末尾用 ACTION: 标记。
"""


class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"


class ChatResponse(BaseModel):
    reply: str
    action: str | None = None
    session_id: str


@router.post("/")
def chat(req: ChatRequest):
    import api.graph as graph_mod

    history = _sessions.setdefault(req.session_id, [])

    stats = graph_mod._stats or {}
    decisions = graph_mod._decisions or []

    if stats:
        stats_lines = "\n".join(f"  - {k}: {v}" for k, v in stats.items())
    else:
        stats_lines = "  （尚未运行整合，无统计信息）"

    context = f"\n\n[当前整合状态]\n{stats_lines}\n\n最近决策（前10条）：\n"
    for d in decisions[:10]:
        context += f"- {d.decision_id}: {d.action} | {d.reason}\n"

    user_content = req.message + (context if not history else "")
    history.append({"role": "user", "parts": [user_content]})

    try:
        reply = multi_turn(history, system=SYSTEM)
    except Exception as e:
        reply = f"请求失败：{e}"

    history.append({"role": "model", "parts": [reply]})

    action = None
    if "ACTION:" in reply:
        action = reply.split("ACTION:")[-1].strip().split("\n")[0]
        _execute_action(action)

    return ChatResponse(reply=reply, action=action, session_id=req.session_id)


def _execute_action(action_str: str):
    from api.graph import _decisions
    parts = action_str.split(":")
    if len(parts) < 2:
        return
    op, decision_id = parts[0], parts[1]
    for d in _decisions:
        if d.decision_id == decision_id:
            if op in ("KEEP", "SPLIT"):
                d.action = "keep"
                d.reason += f"（教师要求：{op}）"
            break


@router.get("/history/{session_id}")
def get_history(session_id: str):
    return _sessions.get(session_id, [])


@router.delete("/history/{session_id}")
def clear_history(session_id: str):
    _sessions.pop(session_id, None)
    return {"cleared": session_id}
