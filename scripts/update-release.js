const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = "C:\\electron_app2\\out\\make\\squirrel.windows\\x64";
const DOWNLOADS_DIR = path.join(ROOT, "website", "downloads");
const LATEST_JSON = path.join(ROOT, "updates", "latest.json");
const LFS_BASE =
  "https://media.githubusercontent.com/media/rhm0202/Graduation_Project/main";

function getForgeConfig() {
  const config = require(path.join(ROOT, "forge.config.js"));
  const packager = config.packagerConfig || {};
  const squirrel = (config.makers || []).find((m) =>
    m.name.includes("squirrel"),
  );
  return {
    appName: packager.name || "app",
    setupExe: squirrel?.config?.setupExe || `${packager.name}-Setup.exe`,
  };
}

function getVersion() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  return pkg.version;
}

function findSetupExe(setupExeName) {
  const target = path.join(OUT_DIR, setupExeName);
  if (fs.existsSync(target)) return target;

  // fallback: find any Setup.exe in the out dir
  if (!fs.existsSync(OUT_DIR)) {
    console.error(`[update-release] out 폴더를 찾을 수 없음: ${OUT_DIR}`);
    return null;
  }
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".exe"));
  if (files.length === 0) {
    console.error("[update-release] out 폴더에 exe 파일 없음");
    return null;
  }
  return path.join(OUT_DIR, files[0]);
}

function run() {
  const { appName, setupExe } = getForgeConfig();
  const version = getVersion();
  const today = new Date().toISOString().split("T")[0];

  const srcExe = findSetupExe(setupExe);
  if (!srcExe) process.exit(1);

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const destExe = path.join(DOWNLOADS_DIR, setupExe);
  fs.copyFileSync(srcExe, destExe);
  console.log(`[update-release] exe 복사 완료: ${destExe}`);

  const existing = fs.existsSync(LATEST_JSON)
    ? JSON.parse(fs.readFileSync(LATEST_JSON, "utf8"))
    : {};

  const updated = {
    ...existing,
    version,
    releaseDate: today,
    downloadUrl: `${LFS_BASE}/website/downloads/${setupExe}`,
  };

  fs.writeFileSync(LATEST_JSON, JSON.stringify(updated, null, 2), "utf8");
  console.log(`[update-release] latest.json 갱신 완료: v${version} (${today})`);
}

run();
