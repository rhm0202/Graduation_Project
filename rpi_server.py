import cv2
import threading
import time
import json
import asyncio
import websockets
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

# ==========================================
# 설정 (Configuration)
# ==========================================
HTTP_PORT = 8000  # 영상 스트리밍 포트
WS_PORT = 8765    # 제어 및 좌표 통신 포트

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
        
        # MJPEG 스트리밍을 위한 이미지 인코딩
        ret, encoded_img = cv2.imencode('.jpg', frame)
        if ret:
            with lock:
                output_frame = encoded_img.tobytes()
        
        time.sleep(0.01)

# ==========================================
# 2. MJPEG HTTP 스트리밍 서버
# ==========================================
class MJPEGHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/stream.mjpg':
            self.send_response(200)
            self.send_header('Content-type', 'multipart/x-mixed-replace; boundary=--jpgboundary')
            self.end_headers()
            
            while True:
                with lock:
                    if output_frame is None:
                        continue
                    current_frame = output_frame
                
                try:
                    self.wfile.write(b'--jpgboundary\r\n')
                    self.send_header('Content-type', 'image/jpeg')
                    self.send_header('Content-length', str(len(current_frame)))
                    self.end_headers()
                    self.wfile.write(current_frame)
                    self.wfile.write(b'\r\n')
                    time.sleep(0.03) # 약 30 FPS
                except Exception:
                    break
        else:
            self.send_response(404)
            self.end_headers()

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """멀티스레드 지원 HTTP 서버"""

# ==========================================
# 3. WebSocket 서버 (좌표 전송용)
# ==========================================
async def ws_handler(websocket):
    print(f"WebSocket Client Connected")
    try:
        while True:
            # 최신 ROI 좌표 전송
            await websocket.send(json.dumps(roi_data))
            await asyncio.sleep(0.05) # 20 FPS로 좌표 전송
    except websockets.exceptions.ConnectionClosed:
        print("WebSocket Client Disconnected")

async def start_websocket_server():
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        await asyncio.get_running_loop().create_future()

if __name__ == '__main__':
    # 카메라 스레드 시작
    t_cam = threading.Thread(target=camera_processing_thread, daemon=True)
    t_cam.start()
    
    # HTTP 서버 시작
    http_server = ThreadedHTTPServer(('0.0.0.0', HTTP_PORT), MJPEGHandler)
    t_http = threading.Thread(target=http_server.serve_forever, daemon=True)
    t_http.start()
    
    print(f"Stream: http://0.0.0.0:{HTTP_PORT}/stream.mjpg")
    print(f"WebSocket: ws://0.0.0.0:{WS_PORT}")
    
    # WebSocket 서버 시작 (메인 루프)
    try:
        asyncio.run(start_websocket_server())
    except KeyboardInterrupt:
        pass