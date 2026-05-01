"""
pid_controller.py
─────────────────
PID 컨트롤러 기반 팬/틸트 모터 제어 모듈.

기존 CorrectionCalculator(단순 게인 × 오프셋)를 대체하여
PID 제어 + EMA 평활화를 적용한 정밀 추적을 수행한다.

아키텍처:
    [Electron] obj_x, obj_y
        │
        ▼
    [MotorPIDManager.update()]
        ├─ Pan PID  → EMA → pan_angle  (0~180°)
        └─ Tilt PID → EMA → tilt_angle (0~180°)
        │
        ▼
    [RPi servo_drive.py] → PCA9685 PWM 출력
"""

from __future__ import annotations

import time
import collections
from modules.logger import get_logger

logger = get_logger("pid_controller")


class PIDController:
    """비례-적분-미분(PID) 컨트롤러.

    simple_pid 라이브러리의 핵심 로직을 내장하여 외부 의존성을 제거했다.

    Args:
        Kp: 비례 게인
        Ki: 적분 게인
        Kd: 미분 게인
        setpoint: 목표값 (프레임 중심 좌표)
        output_limits: (min, max) 한 번의 연산에서 출력할 수 있는 최대 보정값
    """

    def __init__(
        self,
        Kp: float = 0.08,
        Ki: float = 0.0005,
        Kd: float = 0.03,
        setpoint: float = 0.0,
        output_limits: tuple[float, float] = (-5.0, 5.0),
    ):
        self.Kp = Kp
        self.Ki = Ki
        self.Kd = Kd
        self.setpoint = setpoint
        self.output_limits = output_limits

        self._integral = 0.0
        self._last_error = 0.0
        self._last_time: float | None = None

    def __call__(self, current_value: float) -> float:
        """PID 연산을 수행하고 보정값을 반환한다.

        Args:
            current_value: 현재 측정값 (객체의 x 또는 y 좌표)

        Returns:
            보정해야 할 각도 (output_limits 범위 내)
        """
        now = time.monotonic()
        error = self.setpoint - current_value

        if self._last_time is None:
            dt = 0.01  # 최초 호출 시 기본 dt
        else:
            dt = now - self._last_time
            if dt <= 0:
                dt = 0.01

        # 적분 (누적 오차)
        self._integral += error * dt

        # 미분 (오차 변화율)
        derivative = (error - self._last_error) / dt if dt > 0 else 0.0

        # PID 출력
        output = (self.Kp * error) + (self.Ki * self._integral) + (self.Kd * derivative)

        # 출력 제한
        min_out, max_out = self.output_limits
        output = max(min_out, min(max_out, output))

        # Anti-windup: 출력이 포화되면 적분 누적 정지
        if output == min_out or output == max_out:
            self._integral -= error * dt

        self._last_error = error
        self._last_time = now
        return output

    def reset(self):
        """PID 내부 상태를 초기화한다."""
        self._integral = 0.0
        self._last_error = 0.0
        self._last_time = None


class MotorPIDManager:
    """팬(Pan) & 틸트(Tilt) 두 축의 PID 제어 + EMA 평활화를 통합 관리.

    spotlight_core.py에서 객체 좌표를 수신할 때마다 update()를 호출하면
    평활화된 서보 목표 각도 (0~180°)를 반환한다.

    Args:
        frame_width:  카메라 프레임 가로 해상도 (픽셀)
        frame_height: 카메라 프레임 세로 해상도 (픽셀)
        pid_kp: PID 비례 게인
        pid_ki: PID 적분 게인
        pid_kd: PID 미분 게인
        output_limit: PID 1회 출력 최대 각도 변화
        ema_alpha: EMA 스무딩 팩터 (0 < alpha ≤ 1, 낮을수록 부드러움)
        ema_history_len: EMA 히스토리 큐 길이
    """

    def __init__(
        self,
        frame_width: int = 1280,
        frame_height: int = 720,
        pid_kp: float = 0.08,
        pid_ki: float = 0.0005,
        pid_kd: float = 0.03,
        output_limit: float = 10.0,
        ema_alpha: float = 0.2,
        ema_history_len: int = 5,
        dead_zone: float = 80.0,
    ):
        center_x = frame_width / 2.0
        center_y = frame_height / 2.0

        self.pan_pid = PIDController(
            Kp=pid_kp, Ki=pid_ki, Kd=pid_kd,
            setpoint=center_x,
            output_limits=(-output_limit, output_limit),
        )
        self.tilt_pid = PIDController(
            Kp=pid_kp, Ki=pid_ki, Kd=pid_kd,
            setpoint=center_y,
            output_limits=(-output_limit, output_limit),
        )

        self.alpha = ema_alpha
        self.pan_history: collections.deque = collections.deque(maxlen=ema_history_len)
        self.tilt_history: collections.deque = collections.deque(maxlen=ema_history_len)

        # 서보 초기 위치: 정중앙 (90°)
        self.pan_angle = 90.0
        self.tilt_angle = 90.0

        # 데드존: 객체가 중심에서 이 픽셀 범위 안에 있으면 보정하지 않음
        self.dead_zone = dead_zone
        self.center_x = center_x
        self.center_y = center_y

        logger.info(
            f"PID 매니저 초기화 — setpoint=({center_x}, {center_y}), "
            f"Kp={pid_kp}, Ki={pid_ki}, Kd={pid_kd}, "
            f"output_limit=±{output_limit}°, EMA α={ema_alpha}, dead_zone={dead_zone}px"
        )

    def update(self, obj_x: float, obj_y: float) -> tuple[float, float]:
        """객체 좌표를 받아 PID 연산 + EMA 평활화를 수행한다.

        Args:
            obj_x: 감지된 객체 중심의 x 좌표 (픽셀)
            obj_y: 감지된 객체 중심의 y 좌표 (픽셀)

        Returns:
            (pan_angle, tilt_angle) — 서보 목표 각도 (0~180°)
        """
        # PID 연산: 프레임 중심으로부터 얼마나 보정해야 하는지 계산
        pan_correction = self.pan_pid(obj_x)
        tilt_correction = self.tilt_pid(obj_y)

        # 데드존: 객체가 중앙 근처에 있으면 보정 무시 + 적분 리셋
        dx = abs(obj_x - self.center_x)
        dy = abs(obj_y - self.center_y)
        if dx < self.dead_zone:
            pan_correction = 0.0
            self.pan_pid._integral = 0.0
        if dy < self.dead_zone:
            tilt_correction = 0.0
            self.tilt_pid._integral = 0.0

        # 목표 각도 산출 (서보 장착 방향에 따라 부호 조정)
        raw_pan = self.pan_angle - pan_correction
        raw_tilt = self.tilt_angle - tilt_correction

        # 서보 물리적 한계 적용 (0~180°)
        raw_pan = max(0.0, min(180.0, raw_pan))
        raw_tilt = max(0.0, min(180.0, raw_tilt))

        # EMA 평활화
        if not self.pan_history:
            smooth_pan, smooth_tilt = raw_pan, raw_tilt
        else:
            smooth_pan = (self.alpha * raw_pan) + ((1 - self.alpha) * self.pan_history[-1])
            smooth_tilt = (self.alpha * raw_tilt) + ((1 - self.alpha) * self.tilt_history[-1])

        self.pan_history.append(smooth_pan)
        self.tilt_history.append(smooth_tilt)

        # 현재 각도 업데이트
        self.pan_angle = smooth_pan
        self.tilt_angle = smooth_tilt

        return self.pan_angle, self.tilt_angle

    def reset(self):
        """추적 대상이 바뀌거나 잃어버렸을 때 전체 상태를 초기화한다."""
        self.pan_pid.reset()
        self.tilt_pid.reset()
        self.pan_history.clear()
        self.tilt_history.clear()
        self.pan_angle = 90.0
        self.tilt_angle = 90.0
        logger.info("PID 매니저 리셋 — 서보 중앙(90°)으로 복귀")
