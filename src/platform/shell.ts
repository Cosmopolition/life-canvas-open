/**
 * 原生外壳桥接（macOS WKWebView）。
 *
 * 方向相反的两条通道：
 *   web → 原生   window.webkit.messageHandlers.shell.postMessage(obj)
 *   原生 → web   window.__lcShell.cmd({...})
 *
 * 为什么不用 Settings 里的开关判断"是否原生模式"：
 * Settings 存在 Dexie 的 meta 表里，而库在解锁前是打不开的（PBKDF2 门禁）。
 * 拿设置当开关会先闪一下 web 顶栏、进入后再消失。桥的存在性第一行脚本就能拿到，
 * 没有任何时序问题。
 */

/** 原生 → web 的命令 */
export type ShellCommand =
  | { type: 'view'; view: string }
  | { type: 'search'; q: string }
  | { type: 'action'; action: string }
  | { type: 'theme'; theme: 'dark' | 'light' }
  | { type: 'focusCanvas' }
  /**
   * 原生选好了文件，把**内容**送过来。
   *
   * 为什么不让 web 用 <input type=file> 直接拿文件：
   * 那条路要靠 WebKit 把文件交给 web 进程，实测**会偶发交不到** ——
   * 原生这边面板选好了、文件也在，web 那边 `input.files` 就是空的，
   * onchange 拿不到文件，导入静默没反应。
   * 原生自己读（它有用户选文件的权限）再把内容送过来，就没这个环节了。
   */
  | { type: 'importFile'; name: string; text: string; error?: string; cancelled?: boolean }
  /**
   * 原生选好了**图片**，把处理好的内容送过来。
   *
   * 为什么图片要原生先缩放再送，而不是送原文件：
   * 一张手机照片 3–5MB，base64 之后 4–7MB —— 塞进 JSON 走
   * evaluateJavaScript 会卡住主线程。原生用 ImageIO 缩到长边 ≤800
   * 之后只剩 50KB 左右，传输成本可以忽略。
   *
   * 为什么不让 web 用 <input type=file> 直接拿文件：
   * ① 原生侧的面板写死了只收 JSON（WKOpenPanelParameters 没有类型字段，
   *    web 的 accept="image/*" 传不过去）—— 桌面端根本选不了图；
   * ② 那条路实测**会偶发交不到**（见 importFile 的注释）。
   */
  | {
      type: 'imageFile'; name: string; dataUrl: string; w: number; h: number;
      error?: string; cancelled?: boolean;
    }
  /**
   * 原生把**界面语言**告诉 web。
   *
   * 什么时候发：web 发来 ready 之后，原生按系统语言报一次。
   * web 那边只在"用户没显式选过语言"（跟随系统）时采纳它 ——
   * 用户在设置面板里锁过语言的话，web 的偏好才是权威。
   */
  | { type: 'locale'; locale: string }
  /**
   * 原生报来的 **App 版本号**（用户可见版本 + 构建号）。
   *
   * 什么时候发：web 发来 ready 之后，原生报一次。
   * 真源是 Bundle 里的 Info.plist —— 跟 Finder「关于本机」同一个值。
   */
  | { type: 'appInfo'; version: string; build: string };

/** web → 原生的消息（payload 随 type 而定，这里只约束 type） */
export type ShellEventType =
  | 'ready' | 'viewChanged' | 'searchChanged' | 'filterChanged'
  | 'lockChanged' | 'themeChanged' | 'titleChanged'
  // 下载文件名：原生弹的保存面板不知道建议叫什么，web 侧知道，先报上来
  | 'downloadName'
  // 打开「选择 JSON 文件…」面板（由原生弹、由原生读文件）
  | 'openImport'
  // 打开「选择图片…」面板（由原生弹、由原生缩放、由原生读文件）
  | 'openImage'
  // 界面语言变了 —— 原生据此把菜单栏 / 工具栏 / 窗口标题重刷一遍
  | 'localeChanged';

interface WKMessageHandler {
  postMessage(message: unknown): void;
}

function handler(): WKMessageHandler | undefined {
  const w = window as unknown as {
    webkit?: { messageHandlers?: Record<string, WKMessageHandler> };
  };
  return w.webkit?.messageHandlers?.shell;
}

/** 是否跑在原生外壳里。纯读，无副作用。 */
export function isNative(): boolean {
  return typeof window !== 'undefined' && !!handler();
}

/** web → 原生。浏览器里是空操作。 */
export function emit(type: ShellEventType, payload: Record<string, unknown> = {}): void {
  handler()?.postMessage({ type, ...payload });
}

let commandHandler: ((c: ShellCommand) => void) | null = null;

/**
 * 装好原生模式：标记 <html data-native-shell>（CSS 据此让出顶栏），
 * 并注册 native → web 的分发器。
 *
 * 幂等：重复调用只生效一次。
 */
export function enable(onCommand: (c: ShellCommand) => void): boolean {
  if (!isNative()) return false;

  if (!commandHandler) {
    commandHandler = onCommand;
    (window as unknown as { __lcShell?: unknown }).__lcShell = {
      cmd(raw: unknown): void {
        if (!raw) return;
        let c: ShellCommand;
        try {
          c = typeof raw === 'string' ? JSON.parse(raw) : (raw as ShellCommand);
        } catch {
          return;
        }
        commandHandler?.(c);
      },
    };
  }

  document.documentElement.dataset.nativeShell = '1';
  return true;
}