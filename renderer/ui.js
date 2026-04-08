/**
 * UI 상호작용 모듈
 * 드롭다운 메뉴, 패널 리사이즈, Transform 모달, 앱 메뉴 이벤트를 담당합니다.
 */
import { isElectron } from "./state.js";
import { checkForUpdatesManually } from "./updates.js";

/**
 * 드롭다운 메뉴를 클릭 방식으로 초기화합니다.
 */
export function setupDropdownMenus() {
  const menuItems = document.querySelectorAll(".menu-item");
  let activeMenu = null;

  menuItems.forEach((menuItem) => {
    menuItem.querySelector("span")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeMenu === menuItem) {
        menuItem.classList.remove("active");
        activeMenu = null;
      } else {
        activeMenu?.classList.remove("active");
        menuItem.classList.add("active");
        activeMenu = menuItem;
      }
    });

    menuItem.querySelectorAll(".dropdown-menu li").forEach((item) => {
      item.addEventListener("click", () => {
        setTimeout(() => {
          menuItem.classList.remove("active");
          activeMenu = null;
        }, 100);
      });
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu-item") && activeMenu) {
      activeMenu.classList.remove("active");
      activeMenu = null;
    }
  });
}

/**
 * 하단 패널 리사이즈 기능을 초기화합니다.
 */
export function setupPreviewResize() {
  const previewArea = document.getElementById("preview-area");
  const docksContainer = document.getElementById("docks-container");
  const resizeBar = document.getElementById("docks-resize-bar");
  if (!previewArea || !docksContainer || !resizeBar) return;

  let isResizing = false;
  let startY = 0;
  let startPreviewHeight = 0;
  let startDocksHeight = 0;

  resizeBar.addEventListener("mousedown", (e) => {
    isResizing = true;
    startY = e.clientY;
    startPreviewHeight = previewArea.offsetHeight;
    startDocksHeight = docksContainer.offsetHeight;
    e.preventDefault();
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;
    const deltaY = e.clientY - startY;
    const newPreviewHeight = startPreviewHeight + deltaY;
    const newDocksHeight = startDocksHeight - deltaY;
    const minPreviewHeight = 200;
    const minDocksHeight = 150;
    const maxPreviewHeight = window.innerHeight - 200;

    if (
      newPreviewHeight >= minPreviewHeight &&
      newPreviewHeight <= maxPreviewHeight &&
      newDocksHeight >= minDocksHeight
    ) {
      previewArea.style.height = newPreviewHeight + "px";
      previewArea.style.flexGrow = "0";
      docksContainer.style.height = newDocksHeight + "px";
      docksContainer.style.flexGrow = "0";
    }
  });

  document.addEventListener("mouseup", () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });
}

/**
 * 앱 메뉴(종료, 복사, 붙여넣기 등) 이벤트 리스너를 초기화합니다.
 */
export function setupAppMenus() {
  const exitFunc = () => {
    if (isElectron) window.electronAPI.send("exit-app");
    else alert("프로그램을 종료합니다. (목업)");
  };
  document.getElementById("exit-button")?.addEventListener("click", exitFunc);
  document.getElementById("menu-exit")?.addEventListener("click", exitFunc);

  ["menu-toggle-fullscreen", "menu-reload"].forEach(
    (evt) => {
      document.getElementById(evt)?.addEventListener("click", () => {
        if (isElectron) window.electronAPI.send(evt);
      });
    },
  );

  document.getElementById("menu-toggle-docks")?.addEventListener("click", () => {
    const docks = document.getElementById("docks-container");
    const resizeBar = document.getElementById("docks-resize-bar");
    const hidden = docks?.classList.toggle("docks-hidden");
    resizeBar?.classList.toggle("docks-hidden", hidden);
  });

  document
    .getElementById("menu-show-recordings")
    ?.addEventListener("click", () => {
      if (isElectron && window.electronAPI.invoke) {
        window.electronAPI
          .invoke("show-recordings")
          .then((files) => {
            if (files?.length > 0)
              alert(
                `녹화 파일 목록:\n\n${files.map((f) => `• ${f}`).join("\n")}`,
              );
            else alert("저장된 녹화 파일이 없습니다.");
          })
          .catch(() => alert("녹화 파일 목록을 가져올 수 없습니다."));
      } else {
        alert("Electron 환경에서만 사용 가능합니다.");
      }
    });

  document.getElementById("menu-settings")?.addEventListener("click", () => {
    document.getElementById("open-settings")?.click();
  });

  document
    .getElementById("menu-check-updates")
    ?.addEventListener("click", checkForUpdatesManually);

  document.getElementById("menu-about")?.addEventListener("click", () => {
    alert(
      "Spotlight Cam v1.0.0\n\n크로마키를 대체하는 AI 객체 추적 및 배경 제거 시스템\n\n팀: Anywhere Studio",
    );
  });
}

/**
 * GPU 상태 표시 리스너를 초기화합니다.
 */
export function setupGpuStatusListeners() {
  if (typeof window.electronAPI === "undefined") return;

  window.electronAPI.onGpuUsage?.((usage) => {
    const el = document.getElementById("gpu-status");
    if (el) el.textContent = `GPU: ${usage.toFixed(1)}%`;
  });

  window.electronAPI.onGpuName?.((name) => {
    const el = document.getElementById("gpu-name-status");
    if (el) el.textContent = `${name} | `;
  });
}
