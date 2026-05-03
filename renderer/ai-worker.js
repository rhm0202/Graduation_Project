/**
 * ai-worker.js
 * CPU 집약적인 픽셀 루프를 메인 스레드 밖에서 처리합니다.
 *
 * 메시지 타입:
 *   prep  { pixels: ArrayBuffer }                          → { tensorData: ArrayBuffer }
 *   mask  { bestCoeffs, protos, bestBox, framePixels, w, h } → { pixels: ArrayBuffer }
 *   clear { framePixels, w, h }                            → { pixels: ArrayBuffer }
 */

const MODEL_SIZE = 640;

// ─── 텐서 준비: RGBA Uint8 → CHW Float32 정규화 ─────────────────────────────
function prepTensor(pixels) {
  const n = MODEL_SIZE * MODEL_SIZE;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i]         = pixels[i * 4]     / 255;
    out[n + i]     = pixels[i * 4 + 1] / 255;
    out[2 * n + i] = pixels[i * 4 + 2] / 255;
  }
  return out;
}

// ─── 마스크 계산 + 알파 적용 ─────────────────────────────────────────────────
function applyMask(bestCoeffs, protos, bestBox, framePixels, w, h) {
  // 1. 160×160 마스크 계산 (sigmoid)
  const mask160 = new Float32Array(160 * 160);
  for (let p = 0; p < 160 * 160; p++) {
    let sum = 0;
    for (let c = 0; c < 32; c++) sum += bestCoeffs[c] * protos[c * 160 * 160 + p];
    mask160[p] = 1 / (1 + Math.exp(-sum));
  }

  const bx1 = Math.floor(bestBox.x1 * (160 / 640));
  const by1 = Math.floor(bestBox.y1 * (160 / 640));
  const bx2 = Math.ceil(bestBox.x2  * (160 / 640));
  const by2 = Math.ceil(bestBox.y2  * (160 / 640));

  // 2. 프레임 픽셀 알파 적용
  const pixels = new Uint8ClampedArray(framePixels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mx = Math.floor((x / w) * 160);
      const my = Math.floor((y / h) * 160);
      if (mx < bx1 || mx > bx2 || my < by1 || my > by2 || mask160[my * 160 + mx] < 0.75) {
        pixels[(y * w + x) * 4 + 3] = 0;
      }
    }
  }
  return pixels;
}

// ─── 전체 투명 처리 (미감지 시) ──────────────────────────────────────────────
function clearAlpha(framePixels, w, h) {
  const pixels = new Uint8ClampedArray(framePixels);
  const total = w * h;
  for (let i = 0; i < total; i++) pixels[i * 4 + 3] = 0;
  return pixels;
}

// ─── 메시지 핸들러 ────────────────────────────────────────────────────────────
self.onmessage = (e) => {
  const { id, type } = e.data;

  if (type === 'prep') {
    const tensorData = prepTensor(new Uint8ClampedArray(e.data.pixels));
    self.postMessage({ id, tensorData }, [tensorData.buffer]);

  } else if (type === 'mask') {
    const { bestCoeffs, protos, bestBox, framePixels, w, h } = e.data;
    const pixels = applyMask(
      new Float32Array(bestCoeffs),
      new Float32Array(protos),
      bestBox, framePixels, w, h
    );
    self.postMessage({ id, pixels }, [pixels.buffer]);

  } else if (type === 'clear') {
    const pixels = clearAlpha(e.data.framePixels, e.data.w, e.data.h);
    self.postMessage({ id, pixels }, [pixels.buffer]);
  }
};
