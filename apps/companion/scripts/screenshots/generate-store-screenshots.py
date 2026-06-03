#!/usr/bin/env python3
from __future__ import annotations

import base64
import html
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'store-assets' / 'raw'
TMP = ROOT / 'store-assets' / 'generated-svg'
IOS_OUT = ROOT / 'fastlane' / 'screenshots' / 'en-US'
PLAY_OUT = ROOT / 'fastlane' / 'play-metadata' / 'en-US' / 'images'
TMP.mkdir(parents=True, exist_ok=True)
IOS_OUT.mkdir(parents=True, exist_ok=True)
(PLAY_OUT / 'phoneScreenshots').mkdir(parents=True, exist_ok=True)
(PLAY_OUT / 'tenInchScreenshots').mkdir(parents=True, exist_ok=True)

SCREENS = [
    ('01_fleet', 'Monitor every agent slot', 'Live slot health, task progress, and worker attention in one operator view.'),
    ('02_recipes', 'Review recipe evidence', 'Open runs, acceptance checks, artifacts, and validation status before approving work.'),
    ('03_workers', 'Track worker terminals', 'See active panes, stale sessions, linked runs, and where a worker needs attention.'),
    ('04_pull_requests', 'Follow PR readiness', 'Keep CI, review state, bot comments, and release readiness visible from mobile.'),
    ('05_gateway', 'Pair your own gateway', 'Connect by QR code or profile, with no hosted gateway configured by default.'),
]

TARGETS = {
    'iphone_69': {
        'size': (1320, 2868),
        'source': 'ios-phone',
        'dest': IOS_OUT,
        'suffix': 'iphone_69',
    },
    'ipad_13': {
        'size': (2064, 2752),
        'source': 'ios-tablet',
        'fallback': 'ios-phone',
        'dest': IOS_OUT,
        'suffix': 'ipad_13',
    },
    'play_phone': {
        'size': (1080, 1920),
        'source': 'android-phone',
        'dest': PLAY_OUT / 'phoneScreenshots',
        'suffix': 'phone',
    },
    'play_tablet': {
        'size': (1600, 2560),
        'source': 'android-tablet',
        'fallback': 'android-phone',
        'dest': PLAY_OUT / 'tenInchScreenshots',
        'suffix': 'tablet',
    },
}

BG = '#07111f'
BG2 = '#111827'
ACCENT = '#6366f1'
ACCENT2 = '#22d3ee'
TEXT = '#f8fafc'
MUTED = '#cbd5e1'
FRAME = '#0b1220'


def identify(path: Path) -> tuple[int, int]:
    output = subprocess.check_output(['magick', 'identify', '-format', '%w %h', str(path)], text=True)
    width, height = output.split()
    return int(width), int(height)


def image_data(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode('ascii')
    return f'data:image/png;base64,{encoded}'


def cleaned_raw_path(raw_path: Path) -> Path:
    if raw_path.parent.name != 'ios-phone':
        return raw_path
    width, height = identify(raw_path)
    cleaned = TMP / f'cleaned_{raw_path.parent.name}_{raw_path.name}'
    # Expo development builds draw a floating dev-tools button over the app.
    # Store screenshots should show the app UI, not the dev-client overlay.
    cx = int(width * 0.895)
    cy = int(height * 0.690)
    radius = int(width * 0.078)
    subprocess.run([
        'magick', str(raw_path),
        '-fill', '#05070c',
        '-draw', f'circle {cx},{cy} {cx + radius},{cy}',
        str(cleaned),
    ], check=True)
    return cleaned


def text(x: int | float, y: int | float, content: str, size: int, weight: int = 800, fill: str = TEXT, anchor: str = 'start') -> str:
    return f'<text x="{x}" y="{y}" fill="{fill}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}">{html.escape(content)}</text>'


def wrapped(x: int, y: int, content: str, max_chars: int, size: int, line_height: int) -> str:
    words = content.split()
    lines: list[str] = []
    current: list[str] = []
    for word in words:
        candidate = ' '.join([*current, word])
        if current and len(candidate) > max_chars:
            lines.append(' '.join(current))
            current = [word]
        else:
            current.append(word)
    if current:
        lines.append(' '.join(current))
    return '\n'.join(text(x, y + index * line_height, line, size=size, weight=600, fill=MUTED) for index, line in enumerate(lines[:3]))


def find_raw(source: str, fallback: str | None, key: str) -> Path:
    primary = RAW / source / f'{key}.png'
    if primary.exists():
        return primary
    if fallback:
        fallback_path = RAW / fallback / f'{key}.png'
        if fallback_path.exists():
            print(f'[screenshots] using {fallback}/{key}.png for missing {source}/{key}.png')
            return fallback_path
    raise FileNotFoundError(f'Missing raw app screenshot: {primary}')


def render(target_name: str, key: str, title: str, subtitle: str, raw_path: Path) -> Path:
    target = TARGETS[target_name]
    width, height = target['size']
    raw_path = cleaned_raw_path(raw_path)
    raw_w, raw_h = identify(raw_path)
    is_tablet = width >= 1500
    title_size = 68 if width < 1200 else 84
    subtitle_size = 31 if width < 1200 else 42
    top = int(height * (0.085 if is_tablet else 0.075))
    margin = int(width * 0.075)
    brand_h = 68 if width < 1200 else 82
    screenshot_top = int(height * (0.31 if is_tablet else 0.32))
    screenshot_bottom_margin = int(height * 0.06)
    frame_h = height - screenshot_top - screenshot_bottom_margin
    frame_w = min(int(frame_h * raw_w / raw_h), int(width * (0.78 if is_tablet else 0.80)))
    frame_x = int((width - frame_w) / 2)
    frame_y = screenshot_top
    radius = int(frame_w * 0.055)
    shadow_x = frame_x + 18
    shadow_y = frame_y + 24

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{BG}"/><stop offset="0.58" stop-color="{BG2}"/><stop offset="1" stop-color="#312e81"/></linearGradient>
    <clipPath id="screenClip"><rect x="{frame_x + 16}" y="{frame_y + 16}" width="{frame_w - 32}" height="{frame_h - 32}" rx="{max(12, radius - 8)}"/></clipPath>
  </defs>
  <rect width="{width}" height="{height}" fill="url(#bg)"/>
  <circle cx="{int(width * 0.82)}" cy="{int(height * 0.12)}" r="{int(width * 0.38)}" fill="{ACCENT}" opacity="0.18"/>
  <circle cx="{int(width * 0.10)}" cy="{int(height * 0.82)}" r="{int(width * 0.42)}" fill="{ACCENT2}" opacity="0.12"/>
  <rect x="{margin}" y="{top - int(brand_h * 0.72)}" width="{220 if width < 1200 else 270}" height="{brand_h}" rx="{brand_h // 2}" fill="#ffffff" opacity="0.08"/>
  {text(margin + 30, top, 'Farmslot', size=32 if width < 1200 else 42, weight=900)}
  {text(margin, top + int(height * 0.095), title, size=title_size, weight=950)}
  {wrapped(margin, top + int(height * 0.145), subtitle, max_chars=38 if width < 1200 else 54, size=subtitle_size, line_height=int(subtitle_size * 1.35))}
  <rect x="{shadow_x}" y="{shadow_y}" width="{frame_w}" height="{frame_h}" rx="{radius}" fill="#000000" opacity="0.28"/>
  <rect x="{frame_x}" y="{frame_y}" width="{frame_w}" height="{frame_h}" rx="{radius}" fill="{FRAME}" stroke="#334155" stroke-width="2"/>
  <image x="{frame_x + 16}" y="{frame_y + 16}" width="{frame_w - 32}" height="{frame_h - 32}" preserveAspectRatio="xMidYMid slice" clip-path="url(#screenClip)" href="{image_data(raw_path)}"/>
  <rect x="{frame_x + 16}" y="{frame_y + 16}" width="{frame_w - 32}" height="{frame_h - 32}" rx="{max(12, radius - 8)}" fill="none" stroke="#1e293b" stroke-width="1"/>
</svg>'''
    svg_path = TMP / f'{key}_{target["suffix"]}.svg'
    png_path = target['dest'] / f'{key}_{target["suffix"]}.png'
    svg_path.write_text(svg)
    subprocess.run(['rsvg-convert', '-o', str(png_path), str(svg_path)], check=True)
    return png_path


def clean_output_dirs() -> None:
    for folder in [IOS_OUT, PLAY_OUT / 'phoneScreenshots', PLAY_OUT / 'tenInchScreenshots']:
        for screenshot in folder.glob('*.png'):
            screenshot.unlink()


def main() -> None:
    clean_output_dirs()
    rendered: list[Path] = []
    for key, title, subtitle in SCREENS:
        for target_name, target in TARGETS.items():
            raw_path = find_raw(target['source'], target.get('fallback'), key)
            rendered.append(render(target_name, key, title, subtitle, raw_path))
    # Keep Play icon/feature graphic stable; screenshots are regenerated above.
    print('\n'.join(str(path) for path in rendered))


if __name__ == '__main__':
    if not shutil.which('magick'):
        raise SystemExit('ImageMagick `magick` is required to frame store screenshots.')
    if not shutil.which('rsvg-convert'):
        raise SystemExit('`rsvg-convert` is required to render framed store screenshots.')
    main()
