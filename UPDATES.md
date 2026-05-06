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
const UPDATE_SERVER_URL = 'https://raw.githubusercontent.com/rhm0202/Graduation_Project/main/updates/latest.json';
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
const UPDATE_SERVER_URL = 'https://your-server.com/updates/latest.json';
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

## 버전별 기능 추가 계획

### v1.0.0 (현재 릴리스 - 2026-05-06)
- OBS 스타일 Sources 패널 (웹캠/화면/창/RPi 소스, 레이어 컴포지팅)
- 실시간 AI 배경 제거 (ONNX/SegFormer)
- 배경 교체 기능 (이미지/동영상/단색)
- 라즈베리파이 WebSocket 연동 (spotlight_core.py)
- 팬/틸트 모터 자동 추적 모드
- 자동 업데이트 기능
- 이벤트 리스너 최적화 (이벤트 위임 패턴)
- Audio Mixer 볼륨 미터 수정
- UI 레이아웃 개선 (리사이즈 바, 패널 비율 조정)

### v1.0.1 (예정)
- 해상도/프레임레이트 설정 실제 적용 (현재 UI만 존재)
- 에러 처리 개선 (에러 유형별 사용자 안내 메시지)
- WebSocket 자동 재연결 (최대 3회)

### v1.1.0 (예정)
- YOLO 모델 완전 통합 (현재 시뮬레이션 상태)
- 스트리밍 기능 (RTMP 등)
- 다국어 지원
