# legacy/

현재 사용하지 않는 구버전 모듈 보관 폴더.
삭제하지 않고 변경 이력 참고용으로 유지한다.

---

## correction_module.py

**기존 역할**
YOLO 좌표 기반 pan/tilt 보정값을 계산하는 모듈.
- 픽셀 오차(offset)에 threshold + gain을 곱해 보정값 산출
- EMA 스무딩으로 노이즈 감소
- 보정값을 RPi에 전송하고 `motor_corrected` 응답 대기

**교체 이유**
단순 비례 제어(P 제어)라 오버슈트·진동 발생.
누적 오차 보정(I), 급격한 변화 억제(D) 불가.

**대체 모듈**
`modules/pid_controller.py` — `MotorPIDManager` (PID + EMA 평활화)

---

## yolo_bridge.py

**기존 역할**
Python 측 YOLO 스레드와 `spotlight_core.py` 간 의존성을 분리하는 중개 모듈.
- `register()`: spotlight_core의 핸들러와 이벤트 루프 등록
- `submit()`: YOLO 스레드에서 감지 좌표를 asyncio 루프로 안전하게 전달

**교체 이유**
YOLO 탐지가 Python 서버에서 Electron(JS)으로 이전됨.
Electron이 `object_detected` WebSocket 메시지로 좌표를 직접 전송하므로
스레드 간 브릿지가 불필요해짐.

**대체 방식**
`spotlight_core.py`의 `ws_handler()` 내 `object_detected` 메시지 직접 처리
