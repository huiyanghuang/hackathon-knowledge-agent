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

    # 关键词召回：从决策 reason 中找跟用户问题相关的，优先放进 context
    # （比通用"前10条"更有针对性，且 prompt 不会爆炸）
    msg = req.message
    # 截取用户消息里 2 个字以上的中文/字母片段作为候选关键词
    import re
    tokens = [t for t in re.findall(r'[一-鿿]{2,}|[A-Za-z]{3,}', msg) if t]

    relevant = []
    for d in decisions:
        if not d.reason:
            continue
        if any(t in d.reason for t in tokens):
            relevant.append(d)
        if len(relevant) >= 5:
            break

    # 没召回到就退化为前3条 merge 决策（最有信息量），避免空 context
    if not relevant:
        relevant = [d for d in decisions if d.action == 'merge'][:3]

    if stats:
        stats_lines = "\n".join(f"  - {k}: {v}" for k, v in stats.items() if isinstance(v, (int, float)))
    else:
        stats_lines = "  （尚未运行整合，无统计信息）"

    context = f"\n\n[当前整合状态]\n{stats_lines}\n\n[相关决策]\n"
    for d in relevant:
        context += f"- {d.decision_id} ({d.action}, 置信度 {d.confidence:.2f}): {d.reason}\n"

    user_content = req.message + (context if not history else "")
    history.append({"role": "user", "parts": [user_content]})

    try:
        reply = multi_turn(history, system=SYSTEM)
    except Exception as e:
        emsg = str(e)
        if "timeout" in emsg.lower() or "deadline" in emsg.lower() or "524" in emsg:
            reply = "⏱ AI 服务响应超时（Gemini 当前繁忙）。请稍后再试，或换个角度提问。"
        elif "429" in emsg:
            reply = "🚦 触发 API 限速（48 次/分钟）。请稍等几秒再试。"
        else:
            reply = f"❌ 请求失败：{emsg[:200]}"
        # 失败时不把这条 user 消息留在历史里，避免下次又触发
        history.pop()
        return ChatResponse(reply=reply, action=None, session_id=req.session_id)

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
