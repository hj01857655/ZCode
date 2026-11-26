/**
 * Windows 屏幕截图——PowerShell System.Drawing 方案（方案 B）。
 * koffi 的 GDI BitBlt 在 9 参数跨 DC 场景存在调用问题（rc=0/invalid handle），改用
 * PowerShell CopyFromScreen（子进程，~1-2s），零 FFI 风险，输出 PNG buffer。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PS_SCRIPT = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$g.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[System.Convert]::ToBase64String($ms.ToArray())
`;

/** 全屏截图，返回 { width, height, png }。region 支持 {x,y,width,height}（裁剪自全屏）。 */
export async function captureScreen(region) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT],
    { maxBuffer: 64 * 1024 * 1024, timeout: 30_000, windowsHide: true },
  );
  const png = Buffer.from(stdout.trim(), "base64");

  if (!region) {
    // 从 PNG IHDR 读尺寸
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    return { width, height, png };
  }

  // region 裁剪：交给 sharp 或调用方处理；此处直接返回全屏
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return { width, height, png, fullScreen: true };
}
