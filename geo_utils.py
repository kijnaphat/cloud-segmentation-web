from pathlib import Path
import numpy as np
import rasterio
from rasterio.features import shapes as rio_shapes
import geopandas as gpd
from shapely.geometry import shape
import zipfile
import tempfile

def ensure_same_grid(datasets):
    base = datasets[0]
    for ds in datasets[1:]:
        if (ds.width, ds.height) != (base.width, base.height):
            raise ValueError("Band sizes mismatch")
        if ds.transform != base.transform:
            raise ValueError("Band transform mismatch")
        if ds.crs != base.crs:
            raise ValueError("Band CRS mismatch")

def write_geotiff_like(src_path: Path, out_path: Path, array: np.ndarray, dtype, nodata=0):
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(src_path) as src:
        profile = src.profile.copy()
        profile.update(
            count=1,
            dtype=dtype,
            nodata=nodata,
            compress="lzw",
            height=array.shape[0],
            width=array.shape[1],
        )
        with rasterio.open(out_path, "w", **profile) as dst:
            dst.write(array.astype(dtype), 1)

def _norm01_percentile(x: np.ndarray) -> np.ndarray:
    x = x.astype(np.float32)
    p2, p98 = np.percentile(x, 2), np.percentile(x, 98)
    x = (x - p2) / (p98 - p2 + 1e-6)
    return np.clip(x, 0, 1)

def rgb_preview_from_bgr(blue, green, red) -> np.ndarray:
    r = (_norm01_percentile(red) * 255).astype(np.uint8)
    g = (_norm01_percentile(green) * 255).astype(np.uint8)
    b = (_norm01_percentile(blue) * 255).astype(np.uint8)
    return np.stack([r, g, b], axis=-1)  # RGB uint8

def raster_mask_to_shp_zip(mask_tif: Path, out_zip: Path, min_area_m2=None):
    """
    mask_tif: GeoTIFF mask 0/1
    out_zip: zip ที่บรรจุ shapefile (cloud.shp + เพื่อนๆ)
    min_area_m2: optional ตัด polygon ชิ้นเล็ก (ต้องเป็น CRS เมตรถึงจะแม่น)
    """
    mask_tif = Path(mask_tif)
    out_zip = Path(out_zip)
    out_zip.parent.mkdir(parents=True, exist_ok=True)

    with rasterio.open(mask_tif) as src:
        arr = src.read(1)
        crs = src.crs
        transform = src.transform

        geoms = []
        for geom, val in rio_shapes(arr, mask=(arr == 1), transform=transform):
            if int(val) == 1:
                geoms.append(shape(geom))

    gdf = gpd.GeoDataFrame({"class": [1] * len(geoms)}, geometry=geoms, crs=crs)

    if min_area_m2 is not None and len(gdf) > 0:
        try:
            utm = gdf.estimate_utm_crs()
            gdf2 = gdf.to_crs(utm)
            gdf2 = gdf2[gdf2.area >= float(min_area_m2)]
            gdf = gdf2.to_crs(crs)
        except Exception:
            # ถ้า estimate_utm_crs ใช้ไม่ได้ ก็ข้าม
            pass

    with tempfile.TemporaryDirectory() as td:
        shp_path = Path(td) / "cloud.shp"
        gdf.to_file(shp_path)

        with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as z:
            for ext in [".shp", ".shx", ".dbf", ".prj", ".cpg"]:
                p = shp_path.with_suffix(ext)
                if p.exists():
                    z.write(p, arcname=p.name)