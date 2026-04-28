"""
yolo_bridge.py
──────────────
YOLO 탐지 결과를 spotlight_core의 보정 로직으로 연결하는 중개 모듈.

흐름:
    1. spotlight_core의 main()에서 register()로 핸들러와 이벤트 루프 등록
    2. YOLO가 객체를 감지하면 submit(obj_x, obj_y) 호출
    3. 이 모듈이 등록된 핸들러(process_object_detected)를 이벤트 루프에 스케줄링

이 구조를 사용하는 이유:
    spotlight_core ↔ YOLO 간 직접 import 시 순환 참조가 발생하므로
    중개 모듈을 통해 의존성을 분리한다.

사용 예 (YOLO 쪽):
    from moduls.yolo_bridge import submit
    submit(obj_x=960.0, obj_y=540.0)
"""

import asyncio
import logging

logger = logging.getLogger("yolo_bridge")

_handler = None                          # process_object_detected 코루틴 함수
_loop: asyncio.AbstractEventLoop = None  # spotlight_core의 이벤트 루프


def register(handler, loop: asyncio.AbstractEventLoop):
    """spotlight_core의 main()에서 호출해 핸들러와 이벤트 루프를 등록한다.

    Args:
        handler: process_object_detected 코루틴 함수
        loop:    spotlight_core가 실행 중인 asyncio 이벤트 루프
    """
    global _handler, _loop
    _handler = handler
    _loop = loop
    logger.info("YOLO 브릿지 등록 완료")


def submit(obj_x: float, obj_y: float):
    """YOLO가 객체를 감지했을 때 호출한다.

    동기 함수이므로 YOLO가 별도 스레드에서 실행되더라도 안전하게 호출할 수 있다.
    내부적으로 asyncio 이벤트 루프에 코루틴을 스케줄링한다.

    Args:
        obj_x: 감지된 객체 중심의 x 좌표 (픽셀)
        obj_y: 감지된 객체 중심의 y 좌표 (픽셀)
    """
    if _handler is None or _loop is None:
        logger.warning("핸들러 미등록 상태에서 submit 호출됨 — register()를 먼저 호출하세요")
        return

    # 스레드 안전하게 코루틴을 이벤트 루프에 스케줄링
    asyncio.run_coroutine_threadsafe(_handler(obj_x, obj_y), _loop)
    logger.debug(f"YOLO 좌표 전달 — obj_x: {obj_x:.1f}, obj_y: {obj_y:.1f}")
