import json
import asyncio
import websockets
from modules.logger import get_logger
from modules.correction_module import CorrectionCalculator
from modules import yolo_bridge
from modules.config import RPI_WS_URL, WS_PORT, FRAME_WIDTH, FRAME_HEIGHT

# ==========================================
# 로거
# ==========================================
logger = get_logger("spotlight_core")

# ==========================================
# 전역 변수 (main()에서 초기화)
# ==========================================
output_frame = None              # RPi에서 수신한 최신 프레임
lock: asyncio.Lock = None        # output_frame 동시 접근 방지
pi_outbound_queue: asyncio.Queue = None      # PC → RPi 전송 대기열
pi_to_desktop_queue: asyncio.Queue = None    # RPi → Electron 메시지 전달 대기열
motor_corrected_event: asyncio.Event = None  # RPi 보정 완료 신호
tracking_state = "off"           # 추적 기능 활성화 상태 (Electron 앱에서 설정)
_correction_in_progress = False  # 보정 중 중복 요청 방지 플래그

correction_calc: CorrectionCalculator = None  # 보정값 계산기

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
    """YOLO 측에서 객체를 감지했을 때 yolo_bridge를 통해 호출된다.

    1. CorrectionCalculator로 pan/tilt 보정값 계산
    2. 보정이 필요하면 RPi로 전송
    3. RPi의 motor_corrected 응답을 대기 (최대 1초)
    4. 응답 수신 후 루프는 다음 프레임 탐지 시 자동 반복

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
        logger.debug(f"객체 좌표 수신 — obj_x: {obj_x:.1f}, obj_y: {obj_y:.1f} (중심: {correction_calc.center_x}, {correction_calc.center_y})")
        correction = correction_calc.calc(obj_x, obj_y)
        if correction is None:
            logger.debug(f"보정 불필요 — 객체가 중앙 근처 (obj_x={obj_x:.1f}, obj_y={obj_y:.1f})")
            return

        pan, tilt = correction
        logger.info(f"보정값 계산 — pan: {pan:.2f}, tilt: {tilt:.2f} | dx: {obj_x - correction_calc.center_x:.1f}, dy: {obj_y - correction_calc.center_y:.1f}")

        motor_corrected_event.clear()
        await send_to_pi({
            "tracking": "on",
            "control": {"pan": -pan, "tilt": tilt},
            "status": "tracking",
        })

        try:
            await asyncio.wait_for(motor_corrected_event.wait(), timeout=3.0)
            logger.debug("모터 보정 완료 확인")
        except asyncio.TimeoutError:
            logger.warning("모터 보정 완료 응답 타임아웃 — 다음 프레임에서 재시도")
    finally:
        _correction_in_progress = False

# ==========================================
# 1. RPi 통신
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

async def receive_from_pi():
    """RPi에 접속해 영상을 수신하고, 제어 명령을 역방향으로 송신하는 메인 루프.
    연결이 끊기면 3초 후 자동 재접속.
    """
    global output_frame
    frame_count = 0

    while True:
        try:
            logger.info(f"RPi({RPI_WS_URL}) 연결 시도 중...")
            async with websockets.connect(RPI_WS_URL, ping_interval=None) as websocket:
                logger.info("RPi 연결 성공")
                frame_count = 0

                sender = asyncio.create_task(pi_sender_task(websocket))

                try:
                    async for message in websocket:
                        if isinstance(message, bytes):
                            # 프레임 저장
                            async with lock:
                                output_frame = message
                            frame_count += 1
                            if frame_count % 100 == 0:
                                logger.debug(f"RPi 프레임 수신: {frame_count}장")
                        else:
                            # RPi → Electron 메시지 처리 (예: motor_corrected)
                            try:
                                data = json.loads(message)
                                if data.get("type") == "motor_corrected":
                                    motor_corrected_event.set()
                                await pi_to_desktop_queue.put(data)
                                logger.debug(f"RPi → Desktop 중계: {data}")
                            except json.JSONDecodeError:
                                pass
                finally:
                    logger.warning(f"RPi 연결 끊김 (수신 프레임: {frame_count}장)")
                    sender.cancel()
                    while not pi_outbound_queue.empty():
                        pi_outbound_queue.get_nowait()

        except Exception as e:
            logger.error(f"RPi 연결 오류: {e} — 3초 후 재접속 시도")
            await asyncio.sleep(3)

# ==========================================
# 2. Electron 앱 통신
# ==========================================
async def desktop_sender_task(websocket):
    """새 프레임이 있을 때만 Electron 앱으로 전송 (60fps 폴링).
    RPi에서 오는 제어 응답(motor_corrected 등)도 함께 전달한다.
    """
    last_frame = None
    try:
        while True:
            # RPi → Electron 메시지 전달 (큐에 쌓인 것 모두 소진)
            while not pi_to_desktop_queue.empty():
                data = pi_to_desktop_queue.get_nowait()
                await websocket.send(json.dumps(data))

            # 비디오 프레임 전송
            async with lock:
                current_frame = output_frame

            if current_frame is not None and current_frame is not last_frame:
                await websocket.send(current_frame)
                last_frame = current_frame

            await asyncio.sleep(0.016)  # 60fps
    except websockets.exceptions.ConnectionClosed:
        pass

async def ws_handler(websocket):
    """Electron 앱 접속 시 호출. 영상 송신과 제어 수신을 동시 처리."""
    global tracking_state
    logger.info("Desktop App 연결됨")
    sender = asyncio.create_task(desktop_sender_task(websocket))

    try:
        async for message in websocket:
            try:
                data = json.loads(message)

                if "tracking" in data:
                    tracking_state = data["tracking"]
                    status = "searching" if tracking_state == "on" else "lost"
                    await send_to_pi({"tracking": tracking_state, "status": status})
                    logger.debug(f"추적 상태 변경: {tracking_state}")

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
        sender.cancel()

async def start_desktop_server():
    """Electron 앱의 접속을 대기하는 WebSocket 서버."""
    logger.info(f"Desktop App WebSocket 서버 시작: ws://0.0.0.0:{WS_PORT}")
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        await asyncio.Future()

# ==========================================
# 진입점
# ==========================================
async def main():
    global lock, pi_outbound_queue, pi_to_desktop_queue
    global motor_corrected_event, correction_calc

    lock = asyncio.Lock()
    pi_outbound_queue = asyncio.Queue()
    pi_to_desktop_queue = asyncio.Queue()
    motor_corrected_event = asyncio.Event()
    correction_calc = CorrectionCalculator(FRAME_WIDTH, FRAME_HEIGHT)
    yolo_bridge.register(process_object_detected, asyncio.get_event_loop())

    receiver_task = asyncio.create_task(receive_from_pi())
    server_task   = asyncio.create_task(start_desktop_server())
    await asyncio.gather(receiver_task, server_task)

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("서버 종료")
