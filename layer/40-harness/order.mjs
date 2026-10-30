// 侧边栏位置：把「DeepSeek」插到「应用日志」前面，不让它落在「我的」后面。
// 只重排数组，不改默认页面、不改宿主源码。
const PANEL = 'dsh';
const ANCHOR = 'logs';

export function wrapPanelOrder(previousFactory) {
  return function composedPanelAdapters(options) {
    const adapters = previousFactory(options);
    if (!adapters || typeof adapters.listPanels !== 'function') return adapters;
    const listPanels = adapters.listPanels.bind(adapters);
    return {
      ...adapters,
      listPanels() {
        const panels = listPanels();
        if (!panels.some((panel) => panel.id === PANEL)) return panels;
        const rest = panels.filter((panel) => panel.id !== PANEL);
        const mine = panels.find((panel) => panel.id === PANEL);
        const anchor = rest.findIndex((panel) => panel.id === ANCHOR);
        if (anchor < 0) return [...rest, mine];
        return [...rest.slice(0, anchor), mine, ...rest.slice(anchor)];
      },
    };
  };
}
