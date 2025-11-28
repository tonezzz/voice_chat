ARG CUDA_BASE_IMAGE=nvidia/cuda:12.2.0-base-ubuntu20.04

FROM ${CUDA_BASE_IMAGE} AS builder

ARG USE_GPU=true
ENV DEBIAN_FRONTEND=noninteractive \
    VENV_PATH=/opt/venv \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_CACHE_DIR=/root/.cache/pip \
    PIX2PIX3D_ROOT=/opt/pix2pix3d

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        git \
        curl \
        ca-certificates \
        libgl1 \
        libglib2.0-0 \
        libxext6 \
        libxrender1 \
        unzip \
        wget \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv ${VENV_PATH} \
    && ln -sf ${VENV_PATH}/bin/pip /usr/local/bin/pip \
    && ln -sf ${VENV_PATH}/bin/python /usr/local/bin/python

ENV PATH="${VENV_PATH}/bin:${PATH}"

WORKDIR /app

COPY requirements.txt /tmp/requirements.txt
RUN python -m pip install --upgrade pip \
    && if [ "${USE_GPU}" = "true" ]; then \
        pip install --extra-index-url https://download.pytorch.org/whl/cu113 \
            torch==1.11.0+cu113 torchvision==0.12.0+cu113; \
    else \
        pip install torch==1.11.0 torchvision==0.12.0; \
    fi \
    && pip install --no-cache-dir -r /tmp/requirements.txt

RUN git clone --depth 1 https://github.com/dunbar12138/pix2pix3D.git ${PIX2PIX3D_ROOT}

COPY . /app

FROM ${CUDA_BASE_IMAGE} AS runtime

ARG USE_GPU=true
ENV DEBIAN_FRONTEND=noninteractive \
    VENV_PATH=/opt/venv \
    PATH="${VENV_PATH}/bin:${PATH}" \
    PIX2PIX3D_ROOT=/opt/pix2pix3d \
    PIX2PIX3D_DATA_ROOT=/workspace/data \
    PIX2PIX3D_CHECKPOINT_ROOT=/workspace/checkpoints \
    PIX2PIX3D_DEFAULT_CFG=seg2cat \
    PIX2PIX3D_DEFAULT_NETWORK=/workspace/checkpoints/pix2pix3d_seg2cat.pkl \
    PORT=8023 \
    MCP_HOST=0.0.0.0 \
    USE_GPU=${USE_GPU}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
        python3-pip \
        curl \
        ca-certificates \
        libgl1 \
        libglib2.0-0 \
        libxext6 \
        libxrender1 \
        unzip \
        wget \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder ${VENV_PATH} ${VENV_PATH}
COPY --from=builder /app /app
COPY --from=builder ${PIX2PIX3D_ROOT} ${PIX2PIX3D_ROOT}

RUN useradd --create-home --shell /bin/bash appuser \
    && mkdir -p /workspace/checkpoints /workspace/data \
    && chown -R appuser:appuser /workspace /app

USER appuser

WORKDIR /app

VOLUME ["/workspace/checkpoints", "/workspace/data"]
EXPOSE 8023

CMD ["/opt/venv/bin/python", "main.py"]
