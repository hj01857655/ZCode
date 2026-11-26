/**
 * Windows 原生输入注入（user32.dll SendInput）——CUA 执行层的鼠标/键盘原语。
 * koffi 2.x：原型串形式（lib.func('ret __stdcall Name(proto)')），INPUT 结构用字节数组手组，
 * 避开 koffi struct 的 union 对齐解析问题。无编译步骤。
 */
import koffi from "koffi";

const user32 = koffi.load("user32.dll");

// ---- 常量 ----
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSE_EVENTF_MOVE = 0x0001;
const MOUSE_EVENTF_LEFTDOWN = 0x0002;
const MOUSE_EVENTF_LEFTUP = 0x0004;
const MOUSE_EVENTF_RIGHTDOWN = 0x0008;
const MOUSE_EVENTF_RIGHTUP = 0x0010;
const MOUSE_EVENTF_MIDDLEDOWN = 0x0020;
const MOUSE_EVENTF_MIDDLEUP = 0x0040;
const MOUSE_EVENTF_WHEEL = 0x0800;
const MOUSE_EVENTF_ABSOLUTE = 0x8000;

const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

const INPUT_SIZE = 40; // sizeof(INPUT) x64

// SendInput 用字节指针传入（原类型 unsigned char*），绕开 struct 解析
const SendInputRaw = user32.func("uint32 __stdcall SendInput(uint32 cb, const uint8_t* pInputs, int size)");
const GetSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int idx)");
const GetCursorPosRaw = user32.func("int __stdcall GetCursorPos(long* pt)");

function makeInputBuffer({ type, dx = 0, dy = 0, mouseData = 0, vk = 0, scan = 0, flags = 0 }) {
  const buf = new ArrayBuffer(INPUT_SIZE);
  const dv = new DataView(buf);
  dv.setUint32(0, type, true);
  dv.setUint32(4, 0, true); // padding
  if (type === INPUT_MOUSE) {
    dv.setInt32(8, dx | 0, true);
    dv.setInt32(12, dy | 0, true);
    dv.setInt32(16, mouseData | 0, true);
    dv.setUint32(20, flags, true);
  } else {
    dv.setUint16(8, vk, true);
    dv.setUint16(10, scan, true);
    dv.setUint32(12, flags, true);
  }
  dv.setUint32(24, 0, true); // time
  dv.setUint32(28, 0, true); // extraInfo lo
  dv.setUint32(32, 0, true); // extraInfo hi（x64 uintptr 8B）
  return buf;
}

function sendRaw(buf) {
  const u8 = new Uint8Array(buf);
  const sent = SendInputRaw(1, u8, INPUT_SIZE);
  if (sent !== 1) throw new Error(`SendInput failed: sent=${sent}`);
}

function sendMouse(dx, dy, flags, mouseData = 0) {
  sendRaw(makeInputBuffer({ type: INPUT_MOUSE, dx, dy, mouseData, flags }));
}

function sendKey(vk, flags, scan = 0) {
  sendRaw(makeInputBuffer({ type: INPUT_KEYBOARD, vk, scan, flags }));
}

/** 屏幕坐标 → 0..65535 绝对坐标（虚拟屏全域）。 */
function toAbsolute(x, y) {
  const vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  const vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  const ax = Math.round(((x - vx) * 65535) / Math.max(1, vw - 1));
  const ay = Math.round(((y - vy) * 65535) / Math.max(1, vh - 1));
  return [ax, ay];
}

export function mouseMoveTo(x, y) {
  const [ax, ay] = toAbsolute(x, y);
  sendMouse(ax, ay, MOUSE_EVENTF_MOVE | MOUSE_EVENTF_ABSOLUTE);
}

export function getCursorPosition() {
  const arr = new Int32Array(2);
  GetCursorPosRaw(arr);
  return { x: arr[0], y: arr[1] };
}

function buttonFlags(action) {
  switch (action) {
    case "left_click":
    case "left_mouse_down":
    case "left_mouse_up":
      return [MOUSE_EVENTF_LEFTDOWN, MOUSE_EVENTF_LEFTUP];
    case "right_click":
      return [MOUSE_EVENTF_RIGHTDOWN, MOUSE_EVENTF_RIGHTUP];
    case "middle_click":
      return [MOUSE_EVENTF_MIDDLEDOWN, MOUSE_EVENTF_MIDDLEUP];
    default:
      throw new Error(`Unsupported mouse button action: ${action}`);
  }
}

/** 单击/双击/三击/按下/抬起（coordinate 可选：给定时先移动）。 */
export function mouseClick(action, x, y) {
  const [down, up] = buttonFlags(action);
  if (x !== undefined && y !== undefined) mouseMoveTo(x, y);
  if (action === "left_mouse_down") {
    sendMouse(0, 0, down);
    return;
  }
  if (action === "left_mouse_up") {
    sendMouse(0, 0, up);
    return;
  }
  const clicks = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
  for (let i = 0; i < clicks; i++) {
    sendMouse(0, 0, down);
    sendMouse(0, 0, up);
  }
}

/** 拖拽：start → end，按下-插值移动-抬起。 */
export function mouseDrag(startX, startY, endX, endY) {
  mouseMoveTo(startX, startY);
  const [down, up] = buttonFlags("left_click");
  sendMouse(0, 0, down);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(startX + ((endX - startX) * i) / steps);
    const y = Math.round(startY + ((endY - startY) * i) / steps);
    mouseMoveTo(x, y);
  }
  sendMouse(0, 0, up);
}

/** 滚轮：direction up/down，amount 格数。 */
export function scrollWheel(direction, amount) {
  const WHEEL_DELTA = 120;
  const count = Math.max(1, Math.min(50, amount ?? 3));
  const data = direction === "up" ? WHEEL_DELTA * count : -WHEEL_DELTA * count;
  sendMouse(0, 0, MOUSE_EVENTF_WHEEL, data);
}

/** VK 映射（Anthropic computer-use key 名 → Windows VK 码）。 */
const VK = {
  return: 0x0d, enter: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b,
  space: 0x20, backspace: 0x08, delete: 0x2e, del: 0x2e,
  insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  left: 0x25, arrowleft: 0x25, up: 0x26, arrowup: 0x26,
  right: 0x27, arrowright: 0x27, down: 0x28, arrowdown: 0x28,
  shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, option: 0x12,
  meta: 0x5b, win: 0x5b, command: 0x5b,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
};

/** key 组合串："ctrl+shift+t"、单字符、"Return" 等。 */
export function pressKeyCombo(combo) {
  const parts = String(combo ?? "")
    .trim()
    .split(/[\s+]+/)
    .filter(Boolean);
  const vks = parts.map((p) => {
    const lower = p.toLowerCase();
    if (VK[lower] !== undefined) return VK[lower];
    if (p.length === 1) return p.toUpperCase().charCodeAt(0);
    throw new Error(`Unknown key: ${p}`);
  });
  const isMod = (vk) => [0x10, 0x11, 0x12, 0x5b].includes(vk);
  const normal = vks.filter((vk) => !isMod(vk));
  const mods = vks.filter((vk) => isMod(vk));
  for (const vk of mods) sendKey(vk, 0);
  for (const vk of normal) {
    sendKey(vk, 0);
    sendKey(vk, KEYEVENTF_KEYUP);
  }
  for (const vk of mods.reverse()) sendKey(vk, KEYEVENTF_KEYUP);
}

/** Unicode 文本输入（KEYEVENTF_UNICODE 逐字符，scan 槽放码点）。 */
export function typeText(text) {
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) throw new Error("Surrogate pairs not supported in typeText");
    sendKey(0, KEYEVENTF_UNICODE, code);
    sendKey(0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, code);
  }
}
