# 构建与打包

## 从源码运行

```bash
npm install
npm start
```

## 免安装便携打包（无需联网下载 Electron）

利用 `node_modules/electron/dist` 里已有的运行时，直接组装一个可双击的运行目录：

```powershell
$src = "$PWD"                                   # 本仓库根
$out = "..\星穹桌面"                              # 输出目录
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$out\resources\app" | Out-Null

# 1) 复制 Electron 运行时
Copy-Item "$src\node_modules\electron\dist\*" $out -Recurse -Force
Remove-Item "$out\resources\default_app.asar" -Force -ErrorAction SilentlyContinue

# 2) 复制应用本体
Copy-Item "$src\main.js","$src\preload.js","$src\renderer.js","$src\sky-engine.js",`
          "$src\index.html","$src\sky.html","$src\package.json" "$out\resources\app\" -Force
Copy-Item "$src\_lib" "$out\resources\app\_lib" -Recurse -Force

# 3) 原生依赖 koffi（预编译 .node）
New-Item -ItemType Directory -Force -Path "$out\resources\app\node_modules" | Out-Null
Copy-Item "$src\node_modules\koffi" "$out\resources\app\node_modules\koffi" -Recurse -Force

# 4) 改名
Rename-Item "$out\electron.exe" "星穹桌面.exe"
```

产物约 370 MB（Electron 运行时占绝大部分）。

## 分享前务必

删除 `星穹桌面\resources\app\data\state.json`（其中含**打包者本机**的桌面路径），
对方首次运行后用「设置 → 按分类重建格子」生成自己的分类。

## 可选：改用 electron-builder

```bash
npm i -D electron-builder
npx electron-builder --win nsis portable
```

> 需能访问 Electron / nsis 资源（国内可用 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 指向 npmmirror）。
