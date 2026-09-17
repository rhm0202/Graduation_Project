/**
 * ByteTrack association with an elapsed-time XYAH Kalman filter.
 *
 * Algorithm references (independent JS implementation, no external dependency):
 * Zhang et al., "ByteTrack: Multi-Object Tracking by Associating Every Detection
 * Box", ECCV 2022: https://arxiv.org/abs/2110.06864
 * https://github.com/ifzhang/ByteTrack/blob/main/yolox/tracker/byte_tracker.py
 * https://github.com/ifzhang/ByteTrack/blob/main/yolox/tracker/matching.py
 *
 * Like the reference: confirmed+lost/high-score first association (score-fused
 * IoU), unmatched active/low-score second association (IoU only), tentative
 * confirmation, high-score births, and confirmed/lost duplicate suppression.
 * Local adaptations: elapsed milliseconds for expiry, seconds for velocity,
 * strict frame provenance, bounded nonmutating prediction for display/control,
 * and conservative edge-aware recovery before tentative-track confirmation.
 * This module does not add a second motor-latency compensation step.
 */

export const BYTE_TRACKER_DEFAULTS = Object.freeze({
  highThreshold: 0.5,
  lowThreshold: 0.1,
  newTrackThreshold: 0.6,
  matchThreshold: 0.8,
  secondMatchThreshold: 0.5,
  tentativeMatchThreshold: 0.7,
  duplicateIouThreshold: 0.85,
  maxLostMs: 3000,
  recoveryMaxMs: 3000,
  recoveryEdgeAnchorMaxAgeMs: 500,
  recoveryMinIou: 0.5,
  recoveryMaxSizeRatio: 1.5,
  recoveryAmbiguityMargin: 0.15,
  referenceFps: 30,
});

function validateOptions(options) {
  const result = { ...BYTE_TRACKER_DEFAULTS, ...options };
  for (const name of ["highThreshold", "lowThreshold", "newTrackThreshold", "matchThreshold",
    "secondMatchThreshold", "tentativeMatchThreshold", "duplicateIouThreshold",
    "recoveryMinIou", "recoveryAmbiguityMargin"]) {
    if (!Number.isFinite(result[name]) || result[name] < 0 || result[name] > 1) {
      throw new TypeError(`${name} must be between 0 and 1`);
    }
  }
  if (result.lowThreshold >= result.highThreshold || result.newTrackThreshold < result.highThreshold) {
    throw new RangeError("Thresholds must satisfy lowThreshold < highThreshold <= newTrackThreshold");
  }
  if (!Number.isFinite(result.maxLostMs) || result.maxLostMs <= 0
    || !Number.isFinite(result.referenceFps) || result.referenceFps <= 0) {
    throw new TypeError("maxLostMs and referenceFps must be finite and positive");
  }
  if (!Number.isFinite(result.recoveryMaxMs) || result.recoveryMaxMs < 0
    || !Number.isFinite(result.recoveryEdgeAnchorMaxAgeMs) || result.recoveryEdgeAnchorMaxAgeMs < 0
    || !Number.isFinite(result.recoveryMaxSizeRatio) || result.recoveryMaxSizeRatio < 1
    || result.recoveryMinIou <= 0 || result.recoveryAmbiguityMargin <= 0) {
    throw new RangeError("Recovery requires nonnegative time, size ratio >= 1 and positive overlap/ambiguity thresholds");
  }
  return Object.freeze(result);
}

function validDetection(detection) {
  const box = detection?.box;
  if (!box || !Number.isFinite(detection.score) || detection.score < 0 || detection.score > 1
    || !Number.isSafeInteger(detection.anc) || detection.anc < 0) return false;
  if (![box.x1, box.y1, box.x2, box.y2].every(Number.isFinite)) return false;
  const width = box.x2 - box.x1;
  const height = box.y2 - box.y1;
  // Finite derived values also reject extreme coordinates that would overflow KF.
  return width > 0 && height > 0 && Number.isFinite(width * height)
    && Number.isFinite((box.x1 + box.x2) / 2) && Number.isFinite((box.y1 + box.y2) / 2)
    && Number.isFinite(width / height);
}

const FRAME_SIDES = ["left", "right", "top", "bottom"];
const MAX_OBSERVATION_HISTORY = 32;

function copyFrameEdges(edges) {
  if (!edges || typeof edges !== "object") return null;
  return Object.fromEntries(FRAME_SIDES.map(side => [side, edges[side] === true]));
}

function rememberObservation(track, detection, timestampMs, maxAgeMs) {
  const history = (track.observationHistory || []).filter(observation =>
    timestampMs - observation.timestampMs <= maxAgeMs);
  history.push({
    box: { ...detection.box },
    frameEdges: copyFrameEdges(detection.frameEdges),
    timestampMs,
  });
  track.observationHistory = history.slice(-MAX_OBSERVATION_HISTORY);
}

/**
 * A seated person may touch the bottom on every observation, so there need not
 * be an entirely interior box. Keep recent, larger observations on the SAME
 * edge, provided location/size along that edge stayed stable. The normal full
 * box IoU and size gates are still applied to each resulting recovery anchor.
 */
function partialObservationAnchors(track, detection, options) {
  if (options.recoveryEdgeAnchorMaxAgeMs <= 0
    || !track.lastObservedFrameEdges || !detection.frameEdges) return [];
  const commonSides = FRAME_SIDES.filter(side =>
    track.lastObservedFrameEdges[side] && detection.frameEdges[side]);
  if (!commonSides.length) return [];
  const last = track.lastObservedBox;
  const anchors = [];
  for (const observation of track.observationHistory || []) {
    const ageAtExit = track.lastObservedAt - observation.timestampMs;
    if (ageAtExit < 0 || ageAtExit > options.recoveryEdgeAnchorMaxAgeMs) continue;
    const previous = observation.box;
    for (const side of commonSides) {
      if (!observation.frameEdges?.[side]) continue;
      const verticalClipping = side === "top" || side === "bottom";
      const extent = verticalClipping ? previous.y2 - previous.y1 : previous.x2 - previous.x1;
      const lastExtent = verticalClipping ? last.y2 - last.y1 : last.x2 - last.x1;
      if (extent <= lastExtent) continue;

      const start = verticalClipping ? "x1" : "y1";
      const end = verticalClipping ? "x2" : "y2";
      const previousLength = previous[end] - previous[start];
      const lastLength = last[end] - last[start];
      const longest = Math.max(previousLength, lastLength);
      const overlap = Math.max(0, Math.min(previous[end], last[end]) - Math.max(previous[start], last[start]));
      if (longest / Math.min(previousLength, lastLength) > options.recoveryMaxSizeRatio
        || overlap / longest < 0.5) continue;
      anchors.push(previous);
      break; // A corner observation can qualify on two sides; add it only once.
    }
  }
  return anchors;
}

function associate(tracks, detections, threshold, fuseScore) {
  if (!tracks.length || !detections.length) {
    return { matches: [], unmatchedRows: tracks.map((_, i) => i), unmatchedColumns: detections.map((_, i) => i) };
  }
  const costs = tracks.map(track => {
    const predictedBox = xyahToBox(track.mean);
    return detections.map(detection => {
      const overlap = boxIoU(predictedBox, detection.box);
      if (overlap <= 0) return Infinity;
      // Gating is applied in the assignment optimizer, not after greedy choices.
      return 1 - overlap * (fuseScore ? detection.score : 1);
    });
  });
  return linearAssignment(costs, threshold);
}

/**
 * Reappearance after a stop/reversal can be close to the last observation but
 * far from a constant-velocity prediction. Recover only an unambiguous local
 * high-score observation. This is a SpotlightCam extension, not original BYTE.
 */
function recoveryMatches(tracks, detections, occupiedBoxes, options) {
  const similarities = tracks.map(track => {
    const anchors = [track.lastObservedBox];
    const interiorAgeAtExit = track.lastObservedAt - track.lastInteriorAt;
    // A box can shrink as a subject exits the image. Only supplement the final
    // clipped box with an interior observation from immediately before that
    // exit. Anchor freshness is measured at exit, independently of the loss TTL.
    if (options.recoveryEdgeAnchorMaxAgeMs > 0 && track.lastObservedAtFrameEdge
      && track.lastInteriorBox && Number.isFinite(track.lastInteriorAt)
      && interiorAgeAtExit >= 0 && interiorAgeAtExit <= options.recoveryEdgeAnchorMaxAgeMs) {
      anchors.push(track.lastInteriorBox);
    }
    return detections.map(detection => {
      if (occupiedBoxes.some(box => boxIoU(box, detection.box) >= options.recoveryMinIou)) return 0;
      const current = detection.box;
      let bestOverlap = 0;
      for (const previous of [...anchors, ...partialObservationAnchors(track, detection, options)]) {
        const widths = [previous.x2 - previous.x1, current.x2 - current.x1];
        const heights = [previous.y2 - previous.y1, current.y2 - current.y1];
        if (Math.max(...widths) / Math.min(...widths) > options.recoveryMaxSizeRatio
          || Math.max(...heights) / Math.min(...heights) > options.recoveryMaxSizeRatio) continue;
        bestOverlap = Math.max(bestOverlap, boxIoU(previous, current));
      }
      return bestOverlap;
    });
  });
  const matches = [];
  for (let row = 0; row < tracks.length; row++) {
    const ranked = similarities[row].map((score, column) => ({ score, column }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || best.score < options.recoveryMinIou
      || best.score - (ranked[1]?.score || 0) < options.recoveryAmbiguityMargin) continue;
    const competing = similarities.map((scores, index) => ({ score: scores[best.column], row: index }))
      .sort((a, b) => b.score - a.score);
    if (competing[0].row !== row
      || best.score - (competing[1]?.score || 0) < options.recoveryAmbiguityMargin) continue;
    matches.push([row, best.column]);
  }
  return matches;
}

export class ByteTracker {
  constructor(options = {}) {
    this.options = validateOptions(options);
    this._kalman = new XYAHKalmanFilter(this.options.referenceFps);
    this.reset();
  }

  reset() {
    this._records = [];
    this._nextId = 0;
    this._lastTimestampMs = null;
    this._lastFrameId = null;
  }

  /** Confirmed and lost snapshots; tentative births are intentionally hidden. */
  get tracks() {
    return this._records.filter(track => track.state !== "tentative")
      .map(track => this._snapshot(track, this._lastTimestampMs, track.observed));
  }

  isTrackAlive(id) {
    // No implicit wall clock: timestampMs may use video time or performance.now().
    // Expiry is applied on accepted update(); getTrack checks its explicit time.
    return this._records.some(track => track.id === id && track.state !== "tentative");
  }

  /**
   * @param {Array<{anc:number,score:number,box:{x1:number,y1:number,x2:number,y2:number},atFrameEdge?:boolean,frameEdges?:Object}>} detections
   * @param {{timestampMs:number,frameId:number}} metadata Monotonic capture time and frame sequence.
   * @returns {Array} Confirmed tracks observed in exactly this accepted frame.
   *
   * Metadata is mandatory. Nonfinite/negative time or a nonsafe/negative frame ID
   * throws before mutation. Stale/equal time OR frame ID returns [] unchanged.
   * Invalid detections are discarded. Threshold boundaries are inclusive: high
   * is >= highThreshold, low is >= lowThreshold and < highThreshold.
   * atFrameEdge is optional (default false) and only affects recovery anchors.
   * Optional frameEdges identifies left/right/top/bottom proximity independently;
   * without it, legacy last-box and interior-box recovery remain available.
   */
  update(detections, { timestampMs, frameId } = {}) {
    if (!Array.isArray(detections)) throw new TypeError("detections must be an array");
    if (!Number.isFinite(timestampMs) || timestampMs < 0 || !Number.isSafeInteger(frameId) || frameId < 0) {
      throw new TypeError("timestampMs and frameId must be explicit finite nonnegative monotonic values");
    }
    if (this._lastTimestampMs !== null
      && (timestampMs <= this._lastTimestampMs || frameId <= this._lastFrameId)) return [];

    const firstFrame = this._lastTimestampMs === null;
    // Expire BEFORE association: a delayed inference cannot revive an expired ID.
    this._records = this._records.filter(track => timestampMs - track.lastObservedAt < this.options.maxLostMs);
    const candidates = detections.filter(validDetection).map(detection => {
      const frameEdges = copyFrameEdges(detection.frameEdges);
      return {
        anc: detection.anc, score: detection.score, box: { ...detection.box },
        frameEdges,
        atFrameEdge: detection.atFrameEdge === true || (frameEdges && FRAME_SIDES.some(side => frameEdges[side])) === true,
      };
    });
    const high = candidates.filter(detection => detection.score >= this.options.highThreshold);
    const low = candidates.filter(detection => detection.score >= this.options.lowThreshold
      && detection.score < this.options.highThreshold);

    for (const track of this._records) {
      const predicted = this._kalman.predict(track.mean, track.covariance,
        (timestampMs - track.estimateAt) / 1000, track.state === "lost");
      track.mean = predicted.mean;
      track.covariance = predicted.covariance;
      track.estimateAt = timestampMs;
      track.observed = false;
      track.anc = null;
      track.detectionBox = null;
      track.missingFrames++;
    }

    const tentative = this._records.filter(track => track.state === "tentative");
    const pool = this._records.filter(track => track.state !== "tentative");
    const first = associate(pool, high, this.options.matchThreshold, true);
    for (const [trackIndex, detectionIndex] of first.matches) {
      this._observe(pool[trackIndex], high[detectionIndex], timestampMs, frameId);
    }

    // Only previously active tracks may use weak detections. Lost identities
    // require a high-confidence observation to be reactivated.
    const remainingActive = first.unmatchedRows.map(index => pool[index])
      .filter(track => track.state === "confirmed");
    const second = associate(remainingActive, low, this.options.secondMatchThreshold, false);
    for (const [trackIndex, detectionIndex] of second.matches) {
      this._observe(remainingActive[trackIndex], low[detectionIndex], timestampMs, frameId);
    }
    for (const index of second.unmatchedRows) remainingActive[index].state = "lost";

    const remainingHigh = first.unmatchedColumns.map(index => high[index]);
    // Preserve normal confirmed-track ownership first, then let a retained ID
    // recover before a one-frame tentative birth can claim the returning person.
    const recoveryPool = this.options.recoveryMaxMs === 0 ? [] : this._records.filter(track =>
      track.state === "lost" && track.lastObservedBox
      && timestampMs - track.lastObservedAt <= this.options.recoveryMaxMs);
    const occupiedBoxes = this._records.filter(track => track.observed).map(track => track.detectionBox);
    const recovery = recoveryMatches(recoveryPool, remainingHigh, occupiedBoxes, this.options);
    const recoveredDetections = new Set();
    for (const [trackIndex, detectionIndex] of recovery) {
      // Stale velocity caused this fallback. Restart motion at the real box so
      // the same ID does not immediately drift away again on the next frame.
      this._observe(recoveryPool[trackIndex], remainingHigh[detectionIndex], timestampMs, frameId, true);
      recoveredDetections.add(detectionIndex);
    }

    const confirmationCandidates = remainingHigh.filter((_, index) => !recoveredDetections.has(index));
    const confirmation = associate(tentative, confirmationCandidates, this.options.tentativeMatchThreshold, true);
    for (const [trackIndex, detectionIndex] of confirmation.matches) {
      this._observe(tentative[trackIndex], confirmationCandidates[detectionIndex], timestampMs, frameId);
    }
    const discarded = new Set(confirmation.unmatchedRows.map(index => tentative[index]));
    this._records = this._records.filter(track => !discarded.has(track));
    const birthCandidates = confirmation.unmatchedColumns.map(index => confirmationCandidates[index]);

    for (let index = 0; index < birthCandidates.length; index++) {
      const detection = birthCandidates[index];
      if (detection.score < this.options.newTrackThreshold) continue;
      const initial = this._kalman.initiate(boxToXYAH(detection.box));
      this._records.push({
        id: this._nextId++,
        mean: initial.mean,
        covariance: initial.covariance,
        state: firstFrame ? "confirmed" : "tentative",
        score: detection.score,
        anc: detection.anc,
        detectionBox: { ...detection.box },
        lastObservedBox: { ...detection.box },
        lastObservedAtFrameEdge: detection.atFrameEdge,
        lastObservedFrameEdges: copyFrameEdges(detection.frameEdges),
        lastInteriorBox: detection.atFrameEdge ? null : { ...detection.box },
        lastInteriorAt: detection.atFrameEdge ? null : timestampMs,
        observationHistory: [{
          box: { ...detection.box },
          frameEdges: copyFrameEdges(detection.frameEdges),
          timestampMs,
        }],
        observed: true,
        startAt: timestampMs,
        lastObservedAt: timestampMs,
        lastObservedFrameId: frameId,
        estimateAt: timestampMs,
        missingFrames: 0,
      });
    }

    this._removeDuplicates();
    this._lastTimestampMs = timestampMs;
    this._lastFrameId = frameId;
    return this._records.filter(track => track.state === "confirmed" && track.observed)
      .map(track => this._snapshot(track, timestampMs, true));
  }

  _observe(track, detection, timestampMs, frameId, restartMotion = false) {
    const preserveRecentHistory = track.missingFrames <= 1 || FRAME_SIDES.some(side =>
      track.lastObservedFrameEdges?.[side] && detection.frameEdges?.[side]);
    const measurement = boxToXYAH(detection.box);
    const corrected = restartMotion ? this._kalman.initiate(measurement)
      : this._kalman.update(track.mean, track.covariance, measurement);
    track.mean = corrected.mean;
    track.covariance = corrected.covariance;
    track.state = "confirmed";
    track.score = detection.score;
    track.anc = detection.anc;
    track.detectionBox = { ...detection.box };
    track.lastObservedBox = { ...detection.box };
    track.lastObservedAtFrameEdge = detection.atFrameEdge;
    track.lastObservedFrameEdges = copyFrameEdges(detection.frameEdges);
    // A successful fallback starts a new motion segment. An old interior anchor
    // must not survive recovery at the edge and be reused for another departure.
    if (restartMotion) {
      track.lastInteriorBox = null;
      track.lastInteriorAt = null;
      if (!preserveRecentHistory) track.observationHistory = [];
    }
    if (!detection.atFrameEdge) {
      track.lastInteriorBox = { ...detection.box };
      track.lastInteriorAt = timestampMs;
    }
    // Resetting velocity does not mean a partial return has restored the whole
    // person. Keep genuine recent observations, with their ORIGINAL timestamps;
    // rememberObservation still enforces the time window and 32-entry bound.
    rememberObservation(track, detection, timestampMs, this.options.recoveryEdgeAnchorMaxAgeMs);
    track.observed = true;
    track.lastObservedAt = timestampMs;
    track.lastObservedFrameId = frameId;
    track.estimateAt = timestampMs;
    track.missingFrames = 0;
  }

  _removeDuplicates() {
    const active = this._records.filter(track => track.state === "confirmed");
    const lost = this._records.filter(track => track.state === "lost");
    const discarded = new Set();
    for (const current of active) {
      for (const missing of lost) {
        if (boxIoU(xyahToBox(current.mean), xyahToBox(missing.mean)) <= this.options.duplicateIouThreshold) continue;
        const activeAge = current.lastObservedAt - current.startAt;
        const lostAge = missing.lastObservedAt - missing.startAt;
        // Keep the longer observation history. Prefer the observed track on ties
        // so equal-age duplicates do not suppress the only current measurement.
        discarded.add(activeAge >= lostAge ? missing : current);
      }
    }
    this._records = this._records.filter(track => !discarded.has(track));
  }

  /**
   * Read a detached snapshot, optionally predicted to timestampMs. Predictions
   * are bounded from the LAST OBSERVATION, not from the latest missing update.
   * A rejected/expired/horizon-exceeded query returns null and never mutates the
   * Kalman state or removes an ID. Calling update() handles the lost-track TTL.
   * frameId/anc/detectionBox are null for every predicted or lost snapshot.
   */
  getTrack(id, { timestampMs = this._lastTimestampMs, maxPredictionMs = 250 } = {}) {
    if (!Number.isFinite(timestampMs) || timestampMs < 0
      || !Number.isFinite(maxPredictionMs) || maxPredictionMs < 0) return null;
    if (this._lastTimestampMs === null || timestampMs < this._lastTimestampMs) return null;
    const track = this._records.find(candidate => candidate.id === id && candidate.state !== "tentative");
    if (!track) return null;
    const observationAge = timestampMs - track.lastObservedAt;
    if (observationAge >= this.options.maxLostMs || observationAge > maxPredictionMs) return null;
    const observed = track.observed && timestampMs === track.lastObservedAt;
    if (timestampMs === track.estimateAt) return this._snapshot(track, timestampMs, observed);
    const prediction = this._kalman.predict(track.mean, track.covariance,
      (timestampMs - track.estimateAt) / 1000, track.state === "lost");
    return this._snapshot(track, timestampMs, false, prediction.mean);
  }

  _snapshot(track, timestampMs, observed, mean = track.mean) {
    return {
      id: track.id,
      box: xyahToBox(mean),
      detectionBox: observed && track.detectionBox ? { ...track.detectionBox } : null,
      score: track.score,
      anc: observed ? track.anc : null,
      observed,
      state: track.state,
      lastObservedAt: track.lastObservedAt,
      lastObservedFrameId: track.lastObservedFrameId,
      frameId: observed ? track.lastObservedFrameId : null,
      timestampMs,
      missingFrames: track.missingFrames,
    };
  }
}

/** Contracts between the detector, ByteTrack, segmentation and motor output. */

export const TRACKING_POLICY = Object.freeze({
  modelSize: 640,
  frameEdgeMargin: 4,
  maskThreshold: 0.5,
  maxControlAgeMs: 250,
});

function validBox(box) {
  return box && [box.x1, box.y1, box.x2, box.y2].every(Number.isFinite)
    && box.x2 > box.x1 && box.y2 > box.y1;
}

/** YOLO26-seg [1, N, 38]: retain low scores for existing-track recovery. */
export function collectPersonDetections(output, channels = 38) {
  if (channels !== 38 || !output || output.length % channels !== 0) {
    throw new Error("Expected YOLO26-seg detections with 38 channels");
  }
  const detections = [];
  const size = TRACKING_POLICY.modelSize;
  for (let offset = 0; offset < output.length; offset += channels) {
    const score = output[offset + 4];
    if (output[offset + 5] !== 0 || !Number.isFinite(score)
      || score < BYTE_TRACKER_DEFAULTS.lowThreshold || score > 1) continue;
    const values = Array.from(output.slice(offset, offset + 4));
    if (!values.every(Number.isFinite)) continue;
    const [x1, y1, x2, y2] = values.map(value => Math.max(0, Math.min(size, value)));
    const box = { x1, y1, x2, y2 };
    const margin = TRACKING_POLICY.frameEdgeMargin;
    const frameEdges = {
      left: x1 <= margin, right: x2 >= size - margin,
      top: y1 <= margin, bottom: y2 >= size - margin,
    };
    if (validBox(box)) detections.push({
      anc: offset / channels, score, box,
      // Edge detections may describe only the visible part of the person.
      // Keep this separate from the box used by the current segmentation mask.
      atFrameEdge: Object.values(frameEdges).some(Boolean),
      frameEdges,
    });
  }
  return detections;
}

/** A predicted box has no segmentation coefficients for the current frame. */
export function selectMaskTracks(people, selectedIds, frameId, detectionCount) {
  const selected = new Set(selectedIds);
  return people.filter(track => selected.has(track.id)
    && track.observed && track.frameId === frameId
    && track.score >= TRACKING_POLICY.maskThreshold
    && Number.isSafeInteger(track.anc) && track.anc >= 0 && track.anc < detectionCount
    && validBox(track.detectionBox))
    .map(track => ({ ...track, box: { ...track.detectionBox } }));
}

/** One selected, confirmed ID only. Never replace a lost target with another ID. */
export function selectControlTrack(tracker, people, targetId, frameId, nowMs) {
  if (targetId === null || targetId === undefined || !Number.isFinite(nowMs)) return null;
  const observed = people.find(track => track.id === targetId
    && track.observed && track.frameId === frameId && track.state === "confirmed");
  const target = observed || tracker.getTrack(targetId, {
    timestampMs: nowMs,
    maxPredictionMs: TRACKING_POLICY.maxControlAgeMs,
  });
  if (!target || !validBox(target.box)) return null;
  const age = nowMs - target.lastObservedAt;
  if (!Number.isFinite(age) || age < 0 || age > TRACKING_POLICY.maxControlAgeMs) return null;
  // Do not steer farther outside the image on an extrapolated off-screen box.
  const { x1, y1, x2, y2 } = target.box;
  const size = TRACKING_POLICY.modelSize;
  if (x2 <= 0 || y2 <= 0 || x1 >= size || y1 >= size) return null;
  return target;
}

export function controlPoint(box) {
  const size = TRACKING_POLICY.modelSize;
  return {
    x: Math.max(0, Math.min(size, (box.x1 + box.x2) / 2)),
    y: Math.max(0, Math.min(size, box.y1 + (box.y2 - box.y1) * 0.2)),
    frameWidth: size,
    frameHeight: size,
  };
}

/** Browser-reported frame count first, playback timestamp as the fallback. */
export function videoFrameKey(video) {
  const frames = video.getVideoPlaybackQuality?.().totalVideoFrames;
  if (Number.isFinite(frames) && frames > 0) return `frame:${frames}`;
  return Number.isFinite(video.currentTime) ? `time:${video.currentTime}` : null;
}

/**
 * Dependency-free numerical helpers for ByteTracker.
 *
 * The XYAH constant-velocity model and height-relative noise scales follow:
 * https://github.com/ifzhang/ByteTrack/blob/main/yolox/tracker/kalman_filter.py
 * This is an independent JavaScript implementation. Velocities are per SECOND,
 * and the process covariance integrates elapsed time instead of counting frames.
 */

const zeros = (rows, columns) => Array.from({ length: rows }, () => Array(columns).fill(0));

export function boxIoU(a, b) {
  const width = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const height = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const intersection = width * height;
  if (intersection === 0) return 0;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1)
    + (b.x2 - b.x1) * (b.y2 - b.y1) - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Globally minimize assignment cost with optional unmatched rows/columns.
 * Invalid edges (nonfinite or above costLimit) are excluded BEFORE optimization.
 * Each row has dummy columns costing costLimit; an unused real column costs zero.
 * This is equivalent, up to a constant, to charging costLimit / 2 for each
 * unmatched row and column, as in a cost-limited LAP. A rectangular Hungarian
 * shortest-augmenting-path solver finds the minimum; this is not greedy matching.
 */
export function linearAssignment(costMatrix, costLimit) {
  if (!Array.isArray(costMatrix) || !Number.isFinite(costLimit) || costLimit < 0) {
    throw new TypeError("A cost matrix and finite nonnegative cost limit are required");
  }
  const rowCount = costMatrix.length;
  const columnCount = rowCount ? costMatrix[0].length : 0;
  if (costMatrix.some(row => !Array.isArray(row) || row.length !== columnCount)) {
    throw new TypeError("Assignment cost matrix must be rectangular");
  }
  if (rowCount === 0 || columnCount === 0) {
    return {
      matches: [],
      unmatchedRows: Array.from({ length: rowCount }, (_, i) => i),
      unmatchedColumns: Array.from({ length: columnCount }, (_, i) => i),
    };
  }
  const totalColumns = columnCount + rowCount;
  // A tiny tie-break favors a real match whose cost equals the threshold.
  const unmatchedCost = costLimit + 1e-12;
  const forbiddenCost = (costLimit + 1) * (rowCount + 1);
  const edgeCost = (row, column) => {
    if (column >= columnCount) return unmatchedCost;
    const cost = costMatrix[row][column];
    return Number.isFinite(cost) && cost <= costLimit ? cost : forbiddenCost;
  };

  const rowPotential = new Float64Array(rowCount + 1);
  const columnPotential = new Float64Array(totalColumns + 1);
  const columnOwner = new Int32Array(totalColumns + 1);
  const predecessor = new Int32Array(totalColumns + 1);

  for (let row = 1; row <= rowCount; row++) {
    columnOwner[0] = row;
    const distance = new Float64Array(totalColumns + 1).fill(Infinity);
    const visited = new Uint8Array(totalColumns + 1);
    let column = 0;
    do {
      visited[column] = 1;
      const currentRow = columnOwner[column];
      let delta = Infinity;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= totalColumns; candidate++) {
        if (visited[candidate]) continue;
        const reducedCost = edgeCost(currentRow - 1, candidate - 1)
          - rowPotential[currentRow] - columnPotential[candidate];
        if (reducedCost < distance[candidate]) {
          distance[candidate] = reducedCost;
          predecessor[candidate] = column;
        }
        if (distance[candidate] < delta) {
          delta = distance[candidate];
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= totalColumns; candidate++) {
        if (visited[candidate]) {
          rowPotential[columnOwner[candidate]] += delta;
          columnPotential[candidate] -= delta;
        } else {
          distance[candidate] -= delta;
        }
      }
      column = nextColumn;
    } while (columnOwner[column] !== 0);

    do {
      const previous = predecessor[column];
      columnOwner[column] = columnOwner[previous];
      column = previous;
    } while (column !== 0);
  }

  const matches = [];
  const matchedRows = new Set();
  const matchedColumns = new Set();
  for (let column = 1; column <= columnCount; column++) {
    const row = columnOwner[column] - 1;
    if (row < 0) continue;
    const cost = costMatrix[row][column - 1];
    if (!Number.isFinite(cost) || cost > costLimit) continue;
    matches.push([row, column - 1]);
    matchedRows.add(row);
    matchedColumns.add(column - 1);
  }
  matches.sort((a, b) => a[0] - b[0]);
  return {
    matches,
    unmatchedRows: Array.from({ length: rowCount }, (_, i) => i).filter(i => !matchedRows.has(i)),
    unmatchedColumns: Array.from({ length: columnCount }, (_, i) => i).filter(i => !matchedColumns.has(i)),
  };
}

export function boxToXYAH(box) {
  const height = box.y2 - box.y1;
  return [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2, (box.x2 - box.x1) / height, height];
}

export function xyahToBox(mean) {
  const height = Math.max(1e-3, mean[3]);
  const width = Math.max(1e-4, mean[2]) * height;
  return {
    x1: mean[0] - width / 2,
    y1: mean[1] - height / 2,
    x2: mean[0] + width / 2,
    y2: mean[1] + height / 2,
  };
}

// Positive-definite innovation covariance is only 4 x 4. Cholesky solves avoid
// forming its inverse, and Joseph-form correction preserves covariance symmetry.
function cholesky(matrix) {
  const size = matrix.length;
  const result = zeros(size, size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column <= row; column++) {
      let value = matrix[row][column];
      for (let k = 0; k < column; k++) value -= result[row][k] * result[column][k];
      result[row][column] = row === column
        ? Math.sqrt(Math.max(1e-12, value))
        : value / result[column][column];
    }
  }
  return result;
}

function solveCholesky(lower, vector) {
  const size = vector.length;
  const intermediate = Array(size).fill(0);
  const result = Array(size).fill(0);
  for (let row = 0; row < size; row++) {
    let value = vector[row];
    for (let k = 0; k < row; k++) value -= lower[row][k] * intermediate[k];
    intermediate[row] = value / lower[row][row];
  }
  for (let row = size - 1; row >= 0; row--) {
    let value = intermediate[row];
    for (let k = row + 1; k < size; k++) value -= lower[k][row] * result[k];
    result[row] = value / lower[row][row];
  }
  return result;
}

function keepPositiveSize(mean) {
  if (mean[2] < 1e-4) { mean[2] = 1e-4; mean[6] = 0; }
  if (mean[3] < 1e-3) { mean[3] = 1e-3; mean[7] = 0; }
}

export class XYAHKalmanFilter {
  constructor(referenceFps = 30) {
    if (!Number.isFinite(referenceFps) || referenceFps <= 0) {
      throw new TypeError("referenceFps must be finite and positive");
    }
    this.referenceFps = referenceFps;
  }

  initiate(measurement) {
    const height = Math.max(1e-3, measurement[3]);
    const fps = this.referenceFps;
    const standardDeviations = [
      height / 10, height / 10, 1e-2, height / 10,
      height / 16 * fps, height / 16 * fps, 1e-5 * fps, height / 16 * fps,
    ];
    const covariance = zeros(8, 8);
    for (let i = 0; i < 8; i++) covariance[i][i] = standardDeviations[i] ** 2;
    return { mean: [...measurement, 0, 0, 0, 0], covariance };
  }

  predict(mean, covariance, dtSeconds, freezeHeight = false) {
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0) {
      throw new TypeError("Kalman dtSeconds must be finite and nonnegative");
    }
    const predicted = mean.slice();
    if (freezeHeight) predicted[7] = 0;
    for (let i = 0; i < 4; i++) predicted[i] += predicted[i + 4] * dtSeconds;

    const result = zeros(8, 8);
    const dt2 = dtSeconds * dtSeconds;
    // F P F' for F = [I dt*I; 0 I].
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 8; column++) {
        result[row][column] = covariance[row][column]
          + (row < 4 ? dtSeconds * covariance[row + 4][column] : 0)
          + (column < 4 ? dtSeconds * covariance[row][column + 4] : 0)
          + (row < 4 && column < 4 ? dt2 * covariance[row + 4][column + 4] : 0);
      }
    }

    const height = Math.max(1e-3, mean[3]);
    const positionStd = [height / 20, height / 20, 1e-2, height / 20];
    const velocityStd = [height / 160, height / 160, 1e-5, height / 160];
    const fps = this.referenceFps;
    for (let i = 0; i < 4; i++) {
      // Convert the reference per-frame noise into continuous diffusion rates.
      // Qpp includes direct position noise and integrated velocity diffusion;
      // Qpv and Qvv account for the same elapsed interval exactly once.
      const positionRate = positionStd[i] ** 2 * fps;
      const velocityRate = velocityStd[i] ** 2 * fps ** 3;
      result[i][i] += positionRate * dtSeconds + velocityRate * dt2 * dtSeconds / 3;
      result[i][i + 4] += velocityRate * dt2 / 2;
      result[i + 4][i] += velocityRate * dt2 / 2;
      result[i + 4][i + 4] += velocityRate * dtSeconds;
    }
    keepPositiveSize(predicted);
    return { mean: predicted, covariance: result };
  }

  update(mean, covariance, measurement) {
    const height = Math.max(1e-3, mean[3]);
    const noise = [(height / 20) ** 2, (height / 20) ** 2, 1e-2, (height / 20) ** 2];
    const innovation = zeros(4, 4);
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        innovation[row][column] = covariance[row][column] + (row === column ? noise[row] : 0);
      }
    }
    const lower = cholesky(innovation);
    const gain = covariance.map(row => solveCholesky(lower, row.slice(0, 4)));
    const corrected = mean.slice();
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 4; column++) {
        corrected[row] += gain[row][column] * (measurement[column] - mean[column]);
      }
    }

    const residual = zeros(8, 8);
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 8; column++) {
        residual[row][column] = (row === column ? 1 : 0) - (column < 4 ? gain[row][column] : 0);
      }
    }
    const left = zeros(8, 8);
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 8; column++) {
        for (let k = 0; k < 8; k++) left[row][column] += residual[row][k] * covariance[k][column];
      }
    }
    const result = zeros(8, 8);
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 8; column++) {
        for (let k = 0; k < 8; k++) result[row][column] += left[row][k] * residual[column][k];
        for (let k = 0; k < 4; k++) result[row][column] += gain[row][k] * noise[k] * gain[column][k];
      }
    }
    for (let row = 0; row < 8; row++) {
      result[row][row] = Math.max(1e-12, result[row][row]);
      for (let column = 0; column < row; column++) {
        const average = (result[row][column] + result[column][row]) / 2;
        result[row][column] = average;
        result[column][row] = average;
      }
    }
    keepPositiveSize(corrected);
    return { mean: corrected, covariance: result };
  }
}
