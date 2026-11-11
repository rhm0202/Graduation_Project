# Spotlight Cam

크로마키를 대체하는 AI 객체 추적 및 실시간 배경 제거 시스템

**팀: Anywhere Studio** · 한국기술교육대학교 졸업작품 · AI FESTA 2026 전시작

---

## 프로젝트 개요

Spotlight Cam은 크로마키의 물리적 제약을 해결하기 위해 개발된 AI 기반 비디오 처리 시스템입니다. 대형 녹색 스크린 없이도 실시간으로 배경을 제거하고, 팬/틸트 카메라가 사람을 자동으로 따라가 더 넓은 활동 반경과 낮은 비용으로 고품질 비디오 제작을 가능하게 합니다.

### 핵심 차별점

| 항목 | 크로마키 | Spotlight Cam |
|------|----------|--------------|
| 물리적 공간 | 대형 스크린, 조명 공간 (필수) | 카메라만 설치 (불필요) |
| 비용 | 높음 (설치비, 조명비, 유지보수비) | 낮음 (RPi 4 + PC S/W) |
| 활동 반경 | 제한됨 (녹색천 내부) | 자유로움 (AI가 객체 추적) |
| 핵심 기술 | 광학적 색상 분리 (물리) | AI 객체 인식/추적 (S/W) |

---

## 주요 기능

### 🤖 AI 객체 추적
- YOLO26-seg 모델로 사람 탐지 (Electron 앱 내부에서 ONNX Runtime Web으로 추론)
- ByteTrack으로 인물 ID 유지: 칼만 이동 예측과 고·저신뢰 검출의 2단계 연결
- 짧은 미검출 구간은 선택 인물만 최대 250ms 예측, ID 재획득은 최대 3초 유지
- 3초 미만의 소실 후 마지막 관측 위치 부근으로 재등장하면 겹침·크기·모호성 조건을 확인해 기존 ID 복구
- 추적 좌표를 `spotlight_core.py`가 PID + EMA로 서보 각도로 변환해 라즈베리파이 팬/틸트 모터 제어
- 데드존, 좌표 급변(점프) 무시, 대상 전환 시 가속 제한으로 카메라 흔들림 완화

### 🎬 실시간 배경 제거
- YOLO26-seg 세그멘테이션 마스크 기반 실시간 배경 제거 (WebGPU → WebGL → WASM 순으로 가속 선택)
- 겹친 사람 사이 마스크 틈·깜빡임 보정, 움직이는 사람의 잔상 제거
- 배경 교체 옵션: 배경 없음(투명) / 이미지 / 비디오 / 단색
- 전후 비교 모드 지원

### 📡 라즈베리파이 영상 수신 (WebRTC)
- RPi 카메라 영상을 MediaMTX WebRTC(WHEP)로 저지연 수신
- 제어 채널(WebSocket)과 영상 채널(WebRTC)을 분리
- RPi 연결이 끊기면 제어·영상 자동 재연결

### 🎛️ Sources 패널
- **웹캠**: 연결된 카메라 장치 선택 추가
- **전체화면 캡처**: 모니터 화면 캡처 소스 추가
- **창 캡처**: 특정 앱 창 캡처 소스 추가
- **RPi 카메라**: 라즈베리파이 영상 스트림 소스 추가
- 소스 가시성 토글(👁), 삭제(✕)
- 선택한 소스가 마스터 캔버스(1920×1080)에 출력되며, 배경 제거·추적도 선택한 소스에 적용

### 🎥 비디오 녹화
- 마스터 캔버스 출력을 WebM(VP9 + Opus)으로 녹화
- 녹화 시간 및 상태 표시
- 사용자 지정 저장 위치 선택

### 🎚️ 오디오 믹서
- 데스크탑/마이크 채널 실시간 볼륨 조절
- 채널별 음소거

### 🔄 자동 업데이트
- 앱 실행 시 `updates/latest.json`을 확인해 새 버전 안내
- GitHub Release 발행 시 Actions가 빌드·업로드·`latest.json` 갱신을 자동 수행

---

## 시스템 아키텍처

```
┌──────────────────────────────────────────────┐
│   Raspberry Pi 4 (H/W)                        │
│   ├── 카메라 캡처 → MediaMTX (WebRTC, :8000)   │
│   └── rpi_server.py (WebSocket, :8765)         │
│        └── PCA9685 → Pan/Tilt 서보 구동         │
└───────┬──────────────────────────┬────────────┘
        │ WebRTC (WHEP) 영상        │ WebSocket 서보 각도 / 상태
        │                          ↑
        │          ┌───────────────┴──────────────┐
        │          │ spotlight_core.py (PC, :8765)  │
        │          │ ├── 추적 좌표 수신             │
        │          │ ├── PID + EMA → 서보 각도 산출 │
        │          │ └── RPi 연결 관리·재연결       │
        │          └───────────────┬──────────────┘
        │                          ↑ WebSocket 추적 좌표 / 추적 ON·OFF
        ↓                          │
┌────────────────────────────────────────────────┐
│   Spotlight Cam App (Electron)                   │
│                                                  │
│  [소스] 웹캠 / 화면 / 창 / RPi 카메라            │
│     │                                            │
│     ├─▶ YOLO26-seg (ONNX Runtime Web)            │
│     │     ├── 사람 마스크 → 배경 제거·교체        │
│     │     └── 사람 박스 → ByteTrack → 추적 좌표   │
│     ↓                                            │
│  Master Canvas (1920×1080, rAF)                  │
│     │  captureStream(60)                          │
│     ├── 미리보기                                  │
│     └── MediaRecorder 녹화 (WebM)                 │
└────────────────────────────────────────────────┘
```

| 포트 | 위치 | 용도 |
|---|---|---|
| 8000 | RPi (MediaMTX) | WebRTC(WHEP) 영상 송출 |
| 8765 | RPi (`rpi_server.py`) | 서보 각도 수신 / 모터 상태 송신 |
| 8765 | PC (`spotlight_core.py`) | Electron ↔ 서버 제어 채널 (`ws://localhost:8765`) |

---

## 프로젝트 구조

```
Graduation_Project/
├── main.js                 # Electron 메인 프로세스 (spotlight_core 실행, 업데이트 확인)
├── preload.js
├── index.html / styles.css
├── renderer/
│   ├── main-renderer.js    # 렌더러 진입점
│   ├── sources.js          # 소스 관리, 마스터 캔버스, AI 루프
│   ├── background.js       # ONNX 모델 로드, 배경 제거·교체
│   ├── byteTracker.js      # ByteTrack + 칼만 필터
│   ├── tracking.js         # 자동 추적 ON/OFF
│   ├── rpi.js              # RPi 제어 채널, WebRTC(WHEP) 영상 수신
│   ├── recording.js        # MediaRecorder 녹화
│   ├── audio.js            # 오디오 믹서
│   ├── settings.js / ui.js / state.js / updates.js
├── server/
│   ├── spotlight_core.py   # PC 측 제어 서버
│   └── modules/
│       ├── config.py       # 포트, 해상도, 데드존, PID 파라미터
│       ├── pid_controller.py
│       ├── logger.py
│       └── legacy/         # 미사용 구버전 모듈
├── AI_models/              # YOLO26-seg ONNX 모델 (git 미포함, 직접 배치)
├── updates/latest.json     # 자동 업데이트 메타데이터
├── scripts/update-release.js
├── .github/workflows/release.yml
└── docs/                   # 개발 현황 웹사이트
```

라즈베리파이 측 코드는 [Graduation_Project_In_Raspberry_Pi](https://github.com/rhm0202/Graduation_Project_In_Raspberry_Pi) 레포에 있습니다.

---

## 시스템 요구사항

### 데스크탑 (Windows)
- Windows 10 이상
- 8GB RAM 이상 권장
- WebGPU/WebGL 지원 GPU 권장 (없으면 WASM으로 동작하나 느림)

### 라즈베리파이
- Raspberry Pi 4 이상
- Raspberry Pi Camera Module
- PCA9685 I2C PWM 드라이버 + 팬/틸트 서보 2개 (Pan: CH0 / Tilt: CH1)
- MediaMTX

### 네트워크
- PC와 RPi가 같은 로컬 네트워크(또는 Windows 핫스팟)에 연결
- RPi 8000(영상), 8765(제어) 포트 접근 가능

---

## 설치 방법

### 데스크탑 앱

#### 릴리스 파일로 설치
1. [Releases](https://github.com/rhm0202/Graduation_Project/releases)에서 최신 `Spotlight_Cam_v*-win32-x64.zip` 다운로드
2. 압축 해제 후 실행 파일 실행

#### 개발자 빌드
```bash
npm install

# AI 모델 배치 (용량 문제로 git에 포함되지 않음)
#   AI_models/yolo26l-seg.onnx

npm start          # 개발 모드 실행
npm run package    # 실행 파일 빌드
```

개발 모드에서 `spotlight_core.py`를 실행하려면 Python 3.7+와 `websockets`가 필요합니다.
```bash
pip install websockets
```
`server/modules/config.py`의 `RPI_WS_URL`을 실제 RPi IP로 설정하세요.

### 라즈베리파이

[Graduation_Project_In_Raspberry_Pi](https://github.com/rhm0202/Graduation_Project_In_Raspberry_Pi) README를 참고하세요.

1. I2C 활성화: `sudo raspi-config` → Interface Options → I2C → Enable
2. MediaMTX 설치 및 카메라 스트림(`cam`) 설정
3. 환경 설치: `bash setup/install.sh`
4. 서버 실행: `bash active/run.sh`

---

## 사용 방법

### 라즈베리파이 연결
1. RPi에서 MediaMTX와 `rpi_server.py`가 실행 중인지 확인
2. 앱 **Settings**에서 RPi IP, 포트(기본 8000), 스트림 이름(기본 `cam`) 입력 후 **연결**
3. 앱이 `spotlight_core`를 자동 실행하고 RPi 카메라 소스를 추가

### 소스 추가
1. **Sources** 패널에서 **+** 버튼 클릭
2. 웹캠 / 전체화면 캡처 / 창 캡처 / RPi 카메라 중 선택
3. 소스를 클릭해 화면에 출력할 소스 선택, 👁로 가시성 토글, ✕로 삭제

### 배경 제거
1. 웹캠 또는 RPi 카메라 소스 선택
2. **배경 제거** 버튼으로 ON/OFF
3. **배경 교체**에서 배경 없음 / 이미지 / 비디오 / 단색 선택
4. **전후 비교**로 원본과 처리 결과 비교

### 자동 추적
1. RPi가 연결된 상태에서 **자동 추적** 버튼 ON
2. 화면 속 사람을 ByteTrack으로 추적하고, 팬/틸트 카메라가 대상을 따라 움직임

### 녹화
1. **Start Recording**으로 녹화 시작, **Stop Recording**으로 종료
2. 설정한 저장 위치에 `.webm`으로 저장 (기본: `C:\VideoRecoding`)

### 오디오 믹서
- 슬라이더로 채널별 볼륨 조절, 음소거 버튼으로 음소거/해제

---

## 메뉴 기능

### File
- **Show Recordings**: 저장된 녹화 파일 폴더 열기
- **Settings**: 설정 창 열기
- **Exit**: 프로그램 종료

### View
- **Docks**: 도크 패널 표시/숨김 토글
- **Force Reload**: 강제 새로고침
- **Toggle Developer Tools**: 개발자 도구 열기/닫기

---

## 기술 스택

### 데스크탑 앱
- **Electron** 39 / **Electron Forge** 7
- **ONNX Runtime Web** 1.24 — YOLO26-seg 추론 (WebGPU / WebGL / WASM)
- **ByteTrack** — 독립 JS 구현 (`renderer/byteTracker.js`)
- **WebRTC (WHEP)** — RPi 영상 수신
- **Web APIs** — MediaRecorder, getUserMedia, desktopCapturer, Web Audio API, Canvas API

### PC 제어 서버
- **Python 3**, **asyncio**, **websockets**
- PID + EMA 기반 팬/틸트 각도 산출

### 라즈베리파이
- **Python 3**, **picamera2**, **websockets**
- **MediaMTX** — WebRTC 영상 송출
- **PCA9685** (adafruit-circuitpython-servokit) — I2C 서보 제어

### 배포
- **GitHub Actions** — Release 발행 시 Windows 빌드·업로드·`latest.json` 갱신

---

## 활용 분야

### 뉴스 / 일기예보
크로마키로 인한 방송 사고를 원천 차단, 더 역동적인 날씨 예보 등 새로운 연출 가능

### 미디어 콘텐츠 제작자
좁은 방에서도 고품질의 배경 합성이 가능, 비용 감소와 다양한 연출 효과 제공

### 온라인 강의 / 회의
물리적 공간 제약 없이 자유롭게 움직이며 강의 진행, 깔끔한 배경을 실시간으로 제공

---

## 문제 해결

### 라즈베리파이 연결 실패
1. RPi에서 MediaMTX(8000)와 `rpi_server.py`(8765)가 실행 중인지 확인
2. Settings의 RPi IP와 `config.py`의 `RPI_WS_URL`이 같은지 확인
3. 방화벽에서 8000, 8765 포트 허용 여부 확인

### RPi 영상이 나오지 않는 경우
- 브라우저에서 `http://<RPi IP>:8000/cam`으로 MediaMTX 스트림이 열리는지 확인
- Settings의 스트림 이름이 MediaMTX 설정과 같은지 확인

### AI 배경 제거가 동작하지 않거나 느린 경우
- `AI_models/yolo26l-seg.onnx`가 있는지 확인 (개발 빌드)
- 앱 상단 AI Ready 표시에서 GPU 가속 여부 확인
- 해상도를 720p로 낮춰보세요

### 카메라/마이크가 인식되지 않는 경우
1. 다른 프로그램에서 카메라/마이크를 사용 중인지 확인
2. Settings에서 다른 장치 선택

### 녹화 파일이 저장되지 않는 경우
1. 저장 경로에 쓰기 권한이 있는지 확인
2. 디스크 공간 확인
3. Settings에서 저장 위치 변경

---

## 자동 업데이트 / 배포

1. `package.json`의 `version` 수정
2. GitHub에서 `v{version}` 태그로 Release 발행
3. Actions(`release.yml`)가 Windows 빌드 → zip 업로드 → `updates/latest.json` 갱신
4. 앱이 실행 시 `latest.json`을 확인해 업데이트 안내

자세한 설정은 [UPDATES.md](UPDATES.md)를 참고하세요.

---

## 라이선스

**GNU Affero General Public License v3.0 (AGPL-3.0-only)**

```
Copyright (C) 2025-2026 Anywhere Studio

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

전문은 [LICENSE](LICENSE)를 참조하십시오.

### AGPL-3.0을 채택한 이유

이 프로젝트는 배포 패키지에 Ultralytics YOLO26 세그멘테이션 모델을 포함합니다.
Ultralytics는 **학습 코드뿐 아니라 그 코드가 생성한 모델 가중치에도 AGPL-3.0이
적용된다**고 명시합니다. 따라서 해당 모델을 번들하여 배포하는 저작물은 전체를
AGPL-3.0으로 공개하거나 Ultralytics Enterprise 라이선스를 취득해야 합니다.
본 프로젝트는 전자를 택했습니다.

### 제3자 구성 요소 고지

| 구성 요소 | 라이선스 | 비고 |
|---|---|---|
| [Ultralytics YOLO26](https://github.com/ultralytics/yolo26) (`yolo26*-seg.onnx`) | AGPL-3.0 | 배포 패키지에 번들됨. 본 프로젝트가 AGPL-3.0인 직접적 근거 |

각 npm 의존성의 라이선스는 해당 패키지의 `package.json` 및
`node_modules/<패키지>/LICENSE`에 명시된 조건을 따릅니다.

---

## 개발팀

**Anywhere Studio**
- 2021161084 오현동
- 2021161014 김동수
- 2021161045 류황민

프로젝트 노션: [Project Hub](https://www.notion.so/Project-Hub-2eff017f3c8080caba0cdb1e919f17a5)

## 버전

2.1.0

---

## 참고 자료

- [ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)
- [Electron 공식 문서](https://www.electronjs.org/)
- [Ultralytics YOLO](https://github.com/ultralytics/ultralytics)
- [ByteTrack (Zhang et al., ECCV 2022)](https://arxiv.org/abs/2110.06864)
- [MediaMTX](https://github.com/bluenviron/mediamtx)

---

## Q&A

프로젝트에 대한 질문이나 제안사항이 있으시면 이슈를 등록해주세요.
