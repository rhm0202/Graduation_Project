# Spotlight Cam 개발 현황 웹사이트

프로젝트의 개발 현황을 게시하는 동적 웹사이트입니다.

## 배포 방법

### GitHub Pages 사용

1. GitHub 저장소로 이동: https://github.com/wer134/application
2. **Settings** 탭 클릭
3. 왼쪽 메뉴에서 **Pages** 선택
4. **Source** 섹션에서:
   - Branch: `main` 선택
   - Folder: `/website` 선택
5. **Save** 클릭
6. 몇 분 후 웹사이트가 배포됩니다
7. 배포된 URL: `https://wer134.github.io/application/`

### 로컬에서 테스트

```bash
# Python 3 사용
cd website
python -m http.server 8000

# 또는 Node.js 사용
npx http-server website -p 8000
```

브라우저에서 `http://localhost:8000` 접속

## 기능

- ✅ 동적 버전 정보 로딩 (GitHub에서 자동 업데이트)
- ✅ 개발 진행 상황 시각화
- ✅ 반응형 디자인 (모바일 지원)
- ✅ 현대적인 UI/UX
- ✅ 스무스 스크롤 및 애니메이션
- ✅ 다크 테마

## 파일 구조

```
website/
├── index.html      # 메인 HTML 파일
├── styles.css      # 스타일시트
├── script.js        # JavaScript (동적 데이터 로딩)
└── README.md       # 이 파일
```

## 업데이트

웹사이트는 `updates/latest.json` 파일을 자동으로 읽어서 최신 버전 정보를 표시합니다.
새 버전이 릴리스되면 자동으로 웹사이트에 반영됩니다.

