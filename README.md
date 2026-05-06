# Spotlight Cam

크로마키를 대체하는 AI 객체 추적 및 배경 제거 시스템

**팀: Anywhere Studio**

---

## 프로젝트 개요

Spotlight Cam은 크로마키의 물리적 제약을 해결하기 위해 개발된 AI 기반 비디오 처리 시스템입니다. 대형 녹색 스크린 없이도 실시간으로 배경을 제거하고 객체를 추적하여, 더 넓은 활동 반경과 낮은 비용으로 고품질 비디오 제작을 가능하게 합니다.

### 핵심 차별점

| 항목 | 크로마키 | Spotlight Cam |
|------|----------|--------------|
| 물리적 공간 | 대형 스크린, 조명 공간 (필수) | 카메라만 설치 (불필요) |
| 비용 | 높음 (설치비, 조명비, 유지보수비) | 낮음 (RPI 4 + PC S/W) |
| 활동 반경 | 제한됨 (녹색천 내부) | 자유로움 (AI가 객체 추적) |
| 핵심 기술 | 광학적 색상 분리 (물리) | AI 객체 인식/추적 (S/W) |

---

## 주요 기능

### 🤖 AI 객체 추적
- YOLO 객체 인식 기반 사람 탐지
- spotlight_core.py를 통해 라즈베리파이 팬/틸트 모터 자동 제어
- 수동 제어 모드 지원

### 🎬 실시간 배경 제거
- ONNX Runtime + YOLO26-seg 모델(`YOLO26-seg.onnx`)로 실시간 배경 제거
- **소스별 독립 처리**: 각 소스가 자체 배경 제거 루프(`_bgLoop`)를 실행
- 배경 교체 옵션: 이미지 / 동영상 / 단색
- 전/후 비교 모드 지원

### 🎥 비디오 녹화
- 마스터 캔버스 합성 결과를 WebM/VP9 형식으로 녹화
- 다중 소스가 합성된 최종 영상이 녹화됨
- 녹화 시간 표시 및 상태 표시
- 사용자 지정 저장 위치 선택

### 🎛️ OBS 스타일 Sources 패널
- **웹캠**: 연결된 카메라 장치 선택 추가
- **전체화면 캡처**: 모니터 화면 캡처 소스 추가
- **창 캡처**: 특정 앱 창 캡처 소스 추가
- **RPi 카메라**: 라즈베리파이 영상 스트림 소스 추가
- 소스 가시성 토글(👁), 삭제(✕), 드래그 앤 드롭으로 레이어 순서 변경
- 소스 선택 후 배경 제거 ON/OFF 개별 적용

### 🎚️ 오디오 믹서
- 데스크탑/마이크 채널 실시간 볼륨 조절
- 채널별 음소거

### ⚙️ 설정 기능
- 카메라/마이크 선택
- 해상도 설정 (1080p, 720p, 자동)
- 저장 위치 설정
- 라즈베리파이 연결 설정

---

## 시스템 아키텍처

```
┌──────────────────────────────────────────┐
│   Raspberry Pi (H/W)                     │
│   ├── 카메라 영상 캡처                    │
│   └── 팬/틸트 모터 제어                  │
└────────────────┬─────────────────────────┘
                 │ WebSocket (JPEG 프레임)
                 ↓
┌──────────────────────────────────────────┐
│   spotlight_core.py (localhost:8000)      │
│   ├── RPi ↔ Electron 메시지 중계         │
│   └── 모터 제어 명령 전달                │
└────────────────┬─────────────────────────┘
                 │ WebSocket
                 ↓
┌──────────────────────────────────────────┐
│   Spotlight Cam App (Electron)            │
│                                           │
│  [소스 레이어]                            │
│   웹캠 ──────┐                            │
│   전체화면 ──┤→ Master Canvas (1920×1080) │
│   창 캡처 ───┤   rAF 컴포지터             │
│   RPi 카메라 ┘   (소스별 bgLoop 합성)    │
│                        │                  │
│                        ↓ captureStream(30)│
│                   masterStream            │
│                   ├── 화면 표시           │
│                   └── MediaRecorder 녹화  │
│                                           │
│  [AI 처리]                                │
│   ONNX Runtime (WebGPU/WebGL/WASM)       │
│   YOLO26-seg → 사람 마스크 생성            │
└──────────────────────────────────────────┘
```

---

## 시스템 요구사항

### 데스크탑 (Windows)
- Windows 10 이상
- 최소 4GB RAM (8GB 권장)
- GPU 지원 (AI 처리 성능 향상, WebGPU/WebGL 가속)

### 라즈베리파이
- Raspberry Pi 4 이상
- 카메라 모듈 또는 USB 웹캠
- 팬/틸트 모터 (선택사항)
- Python 3.x, OpenCV

### 네트워크
- spotlight_core.py가 실행 중인 호스트와 연결
- WebSocket 포트 8000 개방

---

## 설치 방법

### 데스크탑 앱 설치

#### 설치 파일로 설치
1. `Spotlight_Cam-Setup_v1.0.0.exe` 파일을 다운로드
2. 설치 파일을 실행
3. 설치 마법사의 안내를 따릅니다
4. 설치 완료 후 바탕화면 또는 시작 메뉴에서 실행

#### 개발자 빌드
```bash
# 의존성 설치
npm install

# 개발 모드로 실행
npm start

# 실행 파일 빌드
npm run package
```

### 라즈베리파이 설정

1. 라즈베리파이 OS 설치 (Raspberry Pi OS)
2. 카메라 모듈 활성화:
   ```bash
   sudo raspi-config
   # Interface Options > Camera > Enable
   ```
3. Python 패키지 설치:
   ```bash
   pip install opencv-python numpy websockets
   ```
4. `spotlight_core.py` 실행:
   ```bash
   python spotlight_core.py
   ```

---

## 사용 방법

### 라즈베리파이 연결
1. `spotlight_core.py`가 실행 중인지 확인 (`ws://localhost:8000`)
2. 앱 실행 후 **Settings** 모달에서 **연결** 버튼 클릭
3. 연결 상태 확인 (상태 표시줄에 "연결됨" 표시)
4. 연결 성공 시 Sources 패널에 RPi 카메라 소스가 자동으로 추가됨

### 소스 추가
1. **Sources** 패널에서 **+** 버튼 클릭
2. 소스 타입 선택:
   - **웹캠 (Webcam)**: 연결된 카메라 장치 목록에서 선택
   - **전체화면 캡처**: 모니터 화면 선택
   - **창 캡처**: 캡처할 앱 창 선택
   - **RPi 카메라**: RPi 연결 후 자동 추가 (수동 추가도 가능)
3. 소스 클릭으로 선택, 👁 버튼으로 가시성 토글, ✕ 버튼으로 삭제
4. 드래그 앤 드롭으로 레이어 순서 변경 (위가 상단 레이어)

### 기본 녹화
1. 소스를 하나 이상 추가합니다
2. **Controls** 패널에서 **Start Recording** 버튼 클릭
3. 녹화 중지하려면 **Stop Recording** 버튼 클릭
4. 녹화 파일은 설정한 저장 위치에 저장됩니다 (기본: `C:\VideoRecording`)

### 배경 제거
1. Sources 패널에서 웹캠 또는 RPi 카메라 소스 선택
2. **Background Removal** 버튼으로 ON/OFF 토글
3. 배경 교체가 필요하면 **배경 교체** 버튼 클릭 → 이미지/동영상/단색 선택
4. **전/후 비교** 버튼으로 원본과 처리 결과 나란히 비교 가능

### 객체 추적 모드
1. RPi가 연결된 상태에서 **자동 추적** 버튼 활성화
2. spotlight_core.py가 RPi로 추적 명령을 중계
3. RPi 팬/틸트 모터가 자동으로 카메라를 조정

### 수동 카메라 제어
- 팬/틸트 조이스틱 또는 방향 버튼으로 RPi 카메라 수동 제어

### 오디오 믹서
- 볼륨 슬라이더: 실시간 볼륨 조절
- 음소거 버튼: 클릭하여 채널별 음소거/해제

### 설정 변경
1. **Settings** 버튼 클릭
2. 비디오/오디오 장치, 해상도 설정
3. 라즈베리파이 연결 설정
4. 저장 위치 선택
5. **닫기** 버튼으로 저장

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

## 빌드 방법

### 개발 빌드
```bash
npm run package
```

### 배포용 빌드 (인스톨러 포함)
```bash
npm run make
```

빌드된 파일은 `out/make/squirrel.windows/x64/` 폴더에 생성됩니다.

---

## 기술 스택

### 데스크탑 앱
- **Electron** v39.1.0 - 크로스 플랫폼 데스크탑 앱 프레임워크
- **Electron Forge** v7.10.2 - 빌드 및 패키징 도구
- **ONNX Runtime Web** - SegFormer AI 모델 실행 (WebGPU / WebGL / WASM 가속)
- **Web APIs**: MediaRecorder, getUserMedia, desktopCapturer, Web Audio API, Canvas API
- **WebSocket** - spotlight_core.py와 실시간 통신

### 라즈베리파이
- **Python 3.x** - 메인 프로그래밍 언어
- **OpenCV** - 카메라 캡처 및 영상 처리
- **YOLO** - 객체 탐지 알고리즘
- **WebSocket** - spotlight_core.py ↔ Electron 통신

---

## 활용 분야

### 뉴스 / 일기예보
크로마키로 인한 방송 사고를 원천 차단, 더 역동적인 날씨 예보 등 새로운 연출 가능

### 미디어 콘텐츠 제작자
좁은 방에서도 고품질의 배경 합성이 가능, 비용 감소와 다양한 연출 효과 제공

### 온라인 강의 / 회의
물리적 공간 제약 없이 자유롭게 움직이며 강의 진행, 깔끔한 배경을 실시간으로 제공

---

## 프로젝트 일정

| 항목 | 12월 | 1월 | 2월 | 3월 | 4월 | 5월 |
|------|------|-----|-----|-----|-----|-----|
| 실행프로그램 (.exe) 제작 | ✅ | | | | | |
| OBS 스타일 UI 기본 구조 | ✅ | | | | | |
| 라즈베리파이 WebSocket 연동 | | ✅ | | | | |
| 팬/틸트 모터 제어 | | ✅ | | | | |
| AI 배경 제거 (ONNX/SegFormer) | | | ✅ | | | |
| 배경 교체 기능 | | | ✅ | | | |
| 자동 추적 모드 | | | | ✅ | | |
| OBS Sources 패널 (다중 소스/컴포지팅) | | | | | ✅ | |
| 테스트 및 성능 검증 | | | | | | 🔄 |
| 보고서 작성 | | | | | | 🔄 |

---

## 라이선스

ISC

## 개발팀

**Anywhere Studio**
- 2021161084 오현동
- 2021161014 김동수
- 2021161045 류황민

## 버전

1.0.0

---

## 문제 해결

### 라즈베리파이 연결 실패
1. `spotlight_core.py`가 실행 중인지 확인 (`ws://localhost:8000`)
2. 방화벽 설정 확인 (포트 8000)
3. 네트워크 연결 상태 확인

### 카메라/마이크가 인식되지 않는 경우
1. 다른 프로그램에서 카메라/마이크를 사용 중인지 확인
2. Settings에서 다른 장치 선택 시도

### 화면/창 캡처 소스가 추가되지 않는 경우
- Electron 환경에서만 동작하는 기능입니다 (개발 모드 포함)

### 녹화 파일이 저장되지 않는 경우
1. 저장 경로에 쓰기 권한이 있는지 확인
2. 디스크 공간 확인
3. Settings에서 저장 위치 변경 시도

### AI 배경 제거가 느린 경우
- GPU 가속 여부 확인 (앱 상단 AI Ready 표시에서 확인)
- 여러 소스에 동시에 배경 제거를 켜면 부하가 증가함

### 성능 문제
- 소스 수를 줄이거나 불필요한 소스 가시성을 OFF
- 해상도를 낮춰보세요 (720p)

---

## 향후 계획

- [x] 기본 비디오 녹화 기능
- [x] OBS 스타일 UI
- [x] 라즈베리파이 WebSocket 연동 (spotlight_core.py)
- [x] 실시간 배경 제거 (ONNX/SegFormer)
- [x] 배경 교체 기능 (이미지/동영상/단색)
- [x] 팬/틸트 모터 제어
- [x] 자동 추적 모드
- [x] OBS Sources 패널 (웹캠/화면/창/RPi, 레이어 컴포지팅)
- [x] 자동 업데이트
- [ ] YOLO 모델 완전 통합 (현재 시뮬레이션)
- [ ] 스트리밍 기능 (RTMP 등)
- [ ] 다국어 지원

---

## 자동 업데이트 설정

### GitHub Releases를 업데이트 서버로 사용

1. **GitHub 저장소 생성**
   - `main.js`의 `UPDATE_SERVER_URL`을 GitHub raw URL로 설정합니다

2. **latest.json 파일 생성**
   - 저장소에 `updates/latest.json` 파일을 생성합니다:
   ```json
   {
     "version": "1.0.1",
     "releaseDate": "2026-05-06",
     "downloadUrl": "https://media.githubusercontent.com/media/rhm0202/Graduation_Project/main/website/downloads/Spotlight_Cam-Setup_v1.0.1.exe",
     "releaseNotes": "버그 수정 및 성능 개선"
   }
   ```

3. **업데이트 배포 프로세스**
   - 새 버전 빌드: `npm run make`
   - GitHub Releases에 새 버전 업로드
   - `updates/latest.json` 파일 업데이트

4. **현재 설정된 저장소**: [rhm0202/Graduation_Project](https://github.com/rhm0202/Graduation_Project)

---

## 참고 자료

- [ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)
- [Electron 공식 문서](https://www.electronjs.org/)
- [OpenCV 공식 문서](https://opencv.org/)
- [YOLO 공식 문서](https://github.com/ultralytics/ultralytics)

---

## Q&A

프로젝트에 대한 질문이나 제안사항이 있으시면 이슈를 등록해주세요.

감사합니다!
