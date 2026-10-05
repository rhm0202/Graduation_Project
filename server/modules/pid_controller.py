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
        └─ Tilt PID → EMA → tilt_angle (20~160°)
        │
        ▼
    [RPi servo_drive.py] → PCA9685 PWM 출력
"""

from __future__ import annotations

import time
import collections
import math
from modules.config import PAN_LIMITS, TILT_LIMITS
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
        self._last_error: float | None = None
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
        # 초기화 직후에는 이전 오차가 없으므로 0. 0을 이전 오차로 쓰면
        # error/0.01 의 미분 킥이 나와 첫 명령이 출력 한계까지 튄다.
        if self._last_error is None:
            derivative = 0.0
        else:
            derivative = (error - self._last_error) / dt

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
        self._last_error = None
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
        switch_max_speed: 대상 전환 직후 최대 회전 속도 (°/s, None 이면 제한 없음)
        switch_ramp_s: 전환 직후 0 → switch_max_speed 까지 가속하는 시간 (초)
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
        x_dead_zone: float = 200.0,
        y_dead_zone: float = 100.0,
        y_dead_zone_bottom: float | None = None,
        switch_max_speed: float | None = None,
        switch_ramp_s: float = 0.6,
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
        # 틸트는 위(y_dead_zone)와 아래(y_dead_zone_bottom)를 따로 둔다.
        self.x_dead_zone = x_dead_zone
        self.y_dead_zone = y_dead_zone
        self.y_dead_zone_bottom = y_dead_zone if y_dead_zone_bottom is None else y_dead_zone_bottom
        self.center_x = center_x
        self.center_y = center_y

        # 대상 전환 모드: begin_transition() 부터 대상이 데드존에 들어올 때까지
        # 회전 속도를 0 에서 switch_max_speed 까지 천천히 올린다.
        self.switch_max_speed = switch_max_speed
        self.switch_ramp_s = switch_ramp_s
        self._transition_start: float | None = None
        self._last_command_time: float | None = None

        logger.info(
            f"PID 매니저 초기화 — setpoint=({center_x}, {center_y}), "
            f"Kp={pid_kp}, Ki={pid_ki}, Kd={pid_kd}, "
            f"output_limit=±{output_limit}°, EMA α={ema_alpha}, x_dead_zone={x_dead_zone}px, "
            f"y_dead_zone=-{self.y_dead_zone}/+{self.y_dead_zone_bottom}px"
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
        dy = obj_y - self.center_y  # 화면 y는 아래로 증가: 양수면 중심보다 아래
        y_limit = self.y_dead_zone_bottom if dy > 0 else self.y_dead_zone
        in_dead_x = dx < self.x_dead_zone
        in_dead_y = abs(dy) < y_limit
        if in_dead_x:
            pan_correction = 0.0
            self.pan_pid._integral = 0.0
        if in_dead_y:
            tilt_correction = 0.0
            self.tilt_pid._integral = 0.0

        # 목표 각도 산출 (서보 장착 방향에 따라 부호 조정)
        raw_pan = self.pan_angle + pan_correction
        raw_tilt = self.tilt_angle - tilt_correction

        # 서보 물리적 한계 적용 (0~180°)
        raw_pan = max(PAN_LIMITS[0], min(PAN_LIMITS[1], raw_pan))
        raw_tilt = max(TILT_LIMITS[0], min(TILT_LIMITS[1], raw_tilt))

        # EMA 평활화
        # 초기화 직후(히스토리 없음)에도 현재 자세를 기준으로 평활화한다.
        # raw 를 그대로 쓰면 첫 명령이 PID 1회 출력 한계만큼 한 번에 튄다.
        prev_pan = self.pan_history[-1] if self.pan_history else self.pan_angle
        prev_tilt = self.tilt_history[-1] if self.tilt_history else self.tilt_angle
        smooth_pan = (self.alpha * raw_pan) + ((1 - self.alpha) * prev_pan)
        smooth_tilt = (self.alpha * raw_tilt) + ((1 - self.alpha) * prev_tilt)

        # 대상 전환 모드: 속도 상한을 0 에서부터 천천히 올린다.
        # 출력이 포화되는 큰 오차에서는 평소 속도가 영상 지연보다 빨라
        # 데드존을 지나쳐 되돌아오며 흔들린다. 데드존에 들어오면 해제한다.
        now = time.monotonic()
        if self._transition_start is not None:
            if in_dead_x and in_dead_y:
                self._transition_start = None
            else:
                elapsed = now - self._transition_start
                ramp = min(1.0, elapsed / self.switch_ramp_s) if self.switch_ramp_s > 0 else 1.0
                dt = 0.0 if self._last_command_time is None else min(0.1, now - self._last_command_time)
                max_step = self.switch_max_speed * ramp * dt
                smooth_pan = self.pan_angle + max(-max_step, min(max_step, smooth_pan - self.pan_angle))
                smooth_tilt = self.tilt_angle + max(-max_step, min(max_step, smooth_tilt - self.tilt_angle))
        self._last_command_time = now

        self.pan_history.append(smooth_pan)
        self.tilt_history.append(smooth_tilt)

        # 현재 각도 업데이트
        self.pan_angle = smooth_pan
        self.tilt_angle = smooth_tilt

        return self.pan_angle, self.tilt_angle

    def sync_angles(self, pan_angle: float, tilt_angle: float):
        """Rebase on the Pi's last successful PWM output (not encoder feedback)."""
        if not math.isfinite(pan_angle) or not math.isfinite(tilt_angle):
            raise ValueError("Motor angles must be finite")
        self.pan_angle = max(PAN_LIMITS[0], min(PAN_LIMITS[1], pan_angle))
        self.tilt_angle = max(TILT_LIMITS[0], min(TILT_LIMITS[1], tilt_angle))
        if self.pan_history:
            self.pan_history[-1] = self.pan_angle
            self.tilt_history[-1] = self.tilt_angle

    def reset(self):
        """Clear PID/EMA history while preserving the synchronized camera pose."""
        self.pan_pid.reset()
        self.tilt_pid.reset()
        self.pan_history.clear()
        self.tilt_history.clear()
        self._transition_start = None
        self._last_command_time = None

    def begin_transition(self):
        """새 대상 선택·재포착: 상태를 비우고 전환 모드로 천천히 출발한다."""
        self.reset()
        if self.switch_max_speed:
            self._transition_start = time.monotonic()
