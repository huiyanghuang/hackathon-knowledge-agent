# ---------- Stage 1: build frontend ----------
FROM node:20-alpine AS frontend-builder

WORKDIR /app/src/frontend
COPY src/frontend/package*.json ./
RUN npm ci --no-audit --no-fund

COPY src/frontend/ ./
RUN npm run build


# ---------- Stage 2: backend + serve SPA ----------
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# System deps for pypdf / wheels
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

# Backend source
COPY src/backend/ ./src/backend/
# Built frontend (main.py auto-mounts when this dir exists)
COPY --from=frontend-builder /app/src/frontend/dist ./src/frontend/dist
# Optional helper scripts
COPY batch_process.py generate_report.py ./

# data/ is mounted as a volume in compose; create the dir for first-run
RUN mkdir -p /app/data/textbooks /app/data/processed /app/data/chroma

EXPOSE 8000

WORKDIR /app/src/backend
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
