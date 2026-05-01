const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

module.exports = {
  outDir: "C:\\electron_app2\\out",
  packagerConfig: {
    asar: true,
    prune: true,
    name: "Spotlight_Cam_V3.1.0",
    executableName: "Spotlight_Cam_V3.1.0",
    ignore: [
      /^\/docs/,
      /^\/website/,
      /^\/updates/,
      /^\/out/,
      /^\/\.git/,
      /^\/\.vscode/,
      /^\/.*\.md$/,
      /^\/forge\.config\.js$/,
    ],
    icon: "assets\\icon.ico",
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "Spotlight_Cam_V3.1.0",
        setupExe: "Spotlight_Cam-Setup.exe",
        setupIcon: "assets\\icon.ico",
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
