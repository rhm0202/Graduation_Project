"""
yolo_detector.py
─────────────────
YOLO 모델로 프레임에서 객체를 탐지해 중심 좌표를 반환하는 모듈.

spotlight_core.py의 receive_from_pi()에서 프레임 수신 시 호출된다.
추론은 동기 함수(detect)로 제공되며, 호출 측에서 스레드 풀에 위임해야 한다.

사용 예:
    detector = YoloDetector(model_path="yolov8n.pt")
    result = detector.detect(frame_bgr)
    if result:
        obj_x, obj_y = result
"""

import cv2
import numpy as np
from modules.logger import get_logger

logger = get_logger("yolo_detector")


class YoloDetector:
    """YOLOv8 기반 단일 객체 탐지기.

    감지 대상 클래스 중 신뢰도가 가장 높은 객체 하나의 중심 좌표를 반환한다.
    """

    def __init__(
        self,
        model_path: str = "yolov8n.pt",
        target_class: int = 0,       # 0 = person (COCO 기준)
        conf_threshold: float = 0.5,
    ):
        """
        Args:
            model_path:      YOLO 모델 경로 (.pt 또는 .onnx)
            target_class:    탐지할 클래스 ID (COCO 기준 0 = person)
            conf_threshold:  이 값 미만의 탐지는 무시
        """
        from ultralytics import YOLO
        self.model = YOLO(model_path)
        self.target_class = target_class
        self.conf_threshold = conf_threshold
        logger.info(f"YOLO 모델 로드 완료: {model_path} (class={target_class}, conf≥{conf_threshold})")

    def detect(self, frame_bgr: np.ndarray) -> tuple[float, float] | None:
        """BGR 프레임에서 대상 객체를 탐지해 중심 좌표를 반환한다.

        여러 객체가 감지된 경우 신뢰도가 가장 높은 것을 선택한다.

        Args:
            frame_bgr: OpenCV BGR 포맷 프레임

        Returns:
            (obj_x, obj_y) — 감지된 객체 중심 좌표 (픽셀)
            None           — 대상 객체 미감지
        """
        results = self.model(frame_bgr, verbose=False)

        best_conf = -1.0
        best_center = None

        for box in results[0].boxes:
            cls  = int(box.cls[0])
            conf = float(box.conf[0])

            if cls != self.target_class or conf < self.conf_threshold:
                continue

            if conf > best_conf:
                best_conf = conf
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                best_center = ((x1 + x2) / 2.0, (y1 + y2) / 2.0)

        if best_center:
            logger.debug(f"탐지 성공 — 중심: {best_center}, conf: {best_conf:.2f}")
        else:
            logger.debug("탐지 결과 없음")

        return best_center
