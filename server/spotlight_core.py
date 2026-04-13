import cv2
import json
import asyncio
import websockets
import base64
import numpy as np

# ==========================================
# 0. 설정 (Configuration) 및 전역 변수
# ==========================================
# 라즈베리파이 쪽 웹소켓 주소 (실제 USB-C 네트워크 환경에 맞춰 IP 변경 필요)
RPI_WS_URL = "ws://192.168.137.2:8000" 

# 데스크탑(Electron) 앱과 통신하기 위해 내 PC에서 열어둘 포트 번호
WS_PORT = 8765    

# 라즈베리파이에서 수신한 최신 카메라 1-Frame을 담아놓기 위한 전역 변수
# (수신 스레드와 송신 스레드가 동시에 이 변수에 접근하므로 동기화 관리가 필요함)
output_frame = None

# 두 비동기 작업(수신/송신)이 `output_frame` 변수에 다가갈 때 서로 충돌나지 않게 막는 자물쇠
# (이벤트 루프 시작 후 main()에서 초기화)
lock: asyncio.Lock = None

# 외부의 다른 모듈 요구나 데스크탑 앱에서 온 제어 신호를 라즈베리파이로 보내기 위해 차곡차곡 쌓아두는 '우체통' 역할
# (이벤트 루프 시작 후 main()에서 초기화)
pi_outbound_queue: asyncio.Queue = None

# ==========================================
# [공용 API] 라즈베리파이로 전송 기능 노출
# ==========================================
async def send_to_pi(data_dict):
    """
    외부 모듈(YOLO 등)이나 데스크탑 앱이 어떤 명령/데이터를 파이로 보내고 싶을 때 부르는 함수입니다.
    호출 시 데이터를 파이 전송 대기열(Queue)에 즉시 집어넣습니다.
    예: await send_to_pi({"type": "motor_control", "pan": 45, "tilt": -10})
    """
    await pi_outbound_queue.put(data_dict)

# ==========================================
# 1. 라즈베리파이 통신부 (수신 및 역송신)
# ==========================================
async def pi_sender_task(websocket):
    """
    [우체통 배달부 루프]
    우체통(pi_outbound_queue)에 명령이 들어오면 하나씩 꺼내서 라즈베리파이 웹소켓으로 쏴주는 역할의 무한 반복 함수입니다.
    이 반복문은 웹소켓 연결이 온전히 살아있을 때만 백그라운드로 돌아갑니다.
    """
    while True:
        data = await pi_outbound_queue.get() # 큐에 뭔가가 들어올 때까지 여기서 대기합니다
        try:
            # 딕셔너리를 JSON 문자열로 예쁘게 포장해서 파이로 전송
            await websocket.send(json.dumps(data))
        except Exception as e:
            print(f"라즈베리파이로 데이터 전송 실패: {e}")

async def receive_from_pi():
    """
    [메인 라즈베리파이 클라이언트 로직]
    단순하게 계속 파이 서버측에 접속을 시도하고, 
    성공하면 1. 파이의 영상을 받고, 2. (위에서 만든 배달부를 통해) 명령을 파이로 보냅니다.
    """
    global output_frame
    
    while True: # 예상치 못한 포트 닫힘이나 네트워크 끊김 시를 대비한 영원한 루프
        try:
            print(f"라즈베리파이({RPI_WS_URL})에 연결 시도 중...")
            
            # 핑(Ping) 등 기타 제약 없이 라즈베리파이로 클라이언트 접속 시도
            async with websockets.connect(RPI_WS_URL, ping_interval=None) as websocket:
                print("라즈베리파이와 성공적으로 연결되었습니다!")
                
                # 송신용 태스크(배달부)를 백그라운드에 생성하여 바로 활동을 개시시킴
                sender = asyncio.create_task(pi_sender_task(websocket))
                
                try:
                    # 계속해서 파이로부터 영상을 받아옴 (수신 루프)
                    async for message in websocket:
                        
                        # 파이에서 스트링(Base64 등)이 아닌 생 바이트 배열(바이너리)로 화질 손상과 지연 없이 바로 보낸다고 가정
                        if isinstance(message, bytes):
                            
                            # 넘파이를 활용해 바이트 덩어리를 OpenCV 이미지 매트릭스로 즉시 해독
                            nparr = np.frombuffer(message, np.uint8)
                            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                            
                            # 사진이 멀쩡히 생겼다면
                            if frame is not None:
                                
                                # (필요시 이 부분을 나중에 YOLO 렌더링에 사용)
                                
                                # 이 프레임을 다시 가벼운 70 압축률의 JPG 형태로 치환해서 PC 메모리 글로벌 변수에 업데이트함
                                ret, encoded_img = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
                                if ret:
                                    async with lock: # 다른 송신 로직이 쓰지 못하게 잠깐 잠그고 안전하게 업데이트!
                                        output_frame = encoded_img.tobytes()
                        else:
                            pass # 이미지 외 찌꺼기 텍스트 통신은 여기서 처리 (필요시)
                finally:
                    # 끊기면 이 구문이 실행되므로, 돌고있던 송신부 배달 태스크도 안전하게 Cancel(강제 종료)시킴
                    sender.cancel() 
                        
        except Exception as e:
            print(f"라즈베리파이 연결 오류({e}). 3초 후 재접속을 시도합니다.")
            await asyncio.sleep(3) # 에러 시 과도한 자원 소모를 방지하기 위해 3초 대기 후 재접속

# ==========================================
# 2. 데스크탑 앱(Electron) 통신부 (중계 서버)
# ==========================================
async def desktop_sender_task(websocket):
    """
    [PC 기반 통신 배달부 루프]
    데스크탑 Electron 앱 쪽에 계속해서 최신 영상(output_frame)을 보내줍니다.
    """
    try:
        while True:
            # 아까 라즈베리파이 쪽 함수에서 업데이트해준 영상 데이터를 자물쇠 걸고 안전하게 꺼내옵니다.
            async with lock:
                current_frame = output_frame
                
            if current_frame is not None:
                # 자바스크립트 등 웹 기술이 다루기 쉬운 형태(Base64)로 사진 인코딩
                base64_frame = base64.b64encode(current_frame).decode('utf-8')
                
                # JSON 형태로 통일성 있게 메시지 준비 
                message = {
                    "type": "video_frame",
                    "frame": base64_frame
                }
                
                # 앱으로 전송!
                await websocket.send(json.dumps(message))
            
            # 무한루프가 CPU를 모조리 장악하지 않도록 딜레이 추가 (약 1초에 30프레임 전송 규격)
            await asyncio.sleep(0.033) 
            
    except websockets.exceptions.ConnectionClosed:
        # 정상적인 앱 종료로 소켓이 끊어지면 그냥 무시하고 스레드를 조용히 끝냅니다.
        pass

async def ws_handler(websocket):
    """
    데스크탑 앱(Electron)이 서버(이 파일)에 접속할 때 딱 한 번 실행되어 연결을 관장하는 함수
    """
    print(f"Desktop App(Electron) Client Connected")
    
    # 앱으로 영상을 쏘는 작업 스레드를 백그라운드에 깔아둠
    sender = asyncio.create_task(desktop_sender_task(websocket))
    
    try:
        # 앱으로부터 사용자의 수동 조작 신호(모터 제어 등)를 수신 대기 (영상 쏘기와 완전 동시 진행)
        async for message in websocket:
            try:
                # 수신된 문자열을 파이썬 딕셔너리로 해독
                data = json.loads(message)
                
                # 앱에서 온 데이터를 그대로 상단에 만든 '라즈베리파이 우체통(API)'에 밀어넣음! (다이렉트 중계 완료)
                await send_to_pi(data)
                print(f"앱으로부터 데이터 수신 -> 파이로 전달 예약: {data}")
            except json.JSONDecodeError:
                pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        print("Desktop App(Electron) Client Disconnected")
        # 앱 측이 완전히 끊기면, 위에서 background 로 실행 중이던 영상 쏘기 태스크(`sender`)를 강제 캔슬하여 자원 반환
        sender.cancel()

async def start_desktop_server():
    """앱의 접속을 기다리는 리스너(Listener) 역할을 하는 함수"""
    print(f"Desktop App WebSocket Server listening on: ws://0.0.0.0:{WS_PORT}")
    
    # 0.0.0.0(모든 IP 허용) 환경에서 8765번 포트로 들어오는 요쳥에 대해서 ws_handler를 매칭해 작동시킨다.
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        await asyncio.Future()  # 앱이 꺼지든 말든 이 파이썬 프로세스가 살아있는 한 계속 Listen 대기


# ==========================================
# 프로그램 최초 시작 지점 (메인 런쳐)
# ==========================================
async def main():
    global lock, pi_outbound_queue
    lock = asyncio.Lock()
    pi_outbound_queue = asyncio.Queue()

    # 1. 물리적 파이에서 받아오는 수신 클라이언트 루틴 시작 예약 (비동기)
    receiver_task = asyncio.create_task(receive_from_pi())
    
    # 2. 데스크탑 Electron 과 통신하는 송신 서버 모듈 시작 예약 (비동기)
    server_task = asyncio.create_task(start_desktop_server())
    
    # 예약한 2개의 큰 덩어리를 "동시(Gather)"에 실행시킴으로써 중계(Middleware) 역할 시작
    await asyncio.gather(receiver_task, server_task)

if __name__ == '__main__':
    try:
        # async로 포장된 비동기 세계(main)를 트리거(Run) 해주는 구문
        asyncio.run(main())
    except KeyboardInterrupt:
        # 터미널에서 Ctrl+C를 눌러 강제종료할 때 에러 시루떡 방지용
        print("서버가 종료되었습니다.")