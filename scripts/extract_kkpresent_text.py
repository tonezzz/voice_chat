import argparse
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

parser = argparse.ArgumentParser(description="Dump text content from kkpresent PPTX")
parser.add_argument(
    "ppt",
    nargs="?",
    default=r"C:\_dev\_models\a_kakk\sites\kkpresent\kkpresent.pptx",
    help="Path to kkpresent PPTX",
)
args = parser.parse_args()

ppt_path = Path(args.ppt)

if not ppt_path.exists():
    raise FileNotFoundError(ppt_path)

with zipfile.ZipFile(ppt_path) as zf:
    slides = sorted(
        name for name in zf.namelist() if name.startswith("ppt/slides/slide")
    )

    for name in slides:
        xml = ET.fromstring(zf.read(name))
        texts = []
        for node in xml.iter():
            if node.tag.endswith("}t") and node.text:
                texts.append(node.text.strip())
        print(f"--- {name} ---")
        print(" ".join(texts))
        print()
