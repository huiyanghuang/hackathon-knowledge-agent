import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api.chat import router as chat_router
from api.graph import router as graph_router
from api.rag import router as rag_router
from api.stats import router as stats_router
from api.textbooks import router as textbooks_router

app = FastAPI(title="学科知识整合智能体", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(textbooks_router)
app.include_router(graph_router)
app.include_router(rag_router)
app.include_router(chat_router)
app.include_router(stats_router)


@app.get("/health")
def health():
    return {"status": "ok"}


# 挂载前端静态资源（不拦截 /api/* 和 /health 路由）
_frontend_dist = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
)

if os.path.exists(_frontend_dist):
    app.mount("/assets", StaticFiles(directory=os.path.join(_frontend_dist, "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str):
        # API 路由已在上面注册，这里只处理前端页面
        return FileResponse(os.path.join(_frontend_dist, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
