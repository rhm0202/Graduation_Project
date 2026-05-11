# server/

Spotlight Cam PC 측 미들웨어 서버.
Raspberry Pi와 Electron 앱 사이에서 영상 스트리밍 및 모터 제어 명령을 중계한다.

---

## 진입점

### `spotlight_core.py`
서버 메인 파일. 두 개의 WebSocket 연결을 동시에 관리한다.

| 연결 | 방향 | 내용 |
|---|---|---|
| RPi (`ws://192.168.x.x:8000`) | 양방향 | 영상 프레임 수신 / 서보 각도 송신 |
| Electron (`ws://0.0.0.0:8765`) | 양방향 | 영상 프레임 송신 / 추적 명령 수신 |

**흐름:**

| 단계 | 송신 | 내용 | 수신 |
|---|---|---|---|
| 1 | RPi | JPEG 프레임 (binary) | spotlight_core |
| 2 | spotlight_core | JPEG 프레임 (binary) | Electron |
| 3 | Electron | object_detected (YOLO 좌표) | spotlight_core |
| 4 | spotlight_core | servo_angle (pan/tilt 각도) | RPi |

---

## modules/

| 파일 | 역할 |
|---|---|
| `config.py` | RPi 주소, 포트, 해상도, PID 파라미터 등 공유 상수 |
| `pid_controller.py` | PID 연산 + EMA 평활화 → 서보 절대 각도 산출 (`MotorPIDManager`) |
| `logger.py` | 공통 로거 (`get_logger()`, RotatingFileHandler, UTF-8) |
| `legacy/` | 현재 미사용 구버전 모듈 (참고용 보관) |

---

## 실행

```bash
cd server
python spotlight_core.py
```

### 사전 조건

- Python 3.7+
- `pip install websockets`
- `config.py`의 `RPI_WS_URL`을 실제 RPi IP로 설정

---

## 관련 레포지토리

- RPi 서버: [Graduation_Project_In_Raspberry_Pi](https://github.com/rhm0202/Graduation_Project_In_Raspberry_Pi)
