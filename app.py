from __future__ import annotations

from pathlib import Path
import shutil
import uuid
from threading import Lock

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from pipeline import (
    make_preview_png,
    run_segmentation_pipeline,
    make_shapefile_zip,
)

APP_ROOT = Path(__file__).parent.resolve()
RUNS = APP_ROOT / "runs"
STATIC = APP_ROOT / "static"

RUNS.mkdir(parents=True, exist_ok=True)
STATIC.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Cloud Segmentation Web")
app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")

# -------------------------
# In-memory progress store
# -------------------------
_PROGRESS: dict[str, dict] = {}
_PROGRESS_LOCK = Lock()


def _set_progress(run_id: str, percent: int, stage: str, message: str, status: str = "running", extra: dict | None = None):
    payload = {
        "run_id": run_id,
        "percent": int(max(0, min(100, percent))),
        "stage": str(stage),
        "message": str(message),
        "status": str(status),  # pending | running | done | error
    }
    if extra:
        payload.update(extra)

    with _PROGRESS_LOCK:
        prev = _PROGRESS.get(run_id, {})
        prev.update(payload)
        _PROGRESS[run_id] = prev


def _get_progress(run_id: str) -> dict:
    with _PROGRESS_LOCK:
        return dict(_PROGRESS.get(run_id, {
            "run_id": run_id,
            "percent": 0,
            "stage": "unknown",
            "message": "ยังไม่มี progress สำหรับ run_id นี้",
            "status": "pending",
        }))


@app.get("/")
async def home():
    return FileResponse(str(STATIC / "index.html"))


@app.get("/api/health")
async def api_health():
    return JSONResponse({"status": "ok"})


@app.get("/api/progress/{run_id}")
async def api_progress(run_id: str):
    return JSONResponse(_get_progress(run_id))


def _save_upload(run_dir: Path, f: UploadFile, name: str) -> Path:
    out = run_dir / f"{name}.tif"
    with out.open("wb") as w:
        shutil.copyfileobj(f.file, w)
    return out


def _resolve_model_path(model_path: str) -> Path:
    p = Path(model_path).expanduser()
    if not p.is_absolute():
        p = (APP_ROOT / p).resolve()
    else:
        p = p.resolve()
    return p


def _clamp_int(value: int, min_value: int, max_value: int) -> int:
    return max(min_value, min(int(value), max_value))


@app.post("/api/preview")
async def api_preview(
    blue: UploadFile = File(...),
    green: UploadFile = File(...),
    red: UploadFile = File(...),
    nir: UploadFile = File(...),
):
    run_id = uuid.uuid4().hex[:8]
    run_dir = RUNS / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    _set_progress(run_id, 0, "preview_init", "เริ่มต้น preview", status="pending")

    try:
        b = _save_upload(run_dir, blue, "blue")
        g = _save_upload(run_dir, green, "green")
        r = _save_upload(run_dir, red, "red")
        _save_upload(run_dir, nir, "nir")

        _set_progress(run_id, 30, "preview_processing", "กำลังสร้าง preview", status="running")

        preview_png = run_dir / "preview_rgb.png"
        make_preview_png(b, g, r, preview_png)

        _set_progress(run_id, 100, "preview_done", "Preview เสร็จ", status="done")

        return JSONResponse(
            {
                "run_id": run_id,
                "preview_url": f"/api/file/{run_id}/preview_rgb.png",
            }
        )
    except Exception as e:
        _set_progress(run_id, 100, "preview_error", f"preview failed: {str(e)}", status="error")
        return JSONResponse({"error": f"preview failed: {str(e)}"}, status_code=500)


@app.post("/api/segment")
async def api_segment(
    run_id: str = Form(...),
    model_path: str = Form(...),
    tile: int = Form(480),
    overlap: int = Form(96),
    threshold: float = Form(0.5),
    shadow_threshold: float = Form(0.5),
    preprocess: str = Form("auto"),   # auto | sr_global | div10000 | perband_minmax
    batch_size: int = Form(4),
):
    run_dir = RUNS / run_id
    if not run_dir.exists():
        return JSONResponse(
            {"error": "run_id not found (กด Preview ก่อน)"},
            status_code=404,
        )

    b = run_dir / "blue.tif"
    g = run_dir / "green.tif"
    r = run_dir / "red.tif"
    n = run_dir / "nir.tif"

    if not (b.exists() and g.exists() and r.exists() and n.exists()):
        return JSONResponse(
            {"error": "missing band files in run folder"},
            status_code=400,
        )

    model_file = _resolve_model_path(model_path)
    if not model_file.exists():
        return JSONResponse(
            {"error": f"model file not found: {model_file}"},
            status_code=400,
        )

    tile = _clamp_int(tile, 128, 2048)
    overlap = _clamp_int(overlap, 0, tile - 1)
    batch_size = _clamp_int(batch_size, 1, 32)

    preprocess = (preprocess or "auto").strip().lower()
    if preprocess not in {"auto", "sr_global", "div10000", "perband_minmax"}:
        preprocess = "auto"

    out_mask_any = run_dir / "mask_full.tif"
    out_overlay = run_dir / "overlay.png"

    _set_progress(
        run_id,
        1,
        "segment_init",
        "เริ่มต้น segment",
        status="running",
        extra={
            "tile": tile,
            "overlap": overlap,
            "batch_size": batch_size,
            "preprocess": preprocess,
        },
    )

    def progress_cb(data: dict):
        _set_progress(
            run_id,
            int(data.get("percent", 0)),
            str(data.get("stage", "segmenting")),
            str(data.get("message", "กำลังประมวลผล")),
            status="running",
        )

    try:
        info = run_segmentation_pipeline(
            blue=b,
            green=g,
            red=r,
            nir=n,
            model_path=model_file,
            out_mask_tif=out_mask_any,
            out_overlay_png=out_overlay,
            tile=tile,
            overlap=overlap,
            threshold=float(threshold),
            shadow_threshold=float(shadow_threshold),
            preprocess=preprocess,
            batch_size=batch_size,
            progress_callback=progress_cb,
        )
    except Exception as e:
        _set_progress(
            run_id,
            100,
            "segment_error",
            f"segment failed: {str(e)}",
            status="error",
        )
        return JSONResponse({"error": f"segment failed: {str(e)}"}, status_code=500)

    mask_cloud_url = f"/api/file/{run_id}/{info['mask_cloud_name']}"
    mask_shadow_url = f"/api/file/{run_id}/{info['mask_shadow_name']}"
    mask_class_url = f"/api/file/{run_id}/{info['mask_class_name']}"
    overlay_url = f"/api/file/{run_id}/{info['overlay_name']}"

    _set_progress(
        run_id,
        100,
        "done",
        "Segment เสร็จสิ้น",
        status="done",
        extra={
            "chosen_preprocess": info["chosen_preprocess"],
            "chosen_cloud_threshold": info["chosen_cloud_threshold"],
            "chosen_shadow_threshold": info["chosen_shadow_threshold"],
            "batch_size": info.get("batch_size", batch_size),
            "stride": info.get("stride"),
            "tiles_total": info.get("tiles_total"),
            "tiles_used": info.get("tiles_used"),
            "tiles_skipped": info.get("tiles_skipped"),
            "mask_cloud_url": mask_cloud_url,
            "mask_shadow_url": mask_shadow_url,
            "mask_any_url": mask_class_url,
            "overlay_url": overlay_url,
        },
    )

    return JSONResponse(
        {
            "chosen_preprocess": info["chosen_preprocess"],
            "chosen_cloud_threshold": info["chosen_cloud_threshold"],
            "chosen_shadow_threshold": info["chosen_shadow_threshold"],
            "mask_cloud_url": mask_cloud_url,
            "mask_shadow_url": mask_shadow_url,
            "mask_any_url": mask_class_url,
            "overlay_url": overlay_url,
            "batch_size": info.get("batch_size", batch_size),
            "stride": info.get("stride"),
            "tiles_total": info.get("tiles_total"),
            "tiles_used": info.get("tiles_used"),
            "tiles_skipped": info.get("tiles_skipped"),
        }
    )


@app.post("/api/shapefile")
async def api_shapefile(
    run_id: str = Form(...),
    which: str = Form("cloud"),  # cloud | shadow | any
    min_area_m2: float | None = Form(None),
):
    run_dir = RUNS / run_id
    if not run_dir.exists():
        return JSONResponse({"error": "run_id not found"}, status_code=404)

    which = (which or "cloud").strip().lower()

    if which == "shadow":
        mask = run_dir / "mask_full_shadow.tif"
        out_zip = run_dir / "shadow_shp.zip"
    elif which == "any":
        mask = run_dir / "mask_full.tif"
        out_zip = run_dir / "cloud_shadow_shp.zip"
    else:
        mask = run_dir / "mask_full_cloud.tif"
        out_zip = run_dir / "cloud_shp.zip"

    if not mask.exists():
        return JSONResponse(
            {"error": f"{mask.name} not found (กด Segment ก่อน)"},
            status_code=400,
        )

    try:
        make_shapefile_zip(mask, out_zip, min_area_m2=min_area_m2)
    except Exception as e:
        return JSONResponse({"error": f"shapefile failed: {str(e)}"}, status_code=500)

    return JSONResponse(
        {
            "zip_url": f"/api/file/{run_id}/{out_zip.name}",
        }
    )


@app.get("/api/file/{run_id}/{filename}")
async def api_file(run_id: str, filename: str):
    p = RUNS / run_id / filename
    if not p.exists():
        return JSONResponse({"error": "file not found"}, status_code=404)
    return FileResponse(str(p))