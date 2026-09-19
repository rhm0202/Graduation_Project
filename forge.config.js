const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const coreBuildDir = path.join(__dirname, "build", "python");
const coreBundleDir = path.join(coreBuildDir, "spotlight_core");

function buildSpotlightCore(_config, platform, arch) {
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error("Python 제어 프로그램은 배포 대상과 같은 OS/아키텍처에서 빌드해야 합니다.");
  }
  const envDir = path.join(__dirname, "build", "python-env");
  const python = path.join(envDir, platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const options = { cwd: __dirname, windowsHide: true, stdio: "inherit" };
  fs.mkdirSync(path.dirname(envDir), { recursive: true });
  if (!fs.existsSync(python)) {
    execFileSync(process.env.PYTHON || (platform === "win32" ? "py" : "python3"),
      ["-m", "venv", envDir], options);
  }
  const pythonArch = execFileSync(python, ["-c",
    "import platform, struct; print('ia32' if struct.calcsize('P') == 4 else {'amd64': 'x64', 'x86_64': 'x64', 'arm64': 'arm64', 'aarch64': 'arm64'}.get(platform.machine().lower(), platform.machine()))",
  ], { ...options, stdio: "pipe", encoding: "utf8" }).trim();
  if (pythonArch !== arch) {
    throw new Error(`Python 아키텍처(${pythonArch})와 앱 아키텍처(${arch})가 다릅니다.`);
  }
  try {
    execFileSync(python, ["-c",
      "from importlib.metadata import version; assert version('pyinstaller') == '6.22.3' and version('websockets') == '16.0'",
    ], { ...options, stdio: "pipe" });
  } catch {
    execFileSync(python, ["-m", "pip", "install", "--disable-pip-version-check",
      "pyinstaller==6.22.3", "websockets==16.0"], options);
  }
  execFileSync(python, ["-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
    "--name", "spotlight_core", "--collect-submodules", "websockets",
    "--distpath", coreBuildDir,
    "--workpath", path.join(__dirname, "build", "pyinstaller"),
    "--specpath", path.join(__dirname, "build"),
    path.join(__dirname, "server", "spotlight_core.py"),
  ], options);
}

module.exports = {
  outDir: "out",
  packagerConfig: {
    asar: true,
    extraResource: [coreBundleDir],
    prune: true,
    name: "Spotlight_Cam_v2.1.0",
    executableName: "Spotlight_Cam_v2.1.0",
    ignore: [
      /^\/docs/,
      /^\/updates/,
      /^\/out/,
      /^\/\.git/,
      /^\/\.vscode/,
      /^\/.*\.md$/,
      /^\/forge\.config\.js$/,
      /^\/(build|dist|experiments|logs|tests|server|\.omo|\.github)(\/|$)/,
      /^\/\.env($|\.)/,
    ],
    icon: "./assets/icon.ico",
  },
  hooks: {
    prePackage: async (...args) => buildSpotlightCore(...args),
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "Spotlight_Cam_v2.1.0",
        setupExe: "Spotlight_Cam-Setup_v2.1.0.exe",
        setupIcon: "./assets/icon.ico",
        // loadingGif: './assets/loading.gif', // 선택사항
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    {
      name: "@electron-forge/maker-deb",
      config: {},
    },
    {
      name: "@electron-forge/maker-rpm",
      config: {},
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
