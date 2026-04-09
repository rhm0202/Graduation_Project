import cv2
import threading
import time
import json
import asyncio
import websockets
import base64

# ==========================================
# 설정 (Configuration)
# ==========================================
WS_PORT = 8765    # 제어 및 영상 데이터 통신 포트

# 전역 변수
output_frame = None
lock = threading.Lock()
roi_data = {"x": 0, "y": 0, "w": 0, "h": 0}

# ==========================================
# 1. 카메라 및 AI 처리 스레드
# ==========================================
def camera_processing_thread():
    global output_frame, roi_data
    
    # 카메라 초기화
    cap = cv2.VideoCapture(0)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    
    # [Case B] YOLO 모델 로드 (라즈베리파이에서 실행 시)
    # from ultralytics import YOLO
    # model = YOLO('yolov8n.pt')
    
    print("Camera started...")
    
    while True:
        ret, frame = cap.read()
        if not ret:
            continue
            
        # --- YOLO 객체 인식 (예시) ---
        # results = model(frame)
        # if len(results[0].boxes) > 0:
        #     box = results[0].boxes[0].xywh[0]
        #     roi_data = {"x": int(box[0]), "y": int(box[1]), "w": int(box[2]), "h": int(box[3])}
        # ---------------------------
        
        # 스트리밍을 위한 이미지 인코딩 (Base64 변환과 네트워크 트래픽을 고려해 압축률 70 설정)
        ret, encoded_img = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        if ret:
            with lock:
                output_frame = encoded_img.tobytes()
        
        time.sleep(0.01)

# ==========================================
# 2. WebSocket 서버 (영상 및 좌표 전송용)
# ==========================================
async def ws_handler(websocket):
    print(f"WebSocket Client Connected")
    try:
        while True:
            with lock:
                current_frame = output_frame
                
            if current_frame is not None:
                # 바이트 이미지를 Base64 문자열로 변환
                base64_frame = base64.b64encode(current_frame).decode('utf-8')
                
                # 영상 데이터와 최신 ROI 좌표 전송
                message = {
                    "type": "video_frame",
                    "frame": base64_frame,
                    "roi": roi_data
                }
                
                await websocket.send(json.dumps(message))
            
            await asyncio.sleep(0.033) # 약 30 FPS 로 전송
            
    except websockets.exceptions.ConnectionClosed:
        print("WebSocket Client Disconnected")

async def start_websocket_server():
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        await asyncio.get_running_loop().create_future()

if __name__ == '__main__':
    # 카메라 스레드 시작
    t_cam = threading.Thread(target=camera_processing_thread, daemon=True)
    t_cam.start()
    
    print(f"WebSocket Stream & Control: ws://0.0.0.0:{WS_PORT}")
    
    # WebSocket 서버 시작 (메인 루프)
    try:
        asyncio.run(start_websocket_server())
    except KeyboardInterrupt:
        pass