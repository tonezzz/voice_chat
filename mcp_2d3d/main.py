from __future__ import annotations

import base64
import io
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
from mcp.server.fastmcp import FastMCP
from PIL import Image
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.status import HTTP_400_BAD_REQUEST
import uvicorn

PIX2PIX3D_ROOT = Path(os.getenv("PIX2PIX3D_ROOT", "/opt/pix2pix3d")).resolve()
if str(PIX2PIX3D_ROOT) not in sys.path:
    sys.path.insert(0, str(PIX2PIX3D_ROOT))

try:  # noqa: SIM105
    from applications.generate_samples import init_conditional_dataset_kwargs
    import dnnlib
    import legacy
    from training.utils import color_mask
except ImportError as exc:  # pragma: no cover - import guard
    raise RuntimeError(
        "Unable to import pix2pix3D modules. Ensure PIX2PIX3D_ROOT is cloned inside the container."
    ) from exc

CFG_SPECS: Dict[str, Dict[str, Any]] = {
    "seg2cat": {
        "data": "afhq_v2_train_cat_512.zip",
        "mask": "afhqcat_seg_6c.zip",
        "data_type": "seg",
        "neural_res": 128,
        "description": "AFHQ cats segmentation-to-image",
    },
    "seg2face": {
        "data": "celebamask_test.zip",
        "mask": "celebamask_test_label.zip",
        "data_type": "seg",
        "neural_res": 128,
        "description": "CelebAMask-HQ segmentation-to-face synthesis",
    },
    "edge2car": {
        "data": "cars_128.zip",
        "mask": "shapenet_car_contour.zip",
        "data_type": "edge",
        "neural_res": 64,
        "description": "ShapeNet car edge-to-nerf render",
    },
}

DEFAULT_CFG = os.getenv("PIX2PIX3D_DEFAULT_CFG", "seg2cat")
DEFAULT_NETWORK = os.getenv("PIX2PIX3D_DEFAULT_NETWORK")
DATA_ROOT = Path(os.getenv("PIX2PIX3D_DATA_ROOT", "/workspace/data")).resolve()
CHECKPOINT_ROOT = Path(os.getenv("PIX2PIX3D_CHECKPOINT_ROOT", "/workspace/checkpoints")).resolve()
USE_GPU = os.getenv("USE_GPU", "true").lower() in {"1", "true", "yes", "on"}

torch.backends.cudnn.benchmark = True  # type: ignore[attr-defined]


class Pix2Pix3DService:
    def __init__(self) -> None:
        self.device = torch.device("cuda" if USE_GPU and torch.cuda.is_available() else "cpu")
        self._network_cache: Dict[str, torch.nn.Module] = {}
        self._dataset_cache: Dict[str, Tuple[Any, str]] = {}

    def _image_to_base64(self, array: np.ndarray) -> str:
        image = Image.fromarray(array)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("utf-8")

    def _resolve_cfg(self, cfg: Optional[str]) -> str:
        resolved = (cfg or DEFAULT_CFG).strip().lower()
        if resolved not in CFG_SPECS:
            raise ValueError(f"Unsupported cfg '{cfg}'. Choose from {list(CFG_SPECS)}")
        return resolved

    def _resolve_network(self, network_path: Optional[str]) -> str:
        if network_path:
            return network_path
        if DEFAULT_NETWORK:
            return DEFAULT_NETWORK
        candidate = CHECKPOINT_ROOT / "pix2pix3d_seg2cat.pkl"
        if candidate.is_file():
            return str(candidate)
        raise ValueError("No network checkpoint specified. Provide network_path or set PIX2PIX3D_DEFAULT_NETWORK.")

    def _load_network(self, network_path: str) -> torch.nn.Module:
        if network_path in self._network_cache:
            return self._network_cache[network_path]
        start = time.perf_counter()
        with dnnlib.util.open_url(network_path) as f:
            generator = legacy.load_network_pkl(f)["G_ema"].eval().to(self.device)
        duration = int((time.perf_counter() - start) * 1000)
        self._network_cache[network_path] = generator
        print(f"[pix2pix3d] Loaded network {network_path} in {duration}ms on {self.device}")
        return generator

    def _load_dataset(self, cfg: str, data_root: Optional[str]) -> Tuple[Any, str]:
        spec = CFG_SPECS[cfg]
        root = Path(data_root).resolve() if data_root else DATA_ROOT
        data_path = root / spec["data"]
        mask_path = root / spec["mask"]
        if not data_path.exists():
            raise FileNotFoundError(f"Dataset archive missing: {data_path}")
        if not mask_path.exists():
            raise FileNotFoundError(f"Mask archive missing: {mask_path}")
        cache_key = f"{cfg}|{data_path}|{mask_path}"
        if cache_key in self._dataset_cache:
            return self._dataset_cache[cache_key]
        dataset_kwargs, dataset_name = init_conditional_dataset_kwargs(str(data_path), str(mask_path), spec["data_type"])
        dataset = dnnlib.util.construct_class_by_name(**dataset_kwargs)
        self._dataset_cache[cache_key] = (dataset, dataset_name)
        return dataset, dataset_name

    def _prepare_conditioning(self, cfg: str, batch: Dict[str, Any]) -> Tuple[torch.Tensor, torch.Tensor]:
        pose = torch.tensor(batch["pose"]).unsqueeze(0).to(self.device)
        if CFG_SPECS[cfg]["data_type"] == "seg":
            label = torch.tensor(batch["mask"]).unsqueeze(0).to(self.device)
        else:
            label = -(torch.tensor(batch["mask"]).to(torch.float32) / 127.5 - 1).unsqueeze(0).to(self.device)
        return pose, label

    def _preview_from_batch(self, cfg: str, batch: Dict[str, Any]) -> np.ndarray:
        if CFG_SPECS[cfg]["data_type"] == "seg":
            return color_mask(batch["mask"][0]).astype(np.uint8)
        mask = (255 - batch["mask"][0]).astype(np.uint8)
        return mask

    def generate_sample(
        self,
        *,
        cfg: Optional[str],
        input_id: int,
        random_seed: Optional[int],
        network_path: Optional[str],
        data_root: Optional[str],
    ) -> Dict[str, Any]:
        resolved_cfg = self._resolve_cfg(cfg)
        dataset, dataset_name = self._load_dataset(resolved_cfg, data_root)
        if input_id < 0 or input_id >= len(dataset):
            raise ValueError(f"input_id {input_id} out of range (0 - {len(dataset) - 1})")
        generator = self._load_network(self._resolve_network(network_path))

        batch = dataset[input_id]
        pose, label = self._prepare_conditioning(resolved_cfg, batch)
        neural_res = CFG_SPECS[resolved_cfg]["neural_res"]

        seed = random_seed if random_seed is not None else int(np.random.randint(0, 2**31 - 1))
        z = torch.from_numpy(np.random.RandomState(int(seed)).randn(1, generator.z_dim).astype("float32")).to(self.device)

        started = time.perf_counter()
        with torch.no_grad():
            ws = generator.mapping(z, pose, {"mask": label, "pose": pose})
            out = generator.synthesis(ws, pose, noise_mode="const", neural_rendering_resolution=neural_res)
        duration_ms = int((time.perf_counter() - started) * 1000)

        image_color = ((out["image"][0].permute(1, 2, 0).cpu().numpy().clip(-1, 1) + 1) * 127.5).astype(np.uint8)
        if CFG_SPECS[resolved_cfg]["data_type"] == "seg":
            image_label = color_mask(torch.argmax(out["semantic"][0], dim=0).cpu().numpy()).astype(np.uint8)
        else:
            image_label = ((out["semantic"][0].cpu().numpy() + 1) * 127.5).clip(0, 255).astype(np.uint8)[0]

        input_preview = self._preview_from_batch(resolved_cfg, batch)

        result = {
            "cfg": resolved_cfg,
            "input_id": input_id,
            "random_seed": seed,
            "dataset_name": dataset_name,
            "device": str(self.device),
            "neural_rendering_resolution": neural_res,
            "duration_ms": duration_ms,
            "image_color_base64": self._image_to_base64(image_color),
            "image_label_base64": self._image_to_base64(image_label),
            "input_label_base64": self._image_to_base64(input_preview),
        }
        return result

    def list_configs(self) -> List[Dict[str, Any]]:
        entries: List[Dict[str, Any]] = []
        for name, spec in CFG_SPECS.items():
            data_path = DATA_ROOT / spec["data"]
            mask_path = DATA_ROOT / spec["mask"]
            entries.append(
                {
                    "cfg": name,
                    "data_type": spec["data_type"],
                    "neural_rendering_resolution": spec["neural_res"],
                    "description": spec["description"],
                    "data_present": data_path.exists(),
                    "mask_present": mask_path.exists(),
                    "data_path": str(data_path),
                    "mask_path": str(mask_path),
                }
            )
        return entries


SERVICE = Pix2Pix3DService()
mcp = FastMCP("pix2pix3d")


def _build_error(detail: str) -> JSONResponse:
    return JSONResponse({"error": detail}, status_code=HTTP_400_BAD_REQUEST)


@mcp.tool()
def generate_pix2pix3d_sample(
    cfg: Optional[str] = None,
    input_id: int = 0,
    random_seed: Optional[int] = None,
    network_path: Optional[str] = None,
    data_root: Optional[str] = None,
) -> Dict[str, Any]:
    """Run pix2pix3D on a dataset sample and return RGB + semantic previews."""

    return SERVICE.generate_sample(
        cfg=cfg,
        input_id=input_id,
        random_seed=random_seed,
        network_path=network_path,
        data_root=data_root,
    )


@mcp.tool()
def list_pix2pix3d_configs() -> List[Dict[str, Any]]:
    """Report supported configs plus dataset availability flags."""

    return SERVICE.list_configs()


@mcp.custom_route("/generate", methods=["POST"])
async def generate_http(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return _build_error("invalid_json")

    if not isinstance(payload, dict):
        return _build_error("invalid_payload")

    try:
        data = SERVICE.generate_sample(
            cfg=payload.get("cfg"),
            input_id=int(payload.get("input_id", 0)),
            random_seed=payload.get("random_seed"),
            network_path=payload.get("network_path"),
            data_root=payload.get("data_root"),
        )
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=HTTP_400_BAD_REQUEST)

    return JSONResponse(data)


async def root(_: Request) -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "device": str(SERVICE.device),
            "default_cfg": DEFAULT_CFG,
            "default_network": DEFAULT_NETWORK,
        }
    )


async def health(_: Request) -> JSONResponse:
    return JSONResponse({"status": "ok", "device": str(SERVICE.device)})


def manifest(_: Request) -> JSONResponse:
    tool_schemas = [
        {
            "name": "generate_pix2pix3d_sample",
            "description": "Generate a pix2pix3D RGB render + semantic label map for a dataset sample.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "cfg": {
                        "type": "string",
                        "enum": list(CFG_SPECS.keys()),
                        "description": "Configuration preset (seg2cat, seg2face, edge2car).",
                    },
                    "input_id": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Dataset sample index to render.",
                    },
                    "random_seed": {
                        "type": "integer",
                        "description": "Optional random seed for latent z space.",
                    },
                    "network_path": {
                        "type": "string",
                        "description": "Path or URL to pix2pix3D .pkl checkpoint.",
                    },
                    "data_root": {
                        "type": "string",
                        "description": "Override dataset root directory.",
                    },
                },
                "required": ["input_id"],
            },
        },
        {
            "name": "list_pix2pix3d_configs",
            "description": "List supported configs with dataset + mask availability flags.",
            "input_schema": {"type": "object", "properties": {}},
        },
    ]
    return JSONResponse({"name": "pix2pix3d", "version": "0.1.0", "capabilities": {"tools": tool_schemas}})


def build_app() -> Starlette:
    return Starlette(
        routes=
        [
            Route("/", root, methods=["GET"]),
            Route("/health", health, methods=["GET"]),
            Route("/.well-known/mcp.json", manifest, methods=["GET"]),
            Route("/generate", generate_http, methods=["POST"]),
        ]
    )


def main() -> None:
    host = os.getenv("MCP_HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8023"))
    uvicorn.run(build_app(), host=host, port=port)


if __name__ == "__main__":
    main()
