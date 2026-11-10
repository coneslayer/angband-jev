# Laya decision-model server and trainer (https://github.com/NandhaKishorM/laya).
# Built on the kev image to reuse its torch 2.8 + CUDA venv (a fresh torch download is ~3 GB).
FROM angband-jev-kev

ARG LAYA_VERSION=0.4.6
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/kev/.venv "laya[serve]==${LAYA_VERSION}"

ENV PATH=/opt/kev/.venv/bin:$PATH \
    HF_HOME=/models/hf \
    LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000 \
    LAYA_DEVICE=cuda \
    LAYA_DEFAULT_MODEL=english \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

EXPOSE 8000
CMD ["laya-serve"]
