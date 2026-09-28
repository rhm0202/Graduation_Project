import { collectPersonDetections, collectHeldObjectDetections, selectHeldObjects }
  from "../renderer/byteTracker.js";

const log = [];
const say = (s) => log.push(s);

// ── 앱 소스에서 함수·상수·마스크 조립 블록을 그대로 가져옵니다 ──────────
// 소스는 CRLF 라 앵커 대조 전에 줄바꿈을 통일합니다.
const SRC = (await (await fetch("../renderer/sources.js")).text())
  .split("\r\n").join("\n");
const grabFn = (n) => {
  const s = SRC.indexOf("function " + n + "(");
  if (s < 0) throw new Error("no fn " + n);
  return SRC.slice(s, SRC.indexOf("\n}", s) + 2);
};
const num = (n) => {
  const m = new RegExp("const " + n + " = ([-\\d.e]+);").exec(SRC);
  if (!m) throw new Error("no const " + n);
  return Number(m[1]);
};
const bool = (n) => /true/.test(new RegExp("const " + n + " = (\\w+);").exec(SRC)[1]);

const boxFilter = eval("(" + grabFn("boxFilter") + ")");
const guidedRefine = eval("(" + grabFn("guidedRefine") + ")");
const fillEnclosedHoles = eval("(" + grabFn("fillEnclosedHoles") + ")");
const erodeAlpha = eval("(" + grabFn("erodeAlpha") + ")");
const C = {
  REFINE_EDGE: bool("REFINE_EDGE"), REFINE_RADIUS: num("REFINE_RADIUS"),
  REFINE_EPS: num("REFINE_EPS"), ERODE_CELLS: num("ERODE_CELLS"),
  FILL_ENCLOSED_HOLES: bool("FILL_ENCLOSED_HOLES"),
  MAX_HOLE_FRACTION: num("MAX_HOLE_FRACTION"),
};
const FADE_NEW = eval("(" + /const FADE = REFINE_EDGE \? (\{[^}]+\})/.exec(SRC)[1] + ")");
const FADE_OLD = { lo: 0.45, hi: 0.55 };

// 마스크 조립 블록을 통째로 잘라 함수로 만듭니다.
const BSTART = SRC.indexOf("const combinedMask = new Float32Array(nProto);");
const BEND = SRC.indexOf("for (let i = 0, j = 3; i < alpha.length; i++, j += 4) md[j] = alpha[i];");
if (BSTART < 0 || BEND < 0) throw new Error("block markers not found");
const BLOCK = SRC.slice(BSTART, SRC.indexOf("\n", BEND));
const ARGS = ["nProto", "maskSources", "output0", "NUM_CHANNELS", "COEFF_START",
  "protos", "PROTO", "P2M", "MASK_RES", "bgTargets", "src", "FADE", "data",
  "MODEL_SIZE", "md", "REFINE_EDGE", "REFINE_RADIUS", "REFINE_EPS",
  "FILL_ENCLOSED_HOLES", "MAX_HOLE_FRACTION", "ERODE_CELLS",
  "guidedRefine", "boxFilter", "fillEnclosedHoles", "erodeAlpha"];
const assemble = new Function(...ARGS,
  BLOCK + "\nreturn { alpha, probField, rect, personBoxes, boxes160 };");

// guide 를 최근접이 아니라 면적 평균으로 만드는 변형.
// MASK_RES 가 640 보다 작으면 gScale > 1 이라 9 픽셀 중 1 개만 집어 오게 되고,
// 그렇게 뽑힌 휘도는 앨리어싱이 심합니다. 이게 경계를 흔드는지 봅니다.
const GUIDE_NN = `                const p = (srcRow + sx) * 4;
                rf.guide[dstRow + x] =
                  (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;`;
const GUIDE_AVG = `                const step = gScale > 1 ? (gScale + 0.5) | 0 : 1;
                let acc = 0, cnt = 0;
                for (let yy = sy; yy < sy + step && yy < MODEL_SIZE; yy++) {
                  for (let xx = sx; xx < sx + step && xx < MODEL_SIZE; xx++) {
                    const q = (yy * MODEL_SIZE + xx) * 4;
                    acc += 0.299 * data[q] + 0.587 * data[q + 1] + 0.114 * data[q + 2];
                    cnt++;
                  }
                }
                rf.guide[dstRow + x] = acc / (cnt * 255);`;
if (!BLOCK.includes(GUIDE_NN)) throw new Error("guide 앵커 불일치");
const assembleAvgGuide = new Function(...ARGS,
  BLOCK.replace(GUIDE_NN, GUIDE_AVG)
  + "\nreturn { alpha, probField, rect, personBoxes, boxes160 };");
say("조립 블록 " + BLOCK.split("\n").length + "줄을 소스에서 그대로 잘라 실행합니다.");
say("상수: REFINE_EDGE=" + C.REFINE_EDGE + " RADIUS=" + C.REFINE_RADIUS
  + " EPS=" + C.REFINE_EPS + " ERODE=" + C.ERODE_CELLS
  + " FILL=" + C.FILL_ENCLOSED_HOLES + " MAX_HOLE=" + C.MAX_HOLE_FRACTION
  + " FADE=" + FADE_NEW.lo + "~" + FADE_NEW.hi);

// ── 모델 ────────────────────────────────────────────────────────────
const MODEL_SIZE = 640, PROTO = 160, COEFF_START = 6;
let ep = "none", session = null;
for (const e of ["webgpu", "wasm"]) {
  try {
    session = await ort.InferenceSession.create("../AI_models/yolo26l-seg.onnx",
      { executionProviders: [e] });
    ep = e;
    break;
  } catch (err) { say("EP " + e + " 실패: " + err.message.slice(0, 90)); }
}
if (!session) throw new Error("no session");
say("실행 공급자: " + ep);

const loadImg = (p) => new Promise((res, rej) => {
  const i = new Image();
  i.onload = () => res(i);
  i.onerror = () => rej(new Error("img " + p));
  i.src = p;
});

const tmp = document.createElement("canvas");
tmp.width = tmp.height = MODEL_SIZE;
const tmpCtx = tmp.getContext("2d", { willReadFrequently: true });
const tensorData = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);

function makeSrc(MASK_RES) {
  const c = document.createElement("canvas");
  c.width = c.height = MASK_RES;
  const cx = c.getContext("2d", { willReadFrequently: true });
  const img = cx.createImageData(MASK_RES, MASK_RES);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
  }
  const n = MASK_RES * MASK_RES;
  return {
    _maskCanvas: c, _maskCtx: cx, _maskImg: img,
    _maskAlpha: new Uint8Array(n), _maskAlphaTmp: new Uint8Array(n),
    _maskVisited: new Uint8Array(n), _maskStack: new Int32Array(n),
    _maskProb: new Float32Array(n),
    _refine: {
      guide: new Float32Array(n), sub: new Float32Array(n),
      t1: new Float32Array(n), t2: new Float32Array(n),
      meanI: new Float32Array(n), meanP: new Float32Array(n),
      boxA: new Float32Array(n), boxB: new Float32Array(n),
      integral: new Float64Array((MASK_RES + 1) * (MASK_RES + 1)),
    },
  };
}

// 구멍을 상한과 무관하게 모두 열거해, 실제 데이터에서 넓이 분포를 봅니다.
function surveyHoles(alpha, MASK_RES, rect, personBoxes) {
  const visited = new Uint8Array(MASK_RES * MASK_RES);
  const stack = new Int32Array(MASK_RES * MASK_RES);
  const { x1, y1, x2, y2 } = rect;
  let top = 0;
  const push = (x, y) => {
    const i = y * MASK_RES + x;
    if (visited[i] !== 0 || alpha[i] === 255) return;
    visited[i] = 1; stack[top++] = i;
  };
  for (let x = x1; x <= x2; x++) { push(x, y1); push(x, y2); }
  for (let y = y1; y <= y2; y++) { push(x1, y); push(x2, y); }
  while (top > 0) {
    const i = stack[--top], x = i % MASK_RES, y = (i / MASK_RES) | 0;
    if (x > x1) push(x - 1, y);
    if (x < x2) push(x + 1, y);
    if (y > y1) push(x, y - 1);
    if (y < y2) push(x, y + 1);
  }
  const holes = [];
  let head = 0, tail = 0;
  const enq = (i) => {
    if (visited[i] !== 0 || alpha[i] === 255) return;
    visited[i] = 2; stack[tail++] = i;
  };
  for (let sy = y1; sy <= y2; sy++) {
    for (let sx = x1; sx <= x2; sx++) {
      const seed = sy * MASK_RES + sx;
      if (visited[seed] !== 0 || alpha[seed] === 255) continue;
      head = 0; tail = 0;
      let sumX = 0, sumY = 0, bx1 = 1e9, by1 = 1e9, bx2 = -1, by2 = -1;
      enq(seed);
      while (head < tail) {
        const i = stack[head++], x = i % MASK_RES, y = (i / MASK_RES) | 0;
        sumX += x; sumY += y;
        if (x < bx1) bx1 = x;
        if (x > bx2) bx2 = x;
        if (y < by1) by1 = y;
        if (y > by2) by2 = y;
        if (x > x1) enq(i - 1);
        if (x < x2) enq(i + 1);
        if (y > y1) enq(i - MASK_RES);
        if (y < y2) enq(i + MASK_RES);
      }
      const cx = sumX / tail, cy = sumY / tail;
      let ref = 0;
      for (const b of personBoxes) {
        if (cx < b.x1 || cx > b.x2 || cy < b.y1 || cy > b.y2) continue;
        const a = (b.x2 - b.x1) * (b.y2 - b.y1);
        if (ref === 0 || a < ref) ref = a;
      }
      holes.push({
        area: tail, refArea: Math.round(ref),
        frac: ref > 0 ? tail / ref : null,
        wh: (bx2 - bx1 + 1) + "x" + (by2 - by1 + 1),
      });
    }
  }
  return holes.sort((a, b) => b.area - a.area);
}

window.__run = async (paths) => {
  const out = { log, images: [], pngs: {} };
  for (const path of paths) {
    let im;
    try { im = await loadImg(path); }
    catch (e) { say("이미지 실패 " + path); continue; }
    const w = im.naturalWidth, h = im.naturalHeight;
    tmpCtx.drawImage(im, 0, 0, MODEL_SIZE, MODEL_SIZE);
    const tmpData = tmpCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);
    const data = tmpData.data;
    const total = MODEL_SIZE * MODEL_SIZE, INV = 1 / 255;
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      tensorData[i] = data[p] * INV;
      tensorData[total + i] = data[p + 1] * INV;
      tensorData[2 * total + i] = data[p + 2] * INV;
    }
    const res = await session.run({
      [session.inputNames[0]]:
        new ort.Tensor("float32", tensorData, [1, 3, MODEL_SIZE, MODEL_SIZE]),
    });
    const o0 = res[session.outputNames[0]], o1 = res[session.outputNames[1]];
    const output0 = o0.data, protos = o1.data, NUM_CHANNELS = o0.dims[2];
    const nProto = PROTO * PROTO;

    const people = collectPersonDetections(output0, NUM_CHANNELS)
      .filter((d) => d.score >= 0.5);
    const bgTargets = people.map((d) => ({ ...d, box: { ...d.box } }));
    const heldAll = collectHeldObjectDetections(output0, NUM_CHANNELS);
    const held = selectHeldObjects(heldAll, bgTargets);
    const maskSources = bgTargets.concat(held);

    const MASK_RES = Math.max(PROTO, Math.min(1280, Math.round(Math.max(w, h) / 3)));
    const P2M = PROTO / MASK_RES;
    const src = makeSrc(MASK_RES);
    const md = src._maskImg.data;

    const rec = {
      file: path.split("/").pop(), w, h, MASK_RES,
      people: bgTargets.length,
      objAll: heldAll.length,
      held: held.map((o) => o.classId + "@" + o.score.toFixed(2)),
      variants: {},
    };
    if (!bgTargets.length) { out.images.push(rec); continue; }

    const runOnce = (FADE, fill, maxHole, reps) => {
      let best = Infinity, r = null;
      for (let k = 0; k < (reps || 1); k++) {
        const t0 = performance.now();
        r = assemble(nProto, maskSources, output0, NUM_CHANNELS, COEFF_START,
          protos, PROTO, P2M, MASK_RES, bgTargets, src, FADE, data, MODEL_SIZE, md,
          C.REFINE_EDGE, C.REFINE_RADIUS, C.REFINE_EPS, fill, maxHole, C.ERODE_CELLS,
          guidedRefine, boxFilter, fillEnclosedHoles, erodeAlpha);
        best = Math.min(best, performance.now() - t0);
      }
      src._maskCtx.putImageData(src._maskImg, 0, 0);
      return { ms: best, ...r };
    };

    const upscale = () => {
      const fg = document.createElement("canvas");
      fg.width = w; fg.height = h;
      const fx = fg.getContext("2d", { willReadFrequently: true });
      fx.fillStyle = "#ffffff"; fx.fillRect(0, 0, w, h);
      fx.imageSmoothingEnabled = true;
      fx.globalCompositeOperation = "destination-in";
      fx.drawImage(src._maskCanvas, 0, 0, w, h);
      return fx.getImageData(0, 0, w, h).data;
    };

    // 띠 폭은 둘레로 정규화합니다. 행별 최장구간은 배경의 흐릿한 얼룩까지
    // 세어 버려 실제 인물 경계의 띠보다 훨씬 크게 나옵니다.
    const bandOf = (get, W, H) => {
      let partial = 0, perim = 0;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const v = get(x, y);
        if (v > 5 && v < 250) partial++;
        if (v >= 250 && (get(x - 1, y) < 250 || get(x + 1, y) < 250
          || get(x, y - 1) < 250 || get(x, y + 1) < 250)) perim++;
      }
      return perim ? partial / perim : null;
    };

    // 계단: 알파 128 등고선의 행별 이동량. 이진화된 마스크를 3배 확대하면
    // 한 번에 3px 씩 건너뜁니다. 부위가 바뀌며 튀는 행은 제외합니다.
    const stepOf = (d) => {
      const A = (x, y) => d[(y * w + x) * 4 + 3];
      const xs = [];
      for (let y = 0; y < h; y++) {
        let f = NaN;
        for (let x = 1; x < w; x++) {
          const p = A(x - 1, y), q = A(x, y);
          if (p >= 128 && q < 128) { f = x - 1 + (p - 128) / (p - q || 1); break; }
        }
        xs.push(f);
      }
      let n = 0, big = 0, sum = 0;
      for (let y = 1; y < h; y++) {
        const a = xs[y - 1], b = xs[y];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const dx = Math.abs(b - a);
        if (dx >= 4) continue;              // 다른 부위로 건너뛴 행
        n++; sum += dx;
        if (dx >= 1.5) big++;
      }
      return { rows: n, meanStep: n ? +(sum / n).toFixed(3) : null,
        stepPct: n ? +(100 * big / n).toFixed(1) : null };
    };

    const metrics = (d, r) => {
      const A = (x, y) => d[(y * w + x) * 4 + 3];
      const aM = (x, y) => r.alpha[y * MASK_RES + x];
      // 확률장이 0.5 를 지날 때의 칸당 기울기 (중앙값)
      const g = [];
      for (let y = r.rect.y1 + 1; y < r.rect.y2; y++)
        for (let x = r.rect.x1 + 1; x < r.rect.x2; x++) {
          const i = y * MASK_RES + x, p = r.probField[i];
          if (p < 0.5) continue;
          for (const j of [i - 1, i + 1, i - MASK_RES, i + MASK_RES]) {
            if (r.probField[j] < 0.5) { g.push(Math.abs(p - r.probField[j])); break; }
          }
        }
      g.sort((a, b) => a - b);
      const grad = g.length ? g[g.length >> 1] : null;
      return {
        bandPx: (() => { const v = bandOf(A, w, h); return v === null ? null : +v.toFixed(2); })(),
        bandCells: (() => { const v = bandOf(aM, MASK_RES, MASK_RES); return v === null ? null : +v.toFixed(2); })(),
        grad: grad === null ? null : +grad.toFixed(3),
        ...stepOf(d),
      };
    };

    const sweep = [[0.45, 0.55], [0.40, 0.60], [0.35, 0.65], [0.30, 0.70],
      [0.25, 0.75], [0.20, 0.80], [0.10, 0.90]]
      .map(([lo, hi]) => [lo.toFixed(2) + "~" + hi.toFixed(2), { lo, hi }]);
    sweep.push(["current", FADE_NEW]);
    for (const [name, FADE] of sweep) {
      const r = runOnce(FADE, C.FILL_ENCLOSED_HOLES, C.MAX_HOLE_FRACTION, 3);
      rec.variants[name] = { ms: +r.ms.toFixed(2), ...metrics(upscale(), r) };
      if (name === "0.45~0.55" || name === "0.20~0.80") {
        const fg = document.createElement("canvas");
        fg.width = w; fg.height = h;
        const fx = fg.getContext("2d", { willReadFrequently: true });
        fx.drawImage(im, 0, 0, w, h);
        fx.imageSmoothingEnabled = true;
        fx.globalCompositeOperation = "destination-in";
        fx.drawImage(src._maskCanvas, 0, 0, w, h);
        const comp0 = document.createElement("canvas");
        comp0.width = w; comp0.height = h;
        const cc = comp0.getContext("2d");
        cc.fillStyle = "#1e7a4b"; cc.fillRect(0, 0, w, h);
        cc.drawImage(fg, 0, 0);
        out.pngs[rec.file.replace(/\.[^.]+$/, "") + "-full-"
          + name.replace("~", "-") + ".png"] = comp0.toDataURL("image/png");

        // 실제 윤곽 위에 확대창을 놓습니다. 가장 큰 사람의 어깨 높이에서
        // 알파가 처음 떨어지는 지점을 찾습니다.
        const ad = fx.getImageData(0, 0, w, h).data;
        const pb = r.personBoxes.reduce((a, b) =>
          (a.x2 - a.x1) * (a.y2 - a.y1) > (b.x2 - b.x1) * (b.y2 - b.y1) ? a : b);
        const probeY = Math.min(h - 1, Math.max(0,
          Math.round((pb.y1 + (pb.y2 - pb.y1) * 0.3) / MASK_RES * h)));
        let edgeX = Math.round((pb.x1 + pb.x2) / 2 / MASK_RES * w);
        for (let x = 1; x < w; x++) {
          const p = ad[(probeY * w + x - 1) * 4 + 3], q = ad[(probeY * w + x) * 4 + 3];
          if (p < 40 && q >= 200) { edgeX = x; break; }
        }
        const CW = 90, CH = 110;
        const sx0 = Math.max(0, Math.min(w - CW, edgeX - 45));
        const sy0 = Math.max(0, Math.min(h - CH, probeY - 55));
        const z = document.createElement("canvas");
        z.width = CW * 4; z.height = CH * 4;
        const zc = z.getContext("2d");
        zc.fillStyle = "#1e7a4b"; zc.fillRect(0, 0, z.width, z.height);
        zc.imageSmoothingEnabled = false;
        zc.drawImage(fg, sx0, sy0, CW, CH, 0, 0, z.width, z.height);
        out.pngs[rec.file.replace(/\.[^.]+$/, "") + "-zoom-"
          + name.replace("~", "-") + ".png"] = z.toDataURL("image/png");
      }
      if (name === "current") {
        rec.rect = r.rect;
        rec.rectWH = (r.rect.x2 - r.rect.x1 + 1) + "x" + (r.rect.y2 - r.rect.y1 + 1);
        // 상한을 끈 상태에서 구멍 분포를 조사 (메우기 전 알파가 필요)
        const bare = runOnce(FADE, false, 0, 1);
        rec.holes = surveyHoles(bare.alpha, MASK_RES, bare.rect, bare.personBoxes)
          .slice(0, 6)
          .map((x) => ({ ...x, frac: x.frac === null ? null : +x.frac.toFixed(3) }));
        rec.msNoFill = +bare.ms.toFixed(2);
        // 다시 정식 설정으로 돌려 그림 저장
        runOnce(FADE, C.FILL_ENCLOSED_HOLES, C.MAX_HOLE_FRACTION, 1);
        const comp = document.createElement("canvas");
        comp.width = w; comp.height = h;
        const c2 = comp.getContext("2d");
        c2.fillStyle = "#1e7a4b"; c2.fillRect(0, 0, w, h);
        const fg = document.createElement("canvas");
        fg.width = w; fg.height = h;
        const fx = fg.getContext("2d");
        fx.drawImage(im, 0, 0, w, h);
        fx.imageSmoothingEnabled = true;
        fx.globalCompositeOperation = "destination-in";
        fx.drawImage(src._maskCanvas, 0, 0, w, h);
        c2.drawImage(fg, 0, 0);
        out.pngs[rec.file] = comp.toDataURL("image/png");
      }
    }
    out.images.push(rec);
  }
  return out;
};
// ── 구멍 분포 조사 ──────────────────────────────────────────────────
// 상한을 끈 채로 실제 사진에서 나오는 구멍의 넓이 분포를 봅니다.
// 물건 마스크를 합친 경우와 안 합친 경우를 나눠, 두 장치가 각각
// 무엇을 담당하는지 확인합니다.
window.__survey = async (paths) => {
  const rows = [];
  for (const path of paths) {
    let im;
    try { im = await loadImg(path); } catch (e) { continue; }
    const w = im.naturalWidth, h = im.naturalHeight;
    tmpCtx.drawImage(im, 0, 0, MODEL_SIZE, MODEL_SIZE);
    const data = tmpCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
    const total = MODEL_SIZE * MODEL_SIZE, INV = 1 / 255;
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      tensorData[i] = data[p] * INV;
      tensorData[total + i] = data[p + 1] * INV;
      tensorData[2 * total + i] = data[p + 2] * INV;
    }
    const res = await session.run({
      [session.inputNames[0]]:
        new ort.Tensor("float32", tensorData, [1, 3, MODEL_SIZE, MODEL_SIZE]),
    });
    const o0 = res[session.outputNames[0]], o1 = res[session.outputNames[1]];
    const output0 = o0.data, protos = o1.data, NUM_CHANNELS = o0.dims[2];
    const nProto = PROTO * PROTO;
    const bgTargets = collectPersonDetections(output0, NUM_CHANNELS)
      .filter((d) => d.score >= 0.5).map((d) => ({ ...d, box: { ...d.box } }));
    if (!bgTargets.length) continue;
    const held = selectHeldObjects(
      collectHeldObjectDetections(output0, NUM_CHANNELS), bgTargets);
    const MASK_RES = Math.max(PROTO, Math.min(1280, Math.round(Math.max(w, h) / 3)));
    const P2M = PROTO / MASK_RES;
    const src = makeSrc(MASK_RES);
    const md = src._maskImg.data;
    const go = (sources) => assemble(nProto, sources, output0, NUM_CHANNELS,
      COEFF_START, protos, PROTO, P2M, MASK_RES, bgTargets, src, FADE_NEW, data,
      MODEL_SIZE, md, C.REFINE_EDGE, C.REFINE_RADIUS, C.REFINE_EPS, false, 0,
      C.ERODE_CELLS, guidedRefine, boxFilter, fillEnclosedHoles, erodeAlpha);

    const withObj = go(bgTargets.concat(held));
    const hWith = surveyHoles(withObj.alpha, MASK_RES, withObj.rect, withObj.personBoxes);
    const noObj = go(bgTargets);
    const hNo = surveyHoles(noObj.alpha, MASK_RES, noObj.rect, noObj.personBoxes);
    rows.push({
      file: path.split("/").pop(), w, h, MASK_RES, people: bgTargets.length,
      held: held.map((o) => o.classId),
      holesWith: hWith.filter((x) => x.frac !== null).map((x) => +x.frac.toFixed(4)),
      holesNo: hNo.filter((x) => x.frac !== null).map((x) => +x.frac.toFixed(4)),
      topWith: hWith.slice(0, 3).map((x) => ({ a: x.area, f: x.frac, wh: x.wh })),
    });
  }
  return rows;
};

// ── 한 사진을 구멍 메우기 설정별로 렌더링 ────────────────────────────
window.__variants = async (path) => {
  const im = await loadImg(path);
  const w = im.naturalWidth, h = im.naturalHeight;
  tmpCtx.drawImage(im, 0, 0, MODEL_SIZE, MODEL_SIZE);
  const data = tmpCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const total = MODEL_SIZE * MODEL_SIZE, INV = 1 / 255;
  for (let i = 0, p = 0; i < total; i++, p += 4) {
    tensorData[i] = data[p] * INV;
    tensorData[total + i] = data[p + 1] * INV;
    tensorData[2 * total + i] = data[p + 2] * INV;
  }
  const res = await session.run({
    [session.inputNames[0]]:
      new ort.Tensor("float32", tensorData, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  });
  const o0 = res[session.outputNames[0]], o1 = res[session.outputNames[1]];
  const output0 = o0.data, protos = o1.data, NUM_CHANNELS = o0.dims[2];
  const nProto = PROTO * PROTO;
  const bgTargets = collectPersonDetections(output0, NUM_CHANNELS)
    .filter((d) => d.score >= 0.5).map((d) => ({ ...d, box: { ...d.box } }));
  const held = selectHeldObjects(
    collectHeldObjectDetections(output0, NUM_CHANNELS), bgTargets);
  const MASK_RES = Math.max(PROTO, Math.min(1280, Math.round(Math.max(w, h) / 3)));
  const P2M = PROTO / MASK_RES;
  const src = makeSrc(MASK_RES);
  const md = src._maskImg.data;
  const out = { w, h, MASK_RES, people: bgTargets.length, held: held.map((o) => o.classId), pngs: {} };

  const variants = [
    ["a-메우기끔", bgTargets.concat(held), false, 0],
    ["b-상한없이메움", bgTargets.concat(held), true, 0],
    ["c-상한6퍼센트", bgTargets.concat(held), true, C.MAX_HOLE_FRACTION],
    ["d-물건합치기끔", bgTargets, true, C.MAX_HOLE_FRACTION],
  ];
  for (const [name, sources, fill, cap] of variants) {
    assemble(nProto, sources, output0, NUM_CHANNELS, COEFF_START, protos, PROTO,
      P2M, MASK_RES, bgTargets, src, FADE_NEW, data, MODEL_SIZE, md,
      C.REFINE_EDGE, C.REFINE_RADIUS, C.REFINE_EPS, fill, cap, C.ERODE_CELLS,
      guidedRefine, boxFilter, fillEnclosedHoles, erodeAlpha);
    src._maskCtx.putImageData(src._maskImg, 0, 0);
    const fg = document.createElement("canvas");
    fg.width = w; fg.height = h;
    const fx = fg.getContext("2d");
    fx.drawImage(im, 0, 0, w, h);
    fx.imageSmoothingEnabled = true;
    fx.globalCompositeOperation = "destination-in";
    fx.drawImage(src._maskCanvas, 0, 0, w, h);
    const comp = document.createElement("canvas");
    comp.width = w; comp.height = h;
    const c2 = comp.getContext("2d");
    c2.fillStyle = "#1e7a4b"; c2.fillRect(0, 0, w, h);
    c2.drawImage(fg, 0, 0);
    out.pngs[name] = comp.toDataURL("image/png");
  }
  return out;
};

// ── 정답 마스크와의 비교 ────────────────────────────────────────────
// COCO128-seg 의 사람 폴리곤을 래스터화해 설정별 IoU 와 경계 F1 을 잽니다.
window.__iou = async (items, settings) => {
  const rows = [];
  for (const { path, polys } of items) {
    let im;
    try { im = await loadImg(path); } catch (e) { continue; }
    const w = im.naturalWidth, h = im.naturalHeight;
    tmpCtx.drawImage(im, 0, 0, MODEL_SIZE, MODEL_SIZE);
    const data = tmpCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
    const total = MODEL_SIZE * MODEL_SIZE, INV = 1 / 255;
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      tensorData[i] = data[p] * INV;
      tensorData[total + i] = data[p + 1] * INV;
      tensorData[2 * total + i] = data[p + 2] * INV;
    }
    const res = await session.run({
      [session.inputNames[0]]:
        new ort.Tensor("float32", tensorData, [1, 3, MODEL_SIZE, MODEL_SIZE]),
    });
    const o0 = res[session.outputNames[0]], o1 = res[session.outputNames[1]];
    const output0 = o0.data, protos = o1.data, NUM_CHANNELS = o0.dims[2];
    const nProto = PROTO * PROTO;
    const bgTargets = collectPersonDetections(output0, NUM_CHANNELS)
      .filter((d) => d.score >= 0.5).map((d) => ({ ...d, box: { ...d.box } }));
    if (!bgTargets.length) continue;
    const held = selectHeldObjects(
      collectHeldObjectDetections(output0, NUM_CHANNELS), bgTargets);
    const MASK_RES = Math.max(PROTO, Math.min(1280, Math.round(Math.max(w, h) / 3)));
    const P2M = PROTO / MASK_RES;
    const src = makeSrc(MASK_RES);
    const md = src._maskImg.data;

    // 정답 래스터
    const gtC = document.createElement("canvas");
    gtC.width = w; gtC.height = h;
    const gx = gtC.getContext("2d", { willReadFrequently: true });
    gx.fillStyle = "#000"; gx.fillRect(0, 0, w, h);
    gx.fillStyle = "#fff";
    for (const poly of polys) {
      gx.beginPath();
      for (let i = 0; i < poly.length; i += 2) {
        const X = poly[i] * w, Y = poly[i + 1] * h;
        if (i === 0) gx.moveTo(X, Y); else gx.lineTo(X, Y);
      }
      gx.closePath(); gx.fill();
    }
    const gtD = gx.getImageData(0, 0, w, h).data;
    const N = w * h;
    const gt = new Uint8Array(N);
    for (let i = 0, j = 0; i < N; i++, j += 4) gt[i] = gtD[j] > 127 ? 1 : 0;

    const boundary = (m) => {
      const b = new Uint8Array(N);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!m[i]) continue;
        if (!m[i - 1] || !m[i + 1] || !m[i - w] || !m[i + w]) b[i] = 1;
      }
      return b;
    };
    const dilate = (b, r) => {
      const t = new Uint8Array(N), o = new Uint8Array(N);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let v = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < w && b[y * w + xx]) { v = 1; break; }
        }
        t[y * w + x] = v;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let v = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < h && t[yy * w + x]) { v = 1; break; }
        }
        o[y * w + x] = v;
      }
      return o;
    };
    const gtB = boundary(gt), gtBD = dilate(gtB, 2);

    const fgc = document.createElement("canvas");
    fgc.width = w; fgc.height = h;
    const fc = fgc.getContext("2d", { willReadFrequently: true });

    const rec = { file: path.split("/").pop(), w, h, people: bgTargets.length,
      gtPeople: polys.length, s: {} };
    for (const st of settings) {
      (st.avgGuide ? assembleAvgGuide : assemble)(
        nProto, st.obj === false ? bgTargets : bgTargets.concat(held),
        output0, NUM_CHANNELS, COEFF_START, protos, PROTO, P2M, MASK_RES,
        bgTargets, src, st.fade, data, MODEL_SIZE, md,
        st.refine, st.radius, C.REFINE_EPS, st.fill, st.cap, st.erode,
        guidedRefine, boxFilter, fillEnclosedHoles, erodeAlpha);
      src._maskCtx.putImageData(src._maskImg, 0, 0);
      fc.globalCompositeOperation = "source-over";
      fc.fillStyle = "#fff"; fc.fillRect(0, 0, w, h);
      fc.imageSmoothingEnabled = true;
      fc.globalCompositeOperation = "destination-in";
      fc.drawImage(src._maskCanvas, 0, 0, w, h);
      const pd = fc.getImageData(0, 0, w, h).data;
      const pr = new Uint8Array(N);
      for (let i = 0, j = 3; i < N; i++, j += 4) pr[i] = pd[j] >= 128 ? 1 : 0;
      let inter = 0, uni = 0, np0 = 0, ng0 = 0;
      for (let i = 0; i < N; i++) { const a = gt[i], b = pr[i];
        if (a & b) inter++; if (a | b) uni++; if (b) np0++; if (a) ng0++; }
      const prB = boundary(pr), prBD = dilate(prB, 2);
      let tp = 0, np = 0, tr = 0, nr = 0;
      for (let i = 0; i < N; i++) {
        if (prB[i]) { np++; if (gtBD[i]) tp++; }
        if (gtB[i]) { nr++; if (prBD[i]) tr++; }
      }
      const P = np ? tp / np : 0, R = nr ? tr / nr : 0;
      rec.s[st.name] = {
        iou: uni ? +(inter / uni).toFixed(4) : 0,
        bf1: (P + R) ? +(2 * P * R / (P + R)).toFixed(4) : 0,
        // 정밀도 = 전경으로 남긴 것 중 실제 사람인 비율.
        //   낮으면 배경을 붙들고 있다는 뜻 → 합성하면 옛 배경이 테두리로 남음.
        // 재현율 = 실제 사람 중 남긴 비율. 낮으면 사람을 깎아먹은 것.
        prec: np0 ? +(inter / np0).toFixed(4) : 0,
        rec: ng0 ? +(inter / ng0).toFixed(4) : 0,
      };
    }
    rows.push(rec);
  }
  return rows;
};

// ── 성능 ────────────────────────────────────────────────────────────
window.__perf = async (path, reps) => {
  const im = await loadImg(path);
  const w = im.naturalWidth, h = im.naturalHeight;
  tmpCtx.drawImage(im, 0, 0, MODEL_SIZE, MODEL_SIZE);
  const data = tmpCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const total = MODEL_SIZE * MODEL_SIZE, INV = 1 / 255;
  for (let i = 0, p = 0; i < total; i++, p += 4) {
    tensorData[i] = data[p] * INV;
    tensorData[total + i] = data[p + 1] * INV;
    tensorData[2 * total + i] = data[p + 2] * INV;
  }
  const t0 = performance.now();
  const res = await session.run({
    [session.inputNames[0]]:
      new ort.Tensor("float32", tensorData, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  });
  const inferMs = performance.now() - t0;
  const o0 = res[session.outputNames[0]], o1 = res[session.outputNames[1]];
  const output0 = o0.data, protos = o1.data, NUM_CHANNELS = o0.dims[2];
  const nProto = PROTO * PROTO;
  const bgTargets = collectPersonDetections(output0, NUM_CHANNELS)
    .filter((d) => d.score >= 0.5).map((d) => ({ ...d, box: { ...d.box } }));
  const held = selectHeldObjects(
    collectHeldObjectDetections(output0, NUM_CHANNELS), bgTargets);
  const MASK_RES = Math.max(PROTO, Math.min(1280, Math.round(Math.max(w, h) / 3)));
  const P2M = PROTO / MASK_RES;
  const src = makeSrc(MASK_RES);
  const md = src._maskImg.data;
  const time = (st) => {
    const sources = st.obj === false ? bgTargets : bgTargets.concat(held);
    let best = Infinity;
    for (let k = 0; k < reps; k++) {
      const a = performance.now();
      assemble(nProto, sources, output0, NUM_CHANNELS, COEFF_START, protos,
        PROTO, P2M, MASK_RES, bgTargets, src, { lo: 0.45, hi: 0.55 }, data,
        MODEL_SIZE, md, st.refine, st.radius, C.REFINE_EPS, st.fill, st.cap,
        st.erode, guidedRefine, boxFilter, fillEnclosedHoles, erodeAlpha);
      best = Math.min(best, performance.now() - a);
    }
    return best;
  };
  const base = { refine: true, radius: 8, erode: 1, fill: true, cap: 0.06, obj: true };
  // JIT 가 데워지기 전 첫 설정만 느리게 나오므로 전부 한 번씩 돌려 둡니다.
  for (const st of [base, { ...base, refine: false }, { ...base, fill: false },
    { ...base, cap: 0 }, { ...base, erode: 0 }, { ...base, obj: false }]) time(st);
  const full = time(base);
  const r = {
    file: path.split("/").pop(), w, h, MASK_RES, inferMs: +inferMs.toFixed(1),
    people: bgTargets.length, held: held.length,
    full: +full.toFixed(2),
    "보정없이": +time({ ...base, refine: false }).toFixed(2),
    "구멍메우기없이": +time({ ...base, fill: false }).toFixed(2),
    "상한없이": +time({ ...base, cap: 0 }).toFixed(2),
    "침식없이": +time({ ...base, erode: 0 }).toFixed(2),
    "물건없이": +time({ ...base, obj: false }).toFixed(2),
  };
  return r;
};

// ── 임의 설정으로 렌더링 ─────────────────────────────────────────────
window.__render = async (path, settings) => {
  const im = await loadImg(path);
  const w = im.naturalWidth, h = im.naturalHeight;
  tmpCtx.drawImage(im, 0, 0, MODEL_SIZE, MODEL_SIZE);
  const data = tmpCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const total = MODEL_SIZE * MODEL_SIZE, INV = 1 / 255;
  for (let i = 0, p = 0; i < total; i++, p += 4) {
    tensorData[i] = data[p] * INV;
    tensorData[total + i] = data[p + 1] * INV;
    tensorData[2 * total + i] = data[p + 2] * INV;
  }
  const res = await session.run({
    [session.inputNames[0]]:
      new ort.Tensor("float32", tensorData, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  });
  const o0 = res[session.outputNames[0]], o1 = res[session.outputNames[1]];
  const output0 = o0.data, protos = o1.data, NUM_CHANNELS = o0.dims[2];
  const nProto = PROTO * PROTO;
  const bgTargets = collectPersonDetections(output0, NUM_CHANNELS)
    .filter((d) => d.score >= 0.5).map((d) => ({ ...d, box: { ...d.box } }));
  const held = selectHeldObjects(
    collectHeldObjectDetections(output0, NUM_CHANNELS), bgTargets);
  const MASK_RES = Math.max(PROTO, Math.min(1280, Math.round(Math.max(w, h) / 3)));
  const P2M = PROTO / MASK_RES;
  const src = makeSrc(MASK_RES);
  const md = src._maskImg.data;
  const pngs = {};
  for (const st of settings) {
    (st.avgGuide ? assembleAvgGuide : assemble)(
      nProto, st.obj === false ? bgTargets : bgTargets.concat(held),
      output0, NUM_CHANNELS, COEFF_START, protos, PROTO, P2M, MASK_RES,
      bgTargets, src, st.fade, data, MODEL_SIZE, md,
      st.refine, st.radius, C.REFINE_EPS, st.fill, st.cap, st.erode,
      guidedRefine, boxFilter, fillEnclosedHoles, erodeAlpha);
    src._maskCtx.putImageData(src._maskImg, 0, 0);
    const fg = document.createElement("canvas");
    fg.width = w; fg.height = h;
    const fx = fg.getContext("2d");
    fx.drawImage(im, 0, 0, w, h);
    fx.imageSmoothingEnabled = true;
    fx.globalCompositeOperation = "destination-in";
    fx.drawImage(src._maskCanvas, 0, 0, w, h);
    const comp = document.createElement("canvas");
    comp.width = w; comp.height = h;
    const c2 = comp.getContext("2d");
    c2.fillStyle = "#1e7a4b"; c2.fillRect(0, 0, w, h);
    c2.drawImage(fg, 0, 0);
    pngs[st.name] = comp.toDataURL("image/png");
  }
  return { w, h, MASK_RES, people: bgTargets.length, pngs };
};

window.__ready = true;
