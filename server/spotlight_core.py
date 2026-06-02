import json
import asyncio
import websockets
from modules.logger import get_logger
from modules.pid_controller import MotorPIDManager
from modules.config import (
    RPI_WS_URL, WS_PORT, FRAME_WIDTH, FRAME_HEIGHT,
    PID_KP, PID_KI, PID_KD, PID_OUTPUT_LIMIT, EMA_ALPHA,
)

# ==========================================
# 로거
# ==========================================
logger = get_logger("spotlight_core")

# ==========================================
# 전역 변수 (main()에서 초기화)
# ==========================================
pi_outbound_queue: asyncio.Queue = None  # PC → RPi 전송 대기열
tracking_state = "off"                   # 추적 기능 활성화 상태 (Electron 앱에서 설정)
_correction_in_progress = False          # 보정 중 중복 요청 방지 플래그

pid_manager: MotorPIDManager = None      # PID 기반 모터 제어 매니저


# ==========================================
# 공용 API
# ==========================================
async def send_to_pi(data_dict):
    """PC → RPi로 데이터를 보낼 때 호출. 전송 대기열에 추가됨."""
    await pi_outbound_queue.put(data_dict)


# ==========================================
# 객체 추적 보정 로직
# ==========================================
async def process_object_detected(obj_x: float, obj_y: float):
    """Electron에서 object_detected 메시지 수신 시 호출된다.

    1. MotorPIDManager로 PID 연산 + EMA 평활화 수행
    2. 산출된 절대 서보 각도(pan_angle, tilt_angle)를 RPi에 전송
    3. RPi는 수신한 각도를 PCA9685 PWM으로 즉시 반영 (응답 대기 없음)

    Args:
        obj_x: 감지된 객체 중심의 x 좌표 (픽셀)
        obj_y: 감지된 객체 중심의 y 좌표 (픽셀)
    """
    global _correction_in_progress

    if tracking_state != "on":
        return
    if _correction_in_progress:
        return

    _correction_in_progress = True
    try:
        # PID 연산 + EMA 평활화 → 절대 서보 각도 반환
        pan_angle, tilt_angle = pid_manager.update(obj_x, obj_y)

        logger.debug(
            f"PID 연산 — obj({obj_x:.1f}, {obj_y:.1f}) → servo(pan={pan_angle:.2f}°, tilt={tilt_angle:.2f}°)"
        )

        # RPi에 절대 서보 각도 전송 (비동기 일방향, 응답 대기 없음)
        await send_to_pi({
            "type": "servo_angle",
            "pan_angle": round(pan_angle, 2),
            "tilt_angle": round(tilt_angle, 2),
        })
    finally:
        _correction_in_progress = False


# ==========================================
# 1. RPi 통신 (서보 제어 명령 전송 전용)
# ==========================================
async def pi_sender_task(websocket):
    """전송 대기열(pi_outbound_queue)에서 꺼내 RPi로 전송하는 루프."""
    while True:
        data = await pi_outbound_queue.get()
        try:
            await websocket.send(json.dumps(data))
            logger.debug(f"RPi 전송: {data}")
        except Exception as e:
            logger.error(f"RPi 전송 실패: {e}")


async def connect_to_pi():
    """RPi에 접속해 제어 명령을 송신하는 메인 루프.
    영상 수신은 MediaMTX WebRTC(WHEP)로 전환되어 이 함수에서 담당하지 않음.
    연결이 끊기면 3초 후 자동 재접속.
    """
    while True:
        try:
            logger.info(f"RPi({RPI_WS_URL}) 연결 시도 중...")
            async with websockets.connect(RPI_WS_URL, ping_interval=None) as websocket:
                logger.info("RPi 연결 성공")

                sender = asyncio.create_task(pi_sender_task(websocket))

                try:
                    # RPi에서 오는 메시지(서보 상태 등)만 처리 — 영상 프레임 없음
                    async for message in websocket:
                        if isinstance(message, bytes):
                            # 이전 방식의 영상 프레임은 무시
                            pass
                        else:
                            try:
                                data = json.loads(message)
                                logger.debug(f"RPi → Core 수신: {data}")
                            except json.JSONDecodeError:
                                pass
                finally:
                    logger.warning("RPi 연결 끊김")
                    sender.cancel()
                    while not pi_outbound_queue.empty():
                        pi_outbound_queue.get_nowait()

        except Exception as e:
            logger.error(f"RPi 연결 오류: {e} — 3초 후 재접속 시도")
            await asyncio.sleep(3)


# ==========================================
# 2. Electron 앱 통신
# ==========================================
async def ws_handler(websocket):
    """Electron 앱 접속 시 호출. 제어 명령 수신 처리."""
    global tracking_state
    logger.info("Desktop App 연결됨")

    try:
        async for message in websocket:
            try:
                data = json.loads(message)

                if "tracking" in data:
                    tracking_state = data["tracking"]
                    if tracking_state == "on":
                        pid_manager.reset()
                    status = "searching" if tracking_state == "on" else "lost"
                    await send_to_pi({"tracking": tracking_state, "status": status})
                    logger.debug(f"추적 상태 변경: {tracking_state}")

                elif data.get("type") == "servo_init":
                    pid_manager.reset()
                    await send_to_pi({"type": "servo_angle", "pan_angle": 90.0, "tilt_angle": 90.0})
                    logger.debug("서보 초기화 — pan=90°, tilt=90°")

                elif data.get("type") == "object_detected":
                    obj_x = float(data["obj_x"])
                    obj_y = float(data["obj_y"])
                    asyncio.ensure_future(process_object_detected(obj_x, obj_y))

            except json.JSONDecodeError:
                pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        logger.info("Desktop App 연결 해제됨")


async def start_desktop_server():
    """Electron 앱의 접속을 대기하는 WebSocket 서버."""
    logger.info(f"Desktop App WebSocket 서버 시작: ws://0.0.0.0:{WS_PORT}")
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        await asyncio.Future()


# ==========================================
# 진입점
# ==========================================
async def main():
    global pi_outbound_queue
    global pid_manager

    pi_outbound_queue = asyncio.Queue()
    pid_manager = MotorPIDManager(
        frame_width=FRAME_WIDTH,
        frame_height=FRAME_HEIGHT,
        pid_kp=PID_KP,
        pid_ki=PID_KI,
        pid_kd=PID_KD,
        output_limit=PID_OUTPUT_LIMIT,
        ema_alpha=EMA_ALPHA,
    )
    pi_task     = asyncio.create_task(connect_to_pi())
    server_task = asyncio.create_task(start_desktop_server())
    await asyncio.gather(pi_task, server_task)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("서버 종료")
