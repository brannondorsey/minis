#!/usr/bin/env python3
"""Build the web assets for every photo in photos/.

For each photo this writes, into site/minis/<id>/:
  * responsive WebP renditions of the untouched photo (gallery + fullscreen)
  * a die-cut "sticker" (background removed, white border) in two sizes
  * a soft drop-shadow sprite for the sticker
and then regenerates site/minis/manifest.json, merging in the optional
names/descriptions from minis.toml.

Work is cached per photo (by content hash), so re-running only processes
new or changed photos. Usage:

    pip install -r requirements.txt
    python3 scripts/build.py            # process new/changed photos
    python3 scripts/build.py --force    # rebuild everything
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import io
import json
import re
import shutil
import sys
import tomllib
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
PHOTOS = ROOT / "photos"
OUT = ROOT / "site" / "minis"
META_FILE = ROOT / "minis.toml"
CACHE = ROOT / ".cache" / "cutouts"  # raw segmentation results (gitignored)

# Bump when the processing below changes, to invalidate every cache entry.
PIPELINE_VERSION = "2"

PHOTO_WIDTHS = [480, 960, 1600, 2400]
STICKER_SIZES = {"sm": 640, "lg": 1400}  # longest edge, px
CUTOUT_INPUT = 1600  # longest edge fed to the segmentation model
MASK_CELLS = 64  # hit-test grid resolution (longest edge)
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}

SRGB = ImageCms.createProfile("sRGB")


# ----------------------------------------------------------------- helpers


def slug(stem: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-") or "mini"


def file_hash(*paths: Path) -> str:
    h = hashlib.sha1(PIPELINE_VERSION.encode())
    for p in paths:
        if p and p.exists():
            h.update(p.read_bytes())
    return h.hexdigest()[:16]


def load_rgb(path: Path) -> Image.Image:
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    icc = im.info.get("icc_profile")
    if icc:
        try:
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            im = ImageCms.profileToProfile(im.convert("RGB"), src, SRGB, outputMode="RGB")
        except Exception:  # unreadable profile: assume sRGB
            pass
    return im.convert("RGB")


def capture_time(path: Path) -> str:
    try:
        exif = Image.open(path).getexif()
        raw = exif.get_ifd(0x8769).get(36867) or exif.get(306)
        if raw:
            return datetime.strptime(str(raw).strip(), "%Y:%m:%d %H:%M:%S").isoformat()
    except Exception:
        pass
    return ""


def save_webp(im: Image.Image, path: Path, quality: int = 82) -> None:
    im.save(path, "WEBP", quality=quality, method=6)


def data_uri_webp(im: Image.Image, quality: int = 40) -> str:
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=quality)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()


# ------------------------------------------------------------ the photo


def build_photo(im: Image.Image, out: Path) -> dict:
    w, h = im.size
    widths = sorted({min(x, w) for x in PHOTO_WIDTHS})
    srcs = []
    for tw in widths:
        th = round(h * tw / w)
        name = f"photo-{tw}.webp"
        save_webp(im.resize((tw, th), Image.LANCZOS), out / name)
        srcs.append({"w": tw, "src": name})
    tiny = im.copy()
    tiny.thumbnail((24, 24))
    avg = im.resize((1, 1), Image.BOX).getpixel((0, 0))
    return {
        "w": w,
        "h": h,
        "srcs": srcs,
        "lqip": data_uri_webp(tiny),
        "color": "#%02x%02x%02x" % avg,
    }


# ----------------------------------------------------------- the sticker


_session = None


def cutout(im: Image.Image, model: str) -> Image.Image:
    """Return an RGBA image with the background removed."""
    global _session
    try:  # imported lazily: heavy, and only needed for new photos
        import onnxruntime as ort
        from rembg import new_session, remove
    except ImportError:
        print("error: background removal needs rembg — pip install -r requirements.txt", file=sys.stderr)
        raise SystemExit(3)

    if _session is None:
        print(f"  loading segmentation model '{model}' (first run downloads it)…")
        opts = ort.SessionOptions()
        # The default arena allocator holds on to several GB between runs.
        opts.enable_cpu_mem_arena = False
        opts.enable_mem_pattern = False
        _session = new_session(model, sess_opts=opts)
    small = im.copy()
    small.thumbnail((CUTOUT_INPUT, CUTOUT_INPUT), Image.LANCZOS)
    return remove(small, session=_session).convert("RGBA")


def build_sticker(rgba: Image.Image, out: Path) -> dict:
    from scipy import ndimage

    alpha = np.asarray(rgba.getchannel("A"), dtype=np.float32) / 255.0
    solid = alpha > 0.5
    if not solid.any():
        raise ValueError("segmentation found nothing")

    # Crop to the subject with room for the border + shadow.
    ys, xs = np.nonzero(alpha > 0.04)
    long_edge = max(xs.max() - xs.min(), ys.max() - ys.min())
    border = max(6, round(long_edge * 0.018))
    pad = border * 3
    x0, y0 = xs.min() - pad, ys.min() - pad
    x1, y1 = xs.max() + pad + 1, ys.max() + pad + 1
    rgba = rgba.crop((x0, y0, x1, y1))  # PIL pads out-of-bounds with transparency
    a = np.asarray(rgba.getchannel("A"), dtype=np.float32) / 255.0
    solid = a > 0.5

    # Die-cut outline: grow the silhouette by 2*border, then shrink it by
    # border. That rounds off concave nooks the way a real cutter would.
    grown = ndimage.distance_transform_edt(~solid) <= border * 2
    inner = ndimage.distance_transform_edt(grown)
    cut = np.clip(inner - border + 0.5, 0.0, 1.0)  # 1px anti-aliased edge
    cut = np.maximum(cut, a)

    white = Image.new("RGBA", rgba.size, (255, 255, 255, 0))
    white.putalpha(Image.fromarray((cut * 255).astype(np.uint8)))
    white = white.filter(ImageFilter.GaussianBlur(0.6))
    sticker = Image.alpha_composite(white, rgba)

    # Trim to the outline and write two sizes.
    ys, xs = np.nonzero(cut > 0.01)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    sticker = sticker.crop(box)
    cut_img = Image.fromarray((cut * 255).astype(np.uint8)).crop(box)
    sw, sh = sticker.size

    srcs = {}
    for key, edge in STICKER_SIZES.items():
        s = sticker.copy()
        if max(sw, sh) > edge:
            s.thumbnail((edge, edge), Image.LANCZOS)
        name = f"sticker-{key}.webp"
        s.save(out / name, "WEBP", quality=88, method=6, exact=False)
        srcs[key] = {"src": name, "w": s.width}

    # Soft shadow sprite (tiny; it is blurred anyway). Padded by `spad` of
    # the sticker size on every side so the blur is not clipped.
    spad = 0.15
    sm = cut_img.copy()
    sm.thumbnail((160, 160), Image.LANCZOS)
    px, py = round(sm.width * spad), round(sm.height * spad)
    canvas = Image.new("L", (sm.width + 2 * px, sm.height + 2 * py), 0)
    canvas.paste(sm, (px, py))
    canvas = canvas.filter(ImageFilter.GaussianBlur(max(3, max(sm.size) * 0.035)))
    shadow = Image.new("RGBA", canvas.size, (20, 16, 12, 0))
    shadow.putalpha(canvas)
    shadow.save(out / "shadow.webp", "WEBP", quality=80)

    # Hit-test mask: 1 bit per cell, row-major, MSB first.
    m = cut_img.copy()
    scale = MASK_CELLS / max(sw, sh)
    mw, mh = max(1, round(sw * scale)), max(1, round(sh * scale))
    bits = (np.asarray(m.resize((mw, mh), Image.BOX)) > 40).astype(np.uint8).ravel()
    packed = np.packbits(bits).tobytes()

    return {
        "w": sw,
        "h": sh,
        "srcs": srcs,
        "shadow": {"src": "shadow.webp", "pad": spad},
        "mask": {"w": mw, "h": mh, "bits": base64.b64encode(packed).decode()},
    }


# --------------------------------------------------------------- markdown


_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
_URL = re.compile(r"(?<![\"'=>])\bhttps?://[^\s<]+[^\s<.,;:!?)\]'\"]")


def _anchor(href: str, text: str) -> str:
    href = href if re.match(r"^(https?:|mailto:|/|#)", href) else "#"
    return f'<a href="{href}" target="_blank" rel="noopener">{text}</a>'


def inline_md(text: str) -> str:
    """Tiny, safe Markdown: [links](url), bare URLs, **bold**, *italic*."""
    text = html.escape(text.strip(), quote=True)
    links: list[str] = []

    def stash(s: str) -> str:
        links.append(s)
        return f"\x00{len(links) - 1}\x00"

    text = _LINK.sub(lambda m: stash(_anchor(m.group(2), m.group(1))), text)
    text = _URL.sub(lambda m: stash(_anchor(m.group(0), m.group(0).split("://", 1)[1])), text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", text)
    text = re.sub(r"\x00(\d+)\x00", lambda m: links[int(m.group(1))], text)
    return text


def markdown(text: str) -> str:
    paras = [p for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    return "".join(f"<p>{inline_md(' '.join(p.split()))}</p>" for p in paras)


# ------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="ignore the cache")
    ap.add_argument("--model", default="birefnet-general", help="rembg model (default: %(default)s)")
    args = ap.parse_args()

    meta = tomllib.loads(META_FILE.read_text()) if META_FILE.exists() else {}
    photos = sorted(
        p for p in PHOTOS.iterdir()
        if p.suffix.lower() in EXTS and ".cutout" not in p.stem
    ) if PHOTOS.exists() else []
    OUT.mkdir(parents=True, exist_ok=True)

    known = {slug(p.stem): p for p in photos}
    for key in meta:
        if key not in known and slug(key) not in known:
            print(f"warning: minis.toml has [{key}] but there is no matching photo", file=sys.stderr)

    minis = []
    for photo in photos:
        mid = slug(photo.stem)
        info = meta.get(photo.stem) or meta.get(mid) or {}
        if info.get("hidden"):
            continue
        override = next((photo.with_name(photo.stem + ".cutout" + e) for e in (".png", ".webp") if photo.with_name(photo.stem + ".cutout" + e).exists()), None)
        out = OUT / mid
        cache = out / "build.json"
        digest = file_hash(photo, override) if override else file_hash(photo)

        built = None
        if cache.exists() and not args.force:
            built = json.loads(cache.read_text())
            if built.get("hash") != digest:
                built = None

        if built is None:
            print(f"• {photo.name} → site/minis/{mid}/")
            if out.exists():
                shutil.rmtree(out)
            out.mkdir(parents=True)
            im = load_rgb(photo)
            built = {"hash": digest, "photo": build_photo(im, out)}
            if override:
                rgba = Image.open(override).convert("RGBA")
            else:
                key = hashlib.sha1(photo.read_bytes() + args.model.encode()).hexdigest()[:16]
                cached = CACHE / f"{mid}-{key}.png"
                if cached.exists():
                    rgba = Image.open(cached).convert("RGBA")
                else:
                    rgba = cutout(im, args.model)
                    CACHE.mkdir(parents=True, exist_ok=True)
                    for old in CACHE.glob(f"{mid}-*.png"):
                        old.unlink()
                    rgba.save(cached)
            built["sticker"] = build_sticker(rgba, out)
            cache.write_text(json.dumps(built, indent=1))
        else:
            print(f"  {photo.name} (cached)")

        entry = {"id": mid, "taken": capture_time(photo)}
        if info.get("name"):
            entry["name"] = str(info["name"]).strip()
        if info.get("description"):
            entry["description"] = markdown(str(info["description"]))
        entry["photo"] = built["photo"]
        if info.get("sticker", True):
            entry["sticker"] = built["sticker"]
        minis.append(entry)

    # Newest first (by capture time), then by file name, unless `order` is given.
    minis.sort(key=lambda m: (m["taken"], m["id"]), reverse=True)
    order = {slug(k): v.get("order") for k, v in meta.items() if isinstance(v, dict) and "order" in v}
    if order:
        minis.sort(key=lambda m: order.get(m["id"], float("inf")))

    for stale in OUT.iterdir():
        if stale.is_dir() and stale.name not in {m["id"] for m in minis}:
            print(f"  removing stale {stale.relative_to(ROOT)}")
            shutil.rmtree(stale)

    manifest = {"generated": datetime.now().isoformat(timespec="seconds"), "minis": minis}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"wrote site/minis/manifest.json ({len(minis)} minis)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
