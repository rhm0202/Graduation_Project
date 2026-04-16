"""
correction_module.py
────────────────────
객체 좌표를 받아 카메라 pan/tilt 보정값을 계산하는 모듈.

YOLO(또는 다른 탐지기)가 감지한 객체의 프레임 내 중심 좌표(obj_x, obj_y)를
입력받아, 프레임 중심 대비 오프셋을 보정 각도로 변환한다.

사용 예:
    calc = CorrectionCalculator(frame_width=1920, frame_height=1080)

    # YOLO에서 객체 중심 좌표를 받았다고 가정
    result = calc.calc(obj_x=1100, obj_y=600)
    if result:
        pan, tilt = result  # RPi로 전송할 보정값
"""


class CorrectionCalculator:
    """프레임 내 객체 위치 → pan/tilt 보정값 변환기.

    보정값 부호 규칙:
        pan  > 0 : 객체가 오른쪽 → 카메라를 오른쪽으로 이동
        pan  < 0 : 객체가 왼쪽  → 카메라를 왼쪽으로 이동
        tilt > 0 : 객체가 아래  → 카메라를 아래쪽으로 이동
        tilt < 0 : 객체가 위    → 카메라를 위쪽으로 이동
    """

    def __init__(
        self,
        frame_width: int,
        frame_height: int,
        threshold: float = 30.0,
        gain: float = 0.05,
    ):
        """
        Args:
            frame_width:  카메라 프레임 가로 해상도 (픽셀)
            frame_height: 카메라 프레임 세로 해상도 (픽셀)
            threshold:    보정을 무시할 최소 오프셋 (픽셀).
                          abs(dx) < threshold 이고 abs(dy) < threshold 이면 None 반환.
            gain:         픽셀 오프셋 → 각도 변환 비율 (degree/pixel).
                          예: 오프셋 100px → gain 0.05 → 5° 이동
        """
        self.cx = frame_width / 2.0
        self.cy = frame_height / 2.0
        self.threshold = threshold
        self.gain = gain

    def calc(self, obj_x: float, obj_y: float) -> tuple[float, float] | None:
        """객체 중심 좌표를 받아 pan/tilt 보정값을 반환한다.

        Args:
            obj_x: 감지된 객체 중심의 x 좌표 (픽셀, 프레임 좌측 상단 기준)
            obj_y: 감지된 객체 중심의 y 좌표 (픽셀, 프레임 좌측 상단 기준)

        Returns:
            (pan_correction, tilt_correction) — 보정이 필요한 경우
            None                              — 오프셋이 threshold 미만 (보정 불필요)
        """
        dx = obj_x - self.cx  # 양수 = 오른쪽, 음수 = 왼쪽
        dy = obj_y - self.cy  # 양수 = 아래,   음수 = 위

        if abs(dx) < self.threshold and abs(dy) < self.threshold:
            return None

        pan_correction  = dx * self.gain
        tilt_correction = dy * self.gain
        return pan_correction, tilt_correction
