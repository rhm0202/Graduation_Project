"""
test_yolo_bridge.py
───────────────────
YOLO 브릿지 단독 테스트 스크립트.

YOLO가 미완성일 때 임의 좌표를 yolo_bridge에 주입해
correction_module → process_object_detected 흐름을 검증한다.

실행 방법:
    # spotlight_core.py 없이 단독 실행 (보정값 계산만 확인)
    python test_yolo_bridge.py

    # 대화형 모드 (직접 좌표 입력)
    python test_yolo_bridge.py --interactive
"""

import asyncio
import sys
import os
import argparse

sys.path.insert(0, os.path.dirname(__file__))

from moduls import yolo_bridge
from moduls.correction_module import CorrectionCalculator

# ──────────────────────────────────────────
# 설정 (spotlight_core.py와 일치시킬 것)
# ──────────────────────────────────────────
FRAME_WIDTH  = 1920
FRAME_HEIGHT = 1080

# ──────────────────────────────────────────
# 모의(mock) 핸들러 — process_object_detected 대체
# RPi 전송 없이 보정값만 출력한다.
# ──────────────────────────────────────────
_calc = CorrectionCalculator(FRAME_WIDTH, FRAME_HEIGHT)

async def mock_process_object_detected(obj_x: float, obj_y: float):
    """spotlight_core.process_object_detected 역할을 하는 모의 핸들러."""
    correction = _calc.calc(obj_x, obj_y)
    cx, cy = FRAME_WIDTH / 2, FRAME_HEIGHT / 2

    print(f"  객체 좌표  : ({obj_x:.1f}, {obj_y:.1f})")
    print(f"  프레임 중심: ({cx:.1f}, {cy:.1f})")
    print(f"  오프셋     : dx={obj_x - cx:+.1f}, dy={obj_y - cy:+.1f}")

    if correction:
        pan, tilt = correction
        print(f"  보정값     : pan={pan:+.3f}°, tilt={tilt:+.3f}°  ← RPi로 전송될 값")
    else:
        print(f"  보정값     : 없음 (threshold 미만, 보정 불필요)")
    print()

# ──────────────────────────────────────────
# 사전 정의 테스트 케이스
# ──────────────────────────────────────────
PRESET_CASES = [
    (960,  540,  "중앙 (보정 불필요)"),
    (1200, 540,  "오른쪽"),
    (720,  540,  "왼쪽"),
    (960,  700,  "아래"),
    (960,  300,  "위"),
    (1500, 800,  "오른쪽 아래 (대각선)"),
    (100,  100,  "좌상단 극단값"),
    (1820, 980,  "우하단 극단값"),
]

async def run_presets():
    """사전 정의된 좌표를 순서대로 주입."""
    print(f"=== 사전 정의 테스트 ({len(PRESET_CASES)}개 케이스) ===\n")
    for obj_x, obj_y, desc in PRESET_CASES:
        print(f"[{desc}]")
        yolo_bridge.submit(obj_x, obj_y)
        await asyncio.sleep(0.05)  # 핸들러 처리 대기

async def run_interactive():
    """사용자가 직접 좌표를 입력하는 대화형 모드."""
    print("=== 대화형 모드 ===")
    print(f"프레임 크기: {FRAME_WIDTH} x {FRAME_HEIGHT}")
    print("좌표를 입력하세요. 종료: q\n")

    loop = asyncio.get_event_loop()
    while True:
        try:
            raw = await loop.run_in_executor(None, input, "obj_x obj_y > ")
        except (EOFError, KeyboardInterrupt):
            break

        raw = raw.strip()
        if raw.lower() in ("q", "quit", "exit"):
            break

        parts = raw.split()
        if len(parts) != 2:
            print("  입력 형식: <x> <y>  예) 1200 400\n")
            continue

        try:
            obj_x, obj_y = float(parts[0]), float(parts[1])
        except ValueError:
            print("  숫자를 입력하세요.\n")
            continue

        yolo_bridge.submit(obj_x, obj_y)
        await asyncio.sleep(0.05)

async def main(interactive: bool):
    loop = asyncio.get_event_loop()
    yolo_bridge.register(mock_process_object_detected, loop)
    print(f"[yolo_bridge] 모의 핸들러 등록 완료\n")

    if interactive:
        await run_interactive()
    else:
        await run_presets()

    print("테스트 종료.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="YOLO 브릿지 테스트")
    parser.add_argument("--interactive", "-i", action="store_true",
                        help="대화형 모드 (직접 좌표 입력)")
    args = parser.parse_args()

    try:
        asyncio.run(main(args.interactive))
    except KeyboardInterrupt:
        print("\n종료.")
