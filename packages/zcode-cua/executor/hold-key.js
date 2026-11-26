/**
 * hold_key：按下组合键 → 保持 duration → 释放。
 * 复用 native-input 的底层原语（键序分离）。
 */
import koffi from "koffi";

const user32 = koffi.load("user32.dll");
const SendInputRaw = user32.func(
  "uint32 __stdcall SendInput(uint32 cb, const uint8_t* pInputs, int size)",
);

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const INPUT_SIZE = 40;

const VK = {
  return: 0x0d, enter: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b,
  space: 0x20, shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, option: 0x12,
  meta: 0x5b, win: 0x5b, command: 0x5b,
};

function sendKey(vk, flags, scan = 0) {
  const buf = new ArrayBuffer(INPUT_SIZE);
  const dv = new DataView(buf);
  dv.setUint32(0, INPUT_KEYBOARD, true);
  dv.setUint16(8, vk, true);
  dv.setUint16(10, scan, true);
  dv.setInt32(16, scan, true);
  dv.setUint32(20, flags, true);
  const sent = SendInputRaw(1, new Uint8Array(buf), INPUT_SIZE);
  if (sent !== 1) throw new Error(`SendInput failed: sent=${sent}`);
}

function resolveVks(combo) {
  return String(combo ?? "")
    .trim()
    .split(/[\s+]+/)
    .filter(Boolean)
    .map((p) => {
      const lower = p.toLowerCase();
      if (VK[lower] !== undefined) return VK[lower];
      if (p.length === 1) return p.toUpperCase().charCodeAt(0);
      throw new Error(`Unknown key: ${p}`);
    });
}

/** 按下全部键 → 等待 → 逆序释放。 */
export async function holdKeyCombo(combo, durationMs) {
  const vks = resolveVks(combo);
  for (const vk of vks) sendKey(vk, 0);
  await new Promise((r) => setTimeout(r, durationMs));
  for (const vk of vks.reverse()) sendKey(vk, KEYEVENTF_KEYUP);
}
