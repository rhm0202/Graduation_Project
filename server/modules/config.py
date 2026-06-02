"""
config.py
─────────
spotlight_core 및 관련 모듈에서 공유하는 설정 상수.
"""

RPI_WS_URL   = "ws://192.168.137.114:8765"  # RPi WebSocket 주소 (Wi-Fi)
WS_PORT      = 8765                         # Electron 앱과 통신할 포트
FRAME_WIDTH  = 1920                         # 카메라 해상도 (1080p)
FRAME_HEIGHT = 1080

X_DEAD_ZONE  = 300                          # 팬 데드존 (200@1280 → 300@1920 비례 스케일)
Y_DEAD_ZONE  = 150                          # 틸트 데드존 (100@720 → 150@1080 비례 스케일)

# ─── PID 모터 제어 파라미터 ───────────────────────────────
PID_KP           = 0.25    # 비례 게인
PID_KI           = 0.0005  # 적분 게인
PID_KD           = 0.08    # 미분 게인
PID_OUTPUT_LIMIT = 10.0     # PID 1회 출력 최대 각도 변화 (±도)
EMA_ALPHA        = 0.3     # EMA 스무딩 팩터 (낮을수록 부드러움)
