import json
import itertools
import sys

import requests

PROMPT = "streaming preview of sunrise over mountains"
STEPS = 8
URL = "http://localhost:8001/generate-stream"

response = requests.post(
    URL,
    json={"prompt": PROMPT, "num_inference_steps": STEPS},
    stream=True,
    timeout=600,
)
response.raise_for_status()

lines = (line for line in response.iter_lines(decode_unicode=True) if line)
for idx, line in enumerate(itertools.islice(lines, 6)):
    payload = json.loads(line)
    print(f"Event {idx}: {payload.get('type')} keys={list(payload.keys())}")

print("...truncated...")
