/**
 * BoT-SORT JS Implementation
 * Combines Bounding Box IoU + Kalman Filter with OSNet ReID Features
 *
 * 개선사항:
 * - 2단계 매칭 (확정 트랙 → 미확정 트랙)
 * - ReID 매칭 시 공간 게이트 적용 (먼 거리 ID 스왑 방지)
 * - 트랙 확정 시스템 (최소 3회 연속 감지 후 확정)
 */

// ─────────────────────────────────────────────────────────
// Kalman Filter (Constant Velocity Model)
// ─────────────────────────────────────────────────────────

class KalmanFilter {
  constructor() {
    this.ndim = 4;
    this.dt = 1;
    this.A = [
      [1, 0, 0, 0, this.dt, 0, 0, 0],
      [0, 1, 0, 0, 0, this.dt, 0, 0],
      [0, 0, 1, 0, 0, 0, this.dt, 0],
      [0, 0, 0, 1, 0, 0, 0, this.dt],
      [0, 0, 0, 0, 1, 0, 0, 0],
      [0, 0, 0, 0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0, 0, 1, 0],
      [0, 0, 0, 0, 0, 0, 0, 1],
    ];
    this.H = [
      [1, 0, 0, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0, 0],
    ];
    this.P = Array.from({ length: 8 }, (_, i) =>
      Array.from({ length: 8 }, (_, j) => (i === j ? (i < 4 ? 10 : 100) : 0))
    );
    this.Q = Array.from({ length: 8 }, (_, i) =>
      Array.from({ length: 8 }, (_, j) => (i === j ? (i < 4 ? 1 : 0.01) : 0))
    );
    this.R = Array.from({ length: 4 }, (_, i) =>
      Array.from({ length: 4 }, (_, j) => (i === j ? 10 : 0))
    );
  }

  init(measurement) {
    this.x = [...measurement, 0, 0, 0, 0];
  }

  predict() {
    // x = A * x
    const nx = new Array(8).fill(0);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        nx[i] += this.A[i][j] * this.x[j];
      }
    }
    this.x = nx;

    // P = A * P * A^T + Q
    const temp = Array.from({ length: 8 }, () => new Array(8).fill(0));
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        for (let k = 0; k < 8; k++) {
          temp[i][j] += this.A[i][k] * this.P[k][j];
        }
      }
    }
    const nP = Array.from({ length: 8 }, () => new Array(8).fill(0));
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        for (let k = 0; k < 8; k++) {
          nP[i][j] += temp[i][k] * this.A[j][k]; // A^T
        }
        nP[i][j] += this.Q[i][j];
      }
    }
    this.P = nP;
  }

  update(measurement) {
    // y = z - H * x
    const y = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      let hx = 0;
      for (let j = 0; j < 8; j++) hx += this.H[i][j] * this.x[j];
      y[i] = measurement[i] - hx;
    }

    // S = H * P * H^T + R
    const HP = Array.from({ length: 4 }, () => new Array(8).fill(0));
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 8; j++) {
        for (let k = 0; k < 8; k++) HP[i][j] += this.H[i][k] * this.P[k][j];
      }
    }
    const S = Array.from({ length: 4 }, () => new Array(4).fill(0));
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        for (let k = 0; k < 8; k++) S[i][j] += HP[i][k] * this.H[j][k];
        S[i][j] += this.R[i][j];
      }
    }

    // K = P * H^T * S^-1 (diagonal approximation)
    const K = Array.from({ length: 8 }, () => new Array(4).fill(0));
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 4; j++) {
        let PHT = 0;
        for (let k = 0; k < 8; k++) PHT += this.P[i][k] * this.H[j][k];
        K[i][j] = PHT / (S[j][j] + 1e-6);
      }
    }

    // x = x + K * y
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 4; j++) this.x[i] += K[i][j] * y[j];
    }

    // P = (I - K * H) * P
    const I_KH = Array.from({ length: 8 }, (_, i) =>
      Array.from({ length: 8 }, (_, j) => (i === j ? 1 : 0))
    );
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        for (let k = 0; k < 4; k++) I_KH[i][j] -= K[i][k] * this.H[k][j];
      }
    }
    const nP = Array.from({ length: 8 }, () => new Array(8).fill(0));
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        for (let k = 0; k < 8; k++) nP[i][j] += I_KH[i][k] * this.P[k][j];
      }
    }
    this.P = nP;
  }
}

// ─────────────────────────────────────────────────────────
// Track
// ─────────────────────────────────────────────────────────

const MIN_HITS = 3; // 트랙이 "확정"되기 위한 최소 연속 감지 횟수

class Track {
  constructor(id, box, feature) {
    this.id = id;
    this.kf = new KalmanFilter();
    this.kf.init(this.boxToZ(box));
    this.features = feature ? [...feature] : null;
    this.timeSinceUpdate = 0;
    this.hits = 1;
    this.box = box; // {x1, y1, x2, y2}
  }

  get confirmed() {
    return this.hits >= MIN_HITS;
  }

  boxToZ(box) {
    const w = box.x2 - box.x1;
    const h = box.y2 - box.y1;
    const x = box.x1 + w / 2;
    const y = box.y1 + h / 2;
    return [x, y, w / h, h];
  }

  zToBox(z) {
    const w = z[2] * z[3];
    const h = z[3];
    return {
      x1: z[0] - w / 2,
      y1: z[1] - h / 2,
      x2: z[0] + w / 2,
      y2: z[1] + h / 2,
    };
  }

  predict() {
    this.kf.predict();
    this.box = this.zToBox(this.kf.x);
    this.timeSinceUpdate += 1;
  }

  update(box, feature) {
    this.timeSinceUpdate = 0;
    this.hits += 1;
    this.kf.update(this.boxToZ(box));
    this.box = this.zToBox(this.kf.x);

    // Update ReID feature with EMA
    if (feature && this.features) {
      const alpha = 0.9;
      let sumSq = 0;
      for (let i = 0; i < this.features.length; i++) {
        this.features[i] = alpha * this.features[i] + (1 - alpha) * feature[i];
        sumSq += this.features[i] * this.features[i];
      }
      // Normalize
      const norm = Math.sqrt(sumSq) + 1e-6;
      for (let i = 0; i < this.features.length; i++) {
        this.features[i] /= norm;
      }
    } else if (feature) {
      this.features = [...feature];
    }
  }
}

// ─────────────────────────────────────────────────────────
// BoT-SORT Tracker
// ─────────────────────────────────────────────────────────

let trackIdCounter = 1;

export class BoTSORT {
  constructor() {
    this.tracks = [];
    this.maxAge = 50;           // 미감지 허용 프레임 수 (30→50)
    this.reidThreshold = 0.45;  // ReID cosine distance 임계값
    this.iouThreshold = 0.2;    // IoU 매칭 최소 임계값
    this.maxReidCenterDist = 250; // ReID 적용 최대 중심 거리 (px, 640x640 기준)
  }

  async update(detections, sourceCanvas, osnetSession) {
    // 1. 모든 감지 결과에 대해 ReID 특성 추출
    const detFeatures = [];
    for (let det of detections) {
      let feature = null;
      if (osnetSession && sourceCanvas) {
        feature = await this.extractFeature(det.box, sourceCanvas, osnetSession);
      }
      detFeatures.push({ ...det, feature });
    }

    // 2. 기존 트랙의 다음 상태 예측
    for (let trk of this.tracks) {
      trk.predict();
    }

    // 3. 2단계 매칭
    const confirmedIdx = [];
    const unconfirmedIdx = [];
    this.tracks.forEach((_, i) => {
      if (this.tracks[i].confirmed) confirmedIdx.push(i);
      else unconfirmedIdx.push(i);
    });
    const allDetIdx = detFeatures.map((_, i) => i);

    // Stage 1: 확정 트랙 ↔ 전체 감지 (IoU + ReID, 공간 게이트 적용)
    const { matches: m1, unmatchedTrks: ut1, unmatchedDets: ud1 } =
      this._greedyMatch(confirmedIdx, allDetIdx, detFeatures, true);

    for (const [ti, di] of m1) {
      this.tracks[ti].update(detFeatures[di].box, detFeatures[di].feature);
      detFeatures[di].trackId = this.tracks[ti].id;
    }

    // Stage 2: 미확정 트랙 + Stage1 미매칭 확정 트랙 ↔ 남은 감지 (IoU만)
    const stage2TrkIdx = [...unconfirmedIdx, ...ut1];
    const { matches: m2, unmatchedDets: ud2 } =
      this._greedyMatch(stage2TrkIdx, ud1, detFeatures, false);

    for (const [ti, di] of m2) {
      this.tracks[ti].update(detFeatures[di].box, detFeatures[di].feature);
      detFeatures[di].trackId = this.tracks[ti].id;
    }

    // 4. 미매칭 감지 → 새 트랙 생성
    for (const d of ud2) {
      const det = detFeatures[d];
      if (!det.trackId) {
        const newTrack = new Track(trackIdCounter++, det.box, det.feature);
        this.tracks.push(newTrack);
        det.trackId = newTrack.id;
      }
    }

    // 5. 수명 초과 트랙 제거
    this.tracks = this.tracks.filter((t) => t.timeSinceUpdate <= this.maxAge);

    return detFeatures;
  }

  /**
   * Greedy 매칭 (트랙 인덱스 ↔ 감지 인덱스)
   * @param {number[]} trkIndices  - this.tracks 내 인덱스 배열
   * @param {number[]} detIndices  - detFeatures 내 인덱스 배열
   * @param {object[]} detFeatures - 감지 특성 배열
   * @param {boolean}  useReID     - ReID 사용 여부
   */
  _greedyMatch(trkIndices, detIndices, detFeatures, useReID) {
    const costList = [];

    for (const ti of trkIndices) {
      for (const di of detIndices) {
        const trk = this.tracks[ti];
        const det = detFeatures[di];
        const iou = this.calculateIoU(trk.box, det.box);
        const iouDist = 1 - iou;

        let cost = 1e5;

        if (useReID && trk.features && det.feature) {
          const reidDist = this.cosineDistance(trk.features, det.feature);
          const centerDist = this._centerDistance(trk.box, det.box);

          // ★ 공간 게이트: ReID는 두 박스가 충분히 가까울 때만 적용
          //   → 멀리 있는 사람끼리 옷이 비슷해도 ID 스왑 방지
          if (centerDist < this.maxReidCenterDist) {
            // 두 지표 모두 나쁘면 거부
            if (reidDist < 0.7 || iouDist < 0.85) {
              cost = 0.6 * reidDist + 0.4 * iouDist;
            }
          } else if (iou > this.iouThreshold) {
            // 멀지만 IoU가 있는 경우 (빠른 이동) → IoU만 사용
            cost = iouDist;
          }
        } else {
          // ReID 없이 IoU만 사용
          if (iou > this.iouThreshold) {
            cost = iouDist;
          }
        }

        if (cost < 1e4) {
          costList.push({ ti, di, cost });
        }
      }
    }

    costList.sort((a, b) => a.cost - b.cost);

    const matches = [];
    const matchedTrks = new Set();
    const matchedDets = new Set();

    for (const { ti, di } of costList) {
      if (!matchedTrks.has(ti) && !matchedDets.has(di)) {
        matches.push([ti, di]);
        matchedTrks.add(ti);
        matchedDets.add(di);
      }
    }

    const unmatchedTrks = trkIndices.filter((i) => !matchedTrks.has(i));
    const unmatchedDets = detIndices.filter((i) => !matchedDets.has(i));

    return { matches, unmatchedTrks, unmatchedDets };
  }

  /** 두 박스의 중심점 간 유클리드 거리 */
  _centerDistance(box1, box2) {
    const cx1 = (box1.x1 + box1.x2) / 2;
    const cy1 = (box1.y1 + box1.y2) / 2;
    const cx2 = (box2.x1 + box2.x2) / 2;
    const cy2 = (box2.y1 + box2.y2) / 2;
    return Math.sqrt((cx1 - cx2) ** 2 + (cy1 - cy2) ** 2);
  }

  async extractFeature(box, canvas, session) {
    const OSNET_W = 128;
    const OSNET_H = 256;

    const bx1 = Math.max(0, Math.floor(box.x1));
    const by1 = Math.max(0, Math.floor(box.y1));
    const bx2 = Math.min(canvas.width, Math.ceil(box.x2));
    const by2 = Math.min(canvas.height, Math.ceil(box.y2));
    const bw = bx2 - bx1;
    const bh = by2 - by1;

    if (bw <= 0 || bh <= 0) return null;

    // Crop to temporary canvas
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = OSNET_W;
    tempCanvas.height = OSNET_H;
    const ctx = tempCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, bx1, by1, bw, bh, 0, 0, OSNET_W, OSNET_H);

    const imgData = ctx.getImageData(0, 0, OSNET_W, OSNET_H).data;
    const floatData = new Float32Array(3 * OSNET_W * OSNET_H);

    // ImageNet Normalization (required for OSNet)
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];

    let i = 0;
    for (let y = 0; y < OSNET_H; y++) {
      for (let x = 0; x < OSNET_W; x++) {
        const offset = (y * OSNET_W + x) * 4;
        const r = imgData[offset] / 255.0;
        const g = imgData[offset + 1] / 255.0;
        const b = imgData[offset + 2] / 255.0;

        floatData[i] = (r - mean[0]) / std[0]; // R
        floatData[OSNET_W * OSNET_H + i] = (g - mean[1]) / std[1]; // G
        floatData[2 * OSNET_W * OSNET_H + i] = (b - mean[2]) / std[2]; // B
        i++;
      }
    }

    const tensor = new ort.Tensor("float32", floatData, [1, 3, OSNET_H, OSNET_W]);
    const feeds = { [session.inputNames[0]]: tensor };

    try {
      const results = await session.run(feeds);
      const feature = results[session.outputNames[0]].data;

      // L2 Normalize
      let sumSq = 0;
      for (let j = 0; j < feature.length; j++) sumSq += feature[j] * feature[j];
      const norm = Math.sqrt(sumSq) + 1e-6;
      for (let j = 0; j < feature.length; j++) feature[j] /= norm;

      return feature;
    } catch (e) {
      console.error("OSNet 추론 오류:", e);
      return null;
    }
  }

  calculateIoU(box1, box2) {
    const xA = Math.max(box1.x1, box2.x1);
    const yA = Math.max(box1.y1, box2.y1);
    const xB = Math.min(box1.x2, box2.x2);
    const yB = Math.min(box1.y2, box2.y2);

    const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
    const box1Area = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
    const box2Area = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);

    const iou = interArea / (box1Area + box2Area - interArea + 1e-6);
    return iou;
  }

  cosineDistance(feat1, feat2) {
    if (!feat1 || !feat2 || feat1.length !== feat2.length) return 1;
    let dotProduct = 0;
    for (let i = 0; i < feat1.length; i++) {
      dotProduct += feat1[i] * feat2[i];
    }
    // cosine distance = 1 - cosine similarity
    return 1 - dotProduct;
  }
}
