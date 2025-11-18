ARG BASE_IMAGE=python:3.11-slim
FROM ${BASE_IMAGE}

ARG USE_GPU=false
ENV USE_GPU=${USE_GPU}

RUN rm -f /etc/apt/sources.list.d/cuda* \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    git \
    libgl1 \
    libglib2.0-0 \
    && ln -sf python3 /usr/bin/python \
    && ln -sf pip3 /usr/bin/pip \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --upgrade pip

ENV PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements.txt ./
RUN if [ "$USE_GPU" = "true" ]; then \
        pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cu123 \
            torch torchvision torchaudio; \
    else \
        pip install --no-cache-dir torch==2.4.0 torchvision==0.19.0 torchaudio==2.4.0; \
    fi && \
    pip install --no-cache-dir -r requirements.txt

COPY . ./

ENV IMAGE_MODEL_ID=runwayml/stable-diffusion-v1-5 \
    TORCH_DEVICE=cpu \
    IMAGE_MODEL_CACHE=/app/models

RUN useradd --create-home --shell /bin/bash appuser
USER appuser

VOLUME ["/app/models"]
EXPOSE 8001

CMD ["python", "main.py"]
