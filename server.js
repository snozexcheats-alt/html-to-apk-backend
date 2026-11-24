import express from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const TIMEOUT = Number(process.env.BUILD_TIMEOUT_MS || 900000);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 2 } });
const builds = new Map();
const template = path.join(__dirname, "android-template");

app.use(express.static(path.join(__dirname, "public")));
app.get("/api/health", (_, res) => res.json({ ok: true, service: "html-to-apk-builder" }));

function safePackage(p) {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){1,}$/.test(p || "");
}
function safeLabel(label) {
  return String(label || "HTML App").replace(/[<>\"'&]/g, "").trim().slice(0, 40) || "HTML App";
}
function copyTemplate(dest) {
  fs.cpSync(template, dest, { recursive: true });
}
function writeGradleSettings(dir, pkg, label) {
  const appGradle = fs.readFileSync(path.join(dir, "app", "build.gradle"), "utf8")
    .replace("__PACKAGE__", pkg);
  fs.writeFileSync(path.join(dir, "app", "build.gradle"), appGradle);
  fs.writeFileSync(path.join(dir, "app", "src", "main", "res", "values", "strings.xml"),
    `<resources><string name="app_name">${label.replace(/&/g, "&amp;")}</string></resources>`);
}
function findIndexHtml(entries) {
  // Ignore unsafe zip paths; select index.html from root or first safe folder.
  const candidates = entries.filter(e => !e.isDirectory && !e.entryName.startsWith("/") &&
    !e.entryName.split("/").includes("..") && e.entryName.toLowerCase().endsWith("index.html"));
  const root = candidates.find(e => e.entryName.toLowerCase() === "index.html");
  return root || candidates[0];
}
function extractZipSafely(zip, dest) {
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, "/");
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("ZIP contains an unsafe path.");
    if (entry.isDirectory) continue;
    const out = path.join(dest, name);
    if (!out.startsWith(dest + path.sep)) throw new Error("Unsafe ZIP path.");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, entry.getData());
  }
}
function copyHtmlUpload(file, assetsDir) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    fs.writeFileSync(path.join(assetsDir, "index.html"), file.buffer);
    return;
  }
  if (ext !== ".zip") throw new Error("Upload an .html file or .zip project.");
  const zip = new AdmZip(file.buffer);
  const entries = zip.getEntries();
  const index = findIndexHtml(entries);
  if (!index) throw new Error("ZIP must contain index.html.");
  extractZipSafely(zip, assetsDir);
  // If index was inside one folder, copy its folder contents to assets root.
  if (index.entryName.toLowerCase() !== "index.html") {
    const nested = path.dirname(index.entryName);
    const nestedPath = path.join(assetsDir, nested);
    if (fs.existsSync(nestedPath)) {
      for (const item of fs.readdirSync(nestedPath)) fs.cpSync(path.join(nestedPath, item), path.join(assetsDir, item), { recursive: true });
      fs.rmSync(nestedPath, { recursive: true, force: true });
    }
  }
}
function runGradle(dir, id) {
  return new Promise((resolve, reject) => {
    const proc = spawn("gradle", ["--no-daemon", "assembleDebug"], { cwd: dir, env: { ...process.env, ANDROID_HOME: process.env.ANDROID_HOME || "/opt/android-sdk" } });
    let log = "";
    const timer = setTimeout(() => { proc.kill("SIGTERM"); reject(new Error("Build timed out. Try a smaller project or retry.")); }, TIMEOUT);
    proc.stdout.on("data", d => { log += d.toString(); builds.get(id).log = log.slice(-12000); });
    proc.stderr.on("data", d => { log += d.toString(); builds.get(id).log = log.slice(-12000); });
    proc.on("error", e => { clearTimeout(timer); reject(e); });
    proc.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("Gradle failed. Open build logs for details."));
      else resolve(log);
    });
  });
}
app.post("/api/build", upload.fields([{ name: "project", maxCount: 1 }, { name: "icon", maxCount: 1 }]), async (req, res) => {
  try {
    const project = req.files?.project?.[0];
    if (!project) return res.status(400).json({ error: "Select an HTML or ZIP project." });
    const label = safeLabel(req.body.appName);
    const pkg = String(req.body.packageName || "");
    if (!safePackage(pkg)) return res.status(400).json({ error: "Package name must look like com.example.app." });
    const id = crypto.randomUUID();
    const work = path.join(os.tmpdir(), "apkbuild-" + id);
    fs.mkdirSync(work, { recursive: true });
    copyTemplate(work);
    const assetsDir = path.join(work, "app", "src", "main", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    copyHtmlUpload(project, assetsDir);
    writeGradleSettings(work, pkg, label);
    builds.set(id, { status: "queued", log: "", work, created: Date.now() });
    res.json({ buildId: id });
    builds.get(id).status = "building";
    try {
      await runGradle(work, id);
      const apk = path.join(work, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
      if (!fs.existsSync(apk)) throw new Error("APK output not found after Gradle completed.");
      builds.get(id).apk = apk;
      builds.get(id).status = "success";
    } catch (e) {
      builds.get(id).status = "failed";
      builds.get(id).error = e.message;
      builds.get(id).log = (builds.get(id).log || "") + "\n" + e.message;
    }
  } catch (e) {
    res.status(400).json({ error: e.message || "Could not start build." });
  }
});
app.get("/api/build/:id", (req, res) => {
  const b = builds.get(req.params.id);
  if (!b) return res.status(404).json({ error: "Build not found." });
  res.json({ status: b.status, error: b.error || null, log: b.log || "" });
});
app.get("/api/build/:id/apk", (req, res) => {
  const b = builds.get(req.params.id);
  if (!b || b.status !== "success" || !b.apk || !fs.existsSync(b.apk)) return res.status(404).json({ error: "APK not ready." });
  res.download(b.apk, "html-app-debug.apk");
});
app.listen(PORT, () => console.log(`HTML-to-APK backend listening on ${PORT}`));
