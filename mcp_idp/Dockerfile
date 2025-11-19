ARG BASE_IMAGE=python:3.11-slim

FROM ${BASE_IMAGE} AS builder

ARG USE_GPU=false
ENV DEBIAN_FRONTEND=noninteractive \
    VENV_PATH=/opt/venv

RUN rm -f /etc/apt/sources.list.d/cuda* \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        build-essential \
        cmake \
        pkg-config \
        libopenblas-dev \
        libomp-dev \
        libgl1-mesa-dev \
        libglib2.0-dev \
        libxrender-dev \
        python3-dev \
        python3 \
        python3-pip \
        python3-venv \
        git \
        ffmpeg \
    && ln -sf python3 /usr/bin/python \
    && ln -sf pip3 /usr/bin/pip \
    && python -m venv ${VENV_PATH} \
    && rm -rf /var/lib/apt/lists*

ENV PATH="${VENV_PATH}/bin:${PATH}"

WORKDIR /app

COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install --upgrade pip \
    && if [ "$USE_GPU" = "true" ]; then \
        pip install --no-cache-dir onnxruntime-gpu==1.18.1; \
    else \
        pip install --no-cache-dir onnxruntime==1.18.1; \
    fi \
    && pip install --no-cache-dir -r requirements.txt

COPY . ./

FROM ${BASE_IMAGE} AS runtime

ARG USE_GPU=false
ENV USE_GPU=${USE_GPU} \
    DEBIAN_FRONTEND=noninteractive \
    VENV_PATH=/opt/venv \
    PATH="${VENV_PATH}/bin:${PATH}" \
    IDP_DEVICE=cpu \
    IDP_REFERENCE_DIR=/app/reference_faces \
    IDP_MODEL_STORAGE=/app/models \
    PORT=8004

RUN rm -f /etc/apt/sources.list.d/cuda* \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        libopenblas0 \
        libomp5 \
        libgl1 \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
        ffmpeg \
    && ln -sf python3 /usr/bin/python \
    && ln -sf pip3 /usr/bin/pip \
    && rm -rf /var/lib/apt/lists*

WORKDIR /app

COPY --from=builder ${VENV_PATH} ${VENV_PATH}
COPY --from=builder /app /app

RUN useradd --create-home --shell /bin/bash appuser
USER appuser

VOLUME ["/app/reference_faces", "/app/models"]
EXPOSE 8004

CMD ["python", "main.py"]
