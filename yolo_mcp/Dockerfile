ARG BASE_IMAGE=python:3.11-slim
FROM ${BASE_IMAGE}

# System deps for Ultralytics/Pillow (image ops)
RUN apt-get update && apt-get install -y \
    git \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./

ENV YOLO_MODEL=yolov8n.pt

EXPOSE 8000

CMD ["python", "main.py"]
