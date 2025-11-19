ARG BASE_IMAGE=python:3.11-slim

FROM ${BASE_IMAGE} AS builder

ARG USE_GPU=false
ENV DEBIAN_FRONTEND=noninteractive \
    VENV_PATH=/opt/venv

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        git \
        python3 \
        python3-pip \
        python3-venv \
        libgl1 \
        libglib2.0-0 \
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
        pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cu123 \
            torch==2.4.1 torchvision==0.19.1; \
    else \
        pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu \
            torch==2.4.1 torchvision==0.19.1; \
    fi \
    && pip install --no-cache-dir -r requirements.txt

COPY . ./

FROM ${BASE_IMAGE} AS runtime

ARG USE_GPU=false
ENV DEBIAN_FRONTEND=noninteractive \
    USE_GPU=${USE_GPU} \
    VENV_PATH=/opt/venv \
    PATH="${VENV_PATH}/bin:${PATH}" \
    YOLO_MODEL=yolov8n.pt

# Runtime libs for OpenCV/Ultralytics
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists*

WORKDIR /app

COPY --from=builder ${VENV_PATH} ${VENV_PATH}
COPY --from=builder /app /app

RUN useradd --create-home --shell /bin/bash appuser
USER appuser

EXPOSE 8000

CMD ["python", "main.py"]
