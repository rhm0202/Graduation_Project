/**
 * 하이브리드 객체 추적기 (Hybrid Tracker)
 * IoU(위치 겹침)와 RGB 색상(외형) 추출을 결합하여 가볍고 빠르게 객체를 추적합니다.
 */

/**
 * 두 Bounding Box 간의 IoU (Intersection over Union) 계산
 */
function calculateIoU(box1, box2) {
  const x1 = Math.max(box1.x1, box2.x1);
  const y1 = Math.max(box1.y1, box2.y1);
  const x2 = Math.min(box1.x2, box2.x2);
  const y2 = Math.min(box1.y2, box2.y2);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (intersection === 0) return 0;

  const area1 = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
  const area2 = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);
  const union = area1 + area2 - intersection;

  return intersection / union;
}

/**
 * 캔버스 이미지 데이터에서 Bounding Box를 상/중/하(Upper, Middle, Lower) 3개의 영역으로 나누어
 * 각각의 평균 RGB 값을 추출합니다. (단색 평균의 한계 극복)
 */
function extractRegionColors(box, imageData, modelWidth = 640, modelHeight = 640) {
  const { width, height, data } = imageData; // 원본 캔버스 해상도

  // 모델 좌표계(예: 640x640)를 원본 캔버스 좌표계로 변환
  const startX = Math.floor(box.x1 * (width / modelWidth));
  const startY = Math.floor(box.y1 * (height / modelHeight));
  const endX = Math.floor(box.x2 * (width / modelWidth));
  const endY = Math.floor(box.y2 * (height / modelHeight));

  // 좌우 가장자리 배경 간섭을 줄이기 위해 너비의 30%~70% 부분만 잘라냄
  const cropX1 = Math.floor(startX + (endX - startX) * 0.3);
  const cropX2 = Math.floor(startX + (endX - startX) * 0.7);

  // 상(15~45%: 가슴/머리), 중(45~75%: 복부/골반), 하(75~100%: 다리) 3분할
  const regions = [
    { y1: 0.15, y2: 0.45 },
    { y1: 0.45, y2: 0.75 },
    { y1: 0.75, y2: 1.00 }
  ];

  const regionColors = [];

  for (const reg of regions) {
    const cropY1 = Math.floor(startY + (endY - startY) * reg.y1);
    const cropY2 = Math.floor(startY + (endY - startY) * reg.y2);

    let rSum = 0, gSum = 0, bSum = 0, count = 0;

    for (let y = Math.max(0, cropY1); y < Math.min(height, cropY2); y++) {
      for (let x = Math.max(0, cropX1); x < Math.min(width, cropX2); x++) {
        const idx = (y * width + x) * 4;
        rSum += data[idx];
        gSum += data[idx + 1];
        bSum += data[idx + 2];
        count++;
      }
    }

    if (count === 0) {
      regionColors.push({ r: 0, g: 0, b: 0 });
    } else {
      regionColors.push({
        r: Math.round(rSum / count),
        g: Math.round(gSum / count),
        b: Math.round(bSum / count)
      });
    }
  }

  return regionColors; // [{r,g,b}, {r,g,b}, {r,g,b}] 반환
}

/**
 * 두 색상 배열(상/중/하) 간의 유사도 평균 계산 (0 ~ 1)
 */
function calculateColorSimilarity(colors1, colors2) {
  let totalSim = 0;
  for (let i = 0; i < 3; i++) {
    const c1 = colors1[i];
    const c2 = colors2[i];
    const maxDiff = 255 * 3;
    const diff = Math.abs(c1.r - c2.r) + Math.abs(c1.g - c2.g) + Math.abs(c1.b - c2.b);
    totalSim += 1 - (diff / maxDiff);
  }
  return totalSim / 3;
}

export class HybridTracker {
  constructor() {
    this.tracks = []; // 추적 중인 객체 배열: { id, box, color, missingFrames, score, anc }
    this.nextId = 0;
    this.maxMissingFrames = 30; // 몇 프레임 동안 객체를 놓쳐도 ID를 유지할지 결정
  }

  /**
   * YOLO 감지 결과와 원본 프레임 이미지 데이터를 받아 추적 정보를 업데이트합니다.
   * @param {Array} detections YOLO 감지 결과 [{anc, score, box}]
   * @param {ImageData} imageData 캔버스에서 추출한 원본 픽셀 데이터
   * @returns {Array} ID가 부여된 추적 객체 배열
   */
  update(detections, imageData) {
    // 1. 새로 감지된 객체들의 색상 정보(상/중/하) 추출
    const currentDetections = detections.map(det => ({
      ...det,
      color: extractRegionColors(det.box, imageData)
    }));

    const matchedTracks = [];
    const unassignedTracks = new Set(this.tracks);
    const unassignedDetections = new Set(currentDetections);

    // 2. 모든 기존 트랙과 새 감지 결과의 매칭 점수 계산
    const pairs = [];
    for (const track of this.tracks) {
      for (const det of currentDetections) {
        const iou = calculateIoU(track.box, det.box);
        const colorSim = calculateColorSimilarity(track.color, det.color);

        // [핵심 방어 로직] 하얀 옷과 검은 옷처럼 색상이 완전히 다르면 동일인이 아님! (교차 시 ID 탈취 방지)
        if (colorSim < 0.5) continue;

        // 하이브리드 점수 산정: 교차 상황을 대비해 색상에 더 높은 가중치를 부여
        const score = (iou * 0.4) + (colorSim * 0.6);

        if (score > 0.3) {
          pairs.push({ track, det, score });
        }
      }
    }

    // 3. 점수가 높은 순으로 정렬 (Global Optimal Matching - 특정 객체가 먼저 매칭을 가로채는 현상 방지)
    pairs.sort((a, b) => b.score - a.score);

    // 4. 높은 점수 순서대로 실제 매칭 할당
    for (const pair of pairs) {
      if (unassignedTracks.has(pair.track) && unassignedDetections.has(pair.det)) {
        // 매칭 성공: 정보 업데이트
        pair.track.box = pair.det.box;
        pair.track.color = pair.det.color;
        pair.track.missingFrames = 0;
        pair.track.anc = pair.det.anc;
        pair.track.score = pair.det.score;

        matchedTracks.push(pair.track);
        unassignedTracks.delete(pair.track);
        unassignedDetections.delete(pair.det);
      }
    }

    // 5. 매칭 실패한 기존 트랙 처리: 화면에서 일시적으로 사라지거나 가려진 상태
    for (const track of unassignedTracks) {
      track.missingFrames++;
    }

    // 너무 오랫동안 매칭되지 않은(화면에서 완전히 나간) 트랙 삭제
    this.tracks = this.tracks.filter(t => t.missingFrames < this.maxMissingFrames);

    // 6. 매칭되지 않고 남은 감지 객체는 새로운 트랙(신규 등장 인물)으로 등록
    for (const det of unassignedDetections) {
      const newTrack = {
        id: this.nextId++,
        box: det.box,
        color: det.color,
        anc: det.anc,
        score: det.score,
        missingFrames: 0
      };
      this.tracks.push(newTrack);
      matchedTracks.push(newTrack);
    }

    // UI 표시의 안정성을 위해 X좌표 순이나 ID 순으로 정렬할 수 있습니다.
    // 여기서는 추적의 일관성을 위해 매칭된 객체들을 반환합니다.
    return matchedTracks;
  }

  isTrackAlive(id) {
    return this.tracks.some(t => t.id === id);
  }
}
