#!/usr/bin/env python3
import sys
from pathlib import Path

from PIL import Image


EXPECTED = {
    "bounds": {"accent": (49, 215, 255), "accent_y": 144, "pointer": True},
    "policy": {"accent": (255, 209, 102), "accent_y": 129, "pointer": True},
    "parent": {"accent": (255, 94, 168), "accent_y": 104, "pointer": False},
    "parent-fullscreen": {
        "accent": (255, 94, 168),
        "accent_y": 209,
        "pointer": False,
        "aperture": False,
        "reference": (49, 215, 255),
    },
    "parent-transition": {"accent": (255, 94, 168), "accent_y": 102, "pointer": False},
    "parent-geometry": {
        "accent": (255, 94, 168),
        "accent_y": 174,
        "accent_tolerance": 40,
        "panel_point": (400, 340),
        "pointer": False,
    },
    "parent-lifecycle": {"accent": (255, 94, 168), "accent_y": 122, "pointer": False},
    "parent-matching": {"accent": (93, 242, 160), "accent_y": 104, "pointer": False},
    "input-blocking": {"accent": (255, 209, 102), "accent_y": 144, "pointer": True},
    "wayland-compat": {"accent": (93, 242, 160), "accent_y": 104, "pointer": False},
    "coordinates": {"accent": (93, 242, 160), "accent_y": 104, "pointer": False},
    "layer-shell": {"accent": (174, 124, 255), "accent_y": 40, "pointer": False},
}
POINTER_RECEIVED = (93, 242, 160)
PASS_MARKER = (0, 255, 76)


def fail(message: str) -> None:
    raise SystemExit(message)


def color_count(image: Image.Image, color: tuple[int, int, int]) -> int:
    return sum(1 for pixel in image.getdata() if pixel[:3] == color)


def row_color_count(
    image: Image.Image, y: int, color: tuple[int, int, int], tolerance: int = 2
) -> int:
    return max(
        sum(1 for x in range(image.width) if image.getpixel((x, row))[:3] == color)
        for row in range(max(0, y - tolerance), min(image.height, y + tolerance + 1))
    )


def brightness(image: Image.Image, x: int, y: int) -> int:
    pixel = image.getpixel((x, y))
    return sum(pixel[:3])


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in EXPECTED:
        fail(f"Usage: {Path(sys.argv[0]).name} SCENARIO SCREENSHOT")
    scenario = sys.argv[1]
    screenshot = Path(sys.argv[2])
    expected = EXPECTED[scenario]
    image = Image.open(screenshot).convert("RGBA")

    if image.size != (1280, 800):
        fail(f"{scenario}: expected 1280x800, got {image.width}x{image.height}")

    if len(set(image.getdata())) < 32:
        fail(f"{scenario}: screenshot has too little visual variation")
    pass_marker_pixels = color_count(image, PASS_MARKER)
    if pass_marker_pixels < 40:
        fail(f"{scenario}: final PASS marker is missing ({pass_marker_pixels} pixels)")

    accent_pixels = color_count(image, expected["accent"])
    accent_row_pixels = row_color_count(
        image,
        expected["accent_y"],
        expected["accent"],
        expected.get("accent_tolerance", 2),
    )
    if accent_pixels < 750:
        fail(f"{scenario}: expected accent color is missing ({accent_pixels} pixels)")
    if accent_row_pixels < 500:
        fail(
            f"{scenario}: accent panel is not at expected y={expected['accent_y']} "
            f"({accent_row_pixels} row pixels)"
        )

    aperture_point = expected.get("aperture_point", (620, 340))
    panel_point = expected.get("panel_point", (250, 340))
    aperture_brightness = brightness(image, *aperture_point)
    panel_brightness = brightness(image, *panel_point)
    if expected.get("aperture", True) and aperture_brightness <= panel_brightness + 10:
        fail(
            f"{scenario}: compositor aperture is not visibly distinct from the opaque panel "
            f"({aperture_brightness} <= {panel_brightness})"
        )
    if "reference" in expected and color_count(image, expected["reference"]) < 500:
        fail(f"{scenario}: fullscreen reference process is not visibly composed beneath the HUD")

    if expected["pointer"]:
        pointer_pixels = color_count(image, POINTER_RECEIVED)
        if pointer_pixels < 150:
            fail(f"{scenario}: pointer probe did not visibly render RECEIVED ({pointer_pixels} pixels)")

    print(
        f"{scenario}: visual assertions passed "
        f"(accent={accent_pixels}, row={accent_row_pixels}, aperture={aperture_brightness}, panel={panel_brightness})"
    )


if __name__ == "__main__":
    main()
