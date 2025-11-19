ARG BASE_IMAGE=python:3.10-slim

FROM ${BASE_IMAGE} AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    VENV_PATH=/opt/venv

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        git \
        python3 \
        python3-pip \
        python3-venv \
    && ln -sf python3 /usr/bin/python \
    && ln -sf pip3 /usr/bin/pip \
    && python -m venv ${VENV_PATH} \
    && rm -rf /var/lib/apt/lists*

ENV PATH="${VENV_PATH}/bin:${PATH}"

WORKDIR /app

COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY . ./

FROM ${BASE_IMAGE} AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    VENV_PATH=/opt/venv \
    PATH="${VENV_PATH}/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists*

WORKDIR /app

COPY --from=builder ${VENV_PATH} ${VENV_PATH}
COPY --from=builder /app /app

RUN useradd --create-home --shell /bin/bash appuser
USER appuser

EXPOSE 8002

CMD ["python", "main.py"]
