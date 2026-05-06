"""
config.py
─────────
spotlight_core 및 관련 모듈에서 공유하는 설정 상수.
"""

RPI_WS_URL   = "ws://192.168.137.114:8000"  # RPi WebSocket 주소 (Wi-Fi)
WS_PORT      = 8765                         # Electron 앱과 통신할 포트
FRAME_WIDTH  = 1280                         # 카메라 해상도
FRAME_HEIGHT = 720

# ─── PID 모터 제어 파라미터 ───────────────────────────────
PID_KP           = 0.15    # 비례 게인
PID_KI           = 0.0005  # 적분 게인
PID_KD           = 0.06    # 미분 게인
PID_OUTPUT_LIMIT = 5.0     # PID 1회 출력 최대 각도 변화 (±도)
EMA_ALPHA        = 0.3     # EMA 스무딩 팩터 (낮을수록 부드러움)
