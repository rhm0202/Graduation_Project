const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");

function readHead(relativePath) {
  return execFileSync("git", ["show", `HEAD:${relativePath}`], {
    cwd: repoRoot,
    encoding: "utf8",
  }).replaceAll("\r\n", "\n");
}

function readWorktree(relativePath) {
  return fs
    .readFileSync(path.join(repoRoot, relativePath), "utf8")
    .replaceAll("\r\n", "\n");
}

function normalizeCss(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");
}

function normalizeHtml(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .trim();
}

for (const relativePath of ["styles.css", "docs/styles.css"]) {
  assert.equal(
    normalizeCss(readWorktree(relativePath)),
    normalizeCss(readHead(relativePath)),
    `${relativePath} changed beyond comments or formatting`,
  );
}

for (const relativePath of ["index.html", "docs/index.html"]) {
  assert.equal(
    normalizeHtml(readWorktree(relativePath)),
    normalizeHtml(readHead(relativePath)),
    `${relativePath} changed beyond comments or inter-tag whitespace`,
  );
}

assert.equal(
  readWorktree("docs/script.js"),
  readHead("docs/script.js"),
  "docs/script.js behavior changed",
);

console.log("UI design contract: PASS");
