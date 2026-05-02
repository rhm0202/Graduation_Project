"""
servo_drive.py — 라즈베리파이 전용 서보 구동 스크립트
═══════════════════════════════════════════════════════

이 파일은 라즈베리파이에서 실행되며, PCA9685 PWM 드라이버를 통해
서보모터를 직접 제어합니다.

PC(spotlight_core.py)로부터 WebSocket을 통해 서보 목표 각도
{ type: "servo_angle", pan_angle: float, tilt_angle: float }
를 수신하고, PCA9685에 PWM 신호를 출력합니다.

사용법 (라즈베리파이에서):
    pip install adafruit-circuitpython-pca9685 websockets
    python servo_drive.py

필요 하드웨어:
    - PCA9685 PWM 드라이버 (I2C 주소: 0x40)
    - 서보모터 2개 (채널 0: Pan, 채널 1: Tilt)
"""

import json
import asyncio
import time

# ═══════════════════════════════════════════════════════════
# 설정
# ═══════════════════════════════════════════════════════════

# PC(spotlight_core.py)의 RPi용 WebSocket 서버 주소
# spotlight_core가 RPi에 접속하는 것이 아니라,
# 이 스크립트가 PC에 접속하거나, 기존 RPi WebSocket 서버에 통합됩니다.
PC_WS_URL = "ws://0.0.0.0:8000"  # RPi에서 서버로 대기 (기존 RPi 서버와 같은 포트)

# PCA9685 I2C 주소
PCA_ADDRESS = 0x40

# 서보 채널
PAN_CHANNEL = 0
TILT_CHANNEL = 1

# 서보 PWM 주파수
SERVO_FREQUENCY = 50  # Hz (아날로그 서보 표준)

# 서보 갱신 주기
SERVO_UPDATE_INTERVAL = 0.02  # 20ms (50Hz PWM 주기에 맞춤)


# ═══════════════════════════════════════════════════════════
# PCA9685 서보 드라이버
# ═══════════════════════════════════════════════════════════

class ServoDriver:
    """PCA9685를 통해 서보모터를 제어하는 드라이버.

    I2C 통신으로 PCA9685에 PWM 듀티 사이클을 설정하여
    서보를 원하는 각도로 이동시킵니다.
    """

    def __init__(self, address=PCA_ADDRESS, frequency=SERVO_FREQUENCY):
        """PCA9685를 초기화합니다.

        Args:
            address: PCA9685 I2C 주소 (기본: 0x40)
            frequency: PWM 주파수 (기본: 50Hz)
        """
        import board
        import busio
        from adafruit_pca9685 import PCA9685

        self.i2c = busio.I2C(board.SCL, board.SDA)
        self.pca = PCA9685(self.i2c, address=address)
        self.pca.frequency = frequency
        print(f"[ServoDriver] PCA9685 초기화 완료 (주소: 0x{address:02X}, 주파수: {frequency}Hz)")

    def set_angle(self, channel: int, angle: float):
        """지정된 채널의 서보를 해당 각도로 이동시킵니다.

        0도~180도를 12비트(0~65535) 듀티 사이클로 변환합니다.

        Args:
            channel: PCA9685 채널 번호 (0~15)
            angle: 서보 목표 각도 (0~180)
        """
        angle = max(0.0, min(180.0, angle))

        # 서보 펄스 폭: 1ms(0°) ~ 2ms(180°) at 50Hz (20ms 주기)
        # 듀티 사이클: 1ms/20ms = 5% ~ 2ms/20ms = 10%
        # 16비트 해상도: 0.05 * 65535 ~ 0.10 * 65535
        min_pulse = int(0.05 * 65535)  # 약 3277 (1ms 펄스)
        max_pulse = int(0.10 * 65535)  # 약 6554 (2ms 펄스)
        pulse_range = max_pulse - min_pulse

        pulse = min_pulse + int((angle / 180.0) * pulse_range)
        self.pca.channels[channel].duty_cycle = pulse

    def center_all(self):
        """모든 서보를 중앙(90°)으로 이동시킵니다."""
        self.set_angle(PAN_CHANNEL, 90.0)
        self.set_angle(TILT_CHANNEL, 90.0)
        print("[ServoDriver] 모든 서보 중앙(90°) 위치로 이동")

    def cleanup(self):
        """PCA9685를 비활성화하고 I2C 연결을 해제합니다."""
        self.pca.deinit()
        self.i2c.deinit()
        print("[ServoDriver] PCA9685 해제 완료")


# ═══════════════════════════════════════════════════════════
# WebSocket 서버 + 서보 구동 루프
# ═══════════════════════════════════════════════════════════

# 전역 상태: PC에서 수신한 최신 목표 각도
current_pan_angle = 90.0
current_tilt_angle = 90.0
angle_updated = False


async def handle_pc_message(websocket):
    """PC(spotlight_core.py)에서 수신한 메시지를 처리합니다.

    servo_angle 타입의 메시지에서 pan_angle, tilt_angle을 추출하여
    전역 변수에 저장합니다.
    """
    global current_pan_angle, current_tilt_angle, angle_updated

    async for message in websocket:
        try:
            if isinstance(message, bytes):
                # 바이너리 메시지 (영상 프레임 등)는 무시
                continue

            data = json.loads(message)

            if data.get("type") == "servo_angle":
                current_pan_angle = float(data.get("pan_angle", current_pan_angle))
                current_tilt_angle = float(data.get("tilt_angle", current_tilt_angle))
                angle_updated = True

            # 기존 tracking 상태 메시지도 처리 (호환성)
            elif "tracking" in data:
                status = data.get("status", "")
                print(f"[WebSocket] 추적 상태: {data['tracking']}, 상태: {status}")

                # 기존 방식의 motor_control 메시지도 지원 (하위 호환)
                if "control" in data:
                    control = data["control"]
                    pan = float(control.get("pan", 0))
                    tilt = float(control.get("tilt", 0))
                    # 기존 방식: 델타값 → 현재 각도에 더함
                    current_pan_angle = max(0, min(180, current_pan_angle + pan))
                    current_tilt_angle = max(0, min(180, current_tilt_angle + tilt))
                    angle_updated = True

        except (json.JSONDecodeError, ValueError) as e:
            print(f"[WebSocket] 메시지 파싱 오류: {e}")


async def servo_loop(driver: ServoDriver):
    """서보 구동 루프.

    20ms(50Hz) 주기로 현재 목표 각도를 PCA9685에 반영합니다.
    """
    global angle_updated

    print("[Servo] 서보 구동 루프 시작 (50Hz)")

    while True:
        if angle_updated:
            driver.set_angle(PAN_CHANNEL, current_pan_angle)
            driver.set_angle(TILT_CHANNEL, current_tilt_angle)
            angle_updated = False

        await asyncio.sleep(SERVO_UPDATE_INTERVAL)


async def main():
    """메인 진입점.

    1. PCA9685 서보 드라이버 초기화
    2. WebSocket 서버 시작 (PC 연결 대기)
    3. 서보 구동 루프 시작
    """
    import websockets

    print("=" * 50)
    print("  서보 구동 서비스 (라즈베리파이)")
    print("=" * 50)

    # PCA9685 초기화
    driver = ServoDriver()
    driver.center_all()

    # 서보 구동 루프를 백그라운드 태스크로 실행
    servo_task = asyncio.create_task(servo_loop(driver))

    # WebSocket 서버 시작 — PC의 spotlight_core가 여기에 접속
    print(f"[WebSocket] 서버 시작: {PC_WS_URL}")

    async def ws_handler(websocket):
        print("[WebSocket] PC 연결됨")
        try:
            await handle_pc_message(websocket)
        except Exception as e:
            print(f"[WebSocket] 연결 오류: {e}")
        finally:
            print("[WebSocket] PC 연결 해제됨")

    try:
        async with websockets.serve(ws_handler, "0.0.0.0", 8000):
            await asyncio.Future()  # 무한 대기
    except KeyboardInterrupt:
        print("\n[System] 서보 구동 서비스 종료")
    finally:
        servo_task.cancel()
        driver.center_all()
        driver.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
