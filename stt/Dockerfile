ARG BASE_IMAGE=python:3.11-slim
FROM ${BASE_IMAGE}

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=on

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

COPY app.py .

EXPOSE 5001

ENV WHISPER_MODEL=tiny
ENV WHISPER_DEVICE=cpu

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5001"]
