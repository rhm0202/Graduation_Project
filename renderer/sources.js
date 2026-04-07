/**
 * 소스 관리 모듈
 * 소스 목록 렌더링, 추가/삭제/이동/선택 기능을 담당합니다.
 */
import { state } from './state.js';

/**
 * 소스 목록을 UI에 렌더링합니다.
 */
export function renderSources() {
  const sourcesList = document.getElementById('sources-list');
  const sourcesEmpty = document.getElementById('sources-empty');
  if (!sourcesList) return;

  sourcesList.innerHTML = '';

  if (state.sources.length === 0) {
    sourcesList.style.display = 'none';
    if (sourcesEmpty) sourcesEmpty.style.display = 'block';
    return;
  }

  sourcesList.style.display = 'block';
  if (sourcesEmpty) sourcesEmpty.style.display = 'none';

  const icons = { video: '📹', image: '🖼️', text: '📝' };

  state.sources.forEach((source) => {
    const li = document.createElement('li');
    li.className = 'source-item';
    li.dataset.sourceId = source.id;
    if (source.id === state.selectedSourceId) li.classList.add('selected');

    const icon = document.createElement('span');
    icon.className = 'source-icon';
    icon.textContent = icons[source.type] || '';

    const name = document.createElement('span');
    name.className = 'source-name';
    name.textContent = source.name;

    li.appendChild(icon);
    li.appendChild(name);
    li.addEventListener('click', () => selectSource(source.id));
    sourcesList.appendChild(li);
  });
}

function openAddSourceModal() {
  const modal = document.getElementById('add-source-modal');
  const videoOption = document.getElementById('video-option');
  const imageOption = document.getElementById('image-option');
  const textOption = document.getElementById('text-option');
  const sourceVideoDevice = document.getElementById('source-video-device');

  if (sourceVideoDevice) {
    sourceVideoDevice.innerHTML = '';
    document.getElementById('video-source')?.querySelectorAll('option').forEach((option) => {
      sourceVideoDevice.appendChild(option.cloneNode(true));
    });
  }

  document.querySelectorAll('input[name="source-type"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const type = e.target.value;
      if (videoOption) videoOption.style.display = type === 'video' ? 'flex' : 'none';
      if (imageOption) imageOption.style.display = type === 'image' ? 'flex' : 'none';
      if (textOption) textOption.style.display = type === 'text' ? 'flex' : 'none';
    });
  });

  if (modal) modal.classList.add('visible');
}

function closeAddSourceModal() {
  document.getElementById('add-source-modal')?.classList.remove('visible');
  const sourceName = document.getElementById('source-name');
  const sourceText = document.getElementById('source-text-content');
  const sourceImage = document.getElementById('source-image-file');
  if (sourceName) sourceName.value = '';
  if (sourceText) sourceText.value = '';
  if (sourceImage) sourceImage.value = '';
}

function finishAddSource(name, data) {
  state.sources.push({ id: state.nextSourceId++, name, ...data });
  renderSources();
  closeAddSourceModal();
}

function addSource() {
  const sourceType = document.querySelector('input[name="source-type"]:checked')?.value;
  const sourceName = document.getElementById('source-name')?.value || `Source ${state.nextSourceId}`;
  if (!sourceType) return;

  if (sourceType === 'video') {
    const deviceId = document.getElementById('source-video-device')?.value;
    if (!deviceId) { alert('비디오 장치를 선택하세요.'); return; }
    finishAddSource(sourceName, { type: 'video', deviceId });
  } else if (sourceType === 'image') {
    const fileInput = document.getElementById('source-image-file');
    if (!fileInput?.files?.[0]) { alert('이미지 파일을 선택하세요.'); return; }
    const reader = new FileReader();
    reader.onload = (e) => finishAddSource(sourceName, { type: 'image', imageUrl: e.target.result, fileName: fileInput.files[0].name });
    reader.readAsDataURL(fileInput.files[0]);
  } else if (sourceType === 'text') {
    const textContent = document.getElementById('source-text-content')?.value;
    if (!textContent) { alert('텍스트 내용을 입력하세요.'); return; }
    finishAddSource(sourceName, { type: 'text', content: textContent });
  }
}

function selectSource(sourceId) {
  state.selectedSourceId = sourceId;
  renderSources();
}

function removeSource() {
  if (state.selectedSourceId === null) { alert('삭제할 소스를 선택하세요.'); return; }
  const index = state.sources.findIndex((s) => s.id === state.selectedSourceId);
  if (index !== -1) {
    state.sources.splice(index, 1);
    state.selectedSourceId = null;
    renderSources();
  }
}

function moveSourceUp() {
  if (state.selectedSourceId === null) return;
  const idx = state.sources.findIndex((s) => s.id === state.selectedSourceId);
  if (idx <= 0) return;
  [state.sources[idx - 1], state.sources[idx]] = [state.sources[idx], state.sources[idx - 1]];
  renderSources();
}

function moveSourceDown() {
  if (state.selectedSourceId === null) return;
  const idx = state.sources.findIndex((s) => s.id === state.selectedSourceId);
  if (idx >= state.sources.length - 1) return;
  [state.sources[idx], state.sources[idx + 1]] = [state.sources[idx + 1], state.sources[idx]];
  renderSources();
}

/**
 * 소스 패널 이벤트 리스너를 초기화합니다.
 */
export function setupSourcesPanel() {
  const sourcesPanel = document.getElementById('sources-panel');
  if (!sourcesPanel) return;

  const newPanel = sourcesPanel.cloneNode(true);
  sourcesPanel.parentNode.replaceChild(newPanel, sourcesPanel);

  newPanel.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.target.closest('button');
    if (!btn) return;
    const actions = {
      'add-source-btn': openAddSourceModal,
      'remove-source-btn': removeSource,
      'source-settings-btn': () => {
        if (state.selectedSourceId === null) alert('설정할 소스를 선택하세요.');
        else alert('소스 설정 기능은 추후 구현 예정입니다.');
      },
      'move-source-up-btn': moveSourceUp,
      'move-source-down-btn': moveSourceDown,
    };
    actions[btn.id]?.();
  });

  document.getElementById('add-source-confirm')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    addSource();
  });

  document.getElementById('cancel-add-source')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeAddSourceModal();
  });

  renderSources();
}
