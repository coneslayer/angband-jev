# Kev decision-model server (https://github.com/jaredpalmer/kev), serving TypeSafe's POST /v1/systemone.
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.9.18 /uv /uvx /bin/

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG KEV_REF=85ccf56a0afb952323c621055b02876e8498d60c
WORKDIR /opt/kev
RUN git init -q . \
 && git remote add origin https://github.com/jaredpalmer/kev.git \
 && git fetch -q --depth 1 origin "$KEV_REF" \
 && git checkout -q FETCH_HEAD

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_HTTP_TIMEOUT=60 \
    UV_HTTP_RETRIES=5 \
    UV_CONCURRENT_DOWNLOADS=4
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --extra serve --no-dev

# Model weights download from the Hugging Face Hub on first start; keep them on a volume.
ENV HF_HOME=/models/hf \
    KEV_RUN=jaredpalmer/kev-0.8b \
    KEV_DEVICE=cuda \
    KEV_PORT=8009

EXPOSE 8009
CMD ["sh", "-c", "exec uv run --no-sync python -m kev.serve --run \"$KEV_RUN\" --host 0.0.0.0 --port \"$KEV_PORT\" --device \"$KEV_DEVICE\""]
