/**
 * 设置面板 —— 从 App 里搬出来的自包含 DOM 构建器。
 *
 * 为什么单独拎出来：
 *   设置面板是**一块纯 UI**：建 DOM、挂事件、每改一项即时落盘。
 *   它不掺和视图切换、空间、加密这些流程，原先却和它们挤在同一个类里，
 *   160 行面板代码把 App 的主线（事件 → 状态 → 重画）盖住了大半。
 *
 *   贡献者想加一项设置，现在只要看这一个文件 + 下面那张 host 清单。
 *
 * ⚠️ 面板里的每一项都是**改一项存一项**（不再有"要点保存才落盘"）：
 *    高对比度 / 字体大小 / 主题在 onchange 里就 apply 了，
 *    可落盘只在 onOk 里做 —— 用户改完直接点「关闭」，
 *    眼前变了、下次启动又变回去（实测存在的 bug）。
 *    所以每一项都即时保存，底部只留「完成」，不再有"保存"这回事。
 */
import { loadLocalePref, t } from '../i18n';
import { setLocalePref } from '../i18n/runtime';
import type { Library } from '../model/types';
import { applyA11y, applyTheme, saveSettings, type Settings } from '../persist/db';
import { download, toBundle } from '../persist/export';
import { emit } from '../platform/shell';
import { $, confirmBox, el, modal, toast } from '../ui/dom';
import { versionLabel } from '../version';

/**
 * App 交给设置面板的读写入口。
 *
 * ⚠️ 只列面板真正要的那些：面板要改设置、要重画、要触发几个流程，
 *    但它不需要知道 App 的内部怎么实现 —— 这就是它能独立成一个模块的原因。
 */
export interface SettingsMenuHost {
  /** 当前设置（面板改的就是它）。 */
  settings(): Settings;
  /** 系统当前外观（原生推来的 / prefers-color-scheme）。 */
  systemTheme(): 'dark' | 'light';
  /** 加密会话开没开。 */
  hasSessionKey(): boolean;
  /** 当前空间的库（导出 JSON 用）。 */
  spaceLib(): Library;
  /** 换完外观后重画整个界面。 */
  render(): void;
  /** 让画布重画。 */
  invalidateCanvas(): void;
  /** 打开 / 关闭加密。 */
  toggleCrypto(): Promise<void>;
  /** 导入流程（原生模式下的文件选择）。 */
  importFlow(): Promise<void>;
  /** 载入示例空间。 */
  loadSample(): Promise<void>;
  /** 清空全部数据。 */
  clearAll(): Promise<void>;
  /** 重播首次引导。 */
  showOnboard(): void;
  /** 重新打开设置面板（换语言后面板要重建 —— 里面的字是建的时候 t() 出来的）。 */
  reopen(): Promise<void>;
}

/** 设置面板里的一行：标题 + 说明在左，控件在右。
 *  stack = true 时控件独占一行（分段控件太宽，挤在右边会碎）。 */
function setRow(title: string, desc: string, ctl: HTMLElement, stack = false): HTMLElement {
  const row = el('div', { class: 'set-row' + (stack ? ' stack' : '') });
  const main = el('div', { class: 'set-row-main' });
  main.append(el('div', { class: 'set-row-t' }, title));
  if (desc) main.append(el('div', { class: 'set-row-d' }, desc));
  row.append(main, el('div', { class: 'set-row-ctl' }, ctl));
  return row;
}

/** 分段选择器。自己管自己的选中态，点谁谁亮。 */
function segPick<T extends string>(
  values: readonly T[], labels: readonly string[], cur: T, onPick: (v: T) => void,
): HTMLElement {
  const wrap = el('div', { class: 'scale-pick' });
  const btns: HTMLButtonElement[] = [];
  values.forEach((v, i) => {
    const b = el('button', { class: v === cur ? 'on' : '' }, labels[i] ?? String(v)) as HTMLButtonElement;
    b.onclick = () => {
      btns.forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onPick(v);
    };
    btns.push(b);
    wrap.append(b);
  });
  return wrap;
}

/** 打开设置面板。 */
export async function openSettingsMenu(host: SettingsMenuHost): Promise<void> {
  const lib = host.spaceLib();
  const st = host.settings();

  /** 改一项就存一项。 */
  const persist = () => { void saveSettings(st); };

  await modal({
    title: t('action.settings'),
    okText: t('common.done'),
    hideCancel: true,
    wide: true,
    body: (card, done) => {
      /* ── 语言 ── */
      // 放在最前面：语言是"整个界面长什么样"的开关，先看见它。
      const secLang = el('div', { class: 'set-sec' });
      secLang.append(el('div', { class: 'set-sec-t' }, t('settings.language')));
      secLang.append(setRow(
        t('settings.interfaceLanguage'), t('settings.localeDefaultHint'),
        segPick(
          ['auto', 'zh-CN', 'en-US'] as const,
          [t('settings.followSystem'), '简体中文', 'English'],
          loadLocalePref(),
          (v) => {
            setLocalePref(v);
            // 面板里的字是建的时候 t() 出来的，换完语言得**重建**一次面板，
            // 否则标题和按钮还停在旧语言。
            done(null);
            void host.reopen();
          },
        ),
        true,
      ));
      card.append(secLang);

      /* ── 外观 ── */
      const secLook = el('div', { class: 'set-sec' });
      secLook.append(el('div', { class: 'set-sec-t' }, t('settings.appearance')));
      secLook.append(setRow(
        t('field.theme'), t('settings.followSystemHint'),
        segPick(['auto', 'dark', 'light'] as const, [t('settings.followSystem'), t('settings.dark'), t('settings.light')], st.theme, (v) => {
          st.theme = v;
          persist();
          applyTheme(st, host.systemTheme());
          host.invalidateCanvas();
          host.render();
          // 原生外壳里，窗口外观就是主题的落点：
          // 「跟随系统」把窗口外观交还给系统，暗色/亮色则把它钉死。
          emit('themeChanged', { theme: v });
        }),
        true,
      ));
      card.append(secLook);

      /* ── 无障碍 ── */
      const secA11y = el('div', { class: 'set-sec' });
      secA11y.append(el('div', { class: 'set-sec-t' }, t('settings.accessibility')));
      const hiSw = el('span', { class: 'switch' + (st.contrast === 'high' ? ' on' : '') });
      hiSw.style.cursor = 'pointer';
      hiSw.onclick = () => {
        st.contrast = st.contrast === 'high' ? 'normal' : 'high';
        hiSw.classList.toggle('on', st.contrast === 'high');
        applyA11y(st);
        persist();
      };
      secA11y.append(setRow(t('settings.highContrast'), t('settings.highContrastHint'), hiSw));
      secA11y.append(setRow(
        t('settings.fontSize'), t('settings.scaleTogether'),
        segPick(['md', 'lg', 'xl'] as const, [t('settings.fontStandard'), t('settings.fontLarge'), t('settings.fontExtraLarge')], st.scale, (v) => {
          st.scale = v;
          applyA11y(st);
          persist();
        }),
        true,
      ));
      card.append(secA11y);

      /* ── 数据与安全 ── */
      const secData = el('div', { class: 'set-sec' });
      secData.append(el('div', { class: 'set-sec-t' }, t('settings.dataSecurity')));
      secData.append(setRow(
        t('settings.autoLock'), t('settings.idleLockHint'),
        segPick(
          ['5', '15', '30', '60', '0'] as const,
          [t('duration.min5'), t('duration.min15'), t('duration.min30'), t('duration.hour1'), t('lock.never')],
          String(st.lockMinutes) as '5' | '15' | '30' | '60' | '0',
          (v) => { st.lockMinutes = Number(v); persist(); },
        ),
        true,
      ));
      const encDesc = host.hasSessionKey()
        ? t('crypto.aesGcmExplain')
        : t('crypto.notEncryptedNow');
      const tog = el('button', { class: 'opt' }, host.hasSessionKey() ? t('crypto.turnOff') : t('crypto.turnOn'));
      tog.onclick = () => { void host.toggleCrypto(); };
      secData.append(setRow(t('crypto.title'), encDesc, tog));
      card.append(secData);

      /* ── 备份与迁移 ── */
      // ⚠️ 这一节是「导入」在原生模式下的**保底入口**：
      //    原生外壳会隐藏 web 顶栏（--hd 归零），顶栏上的「导入」按钮看不见；
      //    设置面板是原生菜单「人生画布 → 设置…」打开的，面板里的入口一定在。
      const secBackup = el('div', { class: 'set-sec' });
      secBackup.append(el('div', { class: 'set-sec-t' }, t('settings.backup')));
      const imp = el('button', { class: 'opt' }, t('import.chooseJsonFile'));
      // ⚠️ 这里**不能**先把设置面板关掉：文件选择面板是原生弹的，
      //    关早了就是"面板没了、选择器也没出来"，用户直接回到画布。
      imp.onclick = () => { void host.importFlow(); };
      secBackup.append(setRow(t('action.import'), t('import.overwriteWithPrevious'), imp));
      const exp = el('button', { class: 'opt' }, t('action.saveAsJson'));
      exp.onclick = () => {
        $('#modal')!.hidden = true;
        download(`life-canvas-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(toBundle(lib), null, 2));
        toast(t('toast.exportedJson'));
      };
      secBackup.append(setRow(t('action.export'), t('export.fullFidelityList'), exp));
      card.append(secBackup);

      /* ── 示例空间与引导 ── */
      const secSample = el('div', { class: 'set-sec' });
      secSample.append(el('div', { class: 'set-sec-t' }, t('settings.sampleSpaceAndGuide')));
      const re = el('button', { class: 'opt' }, t('settings.replayGuide'));
      re.onclick = () => { $('#modal')!.hidden = true; host.showOnboard(); };
      secSample.append(setRow(t('settings.firstRunGuide'), t('onboard.replayAnyTime'), re));
      const rs = el('button', { class: 'opt' }, lib.nodes.length ? t('onboard.loadSampleSpaceOverwrites') : t('onboard.loadSampleSpace'));
      rs.onclick = async () => {
        if (lib.nodes.length && !(await confirmBox(t('onboard.loadSample'), t('error.overwriteWarning'), t('import.overwriteLabel')))) return;
        $('#modal')!.hidden = true;
        await host.loadSample();
      };
      secSample.append(setRow(t('onboard.sampleSpace'), t('onboard.sampleLibrary'), rs));
      card.append(secSample);

      /* ── 危险操作：单独成块 ── */
      const secDanger = el('div', { class: 'set-sec' });
      secDanger.append(el('div', { class: 'set-sec-t' }, t('settings.dangerZone')));
      const danger = el('div', { class: 'set-danger' });
      const del = el('button', { class: 'opt' }, lib.nodes.length ? t('action.clearWithCount', { n: lib.nodes.length }) : t('action.clear'));
      del.onclick = () => { $('#modal')!.hidden = true; void host.clearAll(); };
      danger.append(setRow(t('action.clearAllData'), t('error.cannotUndo'), del));
      secDanger.append(danger);
      card.append(secDanger);

      /* ── 关于 ── */
      // 放最后：版本号是"看一眼就走"的信息，不该跟要动手的项挤在一起。
      // 真源是 Info.plist（跟 Finder「关于本机」同一个值）——
      // 桌面版显示的是**正在跑的这个包**的版本，原生启动时报过来的。
      const secAbout = el('div', { class: 'set-sec' });
      secAbout.append(el('div', { class: 'set-sec-t' }, t('settings.about')));
      secAbout.append(setRow(t('version.label'), t('settings.currentVersion'), el('span', { class: 'set-ver' }, versionLabel())));
      card.append(secAbout);
    },
  });
}
