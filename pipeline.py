from __future__ import annotations

import os
# ต้องตั้งค่าตัวแปรนี้ก่อน import tensorflow เสมอ เพื่อแก้บัค TFOpLambda (บังคับใช้ Keras 2)
os.environ["TF_USE_LEGACY_KERAS"] = "1"

from pathlib import Path
import zipfile
from functools import lru_cache

import numpy as np
import rasterio
from rasterio.windows import Window
from rasterio.features import shapes
import tensorflow as tf
from PIL import Image
import cv2
import geopandas as gpd
from shapely.geometry import shape

from geo_utils import (
    ensure_same_grid,
    write_geotiff_like,
    rgb_preview_from_bgr,
)

# -------------------------
# TF / CPU tuning
# -------------------------
try:
    tf.config.set_visible_devices([], "GPU")
except Exception:
    pass

try:
    tf.config.optimizer.set_jit(False)
except Exception:
    pass


# -------------------------
# Cached helpers
# -------------------------
@lru_cache(maxsize=4)
def _load_model_cached(model_path_str: str):
    return tf.keras.models.load_model(model_path_str, compile=False)


@lru_cache(maxsize=16)
def make_weight(tile: int, sigma: float = 0.45) -> np.ndarray:
    y = np.linspace(-1, 1, tile, dtype=np.float32)
    x = np.linspace(-1, 1, tile, dtype=np.float32)
    xv, yv = np.meshgrid(x, y)
    w = np.exp(-(xv * xv + yv * yv) / sigma).astype(np.float32)
    w /= (w.max() + 1e-6)
    return w


def _emit_progress(progress_callback, percent: int, stage: str, message: str):
    if progress_callback is None:
        return
    try:
        progress_callback(
            {
                "percent": int(max(0, min(100, percent))),
                "stage": str(stage),
                "message": str(message),
            }
        )
    except Exception:
        pass


# -------------------------
# Landsat C2 L2 SR: DN -> reflectance
# reflectance = DN*2.75e-05 - 0.2
# -------------------------
def sr_to_reflectance(x: np.ndarray) -> np.ndarray:
    x = x.astype(np.float32) * 2.75e-05 - 0.2
    return np.clip(x, 0.0, 1.0)


def compute_global_percentiles(
    b_path: Path, g_path: Path, r_path: Path, n_path: Path, sample_max: int = 1200
):
    paths = [b_path, g_path, r_path, n_path]
    smalls = []

    for p in paths:
        with rasterio.open(p) as ds:
            H, W = ds.height, ds.width
            scale = max(1, int(max(H, W) / sample_max))
            sh = max(1, H // scale)
            sw = max(1, W // scale)
            a = ds.read(1, out_shape=(sh, sw)).astype(np.float32)
            smalls.append(a)

    stacked = np.stack(smalls, axis=-1)
    p2 = np.zeros(4, dtype=np.float32)
    p98 = np.zeros(4, dtype=np.float32)

    for c in range(4):
        ch = stacked[..., c]
        p2[c] = np.percentile(ch, 2)
        p98[c] = np.percentile(ch, 98)

    return p2, p98


def norm_global_percentile(x: np.ndarray, p2: np.ndarray, p98: np.ndarray) -> np.ndarray:
    x = x.astype(np.float32)
    out = np.zeros_like(x, dtype=np.float32)
    for c in range(4):
        out[..., c] = (x[..., c] - p2[c]) / (p98[c] - p2[c] + 1e-6)
    return np.clip(out, 0.0, 1.0)


# -------------------------
# Preprocess candidates
# -------------------------
def preprocess_div10000(x: np.ndarray) -> np.ndarray:
    x = x.astype(np.float32) / 10000.0
    return np.clip(x, 0.0, 1.0)


def preprocess_perband_minmax(x: np.ndarray) -> np.ndarray:
    x = x.astype(np.float32)
    out = np.zeros_like(x, dtype=np.float32)

    for c in range(x.shape[-1]):
        ch = x[..., c]
        mn = float(np.percentile(ch, 1))
        mx = float(np.percentile(ch, 99))
        out[..., c] = (ch - mn) / (mx - mn + 1e-6) if mx > mn else 0.0

    return np.clip(out, 0.0, 1.0)


def apply_preprocess(mode: str, x: np.ndarray, p2: np.ndarray, p98: np.ndarray) -> np.ndarray:
    mode = (mode or "").lower().strip()

    if mode == "sr_global":
        x = sr_to_reflectance(x)
        x = norm_global_percentile(x, p2, p98)
        return x

    if mode == "div10000":
        return preprocess_div10000(x)

    if mode == "perband_minmax":
        return preprocess_perband_minmax(x)

    raise ValueError("mode must be sr_global | div10000 | perband_minmax")


# -------------------------
# Predict helpers
# -------------------------
def _predict_batch_probs(model, batch_x: np.ndarray):
    """
    batch_x: (N, tile, tile, 4)
    returns:
      cloud:  (N, tile, tile)
      shadow: (N, tile, tile)
    """
    x_tf = tf.convert_to_tensor(batch_x, dtype=tf.float32)
    y = model(x_tf, training=False).numpy()

    if y.ndim != 4:
        raise ValueError(f"Unexpected model output shape: {y.shape}")

    C = y.shape[-1]

    if C == 1:
        cloud = y[..., 0].astype(np.float32)
        shadow = np.zeros_like(cloud, dtype=np.float32)
        return cloud, shadow

    if C == 2:
        cloud = y[..., 0].astype(np.float32)
        shadow = y[..., 1].astype(np.float32)
        return cloud, shadow

    cloud = y[..., 1].astype(np.float32)
    shadow = y[..., 2].astype(np.float32)
    return cloud, shadow


# -------------------------
# Fast auto-pick preprocess
# -------------------------
def auto_pick_preprocess(bds, gds, rds, nds, H, W) -> str:
    """
    ทำให้เบาลง: ใช้สถิติภาพอย่างเดียว ไม่ยิง model หลายรอบ
    """
    try:
        scale = max(1, int(max(H, W) / 1200))
        sh = max(1, H // scale)
        sw = max(1, W // scale)

        b_small = bds.read(1, out_shape=(sh, sw)).astype(np.float32)
        g_small = gds.read(1, out_shape=(sh, sw)).astype(np.float32)
        r_small = rds.read(1, out_shape=(sh, sw)).astype(np.float32)
        n_small = nds.read(1, out_shape=(sh, sw)).astype(np.float32)

        stack = np.stack([b_small, g_small, r_small, n_small], axis=-1)

        p99 = float(np.percentile(stack, 99))
        p1 = float(np.percentile(stack, 1))

        if p99 >= 500.0:
            return "sr_global"

        if (p99 - p1) > 1.5:
            return "perband_minmax"

        return "div10000"
    except Exception:
        return "sr_global"


# -------------------------
# Auto threshold
# -------------------------
def auto_threshold_from_prob(prob: np.ndarray, target=(0.01, 0.35)) -> float:
    p = prob.astype(np.float32).ravel()
    p = p[np.isfinite(p)]
    if p.size < 1000:
        return 0.5

    lo, hi = target

    for q in [99.9, 99.5, 99.0, 98.7, 98.5, 98.0, 97.0, 96.0, 95.0, 93.0, 90.0]:
        t = float(np.percentile(p, q))
        cov = float((p >= t).mean())
        if lo <= cov <= hi:
            return float(np.clip(t, 0.05, 0.99))

    return float(np.clip(np.percentile(p, 98.5), 0.05, 0.99))


def _downsample_prob(prob: np.ndarray, max_size: int = 900) -> np.ndarray:
    H, W = prob.shape[:2]
    scale = max(1, int(max(H, W) / max_size))
    nh = max(1, H // scale)
    nw = max(1, W // scale)
    return cv2.resize(prob.astype(np.float32), (nw, nh), interpolation=cv2.INTER_AREA)


# -------------------------
# Preview RGB
# -------------------------
def make_preview_png(blue_tif: Path, green_tif: Path, red_tif: Path, out_png: Path):
    blue_tif = Path(blue_tif)
    green_tif = Path(green_tif)
    red_tif = Path(red_tif)
    out_png = Path(out_png)

    with rasterio.open(blue_tif) as b, rasterio.open(green_tif) as g, rasterio.open(red_tif) as r:
        ensure_same_grid([b, g, r])

        scale = max(1, int(max(b.width, b.height) / 1200))
        new_h = max(1, b.height // scale)
        new_w = max(1, b.width // scale)

        b_arr = b.read(1, out_shape=(new_h, new_w))
        g_arr = g.read(1, out_shape=(new_h, new_w))
        r_arr = r.read(1, out_shape=(new_h, new_w))

    rgb = rgb_preview_from_bgr(b_arr, g_arr, r_arr)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb).save(out_png)


def _sliding_positions(length: int, tile: int, stride: int):
    pos = list(range(0, max(1, length - tile + 1), stride))
    if not pos:
        pos = [0]
    last = length - tile
    if last > 0 and pos[-1] != last:
        pos.append(last)
    return pos


# -------------------------
# Main pipeline
# outputs:
#   mask_full_cloud.tif
#   mask_full_shadow.tif
#   mask_full.tif  (0=none, 1=cloud, 2=shadow)
#   overlay.png
# -------------------------
def run_segmentation_pipeline(
    blue: Path,
    green: Path,
    red: Path,
    nir: Path,
    model_path: Path,
    out_mask_tif: Path,
    out_overlay_png: Path,
    tile: int = 480,
    overlap: int = 96,
    threshold: float = 0.5,
    shadow_threshold: float | None = None,
    preprocess: str = "auto",
    batch_size: int = 4,
    progress_callback=None,
):
    blue = Path(blue)
    green = Path(green)
    red = Path(red)
    nir = Path(nir)
    model_path = Path(model_path)
    out_mask_tif = Path(out_mask_tif)
    out_overlay_png = Path(out_overlay_png)

    if shadow_threshold is None:
        shadow_threshold = float(threshold)

    _emit_progress(progress_callback, 2, "loading_model", "กำลังโหลดโมเดล")
    model = _load_model_cached(str(model_path.resolve()))

    _emit_progress(progress_callback, 8, "precompute", "กำลังคำนวณค่าสถิติภาพ")
    p2, p98 = compute_global_percentiles(blue, green, red, nir)

    chosen_thr_cloud = float(threshold)
    chosen_thr_shadow = float(shadow_threshold)

    with rasterio.open(blue) as bds, rasterio.open(green) as gds, rasterio.open(red) as rds, rasterio.open(nir) as nds:
        ensure_same_grid([bds, gds, rds, nds])
        H, W = bds.height, bds.width

        prep_req = (preprocess or "auto").lower().strip()
        mode = prep_req

        _emit_progress(progress_callback, 12, "preprocess", "กำลังเลือกวิธี preprocess")
        if prep_req == "auto":
            mode = auto_pick_preprocess(bds, gds, rds, nds, H, W)
        elif mode not in ("sr_global", "div10000", "perband_minmax"):
            mode = "sr_global"

        _emit_progress(progress_callback, 18, "threshold", "กำลังคำนวณ threshold")
        if prep_req == "auto" and float(threshold) == 0.5 and float(shadow_threshold) == 0.5:
            xs_s = np.linspace(0, max(0, W - tile), num=min(3, max(1, (W // tile) + 1)), dtype=int)
            ys_s = np.linspace(0, max(0, H - tile), num=min(3, max(1, (H // tile) + 1)), dtype=int)

            sample_tiles = []
            valid_masks = []

            for y0s in ys_s:
                for x0s in xs_s:
                    win_s = Window(int(x0s), int(y0s), tile, tile)

                    bt = bds.read(1, window=win_s, boundless=True, fill_value=0)
                    gt = gds.read(1, window=win_s, boundless=True, fill_value=0)
                    rt = rds.read(1, window=win_s, boundless=True, fill_value=0)
                    nt = nds.read(1, window=win_s, boundless=True, fill_value=0)

                    vm = bds.dataset_mask(window=win_s).astype(np.uint8)
                    valid = vm > 0

                    if valid.mean() < 0.02:
                        continue

                    x = np.stack([bt, gt, rt, nt], axis=-1)
                    x = apply_preprocess(mode, x, p2, p98)

                    sample_tiles.append(x.astype(np.float32))
                    valid_masks.append(valid)

            if len(sample_tiles) == 0:
                chosen_thr_cloud, chosen_thr_shadow = 0.5, 0.5
            else:
                batch = np.stack(sample_tiles, axis=0)
                pcs, pss = _predict_batch_probs(model, batch)

                vpc_list = []
                vps_list = []

                for i in range(len(valid_masks)):
                    valid = valid_masks[i]
                    vpc_list.append(pcs[i][valid].reshape(-1))
                    vps_list.append(pss[i][valid].reshape(-1))

                if len(vpc_list) == 0 or np.concatenate(vpc_list).size < 5000:
                    chosen_thr_cloud, chosen_thr_shadow = 0.5, 0.5
                else:
                    vpc = np.concatenate(vpc_list).astype(np.float32)
                    vps = np.concatenate(vps_list).astype(np.float32)

                    k = int(np.sqrt(vpc.size))
                    k = max(256, min(k, 1200))
                    vpc = vpc[: k * k].reshape(k, k)
                    vps = vps[: k * k].reshape(k, k)

                    pc_small = _downsample_prob(vpc, max_size=900)
                    ps_small = _downsample_prob(vps, max_size=900)

                    chosen_thr_cloud = auto_threshold_from_prob(pc_small, target=(0.01, 0.35))
                    chosen_thr_shadow = auto_threshold_from_prob(ps_small, target=(0.003, 0.25))

                    chosen_thr_cloud = float(np.clip(chosen_thr_cloud, 0.15, 0.99))
                    chosen_thr_shadow = float(np.clip(chosen_thr_shadow, 0.15, 0.99))
        else:
            chosen_thr_cloud = float(threshold)
            chosen_thr_shadow = float(shadow_threshold)

        overlap = max(0, min(int(overlap), tile - 1))
        stride = max(32, tile - overlap)

        xs = _sliding_positions(W, tile, stride)
        ys = _sliding_positions(H, tile, stride)

        weight_kernel = make_weight(tile, sigma=0.45)

        acc_c = np.zeros((H, W), dtype=np.float32)
        acc_s = np.zeros((H, W), dtype=np.float32)
        wgt = np.zeros((H, W), dtype=np.float32)

        batch_tiles = []
        batch_meta = []

        total_tiles = len(xs) * len(ys)
        processed_tiles = 0
        used_tiles = 0
        skipped_tiles = 0

        _emit_progress(progress_callback, 20, "segmenting", "กำลังเริ่ม segment")

        def flush_batch():
            nonlocal batch_tiles, batch_meta, acc_c, acc_s, wgt, used_tiles

            if not batch_tiles:
                return

            bx = np.stack(batch_tiles, axis=0).astype(np.float32)
            batch_cloud, batch_shadow = _predict_batch_probs(model, bx)

            for i, meta in enumerate(batch_meta):
                y0, x0, vh, vw, valid = meta

                prob_cloud = np.clip(batch_cloud[i], 0.0, 1.0)[:vh, :vw].astype(np.float32)
                prob_shadow = np.clip(batch_shadow[i], 0.0, 1.0)[:vh, :vw].astype(np.float32)

                prob_cloud[~valid] = 0.0
                prob_shadow[~valid] = 0.0

                wk = weight_kernel[:vh, :vw]
                acc_c[y0:y0 + vh, x0:x0 + vw] += prob_cloud * wk
                acc_s[y0:y0 + vh, x0:x0 + vw] += prob_shadow * wk
                wgt[y0:y0 + vh, x0:x0 + vw] += wk

            used_tiles += len(batch_tiles)
            batch_tiles = []
            batch_meta = []

        for y0 in ys:
            for x0 in xs:
                processed_tiles += 1

                vh = min(tile, H - y0)
                vw = min(tile, W - x0)
                if vh <= 0 or vw <= 0:
                    skipped_tiles += 1
                    continue

                win = Window(x0, y0, tile, tile)

                vm = bds.dataset_mask(window=win).astype(np.uint8)
                valid = (vm > 0)[:vh, :vw]

                if valid.mean() < 0.01:
                    skipped_tiles += 1

                    pct = 20 + int((processed_tiles / max(total_tiles, 1)) * 65)
                    _emit_progress(
                        progress_callback,
                        pct,
                        "segmenting",
                        f"กำลัง segment... {processed_tiles}/{total_tiles} tiles",
                    )
                    continue

                bt = bds.read(1, window=win, boundless=True, fill_value=0)
                gt = gds.read(1, window=win, boundless=True, fill_value=0)
                rt = rds.read(1, window=win, boundless=True, fill_value=0)
                nt = nds.read(1, window=win, boundless=True, fill_value=0)

                x = np.stack([bt, gt, rt, nt], axis=-1)
                x = apply_preprocess(mode, x, p2, p98)

                batch_tiles.append(x)
                batch_meta.append((y0, x0, vh, vw, valid))

                if len(batch_tiles) >= max(1, int(batch_size)):
                    flush_batch()

                pct = 20 + int((processed_tiles / max(total_tiles, 1)) * 65)
                _emit_progress(
                    progress_callback,
                    pct,
                    "segmenting",
                    f"กำลัง segment... {processed_tiles}/{total_tiles} tiles",
                )

        flush_batch()

        prob_cloud_full = np.divide(acc_c, np.maximum(wgt, 1e-6))
        prob_shadow_full = np.divide(acc_s, np.maximum(wgt, 1e-6))

        mask_cloud = (prob_cloud_full >= float(chosen_thr_cloud)).astype(np.uint8)
        mask_shadow = (prob_shadow_full >= float(chosen_thr_shadow)).astype(np.uint8)

        out_cloud = out_mask_tif.with_name(out_mask_tif.stem + "_cloud.tif")
        out_shadow = out_mask_tif.with_name(out_mask_tif.stem + "_shadow.tif")

        mask_class = np.zeros((H, W), dtype=np.uint8)
        mask_class[mask_shadow > 0] = 2
        mask_class[mask_cloud > 0] = 1

        _emit_progress(progress_callback, 90, "writing_masks", "กำลังบันทึก mask")
        write_geotiff_like(src_path=blue, out_path=out_cloud, array=mask_cloud, dtype=rasterio.uint8, nodata=0)
        write_geotiff_like(src_path=blue, out_path=out_shadow, array=mask_shadow, dtype=rasterio.uint8, nodata=0)
        write_geotiff_like(src_path=blue, out_path=out_mask_tif, array=mask_class, dtype=rasterio.uint8, nodata=0)

        scale = max(1, int(max(W, H) / 1200))
        new_h = max(1, H // scale)
        new_w = max(1, W // scale)

        _emit_progress(progress_callback, 96, "overlay", "กำลังสร้าง overlay")
        b_small = bds.read(1, out_shape=(new_h, new_w))
        g_small = gds.read(1, out_shape=(new_h, new_w))
        r_small = rds.read(1, out_shape=(new_h, new_w))

        mc = cv2.resize(mask_cloud, (new_w, new_h), interpolation=cv2.INTER_NEAREST)
        ms = cv2.resize(mask_shadow, (new_w, new_h), interpolation=cv2.INTER_NEAREST)

    rgb = rgb_preview_from_bgr(b_small, g_small, r_small)
    overlay = rgb.copy()

    alpha = 0.35
    red_layer = np.zeros_like(rgb)
    red_layer[..., 0] = 255

    blue_layer = np.zeros_like(rgb)
    blue_layer[..., 2] = 255

    m1 = mc > 0
    m2 = ms > 0

    overlay[m1] = (
        overlay[m1].astype(np.float32) * (1 - alpha)
        + red_layer[m1].astype(np.float32) * alpha
    ).astype(np.uint8)

    overlay[m2] = (
        overlay[m2].astype(np.float32) * (1 - alpha)
        + blue_layer[m2].astype(np.float32) * alpha
    ).astype(np.uint8)

    out_overlay_png.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(overlay).save(out_overlay_png)

    _emit_progress(progress_callback, 100, "done", "เสร็จสิ้น")

    return {
        "chosen_preprocess": mode,
        "chosen_cloud_threshold": float(chosen_thr_cloud),
        "chosen_shadow_threshold": float(chosen_thr_shadow),
        "mask_cloud_name": out_cloud.name,
        "mask_shadow_name": out_shadow.name,
        "mask_class_name": out_mask_tif.name,
        "overlay_name": out_overlay_png.name,
        "batch_size": int(batch_size),
        "stride": int(stride),
        "progress_stage": "done",
        "tiles_total": int(total_tiles),
        "tiles_used": int(used_tiles),
        "tiles_skipped": int(skipped_tiles),
    }


# -------------------------
# Raster class (0/1/2) -> shapefile zip เดียว
# field:
#   class_id   : 1=cloud, 2=shadow
#   class_name : cloud / shadow
# -------------------------
def make_shapefile_zip(mask_tif: Path, out_zip: Path, min_area_m2=None):
    mask_tif = Path(mask_tif)
    out_zip = Path(out_zip)

    shp_dir = out_zip.with_suffix("")
    shp_dir.mkdir(parents=True, exist_ok=True)

    with rasterio.open(mask_tif) as src:
        arr = src.read(1).astype(np.uint8)
        transform = src.transform
        crs = src.crs

        feats = []
        for geom, val in shapes(arr, mask=(arr > 0), transform=transform):
            class_id = int(val)
            if class_id == 0:
                continue

            class_name = {
                1: "cloud",
                2: "shadow",
            }.get(class_id, "unknown")

            feats.append(
                {
                    "geometry": shape(geom),
                    "class_id": class_id,
                    "class_name": class_name,
                }
            )

    if not feats:
        raise ValueError("No cloud/shadow polygons found.")

    gdf = gpd.GeoDataFrame(feats, crs=crs)

    if min_area_m2 is not None:
        try:
            gdf = gdf[gdf.geometry.area >= float(min_area_m2)].copy()
        except Exception:
            pass

    shp_path = shp_dir / f"{mask_tif.stem}.shp"
    gdf.to_file(shp_path, driver="ESRI Shapefile")

    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for ext in [".shp", ".shx", ".dbf", ".prj", ".cpg"]:
            f = shp_path.with_suffix(ext)
            if f.exists():
                zf.write(f, arcname=f.name)