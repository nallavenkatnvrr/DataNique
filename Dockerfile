# Datanique in a container.
#
#   docker run -d --name datanique -p 127.0.0.1:8000:8000 -v datanique-data:/data \
#     ghcr.io/nallavenkatnvrr/datanique:latest
#
# Then open http://localhost:8000 and create the master password.
# Publish the port on 127.0.0.1 only: Datanique is a single-user tool.

# ---- frontend ---------------------------------------------------------------
FROM node:22-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- backend ----------------------------------------------------------------
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DV_DATA_DIR=/data

# unixODBC: needed by pyodbc / arrow-odbc (SQL Server). The Microsoft ODBC
# driver itself is not included; see the README for adding it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends unixodbc \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt

COPY backend/ ./
COPY --from=frontend /src/frontend/dist /app/frontend/dist

RUN useradd --create-home --uid 10001 datanique \
 && mkdir -p /data \
 && chown datanique /data
USER datanique
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"

# Inside the container uvicorn listens on all interfaces so the published
# port works; the app itself still only accepts localhost Host headers
# (add more with DV_ALLOWED_HOSTS).
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

LABEL org.opencontainers.image.title="Datanique" \
      org.opencontainers.image.description="Data validation across Snowflake, Oracle, SQL Server, PostgreSQL, MySQL and files, with a SQL IDE" \
      org.opencontainers.image.source="https://github.com/nallavenkatnvrr/DataNique" \
      org.opencontainers.image.licenses="MIT"
