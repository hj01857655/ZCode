/**
 * Computer Use 运行时——真实执行层。
 * 接口契约（index.d.ts）不变：createComputerUseRuntime(options) → { execute, closeSession, dispose }
 * action 集合 = anthropic.computer_20251124 schema（发行版 cjs hca 定义）：
 *   key, hold_key, type, cursor_position, mouse_move, left_mouse_down, left_mouse_up,
 *   left_click, left_click_drag, right_click, middle_click, double_click, triple_click,
 *   scroll, wait, screenshot, zoom
 */
import {
  mouseMoveTo,
  getCursorPosition,
  mouseClick,
  mouseDrag,
  scrollWheel,
  pressKeyCombo,
  typeText,
} from "./executor/native-input.js";
import { captureScreen } from "./executor/screenshot.js";
import { holdKeyCombo } from "./executor/hold-key.js";

function okResult(action, extra = {}) {
  return {
    content: [{ type: "text", text: `Action "${action}" completed.` }],
    isError: false,
    ...extra,
  };
}

function imageResult(png, extra = {}) {
  return {
    content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
    isError: false,
    ...extra,
  };
}

function errResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** action → 执行（真实实现）。 */
async function dispatch(action, args, signal) {
  switch (action) {
    case "screenshot": {
      const { width, height, png } = await captureScreen();
      return imageResult(png, { text: `Screenshot ${width}x${height}` });
    }
    case "zoom": {
      const { png, width, height } = await captureScreen();
      // region 语义（Anthropic）：[x1, y1, x2, y2]
      const region = args.region;
      if (!region || region.length !== 4) {
        return imageResult(png, { text: `Screenshot ${width}x${height} (no region)` });
      }
      const [x1, y1, x2, y2] = region;
      const cw = Math.max(1, x2 - x1);
      const ch = Math.max(1, y2 - y1);
      return imageResult(png, {
        text: `Screenshot ${width}x${height}; zoom region [${region.join(", ")}] → ${cw}x${ch} (full frame attached)`,
      });
    }
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const [x, y] = args.coordinate ?? [];
      mouseClick(action, x, y);
      return okResult(action);
    }
    case "left_mouse_down":
    case "left_mouse_up": {
      const [x, y] = args.coordinate ?? [];
      mouseClick(action, x, y);
      return okResult(action);
    }
    case "left_click_drag": {
      const [sx, sy] = args.start_coordinate ?? [];
      const [ex, ey] = args.coordinate ?? [];
      if (sx === undefined || ex === undefined) {
        return errResult("left_click_drag requires start_coordinate and coordinate");
      }
      mouseDrag(sx, sy, ex, ey);
      return okResult(action);
    }
    case "mouse_move": {
      const [x, y] = args.coordinate ?? [];
      if (x === undefined) return errResult("mouse_move requires coordinate");
      mouseMoveTo(x, y);
      return okResult(action);
    }
    case "cursor_position": {
      const pos = getCursorPosition();
      return { content: [{ type: "text", text: `Cursor at X=${pos.x},Y=${pos.y}` }], isError: false };
    }
    case "key": {
      if (!args.text) return errResult("key requires text");
      pressKeyCombo(args.text);
      return okResult(action);
    }
    case "hold_key": {
      if (!args.text) return errResult("hold_key requires text");
      const duration = Math.min(Math.max(args.duration ?? 1000, 0), 30_000);
      await holdKeyCombo(args.text, duration);
      return okResult(action);
    }
    case "type": {
      if (!args.text) return errResult("type requires text");
      typeText(args.text);
      return okResult(action);
    }
    case "scroll": {
      scrollWheel(args.scroll_direction ?? "down", args.scroll_amount ?? 3);
      return okResult(action);
    }
    case "wait": {
      await sleep(Math.min(Math.max((args.duration ?? 1) * 1000, 0), 60_000));
      return okResult(action);
    }
    default:
      return errResult(`Unknown action: ${action}`);
  }
}

export function createComputerUseRuntime(options) {
  return {
    async execute(input) {
      try {
        const args = input.arguments ?? {};
        return await dispatch(args.action ?? input.toolName, args, input.signal);
      } catch (error) {
        return errResult(`Computer Use execution failed: ${error.message}`);
      }
    },
    async closeSession() {},
    async dispose() {},
  };
}
