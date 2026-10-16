# 鏋勫缓涓庢墦鍖?
## 浠庢簮鐮佽繍琛?
```bash
npm install
npm start
```

## 鍏嶅畨瑁呬究鎼烘墦鍖咃紙鏃犻渶鑱旂綉涓嬭浇 Electron锛?
鍒╃敤 `node_modules/electron/dist` 閲屽凡鏈夌殑杩愯鏃讹紝鐩存帴缁勮涓€涓彲鍙屽嚮鐨勮繍琛岀洰褰曪細

```powershell
$src = "$PWD"                                   # 鏈粨搴撴牴
$out = "..\鏄熺┕妗岄潰"                              # 杈撳嚭鐩綍
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$out\resources\app" | Out-Null

# 1) 澶嶅埗 Electron 杩愯鏃?Copy-Item "$src\node_modules\electron\dist\*" $out -Recurse -Force
Remove-Item "$out\resources\default_app.asar" -Force -ErrorAction SilentlyContinue

# 2) 澶嶅埗搴旂敤鏈綋
Copy-Item "$src\main.js","$src\preload.js","$src\renderer.js","$src\sky-engine.js",`
          "$src\index.html","$src\sky.html","$src\package.json" "$out\resources\app\" -Force
Copy-Item "$src\_lib" "$out\resources\app\_lib" -Recurse -Force

# 3) 鍘熺敓渚濊禆 koffi锛堥缂栬瘧 .node锛?New-Item -ItemType Directory -Force -Path "$out\resources\app\node_modules" | Out-Null
Copy-Item "$src\node_modules\koffi"   "$out\resources\app\node_modules\koffi"   -Recurse -Force
Copy-Item "$src\node_modules\@koromix" "$out\resources\app\node_modules\@koromix" -Recurse -Force   # ← 关键

# 4) 鏀瑰悕
Rename-Item "$out\electron.exe" "鏄熺┕妗岄潰.exe"
```

浜х墿绾?370 MB锛圗lectron 杩愯鏃跺崰缁濆ぇ閮ㄥ垎锛夈€?
## 鍒嗕韩鍓嶅姟蹇?
鍒犻櫎 `鏄熺┕妗岄潰\resources\app\data\state.json`锛堝叾涓惈**鎵撳寘鑰呮湰鏈?*鐨勬闈㈣矾寰勶級锛?瀵规柟棣栨杩愯鍚庣敤銆岃缃?鈫?鎸夊垎绫婚噸寤烘牸瀛愩€嶇敓鎴愯嚜宸辩殑鍒嗙被銆?
## 鍙€夛細鏀圭敤 electron-builder

```bash
npm i -D electron-builder
npx electron-builder --win nsis portable
```

> 闇€鑳借闂?Electron / nsis 璧勬簮锛堝浗鍐呭彲鐢?`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 鎸囧悜 npmmirror锛夈€?

