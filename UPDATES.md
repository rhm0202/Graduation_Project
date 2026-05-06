# 자동 업데이트 설정 가이드

## 개요

Spotlight Cam은 자동 업데이트 기능을 지원합니다. 사용자는 앱을 실행할 때마다 자동으로 최신 버전을 확인하고, 업데이트가 있으면 다운로드할 수 있습니다.

## 업데이트 서버 설정

### 방법 1: GitHub Releases (권장)

#### 1단계: GitHub 저장소 준비

1. GitHub에 프로젝트 저장소를 생성합니다
2. 저장소에 `updates` 폴더를 생성합니다
3. `updates/latest.json` 파일을 생성합니다

#### 2단계: latest.json 파일 작성

```json
{
  "version": "1.0.1",
  "releaseDate": "2026-05-06",
  "downloadUrl": "https://media.githubusercontent.com/media/rhm0202/Graduation_Project/main/website/downloads/Spotlight_Cam-Setup_v1.0.1.exe",
  "releaseNotes": "버그 수정 및 성능 개선\n- 라즈베리파이 연결 안정성 향상\n- UI 개선\n- 새로운 기능 추가"
}
```

**필드 설명:**

- `version`: 새 버전 번호 (예: "1.0.1")
- `releaseDate`: 릴리스 날짜 (YYYY-MM-DD 형식)
- `downloadUrl`: 설치 파일 다운로드 URL (GitHub Releases 또는 자체 서버)
- `releaseNotes`: 릴리스 노트 (줄바꿈은 `\n` 사용)

#### 3단계: main.js 설정

`main.js` 파일에서 업데이트 서버 URL을 설정합니다:

```javascript
const UPDATE_SERVER_URL =
  "https://raw.githubusercontent.com/rhm0202/Graduation_Project/main/updates/latest.json";
```

**현재 설정된 저장소**: [rhm0202/Graduation_Project](https://github.com/rhm0202/Graduation_Project)

#### 4단계: 새 버전 배포

1. `package.json`의 버전 번호를 업데이트합니다 (예: "1.0.0" → "1.0.1")
2. 새 버전을 빌드합니다: `npm run make`
3. GitHub Releases에 새 버전을 업로드합니다
4. `updates/latest.json` 파일을 업데이트합니다
5. 변경사항을 커밋하고 푸시합니다

### 방법 2: 자체 서버 사용

#### 1단계: 웹 서버 준비

- HTTPS 지원 권장
- 정적 파일 호스팅 가능한 서버 (예: AWS S3, GitHub Pages, 자체 서버)

#### 2단계: 파일 구조

```
your-server.com/
├── updates/
│   └── latest.json
└── releases/
    ├── VideoTracker-Setup-1.0.0.exe
    ├── VideoTracker-Setup-1.0.1.exe
    └── VideoTracker-Setup-1.0.2.exe
```

#### 3단계: latest.json 작성

```json
{
  "version": "1.0.1",
  "releaseDate": "2024-01-15",
  "downloadUrl": "https://your-server.com/releases/VideoTracker-Setup-1.0.1.exe",
  "releaseNotes": "업데이트 내용..."
}
```

#### 4단계: main.js 설정

```javascript
const UPDATE_SERVER_URL = "https://your-server.com/updates/latest.json";
```

## 버전 관리 규칙

### 시맨틱 버전 (Semantic Versioning)

- **MAJOR.MINOR.PATCH** 형식 사용
- 예: 1.0.0, 1.0.1, 1.1.0, 2.0.0

### 버전 업데이트 가이드

- **PATCH (1.0.0 → 1.0.1)**: 버그 수정, 작은 개선
- **MINOR (1.0.0 → 1.1.0)**: 새로운 기능 추가, 하위 호환성 유지
- **MAJOR (1.0.0 → 2.0.0)**: 큰 변경사항, 하위 호환성 깨짐

## 업데이트 프로세스

### 개발자 측

1. 코드 수정 및 테스트
2. `package.json` 버전 업데이트
3. 빌드: `npm run make`
4. GitHub Releases에 업로드
5. `updates/latest.json` 업데이트
6. 커밋 및 푸시

### 사용자 측

1. 앱 실행 시 자동으로 업데이트 확인 (5초 후)
2. 업데이트가 있으면 알림 표시
3. 사용자가 다운로드 선택
4. 브라우저에서 설치 파일 다운로드
5. 설치 파일 실행하여 업데이트

## 수동 업데이트 확인

사용자는 다음 방법으로 수동으로 업데이트를 확인할 수 있습니다:

- **Help > Check for Updates** 메뉴 클릭

## 문제 해결

### 업데이트가 확인되지 않는 경우

1. 인터넷 연결 확인
2. 방화벽 설정 확인
3. `UPDATE_SERVER_URL`이 올바른지 확인
4. `latest.json` 파일이 올바른 형식인지 확인

### 다운로드가 실패하는 경우

1. `downloadUrl`이 올바른지 확인
2. 서버가 파일을 제공할 수 있는지 확인
3. CORS 설정 확인 (필요시)

## 보안 고려사항

- HTTPS 사용 권장
- 코드 서명 권장 (Windows Defender 경고 방지)
- 업데이트 서버의 무결성 확인

## 예시: GitHub Releases 사용

### 저장소 구조

```
application/
├── updates/
│   └── latest.json
├── main.js
├── package.json
└── ...
```

### latest.json 예시

```json
{
  "version": "1.0.1",
  "releaseDate": "2026-05-06",
  "downloadUrl": "https://media.githubusercontent.com/media/rhm0202/Graduation_Project/main/website/downloads/Spotlight_Cam-Setup_v1.0.1.exe",
  "releaseNotes": "주요 변경사항:\n- 버그 수정 및 성능 개선\n- UI 개선"
}
```

### GitHub Releases 설정

1. GitHub 저장소로 이동
2. **Releases** 섹션 클릭
3. **Draft a new release** 클릭
4. 태그: `v1.0.1` (버전과 일치)
5. 제목: `Spotlight Cam v1.0.1`
6. 릴리스 노트 작성
7. 빌드된 `Spotlight_Cam-Setup_v1.0.1.exe` 파일 업로드
8. **Publish release** 클릭

이제 사용자들이 자동으로 업데이트를 받을 수 있습니다!

---

## 향후 개발 계획

### 해상도/프레임레이트 설정 기능

#### 목표

사용자가 비디오 해상도(720p/1080p)와 프레임레이트(30fps/60fps)를 선택할 수 있도록 UI 추가 및 실제 적용 로직 구현.

#### 현재 상태

- 해상도 선택 UI는 존재하나 실제 constraints에 적용되지 않음
- 프레임레이트 설정 UI 없음
- 기본값만 사용 중

#### 구현 계획

1. **UI 추가**
   - 설정 모달에 프레임레이트 선택 드롭다운 추가
   - 위치: 비디오 설정 필드셋 내, 해상도 선택 아래

2. **Constraints 로직 수정**
   - `startStream()` 함수에서 해상도/프레임레이트 값을 읽어 constraints에 적용
   - 해상도 매핑: `auto` (기본값), `1080p` (1920x1080), `720p` (1280x720)
   - 프레임레이트 매핑: `auto` (기본값), `30` (30fps), `60` (60fps)

3. **설정 저장/불러오기**
   - 로컬 스토리지에 해상도/프레임레이트 저장
   - 앱 시작 시 저장된 값 불러오기

4. **장치 호환성 처리**
   - 요청한 해상도/프레임레이트를 지원하지 않을 경우 대체값 사용
   - `getCapabilities()`로 지원 범위 확인 후 적절한 값 선택

### 에러 처리 개선

#### 목표

카메라/마이크 접근 실패 및 네트워크 오류 시 사용자에게 명확하고 도움이 되는 메시지를 제공.

#### 현재 상태

- 에러가 `console.error`로만 출력됨
- 사용자에게 간단한 메시지만 표시
- 에러 유형별 구분 없음

#### 구현 계획

##### 1. 카메라/마이크 접근 실패 처리

- **에러 유형별 메시지 매핑**
  - `NotAllowedError`: "카메라/마이크 접근이 거부되었습니다. 브라우저 설정에서 권한을 허용해주세요."
  - `NotFoundError`: "카메라/마이크를 찾을 수 없습니다. 장치가 연결되어 있는지 확인해주세요."
  - `NotReadableError`: "카메라/마이크가 다른 프로그램에서 사용 중입니다. 다른 프로그램을 종료한 후 다시 시도해주세요."
  - `OverconstrainedError`: "선택한 해상도/프레임레이트를 지원하지 않습니다. 다른 설정을 선택해주세요."
  - 기타: "카메라/마이크 접근 중 오류가 발생했습니다. (오류 코드: [에러명])"

- **UI 개선**
  - 에러 메시지를 모달 또는 토스트로 표시
  - "다시 시도" 버튼 제공
  - 설정 페이지로 이동하는 링크 제공

##### 2. 네트워크 오류 처리

- **라즈베리파이 WebSocket 연결**
  - 연결 실패 시 상세 메시지 표시
  - 자동 재연결 시도 (최대 3회)
  - 재연결 실패 시 사용자에게 알림

- **업데이트 확인**
  - 네트워크 오류 시 명확한 메시지
  - 타임아웃 처리 (5초)
  - 재시도 버튼 제공

##### 3. 에러 로깅 시스템

- 에러 발생 시 상세 정보 수집 (에러 타입, 메시지, 스택 트레이스, 타임스탬프)
- 사용자 동의 시 에러 리포트 전송 기능 (선택사항)

#### 예상 소요 시간

- 에러 메시지 매핑 함수: 1시간
- UI 개선: 2시간
- 네트워크 오류 처리: 1시간
- 에러 로깅 시스템: 1시간
- 테스트: 1시간
- **총 예상 시간: 6시간**

---

### 구현 우선순위 (v1.0.1 기준)

1. **Phase 1: 해상도/프레임레이트 설정 실제 적용** (우선순위: 높음)
   - 현재 UI는 있으나 constraints에 미반영
   - 구현 난이도: 중간
   - 예상 소요 시간: 3시간

2. **Phase 2: 에러 처리 개선** (우선순위: 높음)
   - 사용자 경험 개선 (에러 유형별 안내)
   - 구현 난이도: 중간
   - 예상 소요 시간: 6시간

3. **Phase 3: 통합 테스트**
   - 다양한 에러 시나리오 테스트
   - 사용자 피드백 수집
   - 추가 개선사항 반영

---

# Spotlight Cam — 패치노트

> 버전 형식: `Major.Minor.Patch`
>
> - **Major**: API 또는 아키텍처 수준의 변경 (하위 호환 불가)
> - **Minor**: 새 기능 추가 (하위 호환 유지)
> - **Patch**: 버그 수정 및 소규모 개선

---

## v1.0.0a · 2026-05-06 · 첫 정식 릴리즈

> 기존의 기능이 어느정도 구현 완료된 1.0 버전 앱입니다.

### 주요 기능 요약

- YOLO 기반 실시간 사람 감지 및 자동 추적
- HybridTracker (IoU + RGB 색상 매칭) 기반 다중 인원 ID 추적
- PID 제어 + EMA 평활화를 통한 Pan/Tilt 서보 정밀 제어
- Raspberry Pi 카메라 실시간 영상 스트리밍
- AI 배경 제거 / 배경 교체 (이미지·영상·단색)
- OBS 스타일 다중 소스 지원 (웹캠, 화면, 창, RPi 카메라)
- 영상 녹화 (WebM/VP9)

---

## v0.6.1 · 2026-05-06 · 서버 코드 안정화

### Patch

- **[PC]** 콘솔 로그 UTF-8 인코딩 수정 — Windows 환경 한글 깨짐 해결
- **[PC]** `correction_module.py` → `legacy/` 폴더로 이동 (PID로 완전 대체)
- **[RPi]** `asyncio.get_event_loop()` → `get_running_loop()` 교체 (Python 3.10+ deprecated 제거)
- **[RPi]** 프레임 전송 FPS 제한 추가 (무제한 → 50fps) — 중복 전송 및 네트워크 버퍼 누적 방지

---

## v0.6.0 · 2026-05-02 ~ 05-03 · HybridTracker 도입 및 PID 고도화

### Minor

- **[PC]** **HybridTracker** 도입 — IoU × 0.4 + RGB 색상유사도 × 0.6 매칭으로 다중 인원 ID 안정 추적
  - 색상 유사도 0.5 미만 페어 제외 (교차 시 ID 탈취 방지)
  - 최대 30프레임 ID 유지 (일시 소실 대응)
- **[PC]** 감지 인원 목록 UI — 추적 ID와 버튼 연동, 소실 시 흐림 처리
- **[PC]** YOLO 상위 모델(`yolo26l-seg`) 추가

### Patch

- **[PC]** PID 파라미터 튜닝 — Kp=0.08→0.15, Kd=0.03→0.06
- **[PC]** 데드존 축별 분리 — x=200px / y=100px (1280×720 기준)
- **[RPi]** 서보 이동 각도 확대
- **[PC]** UI 스타일 전반 개편

---

## v0.5.0 · 2026-05-02 · PID 제어 도입 ⚠️ Major 변경

> 보정 방식이 단순 비례 → PID로 전면 교체됨. RPi 명령 포맷 변경으로 하위 호환 불가.

### Major

- **[PC]** 보정 방식 전면 교체 — 단순 비례(gain) → **PID 제어 + EMA 평활화**
  - `pid_controller.py` 신규 작성 (P/I/D + Anti-windup)
  - `MotorPIDManager` — Pan/Tilt 2축 통합 관리
- **[PC → RPi]** 명령 포맷 변경 — 델타 보정값 → **절대 서보 각도(0~180°)**
  - `{"type": "servo_angle", "pan_angle": float, "tilt_angle": float}`
- **[PC]** EMA 평활화 위치 변경 — 입력 좌표 기준 → **출력 각도 기준**으로 전환

### Minor

- **[RPi]** `handle_command()` — 신규 `servo_angle` 타입 처리 추가 (구버전 방식 하위 호환 유지)

---

## v0.4.1 · 2026-05-01 · 서보 하드웨어 버그 수정

### Patch

- **[RPi]** PAN/TILT 채널 배선 오류 수정 (채널 0↔1 스왑 후 원복)
- **[RPi]** 틸트 서보 가동 범위 제한 (20~160°) — 물리적 한계 초과 방지
- **[RPi]** 카메라 영상 180도 회전 보정을 RPi → Electron으로 이동 (RPi 부담 감소)
- **[PC]** 보정 gain 반복 조정 — FOV 기반 최적값 탐색 (최종: 0.05°/px)
- **[PC]** tilt 부호 반전 수정 (카메라 뒤집힘 보정)
- **[PC]** 이중 Gain 제거, 축별 독립 데드존 적용
- **[PC]** `_correction_in_progress` 플래그 추가 — 보정 중복 요청 방지
- **[PC]** 추적 ON 시 EMA 상태 리셋 — 이전 세션 누적값 오보정 방지
- **[PC]** 기준 해상도 수정 (1920×1080 → 1280×720)

---

## v0.4.0 · 2026-05-01 · PCA9685 서보 드라이버 전환 ⚠️ Major 변경

> pigpio 기반 소프트웨어 PWM에서 PCA9685 I2C 하드웨어 PWM 보닛으로 전환.

### Major

- **[RPi]** 서보 드라이버 전환 — pigpio → **PCA9685 I2C PWM 보닛** (Adafruit ServoKit)
  - 워커 스레드 기반 부드러운 이동 (3°/step, 15ms 간격)
  - `MAX_LOOKAHEAD` 8° 제한으로 오버슈트 방지
- **[RPi]** 구버전 모터 모듈 (`RPi.GPIO`, `pigpio`) → `legacy/` 폴더로 이동

### Minor

- **[PC]** 배경 제거 / 자동 추적 기능 독립화 — 각각 독립 동작
- **[PC]** 객체 추적용 ReID AI 추가 (옷 색상 + 바운딩박스 겹침 기반)

### Patch

- **[PC]** RPi 영상 정지 현상 수정 — `captureStream→video` 체인 제거, `trackingCanvas` 직접 연결
- **[PC]** WASM 파일 제거 (불필요 용량 정리)

---

## v0.3.0 · 2026-04-30 · 영상 전송 방식 개선 및 추적 파이프라인 구현 ⚠️ Major 변경

> 영상 전송 포맷 변경으로 하위 호환 불가.

### Major

- **[RPi → PC]** 영상 전송 방식 변경 — Base64+JSON → **바이너리 직접 전송**
  - Electron 수신 영상 프레임레이트 대폭 향상

### Minor

- **[PC]** YOLO 감지 좌표 → `spotlight_core` 전송 경로 구현 (`sendObjectCoords`)
- **[PC]** `object_detected` 메시지 타입 처리 추가
- **[PC]** EMA 스무딩·서보 보간·좌표 전달 경로 통합

### Patch

- **[PC]** UI 스타일 개선

---

## v0.2.0 · 2026-04-28 ~ 04-29 · PC 서버 기초 구현 및 YOLO 연동

### Minor

- **[PC]** YOLO 브릿지 모듈(`yolo_bridge.py`) 추가 — 순환참조 방지 구조
- **[PC]** YOLO 탐지 연동 구현 (스레드풀 기반 탐지 후 보정 전송)
- **[PC]** 로거 공통 모듈(`get_logger()`) 분리
- **[PC]** 설정 상수 `modules/config.py`로 분리
- **[PC]** YOLO 모델 추가 (`yolo26n-seg`)
- **[PC]** `correction_module` EMA 스무딩 추가 — 좌표 노이즈 감소
- **[PC]** Object 패널 UI 추가

### Patch

- **[PC]** `modules` 폴더명 오타 수정 (`moduls` → `modules`)
- **[PC]** `__pycache__` .gitignore 추가
- **[PC]** 변수명 컨벤션 정리 (`cx/cy` → `center_x/center_y`)
- **[RPi]** 서보 핀 번호 오류 수정 (물리 핀 → BCM 변환)
- **[RPi]** 서보 보간 이동 추가 (단계적 이동)
- **[RPi]** pigpio 하드웨어 PWM 도입 시도 → 롤백 → 재도입 반복 (최종: pigpio 유지)

---

## v0.1.0 · 2026-04-02 ~ 04-15 · 프로젝트 초기 세팅

### Minor

- **[RPi]** 프로젝트 초기 생성
- **[RPi]** WebSocket 기반 영상 스트리밍 서버 구현
- **[RPi]** Pan/Tilt 서보 모터 모듈 초기 구현 (RPi.GPIO 기반)
- **[RPi]** `CameraModule` 분리 — Picamera2 백그라운드 캡처 스레드 적용
- **[RPi]** `install.sh` 작성 (가상환경 자동 설치 스크립트)
- **[RPi]** `tracking: on` 상태에서만 모터 작동하도록 조건 추가

### Patch

- **[RPi]** Docker 환경 구성 시도 → 실패 → venv 방식으로 전환
- **[RPi]** 카메라 해상도 조정 반복 — 640×480 → 1080p → 720p (최종 720p 확정)
- **[RPi]** `.gitignore` 정비
