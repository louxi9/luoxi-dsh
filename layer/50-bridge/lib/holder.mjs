// 组件包装与路由之间的共享句柄。
// 组件工厂比路由先构造，所以发送队列先存这里，路由创建桥时再取走。
export const holder = {
  send: null,
  bridge: null,
  // 插件上报的工具调用轨迹（30 层桌宠/面板把它存起来给界面用）。
  toolSink: null,
};
