#!/usr/bin/env node
/**
 * 抓某段时间窗内的 captcha 事件链，用于定位 instance_timeout。
 *   node _re/captcha_window.js 2026-09-27 02:59:20 20
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const LOGDIR = path.join(os.homedir(), ".zcode", "v2", "logs");
const day = process.argv[2] || new Date().toISOString().slice(0, 10);
const from = process.argv[3] || "00:00:00";
const spanSec = parseInt(process.argv[4] || "30", 10);

const f = path.join(LOGDIR, day + ".log");
if (!fs.existsSync(f)) { console.error("找不到 " + f); process.exit(1); }

const toSec = (s) => {
  const [h, m, x] = s.split(":").map(Number);
  return h * 3600 + m * 60 + x;
};
const lo = toSec(from), hi = lo + spanSec;

const grab = (line, re, g = 1) => {
  const m = re.exec(line);
  return m ? m[g] : "";
};

console.log("日志   : %s" % f);
console.log("窗口   : %s 起 %d 秒\n", from, spanSec);

const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
for (const line of lines) {
  const t = grab(line, /^\[(\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d))/);
  if (!t) continue;
  const sec = toSec(t.slice(11));
  if (sec < lo || sec > hi) continue;

  const kind = grab(line, /\[(captcha-[a-z]+)\]/, 1);
  const ev = grab(line, /"event":"([^"]+)"/);
  const stage = grab(line, /"stage":"([^"]+)"/);
  const akind = grab(line, /"kind":"([^"]+)"/);
  const host = grab(line, /"host":"([^"]+)"/);
  const el = grab(line, /"elapsedMs":(\d+)/);
  const st = grab(line, /"statusCode":(\d+)/);
  const ec = grab(line, /"errorCode":(\S+?)[,}]/);
  const oc = grab(line, /"outcome":"([^"]+)"/);
  const err = grab(line, /"errorKind":"([^"]+)"/);
  const ready = /"instanceReady":true/.test(line) ? "ready" : "notready";

  let extra = [stage, oc, err, ready].filter(Boolean).join(" ");
  if (akind) extra = akind + "  " + host + "  elapsed=" + el + "  status=" + st + "  err=" + ec;

  console.log(t.slice(11) + "  " + kind.padEnd(20) + ev.padEnd(18) + extra);
}
