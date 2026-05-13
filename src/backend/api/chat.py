"""Stateless single-turn teacher dialogue.

服务器仍把每轮 user/assistant 消息存进 _sessions（供前端 GET /history 拉
作日志展示），但每次 LLM 调用只发 当前问题 + 召回到的决策上下文，
不再带历史。这样：
  * 响应稳定（prompt 长度不随会话增长）
  * 不会因为历史累积慢慢撞 Cloudflare 100s 切断
  * 用户仍能看到完整对话历史
"""
from fastapi import APIRouter
from pydantic import BaseModel

from core.llm import chat as llm_chat

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

    # 关键词召回：从决策 reason 中找跟用户问题相关的
    import re
    tokens = [t for t in re.findall(r'[一-鿿]{2,}|[A-Za-z]{3,}', req.message) if t]

    relevant = []
    for d in decisions:
        if not d.reason:
            continue
        if any(t in d.reason for t in tokens):
            relevant.append(d)
        if len(relevant) >= 5:
            break
    if not relevant:
        relevant = [d for d in decisions if d.action == 'merge'][:3]

    if stats:
        stats_lines = "\n".join(f"  - {k}: {v}" for k, v in stats.items() if isinstance(v, (int, float)))
    else:
        stats_lines = "  （尚未运行整合，无统计信息）"

    context = f"[当前整合状态]\n{stats_lines}\n\n[相关决策]\n"
    for d in relevant:
        context += f"- {d.decision_id} ({d.action}, 置信度 {d.confidence:.2f}): {d.reason}\n"

    # 单轮调用：每次只发当前问题 + 召回上下文，不带历史
    prompt = f"{context}\n\n[用户问题]\n{req.message}"

    try:
        reply = llm_chat(prompt, system=SYSTEM)
    except Exception as e:
        emsg = str(e)
        elow = emsg.lower()
        if "timeout" in elow or "deadline" in elow or "524" in emsg or "499" in emsg or "cancel" in elow:
            reply = "⏱ AI 服务响应超时（Gemini 当前繁忙）。请稍后再试，或换个角度提问。"
        elif "429" in emsg:
            reply = "🚦 触发 API 限速。请稍等几秒再试。"
        else:
            reply = f"❌ 请求失败：{emsg[:200]}"
        # 失败时仍记入历史（让用户看到尝试过什么 + 错误），但不执行 ACTION
        history.append({"role": "user", "parts": [req.message]})
        history.append({"role": "model", "parts": [reply]})
        return ChatResponse(reply=reply, action=None, session_id=req.session_id)

    # 成功：双向记日志（user 只存原始消息，不含 context）
    history.append({"role": "user", "parts": [req.message]})
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
