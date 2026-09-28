// 앱 모듈을 그대로 import 해서 돌립니다.
import fs from "fs";
import { pathToFileURL } from "url";

const bt = await import(pathToFileURL("renderer/byteTracker.js").href);
const { collectHeldObjectDetections, selectHeldObjects, collectPersonDetections,
  HELD_OBJECT_POLICY } = bt;

const SRC = fs.readFileSync("renderer/sources.js", "utf8");
const grab = (n) => {
  const s = SRC.indexOf("function " + n + "(");
  return SRC.slice(s, SRC.indexOf("\n}", s) + 2);
};
const boxFilter = eval("(" + grab("boxFilter") + ")");
const guidedRefine = eval("(" + grab("guidedRefine") + ")");
const fillEnclosedHoles = eval("(" + grab("fillEnclosedHoles") + ")");
const erodeAlpha = eval("(" + grab("erodeAlpha") + ")");

let fails = 0, n = 0;
const ok = (label, cond, extra) => {
  n++;
  if (!cond) fails++;
  console.log((cond ? "  ok   " : "  FAIL ") + label + (extra ? "  " + extra : ""));
};
const head = (s) => console.log("\n" + s);

// ── 1. 물건 검출 수집 ────────────────────────────────────────────────
head("collectHeldObjectDetections");
const CH = 38;
const det = (box, score, cls) => {
  const a = new Float32Array(CH);
  a[0] = box[0]; a[1] = box[1]; a[2] = box[2]; a[3] = box[3];
  a[4] = score; a[5] = cls;
  return a;
};
const cat = (...rows) => {
  const out = new Float32Array(rows.length * CH);
  rows.forEach((r, i) => out.set(r, i * CH));
  return out;
};
{
  const t = cat(
    det([100, 100, 200, 200], 0.9, 0),    // 사람 → 제외
    det([120, 120, 160, 180], 0.8, 41),   // 컵 → 채택
    det([300, 300, 340, 340], 0.4, 41),   // 점수 미달 → 제외
    det([0, 0, 10, 10], 1.5, 41),         // 점수 이상 → 제외
    det([50, 50, 50, 80], 0.9, 41),       // 폭 0 → 제외
    det([10, 10, 20, 20], 0.9, NaN),      // 클래스 NaN → 제외
  );
  const got = collectHeldObjectDetections(t, CH);
  ok("사람과 불량 검출을 걸러 1개만 남김", got.length === 1 && got[0].classId === 41,
    JSON.stringify(got.map((g) => g.classId)));
  ok("anc 인덱스가 보존됨", got[0].anc === 1);
}
{
  const t = cat(det([0, 0, 800, 800], 0.9, 41));   // 640 밖 좌표
  const got = collectHeldObjectDetections(t, CH);
  ok("모델 크기로 잘림", got[0].box.x2 === 640 && got[0].box.y2 === 640);
}
{
  let threw = false;
  try { collectHeldObjectDetections(new Float32Array(37), 38); } catch (e) { threw = true; }
  ok("채널 수가 안 맞으면 예외", threw);
  threw = false;
  try { collectHeldObjectDetections(new Float32Array(76), 37); } catch (e) { threw = true; }
  ok("38채널이 아니면 예외", threw);
}

// ── 2. 몸 안 물건 선별 ───────────────────────────────────────────────
head("selectHeldObjects  (containment=" + HELD_OBJECT_POLICY.containment
  + ", max=" + HELD_OBJECT_POLICY.maxObjects + ")");
const person = [{ box: { x1: 100, y1: 100, x2: 300, y2: 400 } }];
const obj = (x1, y1, x2, y2, score = 0.9, classId = 41) =>
  ({ box: { x1, y1, x2, y2 }, score, classId, anc: 0 });
{
  ok("완전히 안에 들면 채택",
    selectHeldObjects([obj(150, 150, 200, 200)], person).length === 1);
  ok("완전히 밖이면 제외",
    selectHeldObjects([obj(400, 400, 450, 450)], person).length === 0);
  // 절반만 겹침 → containment 0.5 < 0.7
  ok("절반만 겹치면 제외",
    selectHeldObjects([obj(250, 150, 350, 200)], person).length === 0);
  // 80% 겹침 → 채택 (팔 밖으로 조금 나온 경우)
  ok("80% 들어오면 채택",
    selectHeldObjects([obj(260, 150, 310, 200)], person).length === 1);
  ok("대상이 없으면 빈 배열", selectHeldObjects([obj(150, 150, 200, 200)], []).length === 0);
}
{
  const many = [];
  for (let i = 0; i < 8; i++) many.push(obj(150 + i, 150, 200 + i, 200, 0.5 + i * 0.05));
  const got = selectHeldObjects(many, person);
  ok("개수 상한이 걸림", got.length === HELD_OBJECT_POLICY.maxObjects, "→ " + got.length);
  let sorted = true;
  for (let i = 1; i < got.length; i++) if (got[i].score > got[i - 1].score) sorted = false;
  const dropped = many.filter((m) => !got.includes(m)).every((m) => m.score < got[3].score);
  ok("점수 내림차순으로 남김", sorted && dropped,
    got.map((g) => g.score.toFixed(2)).join(" > "));
}

// ── 3. boxFilter 가 무식한 방법과 같은 값을 내는가 ────────────────────
head("boxFilter  (적분영상 vs 직접 합산)");
{
  const W = 37, H = 29, r = 5;
  const src = new Float32Array(W * H);
  for (let i = 0; i < src.length; i++) src[i] = Math.sin(i * 0.7) * 0.5 + 0.5;
  const dst = new Float32Array(W * H);
  boxFilter(src, dst, W, H, r, new Float64Array((W + 1) * (H + 1)));
  let worst = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    let s = 0;
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) s += src[yy * W + xx];
    worst = Math.max(worst, Math.abs(s / ((x1 - x0 + 1) * (y1 - y0 + 1)) - dst[y * W + x]));
  }
  ok("모든 칸이 일치", worst < 1e-6, "최대오차 " + worst.toExponential(2));
}

// ── 4. guidedRefine 의 성질 ─────────────────────────────────────────
head("guidedRefine");
{
  const W = 64, H = 64, n = W * H;
  const bufs = () => ({
    t1: new Float32Array(n), t2: new Float32Array(n), meanI: new Float32Array(n),
    meanP: new Float32Array(n), boxA: new Float32Array(n), boxB: new Float32Array(n),
    integral: new Float64Array((W + 1) * (H + 1)),
  });
  // 휘도가 완전히 균일하면 a→0 이라 확률장의 지역 평균만 남아야 합니다.
  const guide = new Float32Array(n).fill(0.5);
  const prob = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) prob[y * W + x] = x < 32 ? 1 : 0;
  const p2 = prob.slice();
  guidedRefine(guide, p2, W, H, 4, 1e-4, bufs());
  const ref = new Float32Array(n);
  boxFilter(prob, ref, W, H, 4, new Float64Array((W + 1) * (H + 1)));
  // 평활을 두 번 거치므로 정확히 같지는 않지만 경계가 뭉개지는 방향은 같아야 합니다.
  let mono = true;
  for (let x = 1; x < W; x++) if (p2[32 * W + x] > p2[32 * W + x - 1] + 1e-6) mono = false;
  ok("휘도가 균일하면 경계가 단조롭게 뭉개짐", mono);

  // 휘도에 계단이 있으면 확률장이 그 계단을 따라가야 합니다.
  const g2 = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g2[y * W + x] = x < 40 ? 0.9 : 0.1;
  const p3 = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    p3[y * W + x] = 1 / (1 + Math.exp(-(34 - x) * 0.4));   // 34 근처에서 완만히
  }
  const before = p3.slice();
  guidedRefine(g2, p3, W, H, 8, 1e-4, bufs());
  const cross = (arr) => {
    for (let x = 1; x < W; x++) if (arr[32 * W + x] < 0.5 && arr[32 * W + x - 1] >= 0.5) return x;
    return -1;
  };
  const c0 = cross(before), c1 = cross(p3);
  ok("경계가 휘도 계단 쪽으로 끌려감", c1 > c0 && c1 <= 41, `${c0} → ${c1} (휘도 계단 40)`);

  // 반경별로 얼마나 붙고 얼마나 완만해지는지 표로 봅니다.
  // 기록에는 "보정 후 확률장이 가파르게 선다"고 적혀 있지만 실제로는
  // 반대입니다. a·b 를 다시 평활하는 단계가 경계를 눕힙니다.
  console.log("    반경별 (휘도 계단 x=40, 원래 경계 x=35, 원래 기울기 "
    + Math.abs(before[32 * W + c0] - before[32 * W + c0 - 1]).toFixed(3) + ")");
  for (const r of [2, 4, 8, 16]) {
    const p = before.slice();
    guidedRefine(g2, p, W, H, r, 1e-4, bufs());
    const c = cross(p);
    const s = c > 0 ? Math.abs(p[32 * W + c] - p[32 * W + c - 1]) : NaN;
    console.log(`      r=${String(r).padStart(2)}  경계 x=${c}  칸당기울기 ${s.toFixed(3)}`);
  }
  const slope = (arr) => Math.abs(arr[32 * W + c1] - arr[32 * W + c1 - 1]);
  ok("보정이 경계를 가파르게 만들지는 않음 (기록의 전제와 반대)",
    slope(p3) < slope(before),
    slope(before).toFixed(3) + " → " + slope(p3).toFixed(3));
}

// ── 5. fillEnclosedHoles 의 가장자리 조건 ────────────────────────────
head("fillEnclosedHoles  가장자리·비정상 입력");
{
  const S = 32;
  const mk = () => new Uint8Array(S * S);
  const run = (a, rect, boxes, frac) => fillEnclosedHoles(
    a, new Uint8Array(S * S), new Int32Array(S * S), S, rect, boxes, frac);
  let threw = false;
  try {
    run(mk(), { x1: 5, y1: 5, x2: 5, y2: 5 }, [], 0.06);
    run(mk(), { x1: 10, y1: 10, x2: 2, y2: 2 }, [], 0.06);
    run(mk(), { x1: 0, y1: 0, x2: S - 1, y2: S - 1 }, [], 0.06);
  } catch (e) { threw = true; console.log("    " + e.message); }
  ok("퇴화된 rect 와 빈 박스에서 예외 없음", !threw);

  // 인물이 프레임에 걸려 rect 테두리가 불투명한 경우
  const a = mk();
  for (let y = 0; y < S; y++) for (let x = 0; x < 20; x++) a[y * S + x] = 255;
  for (let y = 10; y < 16; y++) for (let x = 5; x < 11; x++) a[y * S + x] = 0;  // 안쪽 구멍
  run(a, { x1: 0, y1: 0, x2: S - 1, y2: S - 1 },
    [{ x1: 0, y1: 0, x2: 19, y2: S - 1 }], 0.06);
  ok("왼쪽 변이 통째로 불투명해도 오른쪽으로 번져 바깥을 찾음",
    a[2 * S + 25] === 0, "바깥 유지");
  ok("걸친 인물 안쪽 구멍은 넓이 상한을 넘으면 유지",
    a[12 * S + 7] === 0, "36칸 / 박스 608칸 = 5.9% → 경계값");

  // 박스 넓이 대비 정확히 경계값 근처
  const a2 = mk();
  for (let y = 0; y < S; y++) for (let x = 0; x < 20; x++) a2[y * S + x] = 255;
  for (let y = 10; y < 15; y++) for (let x = 5; x < 11; x++) a2[y * S + x] = 0; // 30칸 = 4.9%
  run(a2, { x1: 0, y1: 0, x2: S - 1, y2: S - 1 },
    [{ x1: 0, y1: 0, x2: 19, y2: S - 1 }], 0.06);
  ok("상한 아래면 메움", a2[12 * S + 7] === 255);
}

// ── 5-1. 화면 끝에 닿은 구멍 ─────────────────────────────────────────
// 웹캠은 몸이 화면 아래에서 잘리므로, 가슴 앞에 든 물건의 구멍이 화면
// 아래 끝에 닿습니다. 그런 구멍은 메우고, 화면 끝으로 트인 진짜 배경은
// 남겨야 합니다.
head("fillEnclosedHoles  화면 끝에 닿은 구멍");
{
  const N = 200;
  const holes = (a, x0, y0, x1, y1) => {
    let n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (a[y * N + x] === 0) n++;
    return n;
  };
  const run = (a, own, rect, boxes) => fillEnclosedHoles(a, new Uint8Array(N * N),
    new Int32Array(N * N), N, rect, boxes, 0.06, (i) => own[i]);
  const body = (a, own, who, x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      a[y * N + x] = 255;
      if (own[y * N + x] < 0) own[y * N + x] = who;
    }
  };
  const mk = () => [new Uint8Array(N * N), new Int8Array(N * N).fill(-1)];

  // 한 사람, 가슴 앞 이어폰 케이스 구멍이 화면 아래 끝에 닿음
  {
    const [a, own] = mk();
    body(a, own, 0, 40, 40, 160, N - 1);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
      if ((x - 90) ** 2 + (y - 188) ** 2 < 16 ** 2) a[y * N + x] = 0;
    run(a, own, { x1: 38, y1: 38, x2: 162, y2: N - 1 }, [{ x1: 40, y1: 40, x2: 160, y2: N - 1 }]);
    ok("한 사람 안의 구멍은 화면 아래에 닿아도 메움", holes(a, 70, 170, 110, N - 1) === 0);
  }

  // 두 사람 사이, 뻗은 팔 아래의 배경이 화면 아래 끝으로만 트임
  {
    const [a, own] = mk();
    body(a, own, 0, 10, 40, 90, N - 1);
    body(a, own, 0, 90, 60, 170, 74);            // 뻗은 팔
    body(a, own, 1, 120, 40, 190, N - 1);
    run(a, own, { x1: 8, y1: 38, x2: 192, y2: N - 1 },
      [{ x1: 10, y1: 40, x2: 170, y2: N - 1 }, { x1: 120, y1: 40, x2: 190, y2: N - 1 }]);
    const n = holes(a, 91, 75, 119, N - 1);
    ok("두 사람 사이 틈은 유지", n === 29 * 125, n + "칸");
  }

  // 사람이 화면을 가로로 꽉 채움 → 시작점이 되는 변이 없음. 머리 옆 윗모서리 배경.
  {
    const [a, own] = mk();
    body(a, own, 0, 0, 100, N - 1, N - 1);       // 어깨 아래
    body(a, own, 0, 70, 0, 130, 100);            // 머리
    run(a, own, { x1: 0, y1: 0, x2: N - 1, y2: N - 1 }, [{ x1: 0, y1: 0, x2: N - 1, y2: N - 1 }]);
    const n = holes(a, 0, 0, 69, 99);
    ok("화면 두 변에 닿은 모서리 배경은 유지", n === 70 * 100, n + "칸");
  }
}

// ── 6. 침식은 구멍을 넓힌다 (메우기를 먼저 해야 하는 이유) ────────────
head("순서 검증");
{
  const S = 32;
  const a = new Uint8Array(S * S);
  for (let y = 4; y < 28; y++) for (let x = 4; x < 28; x++) a[y * S + x] = 255;
  for (let y = 14; y < 18; y++) for (let x = 14; x < 18; x++) a[y * S + x] = 0;
  const eroded = a.slice();
  erodeAlpha(eroded, new Uint8Array(S * S), S, 1);
  let before = 0, after = 0;
  for (let i = 0; i < a.length; i++) { if (!a[i]) before++; if (!eroded[i]) after++; }
  ok("침식이 구멍을 넓힘 → 메우기가 먼저여야 함", after > before, `${before} → ${after} 투명칸`);
}

console.log(`\n${n - fails}/${n} 통과` + (fails ? `  (${fails} 실패)` : ""));
process.exit(fails ? 1 : 0);
