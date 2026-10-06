# Native Viewport Lease:桌面壳的原生视口租约(fork 实现 + 上游提案)

> 状态:fork(`try3dfeat`)已实现,作为上游 PR 的候选设计。
> 目标:让 dsh Desktop 插件能把一个**由插件进程拥有的原生渲染窗口**嵌入主窗口,
> 如同 RoboCute Electron 示例(HWND 同步 + GPU swapchain 直显)那样。

## 动机

DeepSeek Harness 是 agent harness,插件(Host 半 + `dsh.client` 前端 bundle)能把 UI 注入 Web
客户端,但所有插件 UI 都只能是 Web 内容。游戏引擎/工具软件类插件需要原生 GPU 视口
(零拷贝直显、原生输入路径)。壳内已有同构先例:`DesktopPlatformView` = DOM 占位矩形 ↔
主进程叠加原生视图 ↔ bounds/生命周期同步(`apps/desktop/src/platform-view.ts`),但它写死为
账户文档页专用(page 白名单 + 私有凭证 origin)。

本设计把该机制通用化为 **native viewport lease**:主进程为插件创建一个**裸 Win32 容器 HWND**
(插件引擎把渲染子窗口挂进去),bounds 由渲染进程占位矩形驱动,生命周期跟随主窗口。

## 机制

```
插件 client bundle                壳主进程                        插件 Host 半 / 引擎子进程
──────────────────                ────────                        ──────────────────────
dshNativeViewport.acquire(rect) ──▶ 创建 STATIC 容器 HWND ──▶ 返回 { lease, hwnd }
      │                                                           │
      └─ 把 hwnd 经插件控制通道 ────────────────────────────────▶ 引擎 start(parentHwnd=hwnd,
                                                                   viewportTop/Right=0)
                                                                   引擎视口 = 容器客户区
ResizeObserver/window resize ────▶ setBounds(lease, rect) ──▶ MoveWindow(容器)
      │                                                            (引擎每帧轮询父客户区,
      │                                                             尺寸变化自动 reset_view)
unmount ─────────────────────────▶ release(lease) ──────────▶ DestroyWindow(容器)
                                                                 (引擎检测到父窗口死亡自停)
```

关键性质:

- **壳只做窗口管理,从不接触渲染**。容器是 `user32!CreateWindowExA("STATIC", WS_CHILD)` 的
  空窗口;渲染子窗口由插件引擎进程创建并挂入(RoboCute 的视口层本来就为跨进程借 HWND 设计,
  零进程归属检查,见 robocute `win32_viewport.cpp` 头注释)。
- **RoboCute addon 零改动**:`present:'shared'` + `parentHwnd=容器` + inset 0/0,视口即
  占满占位矩形;resize 由引擎已有的"轮询父客户区 → reset_view"路径自动处理。
- **z-order**:容器与 Chromium "Intermediate D3D Window" 同级,主进程在 acquire/setBounds 时
  `SetWindowPos(HWND_TOP)` 重断言,并以 500ms 间隔持续重断言(与 RoboCute 示例引擎侧
  每 60 帧重断言同一策略)。
- **坐标系**:渲染进程给的是 content(DIP)坐标,主进程按
  `webContents.zoomFactor × display.scaleFactor` 换算为物理像素(跨显示器 DPI 迁移时由
  前端周期 setBounds 重同步)。
- **生命周期**:owner `closed`/`render-process-gone`/主 frame 导航 → 自动 release 全部
  租约(沿用 platform-view 的代际清理模式);退出时随 `finishQuit` dispose。
- **desktop-only**:`process.platform === 'win32'`;macOS/Linux 桥上报 `supported: false`。

## 壳改动清单(上游 PR 面)

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src/native-viewport-ipc.ts` | 新增:私有 IPC 通道常量(模式同 `platform-ipc.ts`) |
| `apps/desktop/src/native-viewport.ts` | 新增:`DesktopNativeViewport`(租约表 + koffi Win32 绑定 + DIP 换算 + z 断言计时器);bounds 校验复用 `platformBounds` |
| `apps/desktop/src/preload-native-viewport.ts` | 新增:`dshNativeViewport` 桥(`supported/acquire/setBounds/release`) |
| `apps/desktop/src/preload-app.ts` | 仅向 `dsh-app://app` 主帧暴露 `dshNativeViewport` |
| `apps/desktop/src/main.ts` | 构造 + `ipcMain.handle`(复用 `assertMainApplication` 发送者校验)+ 退出 dispose |
| `apps/desktop/package.json` | `koffi` devDep → dep(打包进 app.asar;签名扫描已覆盖 koffi) |
| `apps/desktop/tests/native-viewport.spec.ts` | 新增:fake bindings 单测 |

Host↔主进程协议**不变**(引擎生命周期完全由插件自己的 Host 半管理,壳不感知引擎)。

## 安全边界(供上游评审)

- 发送者校验 = 主窗口 webContents 主帧 + `dsh-app://app/`(与 `dshPlatform` 同级)。
- 授予的能力:在应用客户区内创建**空容器窗口**并把句柄交给调用方。调用方(含插件注入脚本)
  因此可以把任意原生窗口嵌入应用 UI。对桌面开发工具这是可接受的能力级;若上游要求收紧,
  演进方向是把租约与 **Host 侧注册表**绑定(插件在 Host 配置声明 `nativeViewport: true`,
  主进程凭 Host IPC 下发的注册表校验),本设计的 API 形状不变。
- 容器无输入处理、无内容;输入落在插件引擎子窗口,不进 Chromium(快捷键让位问题与
  RoboCute 示例一致,属宿主和插件之间的契约,壳不参与)。

## 特性退化矩阵

| 环境 | 行为 |
| --- | --- |
| Windows + fork 壳 + 引擎可用 | 直显嵌入(本设计) |
| Windows + 官方壳(无 API) / 非 Windows | `dshNativeViewport` 不存在或 `supported:false` → 插件退化:轮询截图面板(引擎 readback 一次性回读,~1fps PNG),后续可升级 WebSocket 帧流 |
| 引擎不可用(未装 RoboCute / 无 GPU) | 占位卡片提示 |

检测只需 `globalThis.dshNativeViewport?.supported === true`,一行特性检测,官方/fork 行为自动分化。

## fork 内的 demo

`plugins/robocute-viewport-demo/`(非 workspace 包,不进入构建):手写产物 `lib/index.js`
(Host 半:Cordis 插件注册 `/robocute-viewport` 控制路由 + fork 引擎 runner)与 `lib/client.js`
(lazy-CJS:`__ModuleLoader__.load({id, factory})`,注册 `main`/`sidebar.panellist` slot 面板)。
安装:`dsh plugin --profile desktop add ./plugins/robocute-viewport-demo`,再将
`robocute-viewport-demo` 启用为 bundle(应用内「设置 → 插件 → 添加」粘贴插件目录即可);
引擎路径由 bundle 行配置 `robocuteRepo` 声明(可在插件页编辑),不依赖环境变量。

> demo 插件手写产物是演示简化(正式插件应使用 `packages/client/tsdown.client.ts` 预设构建),
> 不影响壳改动的上游叙事。

## 已知限制(fork 阶段接受,上游前硬化)

- 窗口在显示器间拖动(DPI 变化)依赖前端 1s 周期 setBounds 重同步。
- 原生视口获得焦点时应用级快捷键不触发(焦点进了引擎 WndProc;与 RoboCute 示例坑 #11 相同)。
- 滚动容器内的占位矩形不受支持(原生窗口不裁剪);面板须位于非滚动主区。
- 每窗口同时活动租约数未限流(上游可加上限)。
