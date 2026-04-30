/**
 * BoT-SORT JS Implementation
 * Combines Bounding Box IoU + Kalman Filter with OSNet ReID Features
 */

// 1. Simple Constant Velocity Kalman Filter for Bounding Boxes (x, y, a, h, vx, vy, va, vh)
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

    // K = P * H^T * S^-1 (Simplified pseudo-inverse or diagonal approximation for speed)
    // For diagonal S approximation:
    const K = Array.from({ length: 8 }, () => new Array(4).fill(0));
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 4; j++) {
        // P * H^T
        let PHT = 0;
        for (let k = 0; k < 8; k++) PHT += this.P[i][k] * this.H[j][k];
        K[i][j] = PHT / (S[j][j] + 1e-6); // Approx inversion
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

let trackIdCounter = 1;

export class BoTSORT {
  constructor() {
    this.tracks = [];
    this.maxAge = 30; // Max frames to keep an un-updated track
    this.reidThreshold = 0.5; // Cosine distance threshold
    this.iouThreshold = 0.3; // IoU distance threshold
  }

  async update(detections, sourceCanvas, osnetSession) {
    // 1. Extract ReID features for all detections
    const detFeatures = [];
    for (let det of detections) {
      let feature = null;
      if (osnetSession && sourceCanvas) {
        feature = await this.extractFeature(det.box, sourceCanvas, osnetSession);
      }
      detFeatures.push({ ...det, feature });
    }

    // 2. Predict next state for existing tracks
    for (let trk of this.tracks) {
      trk.predict();
    }

    // 3. Compute cost matrix
    const numTrk = this.tracks.length;
    const numDet = detFeatures.length;
    const costMatrix = Array.from({ length: numTrk }, () => new Array(numDet).fill(1e5));

    for (let t = 0; t < numTrk; t++) {
      for (let d = 0; d < numDet; d++) {
        const trk = this.tracks[t];
        const det = detFeatures[d];
        const iouDist = 1 - this.calculateIoU(trk.box, det.box);
        let reidDist = 1;
        if (trk.features && det.feature) {
          reidDist = this.cosineDistance(trk.features, det.feature);
        }

        // Only consider match if within thresholds
        if (iouDist < 1 - this.iouThreshold || reidDist < this.reidThreshold) {
          costMatrix[t][d] = 0.8 * reidDist + 0.2 * iouDist;
        }
      }
    }

    // 4. Greedy matching (O(N^2 log N))
    const matches = [];
    const unmatchedTrks = new Set(this.tracks.map((_, i) => i));
    const unmatchedDets = new Set(detFeatures.map((_, i) => i));

    const costList = [];
    for (let t = 0; t < numTrk; t++) {
      for (let d = 0; d < numDet; d++) {
        if (costMatrix[t][d] < 1e4) {
          costList.push({ t, d, cost: costMatrix[t][d] });
        }
      }
    }
    costList.sort((a, b) => a.cost - b.cost);

    for (let { t, d, cost } of costList) {
      if (unmatchedTrks.has(t) && unmatchedDets.has(d)) {
        matches.push([t, d]);
        unmatchedTrks.delete(t);
        unmatchedDets.delete(d);
      }
    }

    // 5. Update matched tracks
    for (let [t, d] of matches) {
      this.tracks[t].update(detFeatures[d].box, detFeatures[d].feature);
      detFeatures[d].trackId = this.tracks[t].id;
    }

    // 6. Create new tracks for unmatched detections
    for (let d of unmatchedDets) {
      const det = detFeatures[d];
      const newTrack = new Track(trackIdCounter++, det.box, det.feature);
      this.tracks.push(newTrack);
      det.trackId = newTrack.id;
    }

    // 7. Remove dead tracks
    this.tracks = this.tracks.filter((t) => t.timeSinceUpdate <= this.maxAge);

    return detFeatures;
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
