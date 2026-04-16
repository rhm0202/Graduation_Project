import json
import asyncio
import websockets
import base64
import logging
import os
from logging.handlers import RotatingFileHandler

# ==========================================
# 설정
# ==========================================
RPI_WS_URL = "ws://192.168.137.59:8000"  # RPi WebSocket 주소 (Wi-Fi)
WS_PORT = 8765                           # Electron 앱과 통신할 포트

# ==========================================
# 로거
# ==========================================
os.makedirs("logs", exist_ok=True)

logger = logging.getLogger("spotlight_core")
logger.setLevel(logging.DEBUG)

_formatter = logging.Formatter("[%(asctime)s] %(levelname)s - %(message)s", datefmt="%Y-%m-%d %H:%M:%S")

# 파일: logs/spotlight_core.log (1MB 초과 시 교체, 최대 3개 보관)
_file_handler = RotatingFileHandler("logs/spotlight_core.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
_file_handler.setFormatter(_formatter)

# 콘솔 동시 출력
_console_handler = logging.StreamHandler()
_console_handler.setFormatter(_formatter)

logger.addHandler(_file_handler)
logger.addHandler(_console_handler)

# ==========================================
# 전역 변수 (main()에서 초기화)
# ==========================================
output_frame = None          # RPi에서 수신한 최신 프레임
lock: asyncio.Lock = None    # output_frame 동시 접근 방지
frame_event: asyncio.Event = None        # 새 프레임 도착 알림
pi_outbound_queue: asyncio.Queue = None  # PC → RPi 전송 대기열
pi_to_desktop_queue: asyncio.Queue = None  # RPi → Electron 메시지 전달 대기열
tracking_state = "off"       # 추적 기능 활성화 상태 (Electron 앱에서 설정)

# ==========================================
# 공용 API
# ==========================================
async def send_to_pi(data_dict):
    """PC → RPi로 데이터를 보낼 때 호출. 전송 대기열에 추가됨.
    예: await send_to_pi({"control": {"pan": 45, "tilt": -10}})
    """
    await pi_outbound_queue.put(data_dict)

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

                # 제어 명령 송신 태스크를 백그라운드에서 병렬 실행
                sender = asyncio.create_task(pi_sender_task(websocket))

                try:
                    async for message in websocket:
                        if isinstance(message, bytes):
                            # RPi JPEG을 재인코딩 없이 바로 저장
                            # TODO: YOLO 처리 시 아래 주석 해제 후 cv2.imdecode → 처리 → cv2.imencode 추가
                            # await send_to_pi({
                            #     "tracking": tracking_state,
                            #     "control": {"pan": <보정값>, "tilt": <보정값>},
                            #     "status": "tracking" | "lost" | "searching"
                            # })
                            async with lock:
                                output_frame = message
                            frame_event.set()  # 새 프레임 도착 알림
                            frame_count += 1
                            if frame_count % 100 == 0:
                                logger.debug(f"RPi 프레임 수신: {frame_count}장")
                        else:
                            # RPi → Electron 메시지 전달 (예: motor_corrected)
                            try:
                                data = json.loads(message)
                                await pi_to_desktop_queue.put(data)
                                logger.debug(f"RPi → Desktop 중계: {data}")
                            except json.JSONDecodeError:
                                pass
                finally:
                    logger.warning(f"RPi 연결 끊김 (수신 프레임: {frame_count}장)")
                    sender.cancel()
                    # 재연결 시 오래된 명령이 전송되지 않도록 큐 비우기
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
                message = {
                    "type": "video_frame",
                    "frame": base64.b64encode(current_frame).decode('utf-8')
                }
                await websocket.send(json.dumps(message))
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
                else:
                    await send_to_pi(data)
                    logger.debug(f"Desktop App → RPi 중계: {data}")

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
    global lock, frame_event, pi_outbound_queue, pi_to_desktop_queue
    lock = asyncio.Lock()
    frame_event = asyncio.Event()
    pi_outbound_queue = asyncio.Queue()
    pi_to_desktop_queue = asyncio.Queue()

    receiver_task = asyncio.create_task(receive_from_pi())
    server_task = asyncio.create_task(start_desktop_server())
    await asyncio.gather(receiver_task, server_task)

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("서버 종료")
