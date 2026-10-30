// 拿到真正的发送队列，插件回话走同一条管线（限频、存档、防刷屏都在里面）。
import { holder } from './lib/holder.mjs';

export function wrapSend(previous) {
  return (options) => {
    const instance = previous(options);
    holder.send = instance;
    return instance;
  };
}
