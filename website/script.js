// 업데이트 정보를 가져오는 함수
async function loadUpdateInfo() {
    try {
        const response = await fetch('https://raw.githubusercontent.com/rhm0202/Graduation_Project/main/updates/latest.json');
        if (!response.ok) throw new Error('업데이트 정보를 가져올 수 없습니다.');
        
        const data = await response.json();
        
        // 버전 정보 업데이트
        const currentVersionEl = document.getElementById('current-version');
        const releaseDateEl = document.getElementById('release-date');
        const releaseVersionEl = document.getElementById('release-version');
        const releaseDateFullEl = document.getElementById('release-date-full');
        
        if (currentVersionEl) currentVersionEl.textContent = `v${data.version}`;
        if (releaseDateEl) releaseDateEl.textContent = formatDate(data.releaseDate);
        if (releaseVersionEl) releaseVersionEl.textContent = `v${data.version}`;
        if (releaseDateFullEl) releaseDateFullEl.textContent = formatDate(data.releaseDate);
        
        // 릴리스 노트 업데이트
        const releaseNotes = document.getElementById('release-notes');
        if (releaseNotes) {
            releaseNotes.textContent = data.releaseNotes || '릴리스 노트가 없습니다.';
        }
        
        // 다운로드 링크 업데이트
        const downloadLink = document.getElementById('download-link');
        const downloadWindows = document.getElementById('download-windows');
        
        if (data.downloadUrl) {
            if (downloadLink) downloadLink.href = data.downloadUrl;
            if (downloadWindows) downloadWindows.href = data.downloadUrl;
        }
        
    } catch (error) {
        console.error('업데이트 정보 로딩 실패:', error);
        const currentVersionEl = document.getElementById('current-version');
        const releaseDateEl = document.getElementById('release-date');
        if (currentVersionEl) currentVersionEl.textContent = '로딩 실패';
        if (releaseDateEl) releaseDateEl.textContent = '로딩 실패';
    }
}

// 날짜 포맷팅 함수
function formatDate(dateString) {
    if (!dateString) return '날짜 없음';
    
    try {
        // "YYYY-MM-DD" 형식을 직접 파싱 (시간대 문제 방지)
        const parts = dateString.split('-');
        if (parts.length === 3) {
            const year = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10);
            const day = parseInt(parts[2], 10);
            return `${year}년 ${month}월 ${day}일`;
        }
        
        // 폴백: Date 객체 사용
        const date = new Date(dateString);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        return `${year}년 ${month}월 ${day}일`;
    } catch (e) {
        return dateString;
    }
}

// 스무스 스크롤
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const targetId = this.getAttribute('href');
        if (targetId === '#') return;
        
        const target = document.querySelector(targetId);
        if (target) {
            const headerOffset = 80;
            const elementPosition = target.getBoundingClientRect().top;
            const offsetPosition = elementPosition + window.pageYOffset - headerOffset;

            window.scrollTo({
                top: offsetPosition,
                behavior: 'smooth'
            });
        }
    });
});

// 진행 상황 애니메이션
function animateProgressBars() {
    const progressBars = document.querySelectorAll('.progress-fill');
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const width = entry.target.style.width;
                entry.target.style.width = '0%';
                setTimeout(() => {
                    entry.target.style.width = width;
                }, 200);
                observer.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.1
    });
    
    progressBars.forEach(bar => observer.observe(bar));
}

// 헤더 스크롤 효과
let lastScroll = 0;
const header = document.querySelector('.header');

window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset;
    
    if (currentScroll > 100) {
        header.style.background = 'rgba(30, 41, 59, 0.95)';
    } else {
        header.style.background = 'rgba(30, 41, 59, 0.8)';
    }
    
    lastScroll = currentScroll;
});

// 모바일 메뉴 토글
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const nav = document.querySelector('.nav');

if (mobileMenuBtn && nav) {
    mobileMenuBtn.addEventListener('click', () => {
        nav.classList.toggle('mobile-open');
        mobileMenuBtn.classList.toggle('active');
    });
}

// 페이지 로드 시 초기화
document.addEventListener('DOMContentLoaded', () => {
    loadUpdateInfo();
    animateProgressBars();
    
    // 카드 호버 효과 강화
    const cards = document.querySelectorAll('.feature-card, .download-card, .team-member');
    cards.forEach(card => {
        card.addEventListener('mouseenter', function() {
            this.style.transform = 'translateY(-8px)';
        });
        card.addEventListener('mouseleave', function() {
            this.style.transform = 'translateY(0)';
        });
    });
});

// 에러 처리
window.addEventListener('error', (e) => {
    console.error('페이지 오류:', e);
});

// 네트워크 오류 처리
window.addEventListener('online', () => {
    console.log('인터넷 연결 복구됨');
    loadUpdateInfo();
});

window.addEventListener('offline', () => {
    console.log('인터넷 연결 끊김');
});

