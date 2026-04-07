/**
 * 장면 관리 모듈
 * 장면 목록 렌더링, 추가/삭제/이동/전환 기능을 담당합니다.
 */
import { state } from './state.js';

/**
 * 장면 목록을 UI에 렌더링합니다.
 */
export function renderScenes() {
  const scenesList = document.getElementById('scenes-list');
  if (!scenesList) return;

  scenesList.innerHTML = '';
  state.scenes.forEach((scene) => {
    const li = document.createElement('li');
    li.className = 'scene-item';
    li.dataset.sceneId = scene.id;
    li.textContent = scene.name;
    if (scene.id === state.currentSceneId) li.classList.add('active');
    li.addEventListener('click', () => switchScene(scene.id));
    scenesList.appendChild(li);
  });
}

function openAddSceneModal() {
  const modal = document.getElementById('add-scene-modal');
  const sceneNameInput = document.getElementById('scene-name-input');

  if (modal) {
    modal.classList.add('visible');
    if (sceneNameInput) {
      sceneNameInput.value = `Scene ${state.scenes.length + 1}`;
      sceneNameInput.focus();
      sceneNameInput.select();
    }
  }
}

function closeAddSceneModal() {
  const modal = document.getElementById('add-scene-modal');
  const sceneNameInput = document.getElementById('scene-name-input');
  if (modal) modal.classList.remove('visible');
  if (sceneNameInput) sceneNameInput.value = '';
}

function addScene() {
  const sceneNameInput = document.getElementById('scene-name-input');
  const sceneName = sceneNameInput?.value?.trim();

  if (!sceneName) {
    alert('장면 이름을 입력하세요.');
    sceneNameInput?.focus();
    return;
  }

  const newId = Math.max(...state.scenes.map((s) => s.id), -1) + 1;
  state.scenes.push({ id: newId, name: sceneName });
  renderScenes();
  switchScene(newId);
  closeAddSceneModal();
}

function removeScene() {
  if (state.scenes.length <= 1) {
    alert('최소 하나의 장면이 필요합니다.');
    return;
  }

  const sceneIndex = state.scenes.findIndex((s) => s.id === state.currentSceneId);
  if (sceneIndex === -1) return;

  state.scenes.splice(sceneIndex, 1);
  state.currentSceneId =
    sceneIndex >= state.scenes.length
      ? state.scenes[state.scenes.length - 1].id
      : state.scenes[sceneIndex].id;

  renderScenes();
}

function moveSceneUp() {
  const idx = state.scenes.findIndex((s) => s.id === state.currentSceneId);
  if (idx <= 0) return;
  [state.scenes[idx - 1], state.scenes[idx]] = [state.scenes[idx], state.scenes[idx - 1]];
  renderScenes();
}

function moveSceneDown() {
  const idx = state.scenes.findIndex((s) => s.id === state.currentSceneId);
  if (idx >= state.scenes.length - 1) return;
  [state.scenes[idx], state.scenes[idx + 1]] = [state.scenes[idx + 1], state.scenes[idx]];
  renderScenes();
}

function switchScene(sceneId) {
  if (!state.scenes.find((s) => s.id === sceneId)) return;
  state.currentSceneId = sceneId;
  renderScenes();
}

/**
 * 장면 패널 이벤트 리스너를 초기화합니다.
 */
export function setupScenesPanel() {
  const scenesPanel = document.getElementById('scenes-panel');
  if (!scenesPanel) return;

  const newPanel = scenesPanel.cloneNode(true);
  scenesPanel.parentNode.replaceChild(newPanel, scenesPanel);

  newPanel.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.target.closest('button');
    if (!btn) return;
    const actions = {
      'add-scene-btn': openAddSceneModal,
      'remove-scene-btn': removeScene,
      'move-scene-up-btn': moveSceneUp,
      'move-scene-down-btn': moveSceneDown,
    };
    actions[btn.id]?.();
  });

  document.getElementById('add-scene-confirm')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    addScene();
  });

  document.getElementById('cancel-add-scene')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeAddSceneModal();
  });

  document.getElementById('scene-name-input')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addScene();
    }
  });

  renderScenes();
}
