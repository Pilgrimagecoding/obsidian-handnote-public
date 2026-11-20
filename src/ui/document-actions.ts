import { t } from './i18n';

export type DocumentAction = 'png' | 'svg' | 'pdf' | 'import' | 'performance';
/** Shared by the Obsidian host and browser integration tests; labels resolve when opened. */
export function documentMenuActions(run: (action: DocumentAction, all?: boolean) => void) {
  return ([
    ['png', 'exportPagePng', 'image'],
    ['svg', 'exportPageSvg', 'vector'],
    ['pdf', 'exportPdf', 'pdf'],
    ['import', 'importDocument', 'import'],
    ['performance', 'copyPerformance', 'pulse'],
  ] as const).map(([action, key, icon]) => ({
    get label() { return t(key); }, icon, diagnostic: action === 'performance',
    run: () => run(action),
    children: action === 'png' || action === 'svg' || action === 'pdf' ? [
      { get label() { return t('exportPdfCurrent'); }, run: () => run(action, false) },
      { get label() { return t('exportPdfAll'); }, run: () => run(action, true) },
    ] : undefined,
  }));
}
