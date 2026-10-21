'use strict';
// afterPack 钩子：对 mac 构建产物做 ad-hoc 签名（身份 "-"）。
//
// 为什么用 afterPack 而不是 afterSign：
//   electron-builder 原生签名依赖 keychain 里的真实证书（findIdentity），ad-hoc 身份 "-"
//   走不通它的流程会被整体跳过，afterSign 钩子也只在「确实签过」时才触发。所以这里用
//   afterPack —— 它在 app 打包完成后、dmg 封装前执行，且无论原生签名是否发生都会跑。
//
// 为什么必须签：
//   macOS 的屏幕录制(TCC)权限绑定到代码签名身份。完全未签名的 app 即使在
//   「隐私与安全性 → 屏幕录制」里打了勾，desktopCapturer/screencapture 实际仍被拒
//   （报 Failed to get sources）。ad-hoc 签名即可让 TCC 授权真正生效。
//
// 纯本地 ad-hoc，不引入任何苹果证书/公证。Windows 构建不走这里。
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // --force 覆盖任何已有签名，--deep 递归签内嵌 framework/helper，--sign - 为 ad-hoc。
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  // 校验：预期输出 Signature=adhoc。
  execFileSync('codesign', ['-dv', appPath], { stdio: 'inherit' });

  console.log(`[afterPack] ad-hoc signed: ${appPath}`);
};
