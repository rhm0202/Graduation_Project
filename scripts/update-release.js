const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "out");
const DOWNLOADS_DIR = path.join(ROOT, "website", "downloads");
const LATEST_JSON = path.join(ROOT, "updates", "latest.json");
const LFS_BASE =
  "https://media.githubusercontent.com/media/rhm0202/Graduation_Project/main";

function getVersion() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  return pkg.version;
}

function getReleaseNotes(version) {
  const updatesPath = path.join(ROOT, "UPDATES.md");
  if (!fs.existsSync(updatesPath)) return "";

  const content = fs.readFileSync(updatesPath, "utf8");
  const lines = content.replace(/\r/g, "").split("\n");

  // ## v1.0.0 또는 ## v1.0.0a 처럼 버전 앞자리가 일치하는 섹션 탐색
  const versionPrefix = `v${version}`;
  let inSection = false;
  const sectionLines = [];

  for (const line of lines) {
    if (/^## v/.test(line)) {
      if (inSection) break; // 다음 버전 섹션 시작 → 종료
      // "## v1.0.0" 또는 "## v1.0.0a ·" 형태에서 버전 부분만 추출
      const match = line.match(/^## (v[\d.]+)/);
      if (match && match[1].startsWith(versionPrefix)) {
        inSection = true;
        sectionLines.push(line.replace(/^## /, "").trim()); // 헤더를 첫 줄로 포함
      }
    } else if (inSection) {
      sectionLines.push(line);
    }
  }

  if (sectionLines.length === 0) {
    console.warn(`[update-release] UPDATES.md에서 v${version} 섹션을 찾지 못함`);
    return "";
  }

  // 끝의 빈 줄/구분선 제거
  while (sectionLines.length > 0 && /^[\s\-]*$/.test(sectionLines[sectionLines.length - 1])) {
    sectionLines.pop();
  }

  return sectionLines.join("\n").trim();
}

function findPackageFolder() {
  if (!fs.existsSync(OUT_DIR)) {
    console.error(`[update-release] out 폴더를 찾을 수 없음: ${OUT_DIR}`);
    return null;
  }
  const folders = fs
    .readdirSync(OUT_DIR)
    .filter((f) => {
      const fullPath = path.join(OUT_DIR, f);
      return fs.statSync(fullPath).isDirectory() && f.includes("win32-x64");
    })
    .sort((a, b) => {
      const aMtime = fs.statSync(path.join(OUT_DIR, a)).mtimeMs;
      const bMtime = fs.statSync(path.join(OUT_DIR, b)).mtimeMs;
      return bMtime - aMtime;
    });

  if (folders.length === 0) {
    console.error("[update-release] win32-x64 패키지 폴더를 찾을 수 없음");
    return null;
  }
  return path.join(OUT_DIR, folders[0]);
}

function createZip(srcFolder, destZip) {
  if (process.platform === "win32") {
    execSync(
      `powershell -Command "Compress-Archive -Path '${srcFolder}' -DestinationPath '${destZip}' -Force"`,
      { stdio: "inherit" },
    );
  } else {
    const folderName = path.basename(srcFolder);
    const parentDir = path.dirname(srcFolder);
    execSync(`cd "${parentDir}" && zip -r "${destZip}" "${folderName}"`, {
      stdio: "inherit",
    });
  }
}

function run() {
  const version = getVersion();
  const today = new Date().toISOString().split("T")[0];

  const pkgFolder = findPackageFolder();
  if (!pkgFolder) process.exit(1);

  const folderName = path.basename(pkgFolder);
  const zipName = `${folderName}.zip`;

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const destZip = path.join(DOWNLOADS_DIR, zipName);

  console.log(`[update-release] 압축 중: ${pkgFolder} → ${destZip}`);
  createZip(pkgFolder, destZip);
  console.log(`[update-release] zip 생성 완료: ${destZip}`);

  const existing = fs.existsSync(LATEST_JSON)
    ? JSON.parse(fs.readFileSync(LATEST_JSON, "utf8"))
    : {};

  const releaseNotes = getReleaseNotes(version);

  const updated = {
    ...existing,
    version,
    releaseDate: today,
    downloadUrl: `${LFS_BASE}/website/downloads/${zipName}`,
    ...(releaseNotes && { releaseNotes }),
  };

  fs.writeFileSync(LATEST_JSON, JSON.stringify(updated, null, 2), "utf8");
  console.log(`[update-release] latest.json 갱신 완료: v${version} (${today})`);
}

run();
